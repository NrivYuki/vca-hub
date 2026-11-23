'use strict';
// 確かめた中身だけを渡すこと・状態を食い違わせないこと: プリセット初期化、送り先への玉型の申し出、渡す直前の検査、
// 1 つしか置けないレコードの重なり、索引の復旧、.bak、取り込むフォルダが読めないとき、同じ名乗りの機器が何台もあるとき。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const VCA = require('../src/lib/vca-parser.js');
const T = require('../src/lib/vca-tcp.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { Store } = require('../src/store/store.js');
const { checkBody } = require('../src/send/check.js');
const { uploadTo, uploadRecords, traceProposal } = require('../src/device/upload.js');
const { watchFolder } = require('../src/send/folder.js');
const { Log } = require('../src/log.js');

const FAST = { ack: 1, packet: 2, char: 1 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-con-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const job = sample.replace('REQ=FIL', 'ANS=TRC');
const DAY = 86400000;

async function makeHub(over = () => ({})) {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: true, port: 0 }, timeouts: FAST, connectDelay: 0, ...over(dir),
  }));
  const ports = await hub.start();
  return {
    hub, dir, ports,
    edger: () => T.connectDevice('127.0.0.1', ports.remote, { connectDelay: 0, timeouts: FAST }),
    async done() { await hub.stop(); await wait(50); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// ---- プリセット初期化(7.2.5.2・5.1.3・5.1.4) ----
test('プリセット初期化をした加工機には、要求 ID でも、機器の種類のプリセットの項目一式を返し、無い項目は ?', async () => {
  const h = await makeHub();
  const e = h.hub.store.saveReceived({ body: job, type: 'TRC', job: 'J1', peer: 'p', crcOk: null });
  h.hub.store.queue(e.id, 'J1');
  const edger = await h.edger();
  try {
    const ini = await edger.initialize([['DEV', 'EDG'], ['VEN', 'X'], ['MODEL', 'Y'], ['TRCFMT', '1', '400', 'E', 'R']]);
    assert.ok(ini.requestId);
    const r = await edger.request(ini.requestId, { job: 'J1' });
    assert.equal(r.status, 0);
    const preset = VCA.presetRecords('EDG').map(x => x.label);
    for (const l of Object.keys(r.response.rec)) {
      // 通信用と玉型のレコード、BEVP に伴う BEVM・BEVC(表 A.7 の注記)はプリセットの外でも送る
      if (['ANS', 'JOB', 'STATUS', 'DO', 'TRCFMT', 'R', 'A', 'ZFMT', 'BEVM', 'BEVC'].includes(l)) continue;
      assert.ok(preset.includes(l), `プリセットに無い ${l} を送らない`);
    }
    assert.deepEqual(r.response.rec.LMATTYPE, ['?', '?'], 'プリセットの項目で持っていないものは ?');
    assert.equal(r.response.traces[0].radii.length, 400, '取り決めた点数');
  } finally { edger.socket.destroy(); await h.done(); }
});

// ---- 送り先への玉型の形式(5.4.1・7.2.8) ----
test('別のホストへ送るときは、要求(または初期化)に TRCFMT で形式 1 を申し出て、玉型も形式 1 で送る', async () => {
  const fmt4 = VCA.parse(job).traces[0];
  const body4 = job.replace(/TRCFMT=[^\r\n]*\r\n(R=[^\r\n]*\r\n)+/, '') + require('../src/lib/trace.js').traceRecords(fmt4, { fmt: 4 }).map(r => r[0] + '=' + r.slice(1).join(';') + '\r\n').join('');
  assert.equal(VCA.parse(body4).traces[0].fmt, 4);
  assert.deepEqual(traceProposal(body4), [['TRCFMT', '1', '360', 'E', 'R', 'F']]);
  assert.equal(VCA.parse(uploadRecords(body4).map(r => r[0] + '=' + r.slice(1).join(';')).join('\r\n')).traces[0].fmt, 1);
  assert.deepEqual(traceProposal('JOB=X\r\nDBL=18\r\n'), [], '玉型が無ければ申し出ない(5.4.1)');
  // 相手のホストが受け取った要求に、申し出が入っていること
  const seen = [];
  const server = await T.listenHost(0, () => ({
    timeouts: FAST, onRequest(req) { seen.push(req.proposals.filter(p => p.label === 'TRCFMT').map(p => p.fields.join(';'))); return {}; },
    onData() { return { status: 0 }; },
  }));
  try {
    const r = await uploadTo({ host: '127.0.0.1', port: server.address().port, type: 'TRC' }, { body: body4, name: 'N1', timeouts: FAST, connectDelay: 0 });
    assert.equal(r.status, 0);
    assert.deepEqual(seen, [['1;360;E;R;F']]);
  } finally { server.close(); }
});

// ---- 渡す直前の検査 ----
test('送信待ちにした後で送り出せない理由ができたら、加工機には渡さず(STATUS=8)、送信待ちから外す', async () => {
  const h = await makeHub();
  const e = h.hub.store.saveReceived({ body: job, type: 'TRC', job: 'J1', peer: 'p', crcOk: null });
  h.hub.store.queue(e.id, 'J1');
  // 拡張の検査が、送信待ちにした後で「送れない」と言うようになった
  h.hub.store.hooks.check = () => ({ blockers: ['加工条件が付いていません'], notices: [] });
  const edger = await h.edger();
  try {
    const r = await edger.request('EDG', { job: 'J1', records: [['DEV', 'EDG'], ['VEN', 'X'], ['MODEL', 'Y']] });
    assert.equal(r.status, 8);
    assert.equal(r.response.rec.DBL, undefined, 'データを入れない');
    assert.equal(h.hub.store.get(e.id).status, 'received', '送信待ちから外し、確かめ直してもらう');
    assert.equal(h.hub.store.sending.size, 0);
    assert.ok(h.hub.log.list().some(l => l.event === 'send-blocked'));
  } finally { edger.socket.destroy(); await h.done(); }
});

// ---- 1 つしか置けないレコード(5.1.10) ----
test('1 つしか置けないレコードが値違いで 2 回あれば送り出さず、同じ値なら知らせる', () => {
  const diff = checkBody(job + 'DBL=17.0\r\nETYP=1\r\nETYP=3\r\n');
  assert.ok(diff.blockers.some(b => b.startsWith('DBL ')));
  assert.ok(diff.blockers.some(b => b.startsWith('ETYP ')));
  const same = checkBody(job + 'DBL=18.0\r\n');
  assert.deepEqual(same.blockers, []);
  assert.ok(same.notices.some(n => n.startsWith('DBL ')));
  assert.deepEqual(checkBody(job + 'ENGMARK=A;1\r\nENGMARK=B;2\r\n').blockers, [], '複数置けるレコードは重なってよい');
});

// ---- 索引の復旧と .bak ----
test('1 つ前の索引から読んで記録を外したときも、vca-hub は起動し、拡張の情報も消す', async () => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  try {
    const s = new Store({ dir: data });
    s.saveReceived({ body: job, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = s.saveReceived({ body: job, type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    const before = fs.readFileSync(path.join(data, 'index.json'));
    s.remove(b.id);
    fs.writeFileSync(path.join(data, 'index.json.bak'), before);
    fs.writeFileSync(path.join(data, 'index.json'), '{書きかけ');
    const extDir = path.join(data, 'ext', 'x');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, `${b.id}.json`), '{}');
    const extensionsDir = path.join(dir, 'exts');
    fs.mkdirSync(path.join(extensionsDir, 'x'), { recursive: true });
    fs.writeFileSync(path.join(extensionsDir, 'x', 'index.js'), 'module.exports = { setup() {} };');
    const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: data, web: { enabled: false }, remote: { enabled: false }, extensionsDir, extensions: { x: true } }));
    assert.deepEqual(hub.store.recoveryReport.dropped, [b.id]);
    assert.equal(fs.existsSync(path.join(extDir, `${b.id}.json`)), false);
    await hub.start();
    await hub.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('記録を消したら、1 つ前の索引(.bak)にもジョブ番号と名前を残さない', () => {
  const dir = tmp();
  try {
    const s = new Store({ dir });
    const e = s.saveReceived({ body: job, type: 'TRC', job: 'SECRETJOB', peer: 'p', crcOk: null });
    s.setName(e.id, 'SECRETNAME');
    s.saveReceived({ body: job, type: 'TRC', job: 'KEEP', peer: 'p', crcOk: null });
    s.remove(e.id);
    const bak = fs.readFileSync(path.join(dir, 'index.json.bak'), 'utf8');
    assert.ok(!bak.includes('SECRETJOB') && !bak.includes('SECRETNAME'));
    assert.ok(bak.includes('KEEP'));
    s.saveReceived({ body: job, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    s.purge(1, new Date(Date.now() + 3 * DAY));
    assert.ok(!fs.readFileSync(path.join(dir, 'index.json.bak'), 'utf8').includes('KEEP'), '保存期間で消したときも');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 取り込むフォルダが読めないとき ----
test('取り込むフォルダが読めない・作れないときも vca-hub は動き続け、記録は 10 分に 1 度', async () => {
  const dir = tmp();
  try {
    const notDir = path.join(dir, 'file');
    fs.writeFileSync(notDir, 'x');
    const log = new Log({ dir: path.join(dir, 'log') });
    const w = watchFolder({ dir: path.join(notDir, 'in'), store: new Store({ dir: path.join(dir, 'data') }), log, settleMs: 0, intervalMs: 3600000 });
    for (let i = 0; i < 20; i++) w.scan();
    w.stop();
    assert.equal(log.list().filter(l => l.event === 'import-retry').length, 1);
    const h = await makeHub(d => ({ importDir: path.join(notDir, 'in') }));
    assert.ok(h.ports.remote, '待ち受けは始まる');
    await h.done();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 同じ名乗りの機器が何台も ----
test('同じ名乗り(VEN・MODEL、製造番号なし)の機器が何台も初期化しても、ほかの機器の要求 ID を消さない', async () => {
  const h = await makeHub();
  const e = h.hub.store.saveReceived({ body: job, type: 'TRC', job: 'J1', peer: 'p', crcOk: null });
  h.hub.store.queue(e.id, 'J1');
  const [a, b] = await Promise.all([h.edger(), h.edger()]);
  try {
    const who = [['DEV', 'EDG'], ['VEN', 'SAME'], ['MODEL', 'M'], ['TRCFMT', '1', '360', 'E', 'R']];
    const ia = await a.initialize(who, { tag: 'T', labels: ['DBL'] });
    const ib = await b.initialize(who, { tag: 'T', labels: ['DBL'] });
    assert.notEqual(ia.requestId, ib.requestId);
    const r = await a.request(ia.requestId, { job: 'J1' });
    assert.equal(r.status, 0, 'あとから初期化した機器があっても、前の機器の要求 ID は使える');
    assert.deepEqual(Object.keys(r.response.rec).filter(l => !['ANS', 'JOB', 'STATUS', 'DO', 'TRCFMT', 'R', 'A'].includes(l)), ['DBL'],
      '初期化で求めた項目(DBL)だけを送る(前の機器の希望が残っている)');
  } finally { a.socket.destroy(); b.socket.destroy(); await h.done(); }
});

// ---- 渡している途中・送り出しの失敗 ----
test('加工機へ渡している途中のものは、送信待ちから外すことも、名前を変えることも、ほかのデータで置き換えることもしない', () => {
  const dir = tmp();
  try {
    const s = new Store({ dir });
    const x = s.saveReceived({ body: job, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const y = s.saveReceived({ body: job + 'LMATID=1;1\r\n', type: 'TRC', job: 'Y', peer: 'p', crcOk: null });
    s.queue(x.id, 'A');
    assert.ok(s.reserve('A', {}).entry, '加工機へ渡している途中');
    assert.throws(() => s.unqueue(x.id), e => e.code === 'sending');
    assert.throws(() => s.queue(x.id, 'B'), e => e.code === 'sending');
    assert.throws(() => s.queue(y.id, 'A', { replace: true }), e => e.code === 'sending');
    assert.equal(s.get(x.id).status, 'queued');
    assert.equal(s.get(x.id).name, 'A');
    assert.equal(s.unqueue(x.id, { evenIfSending: true }).status, 'received', '渡す直前の検査で渡さないと決めたときは外せる');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('書き出しや送り先への送信に失敗したら、名前を変えない', async () => {
  const h = await makeHub(d => ({ exportDir: path.join(d, 'out'), destinations: [{ name: 'D', host: '127.0.0.1', port: 1, type: 'UPL' }] }));
  try {
    const e = h.hub.store.saveReceived({ body: job, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    h.hub.exportJob(e.id, 'A');
    fs.writeFileSync(path.join(h.dir, 'out', 'B.vca'), 'ほかのもの');
    assert.throws(() => h.hub.exportJob(e.id, 'B'), err => err.code === 'file-exists');
    assert.equal(h.hub.store.get(e.id).name, 'A');
    await assert.rejects(h.hub.sendTo(e.id, 'C', 'D'), err => err.code === 'upload-failed');
    assert.equal(h.hub.store.get(e.id).name, 'A');
    assert.equal(h.hub.store.get(e.id).sent.length, 1, '送った記録は、成功した書き出しの 1 件だけ');
  } finally { await h.done(); }
});

test('加工条件の例の拡張: 送信待ちのものの条件は変えられず、外せない(確かめたのと違う条件を渡さない)', async () => {
  const exts = path.join(__dirname, '..', 'examples', 'extensions');
  const h = await makeHub(() => ({ extensionsDir: exts, extensions: { 'processing-conditions': { required: true } } }));
  try {
    const e = h.hub.store.saveReceived({ body: job, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const routes = h.hub.ext.get('processing-conditions').routes;
    const call = (p, body) => routes.find(r => r.method === 'POST' && r.path === p).handler({ method: 'POST', path: p, query: {}, body });
    call('conditions', { id: e.id, conditions: { ETYP: '1', BEVP: '4' } });
    h.hub.store.queue(e.id, 'A');
    assert.throws(() => call('conditions', { id: e.id, conditions: { ETYP: '3', BEVP: '1', BEVM: '0.5' } }), err => err.code === 'queued-change');
    assert.throws(() => call('clear', { id: e.id }), err => err.code === 'queued-change');
    h.hub.store.unqueue(e.id);
    assert.doesNotThrow(() => call('conditions', { id: e.id, conditions: { ETYP: '1', BEVP: '0' } }), '送信待ちから外せば変えられる');
  } finally { await h.done(); }
});

test('索引を戻したときの印は、人が確かめ直して送信待ちにしたら外す', () => {
  const dir = tmp();
  try {
    const s = new Store({ dir });
    const a = s.saveReceived({ body: job, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    s.queue(a.id, 'N1');
    s.saveReceived({ body: job, type: 'TRC', job: 'B', peer: 'p', crcOk: null });   // .bak は A を送信待ちにしたときのもの
    fs.writeFileSync(path.join(dir, 'index.json'), '');
    const t = new Store({ dir });
    assert.equal(t.get(a.id).unqueuedByRecovery, true);
    t.queue(a.id, 'N1');
    assert.equal(t.get(a.id).unqueuedByRecovery, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
