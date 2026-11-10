'use strict';
// LAN の接続(設計書 4 章)のうち、vca-hub が決めること: 接続できる相手を、許可した IP アドレスの範囲に限る。
// 待ち受けと接続そのものは vca-guide の vca-tcp.js が行う。

const net = require('node:net');

/** "192.168.0.0/16" 形式の範囲に IPv4 アドレスが含まれるか。 */
function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  if (net.isIPv6(base)) return ip === base;               // IPv6 は完全一致のみ
  const toInt = a => a.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  if (!net.isIPv4(ip) || !net.isIPv4(base)) return false;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function isAllowed(ip, allow) {
  const a = normalizeIp(ip);
  return allow.some(c => inCidr(a, c.includes('/') ? c : `${c}/${net.isIPv6(c) ? 128 : 32}`));
}

/** 記録に書く相手の名前(IP:ポート)。 */
function peerOf(socket) {
  return `${normalizeIp(socket.remoteAddress)}:${socket.remotePort}`;
}

module.exports = { isAllowed, inCidr, normalizeIp, peerOf };
