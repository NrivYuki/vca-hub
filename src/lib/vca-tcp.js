/*
 * vca-tcp.js — vca-session.js を Node.js の TCP・UDP につなぐ(7.8.2)。Node.js 専用
 *
 *   接続の形          デバイス              ホスト
 *   ローカル接続      listenDevice(50000)   connectHost(IP, 50000)
 *   リモート接続      connectDevice(IP, 33512)  listenHost(33512)
 *   オートコネクト    announce(UDP 33511)    listenAutoconnect(33511) → connectHost
 *
 * どの形でも、接続のあとデバイスは 3 秒待ってから最初のセッションを始める(7.8.2.7.4)。
 * opts は createDevice・createHost にそのまま渡す。opts.connectDelay(秒)で待ち時間を変えられる(テスト用)。
 */
'use strict';
const net = require('net');
const dgram = require('dgram');
const VCA = require('./vca-parser.js');
const { createDevice, createHost, autoconnectPacket } = require('./vca-session.js');

const PORTS = { device: 50000, remote: 33512, rendezvous: 33511 };

// ソケットとセッションをつなぐ(1 バイト = 1 文字)
function attach(socket, make, opts) {
  socket.setNoDelay(true);
  const endpoint = make(Object.assign({}, opts, { send: s => socket.write(Buffer.from(s, 'latin1')) }));
  socket.on('data', d => endpoint.receive(d.toString('latin1')));
  socket.on('close', () => endpoint.close());
  socket.on('error', e => { if (opts.onError) opts.onError(e); });
  endpoint.socket = socket;
  return endpoint;
}

function deviceOn(socket, opts) {
  const device = attach(socket, createDevice, opts);
  device.connected(opts.connectDelay);
  return device;
}

/** リモート接続: デバイスがホストのポート(既定 33512)へつなぐ。Promise でデバイスを返す */
function connectDevice(address, port, opts) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port || PORTS.remote, address, () => resolve(deviceOn(socket, opts || {})));
    socket.once('error', reject);
  });
}

/** ローカル接続: デバイスが待ち受ける(既定 50000)。ホストがつなぐたびに onDevice(device) を呼ぶ */
function listenDevice(port, opts, onDevice) {
  const server = net.createServer(socket => onDevice(deviceOn(socket, opts || {})));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port === undefined ? PORTS.device : port, () => resolve(server));
  });
}

/** ローカル接続: ホストがデバイスのポート(既定 50000)へつなぐ。Promise でホストを返す */
function connectHost(address, port, opts) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port || PORTS.device, address, () => resolve(attach(socket, createHost, opts || {})));
    socket.once('error', reject);
  });
}

/**
 * リモート接続: ホストが待ち受ける(既定 33512)。デバイスがつなぐたびに onHost(host) を呼ぶ。
 * opts に関数を渡すと、接続のたびに opts(socket) で、その接続の opts を作る(相手ごとに応答や記録を分けるため)。
 * 関数が null を返したら、セッションを作らずに接続を切る(つないでよい相手を利用者が決める)。
 */
function listenHost(port, opts, onHost) {
  const server = net.createServer(socket => {
    const o = typeof opts === 'function' ? opts(socket) : (opts || {});
    if (!o) { socket.destroy(); return; }
    const host = attach(socket, createHost, o);
    if (onHost) onHost(host);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port === undefined ? PORTS.remote : port, () => resolve(server));
  });
}

/**
 * オートコネクト: デバイスが自分の IP とポートを UDP で知らせる(REQ=CON、7.8.2.7.1)。
 * info: { ip, port, dev, ven, model, mname, sn }、to: { address(既定はブロードキャスト), port(既定 33511) }
 */
function announce(info, to) {
  const t = to || {};
  const address = t.address || '255.255.255.255';
  const msg = Buffer.from(autoconnectPacket(info), 'latin1');
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', e => { sock.close(); reject(e); });
    sock.bind(() => {
      if (address === '255.255.255.255') sock.setBroadcast(true);
      sock.send(msg, t.port || PORTS.rendezvous, address, e => { sock.close(); if (e) reject(e); else resolve(); });
    });
  });
}

/**
 * オートコネクト: ホストが UDP(既定 33511)で待ち、REQ=CON を受け取ったら、その IP とポートへつなぐ。
 * つないだら onHost(host, con) を呼ぶ(con は CON パケットを VCA.parsePacket した結果)。
 *
 * UDP の知らせをきっかけに、意図しない相手へつながないよう、次の場合はつながない。
 *   IP が IP アドレスの形でない、PORT が 1-65535 の整数でない(どちらも CON パケットに必須、7.8.2.7.1)
 *   IP が UDP の送り主のアドレスと違う(デバイスは自分の IP を知らせる決まりなので、第三者のアドレスは断る)
 *   opts.allow({ ip, port, from, con }) が false を返した(つないでよいネットワークを利用者が決める)
 *   同じ IP とポートに、すでにつないでいる(繰り返し届く知らせで接続を増やさない)
 * つながなかったときは opts.onIgnore(理由, { ip, port, from }) を呼ぶ。
 * opts.connectOpts({ ip, port, from, con }) があれば、つなぐたびに、それが返したものを connectHost の opts にする
 * (相手ごとに応答や記録を分けるため)。無ければ opts をそのまま使う。
 */
function listenAutoconnect(port, opts, onHost) {
  const o = opts || {};
  const active = new Set();
  const ignore = (reason, info) => { if (o.onIgnore) o.onIgnore(reason, info); };
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', async (buf, rinfo) => {
    let con;
    try { con = VCA.parsePacket(buf.toString('latin1')); } catch (e) { return; }
    if (VCA.value(con, 'REQ') !== 'CON') return;
    const ip = VCA.value(con, 'IP'), portText = VCA.value(con, 'PORT'), from = rinfo.address;
    const p = /^\d+$/.test(portText || '') ? Number(portText) : NaN;
    const info = { ip, port: p, from };
    if (!ip || !net.isIP(ip)) return ignore('IP が IP アドレスの形ではありません', info);
    if (!(p >= 1 && p <= 65535)) return ignore('PORT が 1-65535 の整数ではありません', info);
    if (o.allow ? !o.allow({ ip, port: p, from, con }) : ip !== from) {
      return ignore(o.allow ? 'allow で断りました' : 'IP が UDP の送り主のアドレスと違います', info);
    }
    const key = ip + ':' + p;
    if (active.has(key)) return ignore('すでにつないでいます', info);
    active.add(key);
    try {
      const host = await connectHost(ip, p, o.connectOpts ? o.connectOpts({ ip, port: p, from, con }) : o);
      host.socket.once('close', () => active.delete(key));
      if (onHost) onHost(host, con);
    } catch (e) { active.delete(key); if (o.onError) o.onError(e); }
  });
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port === undefined ? PORTS.rendezvous : port, () => resolve(sock));
  });
}

module.exports = { PORTS, connectDevice, listenDevice, connectHost, listenHost, announce, listenAutoconnect };
