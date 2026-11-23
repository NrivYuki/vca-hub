'use strict';
// 止まらないこと・壊れたときに戻せること: 消せないファイル、壊れた索引、拡張の失敗、断った接続の記録、書き出しの失敗。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { Store } = require('../src/store/store.js');
const { Registry } = require('../src/host/registry.js');
const { writeJsonAtomic } = require('../src/lib/atomic.js');
const { exportFile } = require('../src/send/folder.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-rob-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const DAY = 86400000;
const BODY = 'JOB=X\r\nDBL=18\r\n';
const windows = process.platform === 'win32';

/** ほかのソフトが、削除も書き込みも許さずにファイルを開いている状態を作る(Windows)。閉じる関数を返す */
async function lockFile(file) {
  const ps = cp.spawn('powershell', ['-NoProfile', '-Command',
    `$f=[System.IO.File]::Open('${file}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Close()`]);
  await new Promise((resolve, reject) => {
    ps.stdout.on('data', d => { if (String(d).includes('locked')) resolve(); });
    ps.once('exit', () => reject(new Error('ファイルを開けませんでした')));
  });
  return () => new Promise(r => { ps.once('exit', r); ps.stdin.end('\n'); });
}

// ---- 消せないファイル ----
test('ほかのソフトが開いていて消せないファイルがあっても、削除は例外にせず、あとで消し直す', { skip: !windows && 'Windows のファイルの共有の制限を使う' }, async () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const failed = [];
    store.hooks.deleteFailed = (f, e) => failed.push([f, e.code]);
    const e = store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const file = path.join(dir, e.file);
    const unlock = await lockFile(file);
    try {
      assert.deepEqual(store.purge(1, new Date(Date.now() + 3 * DAY)).map(x => x.id), [e.id]);
      assert.equal(store.get(e.id), null, '索引からは外す');
      assert.ok(fs.existsSync(file));
      assert.equal(store.pendingDelete.size, 1);
      assert.ok(failed.length >= 1);
      assert.deepEqual(store.retryDeletes(), [], 'まだ開いている間は消せない');
    } finally { await unlock(); }
    assert.deepEqual(store.retryDeletes(), [file]);
    assert.equal(fs.existsSync(file), false);
    assert.equal(store.pendingDelete.size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('保存期間の処理は、消せないファイルがあっても vca-hub を止めず、記録に残す', { skip: !windows && 'Windows のファイルの共有の制限を使う' }, async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: false }, retentionDays: 1 }));
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    hub.store.index.find(x => x.id === e.id).receivedAt = new Date(Date.now() - 3 * DAY).toISOString();
    const unlock = await lockFile(path.join(dir, e.file));
    try {
      assert.doesNotThrow(() => hub.purge());
      assert.ok(hub.log.list().some(l => l.event === 'delete-failed'));
    } finally { await unlock(); }
    hub.purge();
    assert.equal(fs.existsSync(path.join(dir, e.file)), false, '次の回に消し直す');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('索引に無いまま残ったファイルは、保存期間を過ぎたら消す。期間の中のものと、索引にあるものは残す', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const kept = store.saveReceived({ body: BODY, type: 'TRC', job: 'K', peer: 'p', crcOk: null });
    const day = path.join(dir, 'inbox', '2020-01-01');
    fs.mkdirSync(day, { recursive: true });
    for (const n of ['old.vca', 'old.json', 'new.vca', 'note.txt']) fs.writeFileSync(path.join(day, n), 'x');
    const old = new Date(Date.now() - 100 * DAY);
    for (const n of ['old.vca', 'old.json', 'note.txt']) fs.utimesSync(path.join(day, n), old, old);
    fs.utimesSync(path.join(dir, kept.file), old, old);
    assert.deepEqual(store.sweepOrphans(90).sort(), ['inbox/2020-01-01/old.json', 'inbox/2020-01-01/old.vca']);
    assert.deepEqual(fs.readdirSync(day).sort(), ['new.vca', 'note.txt']);
    assert.ok(fs.existsSync(path.join(dir, kept.file)));
    assert.deepEqual(store.sweepOrphans(null), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 壊れた索引 ----
test('索引を書くたびに、前の索引を .bak に残す', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'a.json');
    writeJsonAtomic(f, [1]);
    assert.equal(fs.existsSync(f + '.bak'), false, '前が無ければ残さない');
    writeJsonAtomic(f, [1, 2]);
    assert.deepEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), [1]);
    fs.writeFileSync(f, '{壊れた');
    writeJsonAtomic(f, [3]);
    assert.deepEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), [1], '壊れたものは .bak にしない');
    assert.equal(fs.existsSync(f + '.tmp'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('索引が壊れていたら 1 つ前の索引から読み、記録に残す。どちらも読めなければ起動しない', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const a = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = store.saveReceived({ body: BODY, type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    fs.writeFileSync(path.join(dir, 'index.json'), '[{"id":"書きかけ');
    const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: false } }));
    assert.deepEqual(hub.store.index.map(e => e.id).sort(), [a.id, b.id].sort(), '1 つ前の索引(A だけ)に、抜けた B を情報のファイルから登録し直す');
    assert.equal(hub.store.get(b.id).recovered, true);
    assert.ok(hub.log.list().some(l => l.event === 'index-recovered'));
    fs.writeFileSync(path.join(dir, 'index.json.bak'), 'これも壊れた');
    fs.writeFileSync(path.join(dir, 'index.json'), '');
    assert.throws(() => new Store({ dir }), e => e.code === 'json-broken');
    fs.rmSync(path.join(dir, 'index.json.bak'));
    assert.throws(() => new Store({ dir }), e => e.code === 'json-broken', '前の索引が無くても、空として扱わない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('要求 ID の記録を 1 つ前のものから読んだら、通し番号を進めて同じ番号を 2 度割り当てない(7.2.3.3)', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'devices.json');
    const r = new Registry({ file });
    const ids = [r.nextId(), r.nextId()];
    fs.writeFileSync(file, '');
    const again = new Registry({ file });
    assert.ok(again.recovered);
    assert.ok(again.nextId() > Math.max(...ids.map(Number)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 拡張の失敗 ----
test('拡張のフックが Promise で失敗しても vca-hub は止まらず、記録に残す。検査・send の Promise は失敗として扱う', async () => {
  const dir = tmp();
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'bad'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'bad', 'index.js'), `module.exports = { setup(hub) {
    hub.on('received', async () => { throw new Error('受信の失敗'); });
    hub.on('queued', () => Promise.reject(new Error('送信待ちの失敗')));
    hub.on('check', async () => ({}));
    hub.on('send', async ({ records }) => records);
    hub.on('describe', async () => ['説明']);
  } };`);
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: dir, web: { enabled: false }, remote: { enabled: false }, extensionsDir: extDir, extensions: { bad: true },
  }));
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    hub.ext.queued(e);
    await wait(50);
    assert.equal(unhandled, 0, '捕まえていない失敗が無い');
    const errors = hub.log.list().filter(l => l.event === 'ext-error').map(l => l.detail);
    assert.ok(errors.some(d => d.includes('受信の失敗')) && errors.some(d => d.includes('送信待ちの失敗')));
    assert.ok(hub.ext.check(e, () => BODY).blockers.some(b => b.includes('Promise')), '検査が待てないときは送り出さない');
    assert.throws(() => hub.recordsFor(e, { kind: 'file' }), err => err.code === 'ext-send');
    // 説明を作れなかったことを確認の画面に出す(send が送るデータを変えるかもしれないため)
    const d = hub.ext.describe(e);
    assert.equal(d.length, 1);
    assert.ok(d[0].failed && /説明を作れません/.test(d[0].lines[0]));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await hub.stop(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 接続 ----
test('受けた接続には TCP の keepalive を使う(閉じた知らせが届かない接続も、OS が閉じて数から外れる)', async () => {
  const dir = tmp();
  const calls = [];
  const orig = net.Socket.prototype.setKeepAlive;
  net.Socket.prototype.setKeepAlive = function (...a) { calls.push(a); return orig.apply(this, a); };
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 } }));
  try {
    const { remote: port } = await hub.start();
    const s = net.connect(port, '127.0.0.1');
    await new Promise(r => s.once('connect', r));
    await wait(100);
    assert.ok(calls.some(a => a[0] === true && a[1] > 0));
    s.destroy();
  } finally {
    net.Socket.prototype.setKeepAlive = orig;
    await hub.stop(); await wait(100); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同じ相手を同じ理由で何度断っても、記録は 1 分に 1 度だけ書く', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, connections: { total: 1, perAddress: 1 },
  }));
  const { remote: port } = await hub.start();
  const keep = net.connect(port, '127.0.0.1');
  try {
    await new Promise(r => keep.once('connect', r));
    for (let i = 0; i < 30; i++) {
      const s = net.connect(port, '127.0.0.1');
      s.on('error', () => {});
      await new Promise(r => s.once('close', r));
    }
    assert.equal(hub.log.list().filter(l => l.event === 'rejected').length, 1);
  } finally { keep.destroy(); await hub.stop(); await wait(100); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 書き出し ----
test('受け手が開いたままのファイルへの上書きは、理由を返して断り、一時ファイルを残さない', { skip: !windows && 'Windows のファイルの共有の制限を使う' }, async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'J.vca'), 'old');
    const unlock = await lockFile(path.join(dir, 'J.vca'));
    try {
      assert.throws(() => exportFile(dir, 'J', BODY, [['DBL', '18']], { overwrite: true }), e => e.code === 'file-busy');
    } finally { await unlock(); }
    assert.deepEqual(fs.readdirSync(dir), ['J.vca']);
    assert.equal(fs.readFileSync(path.join(dir, 'J.vca'), 'utf8'), 'old');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ハードリンクを作れないフォルダでも、すでにあるファイルは上書きせず、無ければ書き出す', () => {
  const dir = tmp();
  const orig = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); };
  try {
    assert.equal(exportFile(dir, 'N', BODY, [['DBL', '18']]).overwrote, false);
    assert.match(fs.readFileSync(path.join(dir, 'N.vca'), 'latin1'), /DBL=18/);
    fs.writeFileSync(path.join(dir, 'M.vca'), 'other');
    assert.throws(() => exportFile(dir, 'M', BODY, [['DBL', '18']]), e => e.code === 'file-exists');
    assert.equal(fs.readFileSync(path.join(dir, 'M.vca'), 'utf8'), 'other');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['M.vca', 'N.vca'], '一時ファイルを残さない');
  } finally { fs.linkSync = orig; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('1 つ前の索引から読んだら、ファイルと突き合わせる: 抜けた受信は登録し直し、抜けた削除は外し、送信待ちは外す', () => {
  const dir = tmp();
  try {
    const s = new Store({ dir });
    const a = s.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = s.saveReceived({ body: BODY, type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    s.queue(a.id, 'N1');
    const beforeRemove = fs.readFileSync(path.join(dir, 'index.json'));
    s.remove(b.id);
    // 電源断で、削除を書いた索引も .bak も消す前のものに戻り、ファイルだけが消えた
    fs.writeFileSync(path.join(dir, 'index.json.bak'), beforeRemove);
    fs.writeFileSync(path.join(dir, 'index.json'), '{書きかけ');
    let t = new Store({ dir });
    assert.deepEqual(t.recoveryReport.dropped, [b.id], 'ファイルの無い B を外す');
    assert.equal(t.get(b.id), null);
    // 送信待ちにした直後(.bak は送信待ちの前)と、送信待ちの記録が残っているときの両方を見る
    t.queue(a.id, 'N1');
    t.markSent(a.id, 'EDG');              // .bak は送信待ちのまま
    fs.writeFileSync(path.join(dir, 'index.json'), '');
    t = new Store({ dir });
    assert.deepEqual(t.recoveryReport.unqueued, [a.id], '送信済みが抜けたかもしれないので、送信待ちから外す');
    assert.equal(t.get(a.id).status, 'received');
    assert.equal(t.findQueued('N1'), null, '2 度渡さない');
    const c = t.saveReceived({ body: BODY, type: 'TRC', job: 'C', peer: 'p', crcOk: null });   // .bak には C が無い
    fs.writeFileSync(path.join(dir, 'index.json'), 'x');
    t = new Store({ dir });
    assert.deepEqual(t.recoveryReport.readded, [c.id], '抜けた受信を登録し直す');
    assert.equal(t.get(c.id).recovered, true);
    assert.equal(t.get(c.id).status, 'received');
    assert.equal(new Set(t.index.map(e => e.id)).size, t.index.length, '二重に登録しない');
    t = new Store({ dir });
    assert.equal(t.recoveryReport, null, '読めた索引では突き合わせない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張に渡す索引の記録は写しで、拡張が書き換えても、人の確認を経ずに送信待ちにならない', () => {
  const dir = tmp();
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'mut'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'mut', 'index.js'), `module.exports = { setup(hub) {
    hub.on('received', ({ entry }) => { entry.status = 'queued'; entry.name = 'HACK'; entry.file = '../../x'; });
    hub.on('check', ({ entry }) => { entry.status = 'queued'; return {}; });
  } };`);
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: dir, web: { enabled: false }, remote: { enabled: false }, extensionsDir: extDir, extensions: { mut: true },
  }));
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    hub.ext.check(e, () => BODY);
    const real = hub.store.get(e.id);
    assert.equal(real.status, 'received');
    assert.equal(real.name, null);
    assert.equal(hub.store.findQueued('HACK'), null);
    assert.ok(!real.file.includes('..'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
