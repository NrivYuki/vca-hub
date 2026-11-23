'use strict';
// Windows での運用(共有フォルダが止まっているとき、ドライブの直下、装置の名前、UNC からの起動)と、件数が多いときの重さ。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');
const { watchFolder, folderOverlap, reachable, DONE_DIR } = require('../src/send/folder.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-win-'));
const CRLF = '\r\n';
const BODY = 'DO=R' + CRLF + 'JOB=A' + CRLF + 'DBL=18' + CRLF;
const windows = process.platform === 'win32';

test('届かない共有フォルダを取り込むフォルダにしても、起動と中継を止めない(届くかは止めずに確かめる)', { skip: !windows && 'UNC のパスは Windows だけ' }, async () => {
  const dir = tmp();
  const unc = '\\\\nohost-vcahub-test.invalid\\share\\in';
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, importDir: unc }));
  try {
    const t0 = Date.now();
    await hub.start();
    assert.ok(Date.now() - t0 < 1000, `起動は待たない(${Date.now() - t0} ms)`);
    // 確かめている間も、イベントループが止まらない
    let maxGap = 0, last = Date.now();
    const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 20);
    await new Promise(r => setTimeout(r, 3000));
    clearInterval(iv);
    assert.ok(maxGap < 1000, `止まった時間 ${maxGap} ms`);
    assert.ok(hub.log.list().some(l => /共有フォルダに届きません/.test(l.detail || '')), '届かないことを記録に残す');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ネットワークのパスでなければ、届くかは確かめない(すぐに true)', async () => {
  assert.equal(await reachable(os.tmpdir()), true);
});

test('ドライブの直下を取り込むフォルダと書き出し先の判定に使える(区切りで終わるパス)', { skip: !windows && 'Windows のドライブのパス' }, () => {
  assert.match(String(folderOverlap('Z:\\out', 'Z:\\')), /片方が、もう片方の中/);
  assert.equal(folderOverlap('Z:\\out', 'Y:\\'), null);
});

test('Windows が装置として扱う名前は、書き出しの名前にできず、受信のファイル名では前に _ を付ける', () => {
  for (const n of ['CON .A', 'NUL.X', 'AUX', 'COM1', 'LPT9.TXT']) assert.throws(() => Store.checkName(n), e => e.code === 'bad-name', n);
  for (const n of ['CONX', 'A.CON', 'W1']) assert.equal(Store.checkName(n), n);
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: BODY, type: 'TRC', job: 'NUL.', peer: 'p', crcOk: null });
    assert.ok(path.basename(e.file).startsWith('_NUL'), e.file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('start.bat は、UNC のパスから開いても動く書き方(pushd と、vca-hub のフォルダからの main.js)', () => {
  const bat = fs.readFileSync(path.join(__dirname, '..', 'start.bat'), 'latin1');
  assert.ok(/^pushd "%~dp0"/m.test(bat));
  assert.ok(bat.includes('"%~dp0src\\main.js"'));
  assert.ok(!/^cd \/d/m.test(bat));
});

test('コンソールへ記録を出さない(窓をクリックして選択の状態になると、出力が止まり中継も止まるため)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(main.includes('echoLog: false'));
});

// ---- 件数が多いとき ----
test('取り込み済みに同じ名前のファイルが多くあっても、空いている名前をすぐに決める', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    const done = path.join(watch, DONE_DIR);
    fs.mkdirSync(done, { recursive: true });
    fs.writeFileSync(path.join(done, 'OUT.vca'), '');
    for (let i = 2; i <= 3000; i++) fs.writeFileSync(path.join(done, `OUT_${i}.vca`), '');
    fs.writeFileSync(path.join(watch, 'OUT.vca'), BODY);
    const store = new Store({ dir: path.join(dir, 'data') });
    const t0 = Date.now();
    watchFolder({ dir: watch, store, log: new Log({ dir: path.join(dir, 'log') }), settleMs: 0, intervalMs: 3600000 }).stop();
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
    assert.ok(fs.existsSync(path.join(done, 'OUT_3001.vca')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('管理画面の一覧: 変わっていなければ中身を送らず(304)、拡張の検査は状態・名前・拡張の情報が変わったものだけ行い、送信済みには行わない', async () => {
  const dir = tmp();
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'c'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'c', 'index.js'), "let n = 0;\nmodule.exports = { n: () => n, setup(h) { h.on('check', () => { n++; return {}; }); h.route('POST', 'set', ({ body }) => { h.data.set(body.id, { x: 1 }); }); } };");
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: false }, extensionsDir: extDir, extensions: { c: true },
  }));
  const ports = await hub.start();
  const get = etag => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: ports.web, path: '/api/jobs', headers: { Host: `localhost:${ports.web}`, ...(etag ? { 'If-None-Match': etag } : {}) } }, res => {
      let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve({ code: res.statusCode, etag: res.headers.etag, body: s }));
    }).on('error', reject);
  });
  try {
    const ext = require(path.join(extDir, 'c', 'index.js'));
    const a = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = hub.store.saveReceived({ body: BODY.replace('JOB=A', 'JOB=B'), type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    hub.store.queue(b.id, 'B1'); hub.store.markSent(b.id, 'edger');
    hub.store.saveReceived({ body: BODY.replace('JOB=A', 'JOB=C'), type: 'TRC', job: 'C', peer: 'p', crcOk: null });
    const before = ext.n();
    const r1 = await get();
    assert.equal(r1.code, 200);
    const afterFirst = ext.n();
    assert.equal(afterFirst - before, 2, '送信済みには検査しない(未送信の 2 件だけ)');
    const r2 = await get(r1.etag);
    assert.equal(r2.code, 304, '変わっていなければ中身を送らない');
    hub.ext.touched(a.id);   // 拡張の情報が変わった
    const r3 = await get(r2.etag || r1.etag);
    assert.equal(r3.code, 200);
    assert.equal(ext.n() - afterFirst, 1, '拡張の情報が変わったものだけ検査し直す');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('毎時の掃除: 拡張の情報のファイルが多くても、索引をファイルごとに探さない', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, retentionDays: 30 }));
  try {
    for (let i = 0; i < 3000; i++) hub.store.index.push({ id: `20200101-000000-${String(i).padStart(5, 'a')}`, file: 'x', receivedAt: new Date().toISOString(), status: 'received', sent: [] });
    const extData = path.join(dir, 'data', 'ext', 'x');
    fs.mkdirSync(extData, { recursive: true });
    for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(extData, `20200101-000000-${String(i).padStart(5, 'a')}.json`), '{}');
    let gets = 0;
    const get = hub.store.get.bind(hub.store);
    hub.store.get = id => { gets++; return get(id); };
    hub.purge();
    assert.ok(gets < 100, `索引を探した回数 ${gets}`);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
