'use strict';
// LAN の接続(設計書 4 章)のうち、vca-hub が決めること: 接続できる相手を、許可した IP アドレスの範囲に限る。
// 待ち受けと接続そのものは vca-guide の vca-tcp.js が行う。

const net = require('node:net');

/**
 * 許可する範囲の一覧("192.168.0.0/16"、"fd00::/8"、"10.1.2.3" など)を net.BlockList にする。
 * 形の正しくない項目があれば code='bad-config' で投げる(起動しない)。
 * 範囲の長さを書き損じた項目("10.0.0.0/"・"10.0.0.0/33")を黙って広い範囲として扱うと、意図しない相手を通すため。
 */
function allowList(allow) {
  if (!Array.isArray(allow)) throw Object.assign(new Error('allow は IP アドレスの範囲の一覧で書きます'), { code: 'bad-config' });
  const list = new net.BlockList();
  for (const c of allow) {
    const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(String(c));
    const kind = m ? net.isIP(m[1]) : 0;
    const max = kind === 6 ? 128 : 32;
    const bits = m && m[2] !== undefined ? Number(m[2]) : max;
    if (!kind || bits > max) {
      throw Object.assign(new Error(`allow の ${JSON.stringify(c)} は、IP アドレスか範囲(例: 192.168.0.0/16)の形ではありません`), { code: 'bad-config' });
    }
    list.addSubnet(m[1], bits, kind === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

const lists = new WeakMap();   // 設定の配列 → BlockList

/** IP アドレスが許可した範囲にあるか(IPv4 を IPv6 の形で書いたもの、::ffff:192.168.1.20 は IPv4 として見る) */
function isAllowed(ip, allow) {
  let list = lists.get(allow);
  if (!list) { list = allowList(allow); lists.set(allow, list); }
  const a = normalizeIp(ip);
  const kind = net.isIP(a);
  return kind ? list.check(a, kind === 6 ? 'ipv6' : 'ipv4') : false;
}

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
}

/** 記録に書く相手の名前(IP:ポート)。 */
function peerOf(socket) {
  return `${normalizeIp(socket.remoteAddress)}:${socket.remotePort}`;
}

module.exports = { isAllowed, allowList, normalizeIp, peerOf };
