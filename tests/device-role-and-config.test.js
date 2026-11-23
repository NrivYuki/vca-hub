'use strict';
// vca-hub が機器としてアップロードするとき(送り先)の、ホストの誤った応答の扱い、拡張の約束、設定と起動・停止。
// 期待値の根拠: 7.2.4.4・7.2.5.4(要求 ID はホストのデータのパケットで返す)、表 A.2(DEF の要求 ID は整数)、
// A.4(STATUS は応答のパケットに必ず入る。0 以外はセッションを中止させる。説明文は機器が出す)、7.3.1(最後の応答)、7.2.8(ホストは申し出の 1 つを返す)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const cp = require('node:child_process');
const VCA = require('../src/lib/vca-parser.js');
const { uploadTo } = require('../src/device/upload.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-dev-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const CRLF = '\r\n';
const FAST = { ack: 1, packet: 2, char: 1 };
const FS = '\x1c', GS = '\x1d', ACK = '\x06';
const radii = Array.from({ length: 36 }, () => '2500');
const BODY = ['DO=R', 'JOB=N1', 'DBL=18', 'TRCFMT=1;36;E;R;F', ...[0, 1, 2].map(i => 'R=' + radii.slice(i * 12, i * 12 + 12).join(';'))].join(CRLF) + CRLF;

/**
 * 台本どおりに答えるホスト。script[i] は i 番目に届いたパケットへの応答のレコード。
 * 'close' なら ACK の後に閉じる、'drip' なら応答を 1 文字ずつ間をあけて送る
 */
async function fakeHost(script) {
  const seen = [];
  const srv = net.createServer(sock => {
    let buf = null, i = 0;
    sock.on('error', () => {});
    sock.on('data', d => {
      for (const c of d.toString('latin1')) {
        if (c === FS) buf = c;
        else if (buf !== null) {
          buf += c;
          if (c !== GS) continue;
          const raw = buf; buf = null;
          seen.push(VCA.parsePacket(raw).records.map(r => r.label).join(','));
          sock.write(ACK);
          const step = script[i++];
          if (step === 'close') { setTimeout(() => sock.destroy(), 30); continue; }
          if (step === 'drip') {
            const text = VCA.buildPacket([['ANS', 'UPL'], ['JOB', 'N1'], ['STATUS', '0']]);
            let k = 0;
            const t = setInterval(() => { if (sock.destroyed || k >= text.length - 1) { clearInterval(t); return; } sock.write(text[k++]); }, 300);
            continue;
          }
          if (step) setTimeout(() => sock.write(Buffer.from(VCA.buildPacket(step), 'latin1')), 20);
        }
      }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, close: () => new Promise(r => srv.close(r)) };
}
const up = (h, extra = {}) => uploadTo({ host: '127.0.0.1', port: h.port }, { body: BODY, name: 'N1', timeouts: FAST, connectDelay: 0, ...extra });
const INIT = [[['ANS', 'UPL'], ['JOB', 'N1'], ['STATUS', '5']], [['ANS', 'INI'], ['STATUS', '14']]];

// ---- 送り先の誤った応答 ----
test('初期化で要求 ID が返らなければ、データを送らずに失敗にする(STATUS=0 でも送信済みにしない)', async () => {
  const h = await fakeHost([...INIT, [['ANS', 'INI'], ['STATUS', '0']]]);
  try {
    await assert.rejects(up(h), e => e.code === 'no-request-id');
    assert.equal(h.seen.filter(s => s.startsWith('ANS')).length, 1, '送ったデータのパケットは初期化のものだけ');
  } finally { await h.close(); }
});

test('初期化のデータの応答が 0 以外なら、DEF があっても送らず、ホストの説明文をそのまま返す', async () => {
  const h = await fakeHost([...INIT, [['ANS', 'INI'], ['STATUS', '529', '400 ?'], ['DEF', '', '77']]]);
  try {
    const r = await up(h);
    assert.equal(r.status, 529);
    assert.equal(r.statusText, '400 ?');
    assert.ok(!h.seen.some(s => s.startsWith('REQ') && h.seen.indexOf(s) > 1), '要求 77 を送らない');
  } finally { await h.close(); }
});

test('データのパケットに ACK を受けた後で切れたら、届いたか分からないとして分ける', async () => {
  const h = await fakeHost([[['ANS', 'UPL'], ['JOB', 'N1'], ['STATUS', '0']], 'close']);
  try { await assert.rejects(up(h), e => e.code === 'unconfirmed'); } finally { await h.close(); }
});

test('最後の応答に STATUS が無ければ、届いたか分からないとして分ける(A.4)', async () => {
  const h = await fakeHost([[['ANS', 'UPL'], ['JOB', 'N1'], ['STATUS', '0']], [['ANS', 'UPL'], ['JOB', 'N1']]]);
  try { await assert.rejects(up(h), e => e.code === 'unconfirmed'); } finally { await h.close(); }
});

test('応答を少しずつ送ってくる相手でも、セッション全体の期限で終わらせる', async () => {
  const h = await fakeHost(['drip']);
  try {
    const t0 = Date.now();
    await assert.rejects(up(h, { deadlineMs: 1500 }), e => e.code === 'timeout');
    assert.ok(Date.now() - t0 < 5000);
  } finally { await h.close(); }
});

test('ホストが申し出と違う玉型の形式を返したら、知らせる(7.2.8)', async () => {
  const h = await fakeHost([[['ANS', 'UPL'], ['JOB', 'N1'], ['STATUS', '0'], ['TRCFMT', '2', '36', 'E', 'R']], [['ANS', 'UPL'], ['JOB', 'N1'], ['STATUS', '0']]]);
  try {
    const r = await up(h);
    assert.equal(r.status, 0);
    assert.ok(r.warnings.some(w => /申し出と違う/.test(w)));
  } finally { await h.close(); }
});

test('送り先に届いたか分からないときは、送信済みにせず、画面に分けて知らせる', async () => {
  const dir = tmp();
  const h = await fakeHost([[['ANS', 'UPL'], ['JOB', 'N1'], ['STATUS', '0']], 'close']);
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, connectDelay: 0, timeouts: FAST,
    destinations: [{ name: 'D', host: '127.0.0.1', port: h.port }],
  }));
  await hub.start();
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'N1', peer: 'p', crcOk: null });
    await assert.rejects(hub.sendTo(e.id, 'N1', 'D'), err => err.code === 'upload-unconfirmed');
    assert.equal(hub.store.get(e.id).sent.length, 0);
    assert.ok(hub.log.list().some(l => l.event === 'upload-unconfirmed'));
  } finally { await hub.stop(); await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 拡張の約束 ----
function extHub(dir, code, over = {}, opts = {}) {
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'x'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'x', 'index.js'), code);
  return createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, connectDelay: 0,
    extensionsDir: extDir, extensions: { x: true }, ...over,
  }), opts);
}
const GRAB = `let io = null;
module.exports = { io: () => io, setup(hub) { hub.protocol('g', { listen(o, x) { io = x; return { port: 0, close() {} }; } }); } };`;

