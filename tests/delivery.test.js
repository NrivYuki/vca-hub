'use strict';
// 名前、共有フォルダの書き出しと取り込み、機器役のアップロード、自動削除、オートコネクト(設計書 4-7 章)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VCA = require('../src/lib/vca-parser.js');
const T = require('../src/lib/vca-tcp.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { Store } = require('../src/store/store.js');
const { fileText, watchFolder, DONE_DIR, FAILED_DIR } = require('../src/send/folder.js');

const FAST = { ack: 1, packet: 2, char: 1 };
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const body = sample.replace('REQ=FIL', 'ANS=TRC').replace('JOB=SAMPLE-001', 'JOB=T-RAW');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-s3-'));
const quietLog = () => { const lines = []; return { lines, write: (level, o) => lines.push({ level, ...o }) }; };

async function makeHub(over) {
  const dir = tmp();
  const cfg = merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, timeouts: FAST, connectDelay: 0, ...over(dir) });
  const hub = createHub(cfg);
  const ports = await hub.start();
  return { hub, dir, ports, async done() { await hub.stop(); await new Promise(r => setTimeout(r, 50)); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ---- 名前(設計書 6 章) ----
test('名前を付けるまで、加工機が受け取った JOB で求めても渡さない。付けた名前で求めれば渡す', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    assert.equal(e.name, null);
    assert.equal(store.findQueued('T-RAW'), null, '名前なし');
    store.queue(e.id, 'ORDER-7');
    assert.equal(store.findQueued('T-RAW'), null, '受け取った JOB では渡さない');
    assert.equal(store.findQueued('ORDER-7').id, e.id);
    assert.equal(store.get(e.id).job, 'T-RAW', '受け取った JOB は残す');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('送信待ちの別のデータと同じ名前は付けられない。replace なら前のものを送信待ちから外す', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const a = store.saveReceived({ body, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const b = store.saveReceived({ body, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    store.queue(a.id, 'N1');
    assert.throws(() => store.queue(b.id, 'N1'), e => e.code === 'name-taken' && e.others[0] === a.id);
    assert.equal(store.get(b.id).status, 'received', '断ったときは変えない');
    store.queue(b.id, 'N1', { replace: true });
    assert.equal(store.get(a.id).status, 'received');
    assert.equal(store.findQueued('N1').id, b.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('名前には、空・ファイル名に使えない文字・フォルダをさかのぼる指定を使えない', () => {
  for (const bad of ['', '  ', 'a/b', 'a\\b', '..x', 'a:b', 'x'.repeat(41)]) {
    assert.throws(() => Store.checkName(bad), e => e.code === 'bad-name', JSON.stringify(bad));
  }
  assert.equal(Store.checkName(' A-01 '), 'A-01', '前後の空白は除く');
});

// ---- 共有フォルダ(設計書 6 章) ----
test('書き出すファイル: 1 行目 REQ=FIL、2 行目 JOB(付けた名前)。CRC・STATUS・制御文字は入れず、玉型は形式 1', () => {
  const text = fileText(body.replace('TRCFMT=1;360;E;R;F', 'TRCFMT=1;360;E;R;F'), 'ORDER-7');
  const lines = text.split('\r\n');
  assert.deepEqual(lines.slice(0, 2), ['REQ=FIL', 'JOB=ORDER-7']);
  assert.ok(!/^(CRC|STATUS|ANS)=/m.test(text));
  assert.ok(!/[\x00-\x09\x0b\x0c\x0e-\x1f]/.test(text), '制御文字(CR・LF を除く)');
  const d = VCA.parse(text);
  assert.equal(d.traces[0].fmt, 1);
  assert.deepEqual(d.rec.HBOX, ['52.00', '52.00']);
});

test('書き出しは 名前.vca に上書きし、上書きになることを先に確かめられ、上書きしたことをログに残す', async () => {
  const h = await makeHub(dir => ({ exportDir: path.join(dir, 'out') }));
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    assert.equal(h.hub.exportCheck('ORDER-7').exists, false);
    const r1 = h.hub.exportJob(e.id, 'ORDER-7');
    assert.equal(path.basename(r1.file), 'ORDER-7.vca');
    assert.equal(r1.overwrote, false);
    assert.equal(h.hub.exportCheck('ORDER-7').exists, true);
    assert.equal(h.hub.exportJob(e.id, 'ORDER-7').overwrote, true);
    assert.equal(h.hub.store.get(e.id).name, 'ORDER-7');
    const logs = h.hub.log.list().filter(l => l.event === 'exported');
    assert.equal(logs.length, 2);
    assert.match(logs[0].detail + logs[1].detail, /上書き/);
  } finally { await h.done(); }
});

test('書き出しても、加工機向けの送信待ちは外さない', async () => {
  const h = await makeHub(dir => ({ exportDir: path.join(dir, 'out') }));
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    h.hub.store.queue(e.id, 'Q1');
    h.hub.exportJob(e.id, 'Q1');
    assert.equal(h.hub.store.get(e.id).status, 'queued');
    assert.equal(h.hub.store.get(e.id).sent.length, 1);
  } finally { await h.done(); }
});

test('取り込み: 読めたファイルは名前なしで保存して「取り込み済み」へ、読めないファイルは「取り込めなかった」へ移す', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir: path.join(dir, 'data') });
    const watch = path.join(dir, 'in');
    fs.mkdirSync(watch);
    fs.writeFileSync(path.join(watch, 'a.vca'), sample);
    fs.writeFileSync(path.join(watch, 'b.vca'), 'これは VCA ではない');
    fs.writeFileSync(path.join(watch, 'c.txt'), sample);
    const log = quietLog();
    const w = watchFolder({ dir: watch, store, log, settleMs: 0 });
    w.stop();
    const e = store.list();
    assert.equal(e.length, 1);
    assert.equal(e[0].job, 'SAMPLE-001');
    assert.equal(e[0].name, null, '取り込んだデータも名前なし');
    assert.deepEqual(fs.readdirSync(path.join(watch, DONE_DIR)), ['a.vca']);
    assert.deepEqual(fs.readdirSync(path.join(watch, FAILED_DIR)), ['b.vca']);
    assert.ok(fs.existsSync(path.join(watch, 'c.txt')), '.vca 以外は触らない');
    assert.ok(log.lines.some(l => l.event === 'import-failed'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('取り込み: 書きかけ(最後の書き込みから間もない)のファイルは、まだ取り込まない', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir: path.join(dir, 'data') });
    const watch = path.join(dir, 'in');
    fs.mkdirSync(watch);
    fs.writeFileSync(path.join(watch, 'a.vca'), sample);
    watchFolder({ dir: watch, store, log: quietLog(), settleMs: 60000 }).stop();
    assert.equal(store.list().length, 0);
    assert.ok(fs.existsSync(path.join(watch, 'a.vca')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 機器役のアップロード(設計書 5 章) ----
async function mockHost(handlers) {
  const got = { requests: [], data: [] };
  const server = await T.listenHost(0, {
    timeouts: FAST,
    onRequest: (req, info) => { got.requests.push(req); return handlers.onRequest ? handlers.onRequest(req, info) : {}; },
    onData: (req, data) => { got.data.push(data); return { status: 0 }; },
  });
  return { got, port: server.address().port, close: () => server.close() };
}

test('送り先へは DEV=UPL・VEN と MODEL は vca-hub で、付けた名前を JOB にしてアップロードする(7.2.6.2)', async () => {
  const host = await mockHost({});
  const h = await makeHub(() => ({ destinations: [{ name: 'LAB', host: '127.0.0.1', port: host.port }] }));
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    const r = await h.hub.sendTo(e.id, 'ORDER-9', 'LAB');
    assert.equal(r.status, 0);
    const req = host.got.requests[0];
    assert.deepEqual([VCA.value(req, 'REQ'), VCA.value(req, 'JOB'), VCA.value(req, 'DEV'), VCA.value(req, 'VEN'), VCA.value(req, 'MODEL')],
      ['UPL', 'ORDER-9', 'UPL', 'vca-hub', 'vca-hub']);
    const d = host.got.data[0];
    assert.deepEqual(d.rec.HBOX, ['52.00', '52.00']);
    assert.equal(d.traces[0].radii.length, 360);
    assert.equal(h.hub.store.get(e.id).status, 'sent');
  } finally { await h.done(); host.close(); }
});

test('送り先の type が TRC なら REQ=TRC・DEV=TRC で送る', async () => {
  const host = await mockHost({});
  const h = await makeHub(() => ({ destinations: [{ name: 'LMS', host: '127.0.0.1', port: host.port, type: 'TRC' }] }));
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    assert.equal((await h.hub.sendTo(e.id, 'N', 'LMS')).status, 0);
    assert.deepEqual([VCA.value(host.got.requests[0], 'REQ'), VCA.value(host.got.requests[0], 'DEV')], ['TRC', 'TRC']);
  } finally { await h.done(); host.close(); }
});

test('送り先が STATUS=5(初期化が必要)を返したら、初期化してから要求 ID でやり直す(表 A.24)', async () => {
  const host = await mockHost({ onRequest: (req, info) => (info.type === 'UPL' ? { status: 5 } : {}) });
  const h = await makeHub(() => ({ destinations: [{ name: 'LAB', host: '127.0.0.1', port: host.port }] }));
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    const r = await h.hub.sendTo(e.id, 'N', 'LAB');
    assert.equal(r.status, 0);
    assert.equal(r.initialized, true);
    assert.match(VCA.value(host.got.requests[1], 'REQ'), /^\d+$/, '2 回目は要求 ID');
    assert.equal(host.got.data.length, 1);
  } finally { await h.done(); host.close(); }
});

test('送り先が STATUS=0 以外を返したら、送信済みにしない', async () => {
  const host = await mockHost({ onRequest: () => ({ status: 4 }) });
  const h = await makeHub(() => ({ destinations: [{ name: 'LAB', host: '127.0.0.1', port: host.port }] }));
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    assert.equal((await h.hub.sendTo(e.id, 'N', 'LAB')).status, 4);
    assert.equal(h.hub.store.get(e.id).status, 'received');
    assert.equal(h.hub.store.get(e.id).sent.length, 0);
  } finally { await h.done(); host.close(); }
});

test('止める理由(玉型の点数の不一致)があるデータは、書き出しも送信もしない', async () => {
  const h = await makeHub(dir => ({ exportDir: path.join(dir, 'out'), destinations: [{ name: 'LAB', host: '127.0.0.1', port: 9 }] }));
  try {
    const short = body.replace(/\r\nR=[^\r]*\r\n(?![\s\S]*\r\nR=)/, '\r\n');
    const e = h.hub.store.saveReceived({ body: short, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    assert.throws(() => h.hub.exportJob(e.id, 'N'), err => err.code === 'blocked');
    await assert.rejects(h.hub.sendTo(e.id, 'N', 'LAB'), err => err.code === 'blocked');
  } finally { await h.done(); }
});

// ---- 自動削除(設計書 7 章) ----
test('保存期間を過ぎたデータは、送信待ち以外を消す', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const old = store.saveReceived({ body, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const queued = store.saveReceived({ body, type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    const fresh = store.saveReceived({ body, type: 'TRC', job: 'C', peer: 'p', crcOk: null });
    store.queue(queued.id, 'B');
    const later = new Date(Date.parse(fresh.receivedAt) + 10 * 86400000);
    store.get(fresh.id).receivedAt = new Date(later.getTime() - 86400000).toISOString();   // 1 日前に受け取った
    const removed = store.purge(5, later);
    assert.deepEqual(removed.map(e => e.id), [old.id]);
    assert.deepEqual(store.list().map(e => e.id).sort(), [queued.id, fresh.id].sort());
    assert.ok(!fs.existsSync(path.join(dir, old.file)), 'ファイルも消える');
    assert.deepEqual(store.purge(null, later), [], '無期限なら消さない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- オートコネクト(7.8.2.7.1、設計書 4 章) ----
test('オートコネクト: 機器が UDP で知らせてきたら vca-hub がつなぎに行き、加工機は名前で求めたデータを受け取る', async () => {
  const h = await makeHub(() => ({ autoconnect: { enabled: true, port: 0 } }));
  let got;
  const ready = new Promise(r => { got = r; });
  const edger = await T.listenDevice(0, { connectDelay: 0, timeouts: FAST }, d => got(d));
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'T-RAW', peer: 'p', crcOk: null });
    h.hub.store.queue(e.id, 'AC-1');
    await T.announce({ ip: '127.0.0.1', port: edger.address().port, dev: 'EDG', ven: 'TEST', model: 'E-AC' },
      { address: '127.0.0.1', port: h.ports.autoconnect });
    const d = await ready;
    const r = await d.request('EDG', { job: 'AC-1' });
    assert.equal(r.status, 0);
    assert.equal(r.response.traces[0].radii.length, 360);
    d.socket.destroy();
  } finally { edger.close(); await h.done(); }
});
