'use strict';
// 現場で読める知らせ、同時に起きる操作、受け取った値の重さと形。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const VCA = require('../src/lib/vca-parser.js');
const { hostOptions } = require('../src/host/session.js');
const { checkBody } = require('../src/send/check.js');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');
const { watchFolder, DONE_DIR } = require('../src/send/folder.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-op13-'));
const CRLF = '\r\n';
const BODY = 'DO=R' + CRLF + 'JOB=A' + CRLF + 'DBL=18' + CRLF;
const parse = lines => VCA.parse(lines.join(CRLF) + CRLF);

test('加工機がジョブを受け取れなかったとき、記録に理由と確かめることを書く(STATUS=1)', () => {
  const lines = [];
  const o = hostOptions({ store: { reserve: () => null }, registry: { get: () => null }, log: { write: (l, x) => lines.push(x) }, peer: 'p' });
  assert.deepEqual(o.onRequest(parse(['REQ=EDG', 'JOB=NOPE', 'DEV=EDG']), { type: 'EDG', job: 'NOPE', kind: 'download' }), { status: 1 });
  assert.ok(lines.some(l => /送信待ちのデータがありません/.test(l.detail)));
});

test('この加工機には渡せないとき(STATUS=4)、記録には値を含まない日本語の理由を書き、詳しい理由は画面のために覚える', () => {
  const lines = [], refused = new Map();
  const body = 'DO=B\r\nDRILLE=R;C;1;2;3\r\n';
  const store = { reserve: () => ({ entry: { id: 'x' } }), readBody: () => body, release() {}, checkOf: () => ({ blockers: [], notices: [] }), noteRefusal: (id, r) => refused.set(id, r) };
  const o = hostOptions({ store, registry: { get: () => null }, log: { write: (l, x) => lines.push(x) }, peer: 'p' });
  assert.equal(o.onRequest(parse(['REQ=EDG', 'JOB=J', 'DEV=EDG']), { type: 'EDG', job: 'J', kind: 'download' }).status, 4);
  const l = lines.find(x => x.result === 'STATUS=4');
  assert.ok(/穴あけの基準がこの加工機と合わない/.test(l.detail));
  assert.ok(!/R;C;1;2;3/.test(l.detail), '値は書かない');
  assert.ok(/DRILLE/.test(refused.get('x').message), '詳しい理由は覚える');
});

test('DRILL だけのジョブと、注記(REM)のあるジョブは、送る前の確認で知らせる', () => {
  assert.ok(checkBody('DO=B\r\nDRILL=B;1;2;3\r\n').notices.some(n => /DRILL だけ/.test(n)));
  assert.ok(checkBody('DO=B\r\nREM=RUSH\r\n').notices.some(n => /注記は送りません/.test(n)));
});

