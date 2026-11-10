'use strict';
// 設定(設計書 12 章の主な決まりを既定値にする)。config.json があれば上書きする。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  dataDir: path.join(ROOT, 'data'),
  web: { enabled: true, host: '127.0.0.1', port: 8765 },        // 管理画面はこの PC からのみ
  remote: { enabled: true, port: 33512 },                        // リモート接続の待ち受け(すべての通信口。相手は allow で限る)
  local: [],                                                     // ローカル接続: [{ name, host, port }]
  allow: ['127.0.0.1/32', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  autoconnect: { enabled: false, port: 33511 },                  // オートコネクト(機器が UDP で知らせてくる)
  destinations: [],                                              // 別の PC やソフト:[{ name, host, port, type: 'UPL' | 'TRC', protocol }]
  listeners: [],                                                 // 追加の待ち受け:[{ name, port, protocol, settings }](protocol は 'vca' か拡張の通信方式)
  exportDir: null,                                               // 共有フォルダへの書き出し先
  importDir: null,                                               // 取り込むフォルダ(監視する)
  removePII: true,
  retentionDays: null,                                           // null: 無期限(手動削除のみ)
  timeouts: { ack: 6, packet: 12, char: 5 },                     // 秒(DCS 6.1.3。確認応答・パケット・文字間)
  extensions: {},                                                // 使う拡張:{ 名前: 設定 | true }(設計書 13 章)
  extensionsDir: path.join(ROOT, 'extensions'),                  // 拡張を置くフォルダ
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v) : v;
  }
  return out;
}

function loadConfig(file = path.join(ROOT, 'config.json')) {
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = merge(DEFAULTS, user);
  if (!path.isAbsolute(cfg.dataDir)) cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  if (!path.isAbsolute(cfg.extensionsDir)) cfg.extensionsDir = path.resolve(ROOT, cfg.extensionsDir);
  return cfg;
}

module.exports = { loadConfig, merge, DEFAULTS, ROOT };