test('拡張の io.records が送り出せない理由を見つけたら、押さえも放す(人が消す・送信待ちに戻すことができる)', async () => {
  const dir = tmp();
  const hub = extHub(dir, GRAB, { listeners: [{ name: 'L', port: 0, protocol: 'g' }] });
  await hub.start();
  try {
    const io = require(path.join(dir, 'ext', 'x', 'index.js')).io();
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    hub.store.queue(e.id, 'N');
    const got = io.reserve('N', {});
    hub.store.checkOf = () => ({ blockers: ['後からできた理由'], notices: [] });
    assert.throws(() => io.records(got.entry), err => err.code === 'blocked');
    assert.equal(hub.store.get(e.id).status, 'received');
    assert.equal(hub.store.sending.has(e.id), false, '押さえを放す');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の io.markSent は、ほかの相手が押さえているものと、名前の変わったものを送信済みにしない', async () => {
  const dir = tmp();
  const hub = extHub(dir, GRAB, { listeners: [{ name: 'L', port: 0, protocol: 'g' }] });
  await hub.start();
  try {
    const io = require(path.join(dir, 'ext', 'x', 'index.js')).io();
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    hub.store.queue(e.id, 'N');
    const other = {};
    hub.store.reserve('N', other);   // VCA の加工機が押さえている
    assert.throws(() => io.markSent(e.id, 'dev'), err => err.code === 'sending');
    hub.store.release(e.id, other);
    assert.throws(() => io.markSent(e.id, 'dev', { name: 'OLD' }), err => err.code === 'not-queued');
    const mine = {};
    io.reserve('N', mine);
    io.markSent(e.id, 'dev', { name: 'N' });
    assert.equal(hub.store.get(e.id).status, 'sent');
    assert.equal(hub.store.sending.has(e.id), false);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の send が改行を含む値やセッションの見出し(STATUS など)を返したら、送らない', () => {
  for (const [label, value] of [['ETYP', '1\r\nSTATUS=0'], ['STATUS', '0'], ['BAD LABEL', '1']]) {
    const dir = tmp();
    const hub = extHub(dir, `module.exports = { setup(h) { h.on('send', ({ records }) => records.concat([[${JSON.stringify(label)}, ${JSON.stringify(value)}]])); } };`);
    try {
      const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
      assert.throws(() => hub.recordsFor(e, { kind: 'file' }), err => err.code === 'ext-send', label);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('拡張に渡す時間切れの設定と設定は写しで、拡張が書き換えても vca-hub の設定は変わらない', async () => {
  const dir = tmp();
  const hub = extHub(dir, `let io = null, s = null;
module.exports = { io: () => io, s: () => s, setup(hub) { s = hub.settings; hub.protocol('g', { listen(o, x) { io = x; return { port: 0, close() {} }; } }); } };`,
  { listeners: [{ name: 'L', port: 0, protocol: 'g' }], extensions: { x: { a: 1 } } });
  await hub.start();
  try {
    const m = require(path.join(dir, 'ext', 'x', 'index.js'));
    m.io().timeouts.packet = 999;
    m.s().a = 2;
    assert.notEqual(hub.cfg.timeouts.packet, 999);
    assert.equal(hub.cfg.extensions.x.a, 1);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の upload が終わらなければ時間切れにし、届いたか分からないとして、もう一度送れるようにする', async () => {
  const dir = tmp();
  const hub = extHub(dir, `module.exports = { setup(hub) { hub.protocol('g', { upload() { return new Promise(() => {}); } }); } };`,
    { destinations: [{ name: 'D', host: '127.0.0.1', port: 1, protocol: 'g' }] }, { extUploadMs: 300 });
  await hub.start();
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    await assert.rejects(hub.sendTo(e.id, 'A', 'D'), err => err.code === 'upload-unconfirmed');
    await assert.rejects(hub.sendTo(e.id, 'A', 'D'), err => err.code === 'upload-unconfirmed', '送っている途中の印が外れている');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の listen が終わらなければ、起動を止める', async () => {
  const dir = tmp();
  const hub = extHub(dir, `module.exports = { setup(hub) { hub.protocol('g', { listen() { return new Promise(() => {}); } }); } };`,
    { listeners: [{ name: 'L', port: 0, protocol: 'g' }] }, { extListenMs: 300 });
  try { await assert.rejects(hub.start(), err => err.code === 'ext-listen'); } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の connect が Promise を返しても、止めるときに止める関数を呼ぶ', async () => {
  const dir = tmp();
  const hub = extHub(dir, `let stopped = false;
module.exports = { stopped: () => stopped, setup(hub) { hub.protocol('g', { connect() { return Promise.resolve(() => { stopped = true; }); } }); } };`,
  { local: [{ name: 'E', host: '127.0.0.1', port: 9, protocol: 'g' }] });
  await hub.start();
  await wait(20);
  await hub.stop();
  try { assert.equal(require(path.join(dir, 'ext', 'x', 'index.js')).stopped(), true); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の画面の API が JSON にできない値を返しても、応答を返す', async () => {
  const dir = tmp();
  const hub = extHub(dir, `module.exports = { setup(hub) { hub.route('GET', 'big', () => ({ n: 1n })); } };`, { web: { enabled: true, host: '127.0.0.1', port: 0 } });
  const ports = await hub.start();
  try {
    // 応答が返らなければ 3 秒で失敗にする
    const status = await new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('応答が返らない')), 3000).unref();
      http.get({ host: '127.0.0.1', port: ports.web, path: '/api/ext/x/big', headers: { Host: `localhost:${ports.web}` } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.ok(status >= 400 && status < 600);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 設定 ----
function cfgFile(dir, text) {
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, text);
  return f;
}
test('設定の書き損じは、項目の名前を出して起動しない(黙って別の意味に取らない)', () => {
  const dir = tmp();
  try {
    const bad = (obj, re) => assert.throws(() => loadConfig(cfgFile(dir, JSON.stringify(obj))), e => e.code === 'config' && re.test(e.message), JSON.stringify(obj));
    bad({ remote: true }, /remote は/);
    bad({ web: { enabled: 'false' } }, /web\.enabled/);
    bad({ remote: { port: null } }, /remote\.port/);
    bad({ retentionDays: 0 }, /retentionDays/);
    bad({ retentionDays: '90日' }, /retentionDays/);
    bad({ extensions: ['processing-conditions'] }, /extensions は/);
    bad({ local: [{ name: 'E', host: 'localhost', port: 50000 }] }, /local\[0\]\.host/);
    bad({ local: [{ name: 'E', host: '127.0.0.1', port: 'x' }] }, /local\[0\]\.port/);
    assert.equal(loadConfig(cfgFile(dir, JSON.stringify({ retentionDays: null }))).retentionDays, null, 'null は無期限');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config.json の JSON の誤りはファイルの名前を出し、先頭の BOM は読み飛ばす', () => {
  const dir = tmp();
  try {
    assert.throws(() => loadConfig(cfgFile(dir, '{ "remote": { "port": 1 }, }')), e => e.code === 'config' && e.message.includes('config.json'));
    assert.equal(loadConfig(cfgFile(dir, '﻿{ "retentionDays": 30 }')).retentionDays, 30);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('相対のフォルダは、起動したフォルダによらず vca-hub のフォルダを基準にする', () => {
  const dir = tmp();
  try {
    const cfg = loadConfig(cfgFile(dir, JSON.stringify({ exportDir: 'out', importDir: 'in' })));
    const root = path.resolve(__dirname, '..');
    assert.equal(cfg.exportDir, path.join(root, 'out'));
    assert.equal(cfg.importDir, path.join(root, 'in'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 起動と停止 ----
test('別の vca-hub が同じデータのフォルダを使っていれば、索引に触れる前に起動を断る', async () => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  // 別のプロセスがロックを持っている
  const child = cp.spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(data, 'vca-hub.lock'))}, String(process.pid)); console.log('ok'); setInterval(() => {}, 1000);`]);
  await new Promise(r => child.stdout.once('data', r));
  try {
    const cfg = merge(loadConfig(path.join(dir, 'none.json')), { dataDir: data, web: { enabled: false }, remote: { enabled: false } });
    assert.throws(() => createHub(cfg), e => e.code === 'data-in-use');
    assert.equal(fs.existsSync(path.join(data, 'index.json')), false, '索引を書かない');
    child.kill();
    await new Promise(r => child.once('exit', r));
    const hub = createHub(cfg);   // 前のプロセスが無ければ引き継ぐ
    await hub.stop();
    assert.equal(fs.existsSync(path.join(data, 'vca-hub.lock')), false, '止めたらロックを外す');
  } finally { if (child.exitCode === null) child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ローカル接続でつなげない理由を記録に残す', async () => {
  const dir = tmp();
  const closed = net.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise(r => closed.close(r));
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, local: [{ name: 'E', host: '127.0.0.1', port }],
  }));
  await hub.start();
  try {
    await wait(500);
    assert.ok(hub.log.list().some(l => l.event === 'local-connect' && /ECONNREFUSED/.test(l.detail)));
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('本文を送り切らない管理画面の要求があっても、止める処理は終わる', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: false } }));
  const ports = await hub.start();
  const req = http.request({ host: '127.0.0.1', port: ports.web, method: 'POST', path: '/api/jobs/x/queue', headers: { Host: `localhost:${ports.web}`, 'X-VCA-Hub': '1', 'Content-Type': 'application/json', 'Content-Length': '100' } });
  req.on('error', () => {});
  req.write('{');
  await wait(100);
  try {
    const t0 = Date.now();
    await Promise.race([hub.stop(), wait(3000).then(() => { throw new Error('止まらない'); })]);
    assert.ok(Date.now() - t0 < 3000);
  } finally { req.destroy(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('取り込むフォルダを初めて使う起動で、取り込み途中の印について誤った警告を出さない', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, importDir: path.join(dir, 'in') }));
  await hub.start();
  try {
    assert.ok(!hub.log.list().some(l => /取り込み途中のファイルの印を読めません/.test(l.detail || '')));
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
