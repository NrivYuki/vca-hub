'use strict';
// 設定(設計書 12 章の主な決まりを既定値にする)。config.json があれば上書きする。

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  dataDir: path.join(ROOT, 'data'),
  web: { enabled: true, host: '127.0.0.1', port: 8765 },        // 管理画面はこの PC からのみ
  remote: { enabled: true, port: 33512 },                        // リモート接続の待ち受け(すべての通信口。相手は allow で限る)
  local: [],                                                     // ローカル接続: [{ name, host, port }]
  allow: ['127.0.0.1/32', '::1/128'],                             // 接続を受ける相手。既定はこの PC だけ(機器のアドレスを書き足して使う)
  autoconnect: { enabled: false, port: 33511 },                  // オートコネクト(機器が UDP で知らせてくる)
  destinations: [],                                              // 別の PC やソフト:[{ name, host, port, type: 'UPL' | 'TRC', protocol }]
  listeners: [],                                                 // 追加の待ち受け:[{ name, port, protocol, settings }](protocol は 'vca' か拡張の通信方式)
  exportDir: null,                                               // 共有フォルダへの書き出し先
  importDir: null,                                               // 取り込むフォルダ(監視する)
  removePII: true,
  retentionDays: 90,                                             // 日。過ぎた受信データ(送信待ちを除く)・ログ・取り込んだ元のファイルを消す。null で無期限
  // 待ち受け(VCA)で同時に開いておける接続の数。機器はつないだままにしてよい(7.8.2.3)ので時間では切らず、数で限る
  connections: { total: 64, perAddress: 8 },
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

const configError = message => Object.assign(new Error(message), { code: 'config' });

function loadConfig(file = path.join(ROOT, 'config.json')) {
  let user = {};
  if (fs.existsSync(file)) {
    // メモ帳などが先頭に付ける BOM は除く。読めなければ、どのファイルかを添えて止める
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    try { user = JSON.parse(text); } catch (e) {
      const m = /position (\d+)/.exec(e.message);
      const at = m ? (() => { const before = text.slice(0, Number(m[1])).split(/\r?\n/); return `${before.length} 行目の ${before[before.length - 1].length + 1} 文字目あたり`; })() : '';
      throw configError(`${file} を読めません(JSON の書き方の誤り${at ? '。' + at : ''})。よくある誤り: 最後の項目のあとのカンマ、パスの \\ を 1 つで書いている(\\\\ と 2 つ重ねる)、引用符の閉じ忘れ`);
    }
    if (!user || typeof user !== 'object' || Array.isArray(user)) throw configError(`${file} は { } で囲んだ形で書いてください`);
  }
  // 知らない項目は書き損じとして止める(retentiondays のような大文字・小文字の誤りも、黙って既定のまま動かないように)
  const unknown = [];
  for (const [k, v] of Object.entries(user)) {
    if (!(k in DEFAULTS)) { unknown.push(k); continue; }
    const base = DEFAULTS[k];
    if (base && typeof base === 'object' && !Array.isArray(base) && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sub of Object.keys(v)) if (!(sub in base) && !['protocol', 'settings'].includes(sub)) unknown.push(`${k}.${sub}`);
    }
  }
  if (unknown.length) throw configError(`${file} に知らない項目があります(書き損じではありませんか): ${unknown.join('・')}`);
  const cfg = merge(DEFAULTS, user);
  // 相対のパスは、vca-hub のフォルダを基準にする(起動したときのフォルダによらず、同じ場所を指すように)
  for (const k of ['dataDir', 'extensionsDir', 'exportDir', 'importDir']) {
    if (typeof cfg[k] === 'string' && !path.isAbsolute(cfg[k])) cfg[k] = path.resolve(ROOT, cfg[k]);
  }
  // config.json から読んだ設定は、規格の範囲(時間切れ 2-255 秒)も確かめる。コードから作る設定(確かめの道具)は速く動かすために短くできる
  checkConfig(cfg, file, { strict: true });
  return cfg;
}

/**
 * 設定の形と値の範囲を確かめる。誤りがあれば、項目の名前を添えて止める
 * (書き損じを黙って別の意味に取ると、待ち受けない・個人情報を消さない、などが気付かれないまま続くため)
 */
