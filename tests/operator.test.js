'use strict';
// 人の操作と画面: 渡している途中のものを消さないこと、書き出せない理由、渡している途中の印、消し直しを起動し直しても続けること、
// 細かい働きを外したときに落ちるテスト(索引を戻した印、ラベルの形、取り込みのやり直し、DRILL、io の名前、保存期間の処理の例外、
// オートコネクトの許可範囲、接続の数の既定、書き出しの一時ファイルの片付けのつなぎ)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const dgram = require('node:dgram');
const http = require('node:http');
const VCA = require('../src/lib/vca-parser.js');
const T = require('../src/lib/vca-tcp.js');
const { loadConfig, merge, DEFAULTS } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');
const { buildDownload } = require('../src/send/build.js');
const { exportFile, watchFolder } = require('../src/send/folder.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-op-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const CRLF = '\r\n';
const BODY = 'DO=R' + CRLF + 'JOB=X' + CRLF + 'DBL=18' + CRLF;
const DAY = 86400000;
const windows = process.platform === 'win32';

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `localhost:${port}`, 'X-VCA-Hub': '1', 'Content-Type': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('加工機へ渡している途中のものは削除しない。一覧と詳細に、渡している途中であることを出す', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: false } }));
  const { web } = await hub.start();
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    hub.store.queue(e.id, 'A');
    hub.store.reserve('A', {});
    const del = await request(web, 'DELETE', `/api/jobs/${e.id}`);
    assert.equal(del.status, 409);
    assert.equal(del.body.error, 'sending');
    assert.ok(hub.store.get(e.id));
    assert.equal((await request(web, 'GET', '/api/jobs')).body.find(x => x.id === e.id).sending, true);
    assert.equal((await request(web, 'GET', `/api/jobs/${e.id}`)).body.sending, true);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('書き出し先に書けないときは、理由(export-failed)を返す', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    assert.throws(() => exportFile(path.join(dir, 'file', 'out'), 'A', BODY, [['DBL', '18']]), e => e.code === 'export-failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('消せなかったファイルの消し直しは、起動し直しても続ける', { skip: !windows && 'Windows のファイルの共有の制限を使う' }, async () => {
  const dir = tmp();
  try {
    const s = new Store({ dir });
    const e = s.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const file = path.join(dir, e.file);
    const ps = cp.spawn('powershell', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${file}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Close()`]);
    await new Promise(r => ps.stdout.on('data', d => { if (String(d).includes('locked')) r(); }));
    s.remove(e.id);
    await new Promise(r => { ps.once('exit', r); ps.stdin.end('\n'); });
    const again = new Store({ dir });   // 起動し直し
    assert.deepEqual(again.retryDeletes(), [file]);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('索引を戻したときの「登録し直した」印も、人が送信待ちにしたら外す', () => {
  const dir = tmp();
  try {
    const s = new Store({ dir });
    const e = s.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    s.index.find(x => x.id === e.id).recovered = true;
    s.queue(e.id, 'A');
    assert.equal(s.get(e.id).recovered, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('初期化のラベル一覧に、ラベルの形でないものがあれば断る(STATUS=13)', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, connectDelay: 0 }));
  const { remote } = await hub.start();
  const dev = await T.connectDevice('127.0.0.1', remote, { connectDelay: 0, timeouts: { ack: 4, packet: 6, char: 2 } });
  try {
    const ng = await dev.initialize([['DEV', 'EDG'], ['VEN', 'V'], ['MODEL', 'M']], { tag: 'T', labels: ['DBL', 'TOO_LONG_LABEL_NAME_X'] });
    assert.equal(ng.hostStatus, 13);
  } finally { dev.socket.destroy(); await hub.stop(); await wait(50); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ほかのソフトが開いていて読めない(移すことはできる)ファイルも、「取り込めなかった」へ移さず、読めるようになったら取り込む', { skip: !windows && 'Windows のファイルの共有の制限を使う' }, async () => {
  const dir = tmp();
  const imp = path.join(dir, 'in');
  fs.mkdirSync(imp);
  const file = path.join(imp, 'J.vca');
  fs.writeFileSync(file, BODY);
  // 読むことは許さず、名前を変えること(移すこと)は許す
  const ps = cp.spawn('powershell', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${file}','Open','Read','Delete'); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Close()`]);
  await new Promise(r => ps.stdout.on('data', d => { if (String(d).includes('locked')) r(); }));
  const store = new Store({ dir: path.join(dir, 'data') });
  const w = watchFolder({ dir: imp, store, log: new Log({ dir: path.join(dir, 'log') }), settleMs: 0, intervalMs: 3600000 });
  try {
    assert.equal(fs.existsSync(path.join(imp, '取り込めなかった', 'J.vca')), false);
    assert.equal(store.list().length, 0);
    await new Promise(r => { ps.once('exit', r); ps.stdin.end('\n'); });
    w.scan();
    assert.equal(store.list().length, 1, '読めるようになったら取り込む');
    assert.ok(fs.existsSync(path.join(imp, '取り込み済み', 'J.vca')));
  } finally {
    w.stop();
    if (ps.exitCode === null) await new Promise(r => { ps.once('exit', r); ps.stdin.end('\n'); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('穴あけの基準を取り決めた機器には、受け取りたい一覧が無いときも DRILL を送らない(5.5.1.5)', () => {
  const body = BODY + 'DRILLE=R;C;-18.40;10.30;1.60' + CRLF + 'DRILL=R;-18.4;10.3;1.6' + CRLF;
  const out = buildDownload({ body, profile: { labels: [], trcfmt: null, drill: 'C' }, device: { dev: 'EDG', ven: 'V', model: 'M', sn: '' } }).map(r => r[0]);
  assert.ok(!out.includes('DRILL'));
  assert.ok(out.includes('DRILLE'));
});

test('拡張の io.records は、同じデータでも名前が変わって送信待ちにし直されていたら断る', async () => {
  const dir = tmp();
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'grab2'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'grab2', 'index.js'), `let io = null;
module.exports = { io: () => io, setup(hub) { hub.protocol('g2', { listen(o, x) { io = x; return { port: 0, close() {} }; } }); } };`);
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, extensionsDir: extDir, extensions: { grab2: true }, listeners: [{ name: 'L', port: 0, protocol: 'g2' }],
  }));
  await hub.start();
  try {
    const io = require(path.join(extDir, 'grab2', 'index.js')).io();
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    hub.store.queue(e.id, 'N');
    const found = io.queued('N');
    hub.store.unqueue(e.id);
    hub.store.queue(e.id, 'M');
    assert.throws(() => io.records(found), err => err.code === 'not-queued');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('保存期間の処理は、途中の段が例外を投げても止まらず、記録に残し、残りの段を続ける', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, retentionDays: 30 }));
  try {
    hub.store.purge = () => { throw Object.assign(new Error('索引を書けない'), { code: 'EIO' }); };
    const oldLog = path.join(dir, 'data', 'log', new Date(Date.now() - 60 * DAY).toISOString().slice(0, 10) + '.log');
    fs.writeFileSync(oldLog, '{}\n');
    assert.doesNotThrow(() => hub.purge());
    assert.ok(hub.log.list().some(l => l.event === 'purge-failed'));
    assert.equal(fs.existsSync(oldLog), false, '残りの段(ログ)は続ける');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('オートコネクトは、許可範囲の外のアドレスへはつなぎに行かない', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: false }, autoconnect: { enabled: true, port: 0 }, allow: ['10.0.0.0/8'] }));
  const ports = await hub.start();
  const edger = await T.listenDevice(0, { connectDelay: 0 });
  const sock = dgram.createSocket('udp4');
  try {
    let connected = false;
    edger.on('connection', () => { connected = true; });
    await new Promise(r => sock.send(Buffer.from(VCA.buildPacket([['REQ', 'CON'], ['IP', '127.0.0.1'], ['PORT', String(edger.address().port)], ['DEV', 'EDG'], ['VEN', 'V'], ['MODEL', 'M']]), 'latin1'), ports.autoconnect, '127.0.0.1', r));
    await wait(500);
    assert.equal(connected, false);
    assert.ok(hub.log.list().some(l => l.event === 'autoconnect-ignored'));
  } finally { sock.close(); edger.close(); await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('接続の数の既定は、全体 64・IP ごとに 8(README と設計書 4 章)', () => {
  assert.deepEqual(DEFAULTS.connections, { total: 64, perAddress: 8 });
});

test('保存期間の処理(hub.purge)は、書き出し先に残った書き出しの途中の一時ファイルも消す', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, exportDir: out }));
  try {
    const t = path.join(out, '.J.999999.tmp');
    fs.writeFileSync(t, 'x');
    const old = new Date(Date.now() - DAY);
    fs.utimesSync(t, old, old);
    hub.purge();
    assert.equal(fs.existsSync(t), false);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
