'use strict';
// 部品のつながり: 単体では確かめてある働きが、実際の入口(待ち受け・保存期間の処理・拡張の io・書き出し)からも効いていること。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { startWeb } = require('../src/web/server.js');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');
const { exportFile, watchFolder, DONE_DIR, FAILED_DIR } = require('../src/send/folder.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-wir-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const DAY = 86400000;
const BODY = 'JOB=X\r\nDBL=18\r\n';
const windows = process.platform === 'win32';

// ---- 管理画面 ----
test('管理画面は、この PC のアドレスでだけ待ち受ける(この PC の外向きのアドレスにはつながらない)', async t => {
  const lan = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
  if (!lan) { t.skip('外向きのアドレスが無い PC では確かめられない'); return; }
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: false } }));
  const { web } = await hub.start();
  try {
    const r = await new Promise(resolve => {
      const s = net.connect(web, lan.address);
      s.once('connect', () => { s.destroy(); resolve('connected'); });
      s.once('error', e => resolve(e.code));
    });
    assert.notEqual(r, 'connected');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('管理画面は、相手のアドレスがこの PC のものでなければ、Host が正しくても断る', async () => {
  const dir = tmp();
  const store = new Store({ dir });
  const server = await startWeb({ host: '127.0.0.1', port: 0, store, registry: { list: () => [] }, log: new Log({ dir: path.join(dir, 'log') }), cfg: {}, hub: {}, ext: null });
  try {
    const port = server.address().port;
    const req = new EventEmitter();
    Object.assign(req, { method: 'GET', url: '/api/jobs', headers: { host: `localhost:${port}` }, socket: { remoteAddress: '192.168.1.5' } });
    const res = await new Promise(resolve => {
      const r = { writeHead(code) { this.code = code; }, end(body) { this.body = String(body); resolve(this); } };
      server.emit('request', req, r);
    });
    assert.equal(res.code, 403);
    assert.match(res.body, /forbidden peer/);
  } finally { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 書き出し ----
test('書き出し: 確かめてから置くまでの間に同じ名前のファイルが現れても上書きせず断り、一時ファイルを残さない', () => {
  const dir = tmp();
  const target = path.join(dir, 'RACE.vca');
  const orig = fs.existsSync;
  // 確かめるときには無かったが、置くまでの間に、ほかのソフトが同じ名前のファイルを置いた
  fs.existsSync = p => (p === target ? (orig(p) && false) : orig(p));
  try {
    fs.writeFileSync(target, 'ほかのソフトのもの');
    assert.throws(() => exportFile(dir, 'RACE', BODY, [['DBL', '18']]), e => e.code === 'file-exists');
  } finally { fs.existsSync = orig; }
  try {
    assert.equal(fs.readFileSync(target, 'utf8'), 'ほかのソフトのもの');
    assert.deepEqual(fs.readdirSync(dir), ['RACE.vca']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 保存期間の処理 ----
test('保存期間の処理(hub.purge)は、受信データ・ログ・取り込んだ元のファイル・索引に無いファイルを消す', async () => {
  const dir = tmp();
  const imp = path.join(dir, 'in');
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, importDir: imp, retentionDays: 30 }));
  try {
    const old = new Date(Date.now() - 60 * DAY);
    fs.mkdirSync(path.join(imp, DONE_DIR), { recursive: true });
    const done = path.join(imp, DONE_DIR, 'J.vca');
    fs.writeFileSync(done, BODY); fs.utimesSync(done, old, old);
    const oldLog = path.join(dir, 'data', 'log', new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10) + '.log');
    fs.writeFileSync(oldLog, '{}\n');
    const orphanDir = path.join(dir, 'data', 'inbox', '2020-01-01');
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphan = path.join(orphanDir, 'O.vca');
    fs.writeFileSync(orphan, BODY); fs.utimesSync(orphan, old, old);
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'OLD', peer: 'p', crcOk: null });
    hub.store.index.find(x => x.id === e.id).receivedAt = new Date(Date.now() - 60 * DAY).toISOString();
    hub.purge();
    assert.equal(hub.store.get(e.id), null, '受信データ');
    assert.equal(fs.existsSync(oldLog), false, 'ログ');
    assert.equal(fs.existsSync(done), false, '取り込んだ元のファイル');
    assert.equal(fs.existsSync(orphan), false, '索引に無いファイル');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 拡張の io ----
test('通信方式の拡張が io.records で作るときも、渡す直前に送り出せない理由を確かめ、送信待ちから外す', async () => {
  const dir = tmp();
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'proto'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'proto', 'index.js'), `let io = null;
module.exports = { io: () => io, setup(hub) { hub.protocol('p1', { listen(o, x) { io = x; return { port: 0, close() {} }; } }); } };`);
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, extensionsDir: extDir, extensions: { proto: true },
    listeners: [{ name: 'L', port: 0, protocol: 'p1' }],
  }));
  await hub.start();
  try {
    const io = require(path.join(extDir, 'proto', 'index.js')).io();
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    hub.store.queue(e.id, 'A');
    const got = io.reserve('A', {});
    assert.ok(got.entry);
    hub.store.hooks.check = () => ({ blockers: ['加工条件が付いていません'], notices: [] });
    assert.throws(() => io.records(got.entry), err => err.code === 'blocked');
    assert.equal(hub.store.get(e.id).status, 'received');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 取り込み ----
test('取り込めなかったへ移せないファイルは、「取り込めず」を回ごとに書かない(移せたときに 1 度)', { skip: !windows && 'Windows のファイルの共有の制限を使う' }, async () => {
  const dir = tmp();
  const imp = path.join(dir, 'in');
  fs.mkdirSync(imp);
  const file = path.join(imp, 'x.vca');
  fs.writeFileSync(file, 'これは VCA ではない');
  const ps = cp.spawn('powershell', ['-NoProfile', '-Command',
    `$f=[System.IO.File]::Open('${file}','Open','Read','Read'); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Close()`]);
  await new Promise(r => ps.stdout.on('data', d => { if (String(d).includes('locked')) r(); }));
  const log = new Log({ dir: path.join(dir, 'log') });
  const w = watchFolder({ dir: imp, store: new Store({ dir: path.join(dir, 'data') }), log, settleMs: 0, intervalMs: 3600000 });
  try {
    for (let i = 0; i < 5; i++) w.scan();
    assert.equal(log.list().filter(l => l.event === 'import-failed').length, 0);
    assert.equal(log.list().filter(l => l.event === 'import-retry').length, 1);
  } finally {
    w.stop();
    await new Promise(r => { ps.once('exit', r); ps.stdin.end('\n'); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(FAILED_DIR);
});

// ---- 送信待ちの名前 ----
test('送信待ちのものを別の名前で送信待ちにし直しても、名前は変えない(先に送信待ちから外す)', () => {
  const dir = tmp();
  try {
    const s = new Store({ dir });
    const e = s.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    s.queue(e.id, 'A1');
    assert.throws(() => s.queue(e.id, 'B2'), err => err.code === 'queued-rename');
    assert.equal(s.get(e.id).name, 'A1');
    assert.equal(s.queue(e.id, 'A1').name, 'A1', '同じ名前でし直すのはよい');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('記録の API は新しいものを先に返す(画面は新しいものを上に出す)', () => {
  const dir = tmp();
  try {
    const log = new Log({ dir });
    log.write('info', { event: 'a' });
    log.write('info', { event: 'b' });
    assert.deepEqual(log.list().map(l => l.event), ['b', 'a']);
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'index.html'), 'utf8');
    const loadLog = html.slice(html.indexOf('async function loadLog'), html.indexOf('async function loadLog') + 600);
    assert.ok(!/rows\.slice\(\)\.reverse\(\)/.test(loadLog), '画面で並べ替えない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