function checkConfig(cfg, file = 'config.json', { strict = false } = {}) {
  const errs = [];
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const port = (v, where, { zero = true } = {}) => {
    if (!Number.isInteger(v) || v < (zero ? 0 : 1) || v > 65535) errs.push(`${where} は ${zero ? 0 : 1}-65535 の整数で書いてください(${JSON.stringify(v)})`);
  };
  for (const k of ['web', 'remote', 'autoconnect']) {
    if (!isObj(cfg[k])) { errs.push(`${k} は { "enabled": true, "port": ... } の形で書いてください(${JSON.stringify(cfg[k])})`); continue; }
    if (typeof cfg[k].enabled !== 'boolean') errs.push(`${k}.enabled は true か false で書いてください(${JSON.stringify(cfg[k].enabled)})`);
    port(cfg[k].port, `${k}.port`);
  }
  if (isObj(cfg.web) && typeof cfg.web.host !== 'string') errs.push('web.host は文字列で書いてください');
  for (const k of ['local', 'listeners', 'destinations', 'allow']) if (!Array.isArray(cfg[k])) errs.push(`${k} は [ ] で囲んだ一覧で書いてください`);
  (Array.isArray(cfg.local) ? cfg.local : []).forEach((d, i) => {
    if (!isObj(d)) { errs.push(`local[${i}] は { } の形で書いてください`); return; }
    if (typeof d.name !== 'string' || !d.name) errs.push(`local[${i}].name を書いてください`);
    // つなぐ相手は IP アドレスで書く(許可範囲(allow)は IP で比べるため)
    if (!net.isIP(String(d.host || ''))) errs.push(`local[${i}].host は IP アドレスで書いてください(${JSON.stringify(d.host)})`);
    port(d.port, `local[${i}].port`, { zero: false });
  });
  (Array.isArray(cfg.destinations) ? cfg.destinations : []).forEach((d, i) => {
    if (!isObj(d)) { errs.push(`destinations[${i}] は { } の形で書いてください`); return; }
    if (typeof d.name !== 'string' || !d.name) errs.push(`destinations[${i}].name を書いてください`);
    if (typeof d.host !== 'string' || !d.host) errs.push(`destinations[${i}].host を書いてください`);
    port(d.port, `destinations[${i}].port`, { zero: false });
    if (d.type !== undefined && !['UPL', 'TRC'].includes(String(d.type).toUpperCase())) errs.push(`destinations[${i}].type は "UPL" か "TRC" で書いてください(${JSON.stringify(d.type)})`);
  });
  (Array.isArray(cfg.listeners) ? cfg.listeners : []).forEach((d, i) => {
    if (!isObj(d)) { errs.push(`listeners[${i}] は { } の形で書いてください`); return; }
    if (typeof d.name !== 'string' || !d.name) errs.push(`listeners[${i}].name を書いてください`);
    port(d.port, `listeners[${i}].port`);
  });
  // 保存期間: null(無期限)か正の数。0・負の数・文字列を無期限と同じに扱うと、消すはずの個人情報が残り続けるため
  if (cfg.retentionDays !== null && !(typeof cfg.retentionDays === 'number' && cfg.retentionDays > 0)) {
    errs.push(`retentionDays は正の数(日)か null(無期限)で書いてください(${JSON.stringify(cfg.retentionDays)})`);
  }
  if (!isObj(cfg.connections) || !['total', 'perAddress'].every(k => Number.isInteger(cfg.connections[k]) && cfg.connections[k] >= 0)) {
    errs.push('connections は { "total": 整数, "perAddress": 整数 } で書いてください(0 は上限なし)');
  }
  // 規格の時間切れの範囲は 2-255 秒(6.1.3.5)。vca-hub は TIMEOUT を機器へ送らないので、範囲の外にすると機器と食い違う
  if (!isObj(cfg.timeouts) || !['ack', 'packet', 'char'].every(k => typeof cfg.timeouts[k] === 'number' && (strict ? cfg.timeouts[k] >= 2 && cfg.timeouts[k] <= 255 : cfg.timeouts[k] > 0))) {
    errs.push('timeouts は { "ack": 秒, "packet": 秒, "char": 秒 } で、2-255 の数で書いてください(6.1.3.5)');
  }
  if (!isObj(cfg.extensions)) errs.push('extensions は { "名前": true } の形で書いてください(一覧 [ ] ではありません)');
  for (const k of ['exportDir', 'importDir']) if (cfg[k] !== null && typeof cfg[k] !== 'string') errs.push(`${k} はフォルダのパス(文字列)か null で書いてください`);
  // パスに制御文字があれば、\ を 1 つで書いて \n・\t などと読まれたもの(C:\new が改行になる)
  for (const k of ['dataDir', 'extensionsDir', 'exportDir', 'importDir']) {
    if (typeof cfg[k] === 'string' && /[\x00-\x1f]/.test(cfg[k])) errs.push(`${k} のパスに制御文字があります。config.json の中では \\ を 2 つ重ねて書いてください(例: "C:\\\\vca\\\\out")`);
  }
  // 許可範囲の形も、ほかの誤りと一緒に出す
  try { require('./net/tcp.js').allowList(cfg.allow); } catch (e) { errs.push(`allow: ${e.message}`); }
  if (typeof cfg.removePII !== 'boolean') errs.push('removePII は true か false で書いてください');
  if (errs.length) throw configError(`${file} の設定に誤りがあります:\n  ${errs.join('\n  ')}`);
  return cfg;
}

module.exports = { loadConfig, merge, checkConfig, DEFAULTS, ROOT };