test('送り先へ送れない理由を、現場で読める言葉にする', async () => {
  const dir = tmp();
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, destinations: [{ name: 'D', host: '127.0.0.1', port }] }));
  await hub.start();
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    await assert.rejects(hub.sendTo(e.id, 'A1', 'D'), err => err.code === 'upload-failed' && /待ち受けていません/.test(err.message));
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config.json の JSON の誤りは行を出して直し方を添え、\\ を 1 つで書いて制御文字になったパスは止める', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, '{\n  "retentionDays": 30,\n}\n');
    assert.throws(() => loadConfig(f), e => e.code === 'config' && /行目/.test(e.message) && /カンマ/.test(e.message));
    fs.writeFileSync(f, JSON.stringify({ exportDir: 'C:\new\out' }));
    assert.throws(() => loadConfig(f), e => e.code === 'config' && /exportDir のパスに制御文字/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('送り先へ送っている途中のものは、消さない(保存期間の処理でも消さない)', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    store.hooks.busy = id => id === e.id;
    assert.throws(() => store.remove(e.id), err => err.code === 'uploading');
    assert.deepEqual(store.removeMany([e.id]), []);
    assert.ok(store.get(e.id));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('取り込み途中の印が抜けても、人が消した取り込みは生き返らせない(1 つ前の印より前に移したもの)', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    const data = path.join(dir, 'data');
    fs.mkdirSync(watch, { recursive: true });
    const store = new Store({ dir: data });
    const log = new Log({ dir: path.join(dir, 'log') });
    fs.writeFileSync(path.join(watch, 'A.vca'), BODY);
    watchFolder({ dir: watch, store, log, settleMs: 0, intervalMs: 3600000 }).stop();
    const [e] = store.list();
    store.remove(e.id);   // 人が消した
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(watch, DONE_DIR, 'A.vca'), old, old);
    fs.writeFileSync(path.join(data, 'import-pending.json'), '[壊れた');
    watchFolder({ dir: watch, store: new Store({ dir: data }), log, settleMs: 0, intervalMs: 3600000 }).stop();
    assert.equal(new Store({ dir: data }).list().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('古いロックを引き継いでいる途中の印があれば、2 つ目の vca-hub は起動しない(同時に 2 つ引き継がない)', async () => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  try {
    fs.writeFileSync(path.join(data, 'vca-hub.lock'), '999999');   // 動いていないプロセスの番号
    fs.writeFileSync(path.join(data, 'vca-hub.lock.takeover'), '999998');   // ほかの vca-hub が引き継いでいる途中
    const cfg = merge(loadConfig(path.join(dir, 'none.json')), { dataDir: data, web: { enabled: false }, remote: { enabled: false } });
    assert.throws(() => createHub(cfg), e => e.code === 'data-in-use');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(data, 'vca-hub.lock.takeover'), old, old);   // 引き継ぐ途中で止まった印
    const hub = createHub(cfg);
    await hub.stop();
    assert.equal(fs.existsSync(path.join(data, 'vca-hub.lock.takeover')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ENGMARK の行が多いデータでも、検査に時間がかからない(行の数に比例する)', () => {
  const body = 'DO=B\r\n' + 'ENGMARK=DCS;ZZZ\r\n'.repeat(60000);
  const t0 = Date.now();
  checkBody(body);
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

test('取り込むフォルダに多くのファイルがあっても、1 回の走査で取り込むのは 20 件まで(残りは続けて取り込む)', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    fs.mkdirSync(watch);
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(watch, `F${i}.vca`), BODY.replace('JOB=A', `JOB=F${i}`));
    const store = new Store({ dir: path.join(dir, 'data') });
    const w = watchFolder({ dir: watch, store, log: new Log({ dir: path.join(dir, 'log') }), settleMs: 0, intervalMs: 3600000 });
    assert.equal(store.list().length, 20);
    w.scan(); w.scan();
    w.stop();
    assert.equal(store.list().length, 50);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('バイナリの系列の行に、逃がしていない予約文字(GS・FS など)があれば止める。逃がしたものは止めない(5.1.7.3)', () => {
  assert.ok(checkBody('DO=B\r\nSHLFFMT=4;4;E;R\r\nS=\x1d\x1cREQ=XX\x1e\r\n').blockers.some(b => /逃がしていない予約文字/.test(b)));
  const bin = 'R=' + VCA.escapeBinary(VCA.encodeBinary(2, [2500, 2501, 2502]));
  assert.ok(!checkBody('DO=B\r\nTRCFMT=2;3;E;R;F\r\n' + bin + '\r\n').blockers.some(b => /逃がしていない/.test(b)));
});

test('拡張の io.markSent が送信済みを書けなかったら、送信済みとして押さえたままにする(ほかの相手に渡さない)', async () => {
  const dir = tmp();
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'g'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'g', 'index.js'), "let io = null;\nmodule.exports = { io: () => io, setup(hub) { hub.protocol('g', { listen(o, x) { io = x; return { port: 0, close() {} }; } }); } };");
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, extensionsDir: extDir, extensions: { g: true }, listeners: [{ name: 'L', port: 0, protocol: 'g' }] }));
  await hub.start();
  try {
    const io = require(path.join(extDir, 'g', 'index.js')).io();
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    hub.store.queue(e.id, 'N');
    const holder = {};
    io.reserve('N', holder);
    hub.store.markSent = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    assert.throws(() => io.markSent(e.id, 'dev'));
    io.releaseAll(holder);   // 拡張の接続が切れた
    assert.deepEqual(hub.store.reserve('N', {}), { busy: true }, '接続が切れても、ほかの相手には渡さない');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の情報の変更の番号は、一覧を空にしても前の番号に戻らない(覚えた検査の結果を古いまま使わない)', () => {
  const { Extensions } = require('../src/ext/extensions.js');
  const dir = tmp();
  try {
    const ext = new Extensions({ dir: path.join(dir, 'none'), enabled: {}, dataDir: dir, store: {}, log: { write() {} } });
    ext.touched('a');
    const first = ext.dataGen.get('a');
    ext.dataGen.clear();
    ext.touched('b');
    ext.touched('a');
    assert.notEqual(ext.dataGen.get('a'), first);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('穴あけで加工機に渡せないとき、渡せない理由に、利用者がすること(加工機の設定・穴の位置の入力)を添える', () => {
  const { buildDownload } = require('../src/send/build.js');
  const device = { dev: 'EDG', ven: 'V', model: 'M', sn: '' };
  const cases = [
    ['DO=R\r\nDRILLE=R;;1;1;2;2;;\r\n', { labels: [], trcfmt: null }],                       // 取り決めていない加工機に DRILLE
    ['DO=R\r\nDRILLE=R;E;1;1;2;2;;\r\n', { labels: [], trcfmt: null, drill: 'C' }],           // 基準が違う
    ['DO=R\r\nDRILL=R;1;1;2\r\n', { labels: [], trcfmt: null, drill: 'C' }],                  // DRILL だけ
  ];
  for (const [body, profile] of cases) {
    assert.throws(() => buildDownload({ body, profile, device, toDevice: true }),
      e => e.code === 'drill-reference' && /加工機で穴の位置を入れてください/.test(e.message), body);
  }
});

test('ローカル接続の相手が許可範囲の外なら、使わないときは local から消すことも知らせる', async () => {
  const dir = tmp();
  try {
    const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
      dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, allow: ['192.168.1.0/24'], local: [{ name: 'E1', host: '192.168.0.50', port: 50000 }],
    }));
    try { await assert.rejects(hub.start(), e => e.code === 'config' && /local から消して/.test(e.message)); } finally { await hub.stop(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
