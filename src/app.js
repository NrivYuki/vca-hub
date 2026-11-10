'use strict';
// 各部品を組み立てて起動・停止する。テストからも同じ入口を使う。
// 接続とセッションは vca-guide の vca-tcp.js・vca-session.js が行い、応答の中身は host/session.js が作る。

const path = require('node:path');
const T = require('./lib/vca-tcp.js');
const { hostOptions, requestIdEntries } = require('./host/session.js');
const { Registry } = require('./host/registry.js');
const { Store } = require('./store/store.js');
const { Log } = require('./log.js');
const { isAllowed, peerOf } = require('./net/tcp.js');
const { exportFile, exportTarget, watchFolder, fileRecords } = require('./send/folder.js');
const { uploadTo, uploadRecords } = require('./device/upload.js');
const { buildDownload } = require('./send/build.js');
const { Extensions } = require('./ext/extensions.js');

const LOCAL_RETRY_MS = 10000;          // ローカル接続が切れたあと、つなぎ直すまでの時間
const PURGE_INTERVAL_MS = 3600000;     // 保存期間を過ぎたデータを消しに行く間隔

const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {object} cfg loadConfig() の結果
 * @param {{echoLog?: boolean}} [opts]
 */
function createHub(cfg, opts = {}) {
  const log = new Log({ dir: path.join(cfg.dataDir, 'log'), echo: !!opts.echoLog });
  const store = new Store({ dir: cfg.dataDir, removePII: cfg.removePII });
  const registry = new Registry({ file: path.join(cfg.dataDir, 'devices.json') });
  // 拡張(設計書 13 章)。config.json の extensions に書いたものだけを読む。読めなければ例外(起動しない)
  const ext = new Extensions({ dir: cfg.extensionsDir, enabled: cfg.extensions, dataDir: cfg.dataDir, store, log });
  if (ext.list.length) {
    store.hooks.saved = (entry, body) => ext.received(entry, body);
    store.hooks.removed = id => ext.removed(id);
    store.hooks.check = (entry, readBody) => ext.check(entry, readBody);
    store.hooks.queued = entry => ext.queued(entry);
  }

  /**
   * 送るレコードを作る: 送り先に合わせて組み立て(値は変えない)、拡張の send を通す。
   * @param {object} to { kind: 'device', profile, device } | { kind: 'file' } | { kind: 'destination', dest }
   */
  function recordsFor(entry, to) {
    const body = store.readBody(entry);
    const base = to.kind === 'device' ? buildDownload({ body, profile: to.profile || null })
      : to.kind === 'file' ? fileRecords(body) : uploadRecords(body);
    return ext.list.length ? ext.send(entry, body, base, to) : base;
  }
  ext.app = { recordsFor };

  // ---- 通信方式(設計書 13 章): 口ごとに、VCA(DCS)か拡張が足した通信方式かを選ぶ ----
  const isVca = p => p === undefined || p === null || String(p).toLowerCase() === 'vca';
  /** 口の通信方式を確かめる。VCA なら null、拡張の通信方式ならその定義。無い・使えないなら例外(起動しない) */
  function protocolFor(where, p, need) {
    if (isVca(p)) return null;
    const pr = ext.protocol(p);
    if (!pr) throw fail('no-protocol', `${where} の通信方式 ${p} がありません(足す拡張を config.json の extensions に入れてください)`);
    if (typeof pr.impl[need] !== 'function') throw fail('no-protocol', `${where} の通信方式 ${p} は、${need} に対応していません`);
    return pr;
  }
  const ioFor = (name, protocol) => ext.protocolIo({ name, protocol, allowed: ip => isAllowed(ip, cfg.allow), timeouts: cfg.timeouts });
  // 起動する前に、すべての口の通信方式を確かめる
  protocolFor('リモート接続(remote)', cfg.remote.protocol, 'listen');
  for (const l of cfg.listeners) protocolFor(`待ち受け ${l.name}(listeners)`, l.protocol, 'listen');
  for (const d of cfg.local) protocolFor(`ローカル接続 ${d.name}(local)`, d.protocol, 'connect');
  for (const d of cfg.destinations) protocolFor(`送り先 ${d.name}(destinations)`, d.protocol, 'upload');

  const hosts = new Set();       // つないでいる機器とのセッション(createHost)
  const closers = [];
  const ports = {};

  // 接続ごとのセッションの設定。初期化で割り当てた要求 ID は、つないでいるほかの接続にも知らせる
  // (createHost は要求 ID を接続ごとに持つため。機器がつなぎ直しても STATUS=5 にならないように)
  function sessionOpts(peer) {
    const o = hostOptions({ store, registry, log, peer, recordsFor });
    const onInit = o.onInit;
    o.onInit = (...args) => {
      onInit(...args);
      const entries = requestIdEntries(registry);
      for (const h of hosts) Object.assign(h.requestIds, entries);
    };
    return { ...o, timeouts: cfg.timeouts };
  }

  function attached(host, peer) {
    Object.assign(host.requestIds, requestIdEntries(registry));
    hosts.add(host);
    log.write('info', { event: 'connected', peer });
    host.socket.once('close', () => { hosts.delete(host); log.write('info', { event: 'disconnected', peer }); });
  }

  /** ローカル接続: 機器が待ち受けているポートへ接続し、切れたら一定時間後につなぎ直す。 */
  function connectLocal(dev) {
    let stopped = false, timer = null, current = null;
    const peer = `${dev.name}(${dev.host}:${dev.port})`;
    const retry = () => { if (!stopped) timer = setTimeout(attempt, LOCAL_RETRY_MS); };
    async function attempt() {
      if (stopped) return;
      if (!isAllowed(dev.host, cfg.allow)) { log.write('warn', { event: 'rejected', peer, detail: 'not in allow list' }); return; }
      let host;
      try { host = await T.connectHost(dev.host, dev.port, sessionOpts(peer)); } catch { retry(); return; }
      if (stopped) { host.socket.destroy(); return; }
      current = host.socket;
      attached(host, peer);
      host.socket.once('close', () => { current = null; retry(); });
    }
    attempt();
    return () => { stopped = true; clearTimeout(timer); if (current) current.destroy(); };
  }

  // ---- 送り出し(どれも、人が付けた名前で送る。設計書 6 章) ----
  function sendable(id, name) {
    const entry = store.get(id);
    if (!entry) throw fail('not-found', 'データがありません');
    store.assertSendable(entry);
    return store.setName(id, name);
  }

  /** 共有フォルダへ書き出す前に、同じ名前のファイルがあるか(あれば上書きになる)。 */
  function exportCheck(name) {
    if (!cfg.exportDir) throw fail('no-export-dir', '書き出し先(exportDir)が設定されていません');
    return exportTarget(cfg.exportDir, Store.checkName(name));
  }

  /** 共有フォルダへ書き出す。同じ名前のファイルは上書きし、上書きしたことをログに残す。 */
  function exportJob(id, name) {
    if (!cfg.exportDir) throw fail('no-export-dir', '書き出し先(exportDir)が設定されていません');
    const entry = sendable(id, name);
    const r = exportFile(cfg.exportDir, entry.name, store.readBody(entry), recordsFor(entry, { kind: 'file', dir: cfg.exportDir }));
    store.recordSent(id, `フォルダ ${r.file}`);
    log.write(r.overwrote ? 'warn' : 'info', { event: 'exported', job: entry.name, detail: `${entry.id}${r.overwrote ? ' 上書き' : ''}` });
    return r;
  }

  /** 別の PC やソフト(送り先)へアップロードする(機器役。設計書 5 章)。 */
  async function sendTo(id, name, destName) {
    const dest = cfg.destinations.find(d => d.name === destName);
    if (!dest) throw fail('no-destination', `送り先 ${destName} が設定されていません`);
    const entry = sendable(id, name);
    const to = `${dest.name}(${dest.host}:${dest.port})`;
    const pr = protocolFor(`送り先 ${dest.name}`, dest.protocol, 'upload');
    const records = recordsFor(entry, {
      kind: 'destination', protocol: pr ? dest.protocol : 'vca',
      dest: { name: dest.name, host: dest.host, port: dest.port, type: dest.type || 'UPL' },
    });
    let r;
    try {
      r = pr
        // 拡張の通信方式: VCA のレコードを渡し、メーカーの形に直して送るのは拡張
        ? await pr.impl.upload({ dest: { ...dest }, name: entry.name, entry, records }, ioFor(to, dest.protocol))
        : await uploadTo(dest, { body: store.readBody(entry), name: entry.name, records, timeouts: cfg.timeouts, connectDelay: cfg.connectDelay });
      if (!r || !Number.isInteger(r.status)) throw new Error('送った結果(status)がありません');
    } catch (e) {
      log.write('warn', { event: 'upload', peer: to, job: entry.name, detail: e.code || e.message });
      throw fail('upload-failed', `送れませんでした(${e.code || e.message})`);
    }
    if (r.status === 0) store.recordSent(id, to);
    log.write(r.status === 0 ? 'info' : 'warn', { event: 'uploaded', peer: to, job: entry.name, result: `STATUS=${r.status}`, detail: entry.id });
    return r;
  }

  function purge() {
    for (const e of store.purge(cfg.retentionDays)) log.write('info', { event: 'purged', job: e.name || e.job, detail: e.id });
  }

  /**
   * 待ち受ける。VCA なら DCS のリモート接続(機器がつないでくる)、拡張の通信方式なら拡張の listen。
   * @returns {Promise<number>} 待ち受けたポート
   */
  async function listen({ name, port, protocol, settings }) {
    const pr = protocolFor(`待ち受け ${name}`, protocol, 'listen');
    if (pr) {
      const l = await pr.impl.listen({ name, port, settings: settings || {} }, ioFor(name, protocol));
      if (l && typeof l.close === 'function') closers.push(() => l.close());
      return l && l.port !== undefined ? l.port : port;
    }
    const server = await T.listenHost(port, socket => {
      if (isAllowed(socket.remoteAddress, cfg.allow)) return sessionOpts(peerOf(socket));
      log.write('warn', { event: 'rejected', peer: peerOf(socket), detail: 'not in allow list' });
      return null;
    }, host => attached(host, peerOf(host.socket)));
    closers.push(() => new Promise(r => server.close(r)));
    return server.address().port;
  }

  async function start() {
    if (cfg.retentionDays > 0) {
      purge();
      const t = setInterval(purge, PURGE_INTERVAL_MS);
      closers.push(() => clearInterval(t));
    }
    if (cfg.importDir) {
      const w = watchFolder({ dir: cfg.importDir, store, log });
      closers.push(() => w.stop());
    }
    if (cfg.autoconnect.enabled) {
      // 知らせてきた IP が送り主と同じで、許可範囲の中のときだけつなぐ(設計書 4 章)
      const udp = await T.listenAutoconnect(cfg.autoconnect.port, {
        allow: ({ ip, from }) => ip === from && isAllowed(ip, cfg.allow),
        onIgnore: (reason, info) => log.write('warn', { event: 'autoconnect-ignored', peer: `${info.ip}:${info.port}`, detail: reason }),
        onError: e => log.write('warn', { event: 'autoconnect', detail: e.code || e.message }),
        connectOpts: ({ ip, port }) => sessionOpts(`${ip}:${port}`),
      }, host => attached(host, peerOf(host.socket)));
      ports.autoconnect = udp.address().port;
      closers.push(() => new Promise(r => udp.close(r)));
    }
    if (cfg.remote.enabled) ports.remote = await listen({ name: 'リモート接続', port: cfg.remote.port, protocol: cfg.remote.protocol, settings: cfg.remote.settings });
    // 追加の待ち受け(VCA の口とメーカーの口を並べるときなど)
    ports.listeners = {};
    for (const l of cfg.listeners) ports.listeners[l.name] = await listen(l);
    for (const dev of cfg.local) {
      const pr = protocolFor(`ローカル接続 ${dev.name}`, dev.protocol, 'connect');
      if (!pr) { closers.push(connectLocal(dev)); continue; }
      const peer = `${dev.name}(${dev.host}:${dev.port})`;
      const stopIt = pr.impl.connect({ name: dev.name, host: dev.host, port: dev.port, settings: dev.settings || {} }, ioFor(peer, dev.protocol));
      closers.push(async () => { if (typeof stopIt === 'function') await stopIt(); });
    }
    if (cfg.web.enabled) {
      const { startWeb } = require('./web/server.js');
      const web = await startWeb({ host: cfg.web.host, port: cfg.web.port, store, registry, log, cfg, hub: api, ext });
      ports.web = web.address().port;
      closers.push(() => new Promise(r => web.close(r)));
    }
    log.write('info', { event: 'started', detail: `remote=${ports.remote ?? '-'} web=${ports.web ?? '-'}${ext.list.length ? ` 拡張=${ext.list.map(e => e.name).join(',')}` : ''}` });
    return ports;
  }

  async function stop() {
    for (const h of hosts) h.socket.destroy();
    for (const c of closers.splice(0).reverse()) await c();
  }

  const api = { start, stop, store, registry, log, ports, cfg, ext, exportCheck, exportJob, sendTo, purge, recordsFor };
  return api;
}

module.exports = { createHub };
