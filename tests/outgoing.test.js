'use strict';
// 外へ出る中身: DO(表 A.2・5.1.10)、取り決めの無い玉型の形式(7.2.8)、TRCFMT=0(5.4.1)、LDPATH(5.9.3・5.16)、
// 拡張の io が送信待ちでないものを渡さないこと、送り先へ届いたのに記録が残らないことが無いこと。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VCA = require('../src/lib/vca-parser.js');
const T = require('../src/lib/vca-tcp.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { buildDownload } = require('../src/send/build.js');
const { checkBody } = require('../src/send/check.js');
const { traceRecords } = require('../src/lib/trace.js');
const { uploadRecords } = require('../src/device/upload.js');
const { fileRecords } = require('../src/send/folder.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-out-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const FAST = { ack: 1, packet: 2, char: 1 };
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1').replace('REQ=FIL', 'ANS=TRC');
const lines = args => buildDownload(args).map(r => r[0] + '=' + r.slice(1).join(';'));
const dev = (d, v, m, sn = '') => ({ dev: d, ven: v, model: m, sn });

// ---- DO ----
test('DO が値違いで 2 回ある、R・L・B・N 以外の値か ? のときは送り出さない。無ければ知らせる', () => {
  assert.ok(checkBody('DO=R\r\nDO=L\r\n' + sample).blockers.some(b => b.startsWith('DO が値違い')));
  for (const v of ['X', '?']) assert.ok(checkBody(`DO=${v}\r\n` + sample).blockers.some(b => b.startsWith(`DO=${v}`)), v);
  assert.deepEqual(checkBody('DO=R\r\nDO=R\r\n' + sample).blockers, [], '同じ値なら止めない');
  assert.ok(checkBody(sample).notices.some(n => n.startsWith('DO がありません')));
});

// ---- 取り決めの無い玉型の形式 ----
test('玉型の形式を取り決めていない機器には、形式 1(全ての機器が扱える。7.2.8)で送る', () => {
  const t = VCA.parse(sample).traces[0];
  const fmt4 = sample.replace(/TRCFMT=[^\r\n]*\r\n(R=[^\r\n]*\r\n)+/, '') + traceRecords(t, { fmt: 4 }).map(r => r[0] + '=' + r.slice(1).join(';') + '\r\n').join('');
  assert.equal(VCA.parse(fmt4).traces[0].fmt, 4);
  const out = VCA.parse(lines({ body: fmt4, profile: { labels: [], preset: true }, device: dev('EDG', 'V', 'M') }).join('\r\n')).traces;
  assert.deepEqual(out.map(x => [x.fmt, x.radii.length]), [[1, 360]]);
});

// ---- TRCFMT=0 ----
test('玉型が無いとき、TRCFMT=0 は玉型を求めた機器にだけ送り、送り先と書き出しには付けない(5.4.1)', () => {
  const noTrace = 'JOB=X\r\nDO=R\r\nDBL=18.0\r\n';
  assert.ok(lines({ body: noTrace, profile: { labels: ['DBL'], trcfmt: { fmt: 1, n: 360, mode: 'E', eye: 'R' } }, device: dev('EDG', 'V', 'M') }).includes('TRCFMT=0'));
  assert.ok(!uploadRecords(noTrace).some(r => r[0] === 'TRCFMT'));
  assert.ok(!fileRecords(noTrace).some(r => r[0] === 'TRCFMT'));
});

// ---- LDPATH(5.9.3) ----
test('LDPATH の機器ごとの形は、合う 1 つのパスを LDPATH に、種類を LDTYPE にして渡す(5.9.3.2・5.16)', () => {
  const body = 'JOB=X\r\nDO=B\r\nLDPATH=FSG;LOH;VFT;;SDF;\\\\S\\A\\3141.SDF\r\nLDPATH=FSG;SOM;HSC100;1234;STF;\\\\S\\B\\R.STF;\\\\S\\B\\L.STF\r\n';
  // LDS から LMS への形(1 つ目の欄が整数の LDPATH・2 欄の LDCRYPT)は、機器へ渡す形に作り直せないので渡さない(5.9.3.3・5.9.7.4)
  for (const extra of ['LDPATH=1;FSG;X;Y;;\r\n', 'LDCRYPT=1;0\r\n']) {
    assert.throws(() => buildDownload({ body: body + extra, profile: null, device: dev('FSG', 'LOH', 'VFT') }), e => e.code === 'device-specific-unsupported', extra);
  }
  assert.deepEqual(lines({ body, profile: { labels: ['LDPATH'] }, device: dev('FSG', 'LOH', 'VFT') }), ['DO=B', 'LDPATH=\\\\S\\A\\3141.SDF', 'LDTYPE=SDF']);
  assert.deepEqual(lines({ body, profile: null, device: dev('FSG', 'SOM', 'HSC100', '1234') }).filter(l => l.startsWith('LD')),
    ['LDPATH=\\\\S\\B\\R.STF;\\\\S\\B\\L.STF', 'LDTYPE=STF'], '左右のパスと種類');
  assert.deepEqual(lines({ body, profile: null, device: dev('EDG', 'X', 'Y') }).filter(l => l.startsWith('LD')), [], '合うものが無く、1 欄の形も無ければ渡さない');
  assert.deepEqual(lines({ body, profile: null, device: dev('FSG', 'SOM', 'HSC100') }).filter(l => l.startsWith('LD')), [], '製造番号を名乗らない機器には、製造番号で絞った形は合わない(合う欄の多いものを選ぶ。5.9.3.2)');
  const single = 'JOB=X\r\nDO=B\r\nLDPATH=\\\\S\\P.SDF\r\nLDTYPE=SDF\r\n';
  assert.deepEqual(lines({ body: single, profile: null, device: dev('FSG', 'A', 'B') }).filter(l => l.startsWith('LD')), ['LDPATH=\\\\S\\P.SDF', 'LDTYPE=SDF'], '1 欄の形はそのまま');
  assert.throws(() => buildDownload({ body: single + 'LDPATH=\\\\S\\Q.SDF\r\n', profile: null, device: dev('FSG', 'A', 'B') }), e => e.code === 'device-specific-ambiguous',
    '機器が受け取る LDPATH は 1 つだけ');
  assert.ok(uploadRecords(body).some(r => r[0] === 'LDPATH' && String(r[1]).startsWith('FSG;LOH')), '別のホストへはそのまま');
});

// ---- 拡張の io ----
test('通信方式の拡張が先に見つけたデータが、その後で取り消し・置き換えられたら、io.records も io.markSent も断る', async () => {
  const dir = tmp();
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'grab'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'grab', 'index.js'), `let io = null;
module.exports = { io: () => io, setup(hub) { hub.protocol('g1', { listen(o, x) { io = x; return { port: 0, close() {} }; } }); } };`);
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, extensionsDir: extDir, extensions: { grab: true },
    listeners: [{ name: 'L', port: 0, protocol: 'g1' }],
  }));
  await hub.start();
  try {
    const io = require(path.join(extDir, 'grab', 'index.js')).io();
    const x = hub.store.saveReceived({ body: 'DO=R\r\n' + sample, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const y = hub.store.saveReceived({ body: 'DO=R\r\n' + sample + 'LMATID=2;2\r\n', type: 'TRC', job: 'Y', peer: 'p', crcOk: null });
    hub.store.queue(x.id, 'N');
    const found = io.queued('N');
    hub.store.unqueue(x.id);
    hub.store.queue(y.id, 'N');
    assert.throws(() => io.records(found), e => e.code === 'not-queued');
    assert.throws(() => io.markSent(found.id), e => e.code === 'not-queued');
    assert.equal(hub.store.get(x.id).status, 'received');
    assert.ok(io.records(io.queued('N')).some(r => r[0] === 'LMATID'), '今の送信待ち(Y)は渡せる');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 送り先 ----
test('送り先へ送っている間に別の名前で送信待ちにされても、届いたものは送った記録に残す', async () => {
  const dir = tmp();
  let release;
  const gate = new Promise(r => { release = r; });
  const server = await T.listenHost(0, () => ({
    timeouts: FAST, onRequest() { return {}; },
    async onData() { await gate; return { status: 0 }; },
  }));
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, timeouts: { ack: 5, packet: 10, char: 5 }, connectDelay: 0,
    destinations: [{ name: 'LAB', host: '127.0.0.1', port: server.address().port, type: 'UPL' }],
  }));
  await hub.start();
  try {
    const e = hub.store.saveReceived({ body: 'DO=R\r\n' + sample, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const sending = hub.sendTo(e.id, 'ORDER-A', 'LAB');
    await wait(300);
    hub.store.queue(e.id, 'ORDER-B');
    release();
    const r = await sending;
    assert.equal(r.status, 0);
    assert.equal(hub.store.get(e.id).sent.length, 1, '届いたことを記録に残す');
    assert.match(hub.store.get(e.id).sent[0].to, /ORDER-A/, 'どの名前で送ったか');
    assert.equal(hub.store.get(e.id).name, 'ORDER-B');
  } finally { await hub.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
