'use strict';
// データセット(5.1.9・5.10.4・5.11.1)、玉型の眼(5.4.12)、初期化での穴あけの取り決め(5.5.1.5・5.5.3)、派生レコードの ?(5.1.4・A.1.1.7)、
// 扱えない形式(5.4.17)、加工条件の例の拡張、違うラベルが多い本文・行の多い知らせ、受け取った本文の書き切り。
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
const { watchFolder } = require('../src/send/folder.js');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-ds-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const FAST = { ack: 1, packet: 2, char: 1 };
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1').replace('REQ=FIL', 'ANS=TRC');
const lines = args => buildDownload(args).map(r => r[0] + '=' + r.slice(1).join(';'));
const dev = (d, v, m, sn = '') => ({ dev: d, ven: v, model: m, sn });
const CRLF = '\r\n';

async function hubWithJob(body, over = {}) {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, timeouts: FAST, connectDelay: 0, ...over }));
  const { remote } = await hub.start();
  const e = hub.store.saveReceived({ body, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
  hub.store.queue(e.id, 'J1');
  const edger = await T.connectDevice('127.0.0.1', remote, { connectDelay: 0, timeouts: FAST });
  return { hub, e, edger, async done() { edger.socket.destroy(); await hub.stop(); await wait(50); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('玉型以外のデータセット(CRIBFMT・STHKFMT)は、見出しと系列の行(R・A・T)を一緒に送る', () => {
  const body = 'DO=R' + CRLF + sample + 'CRIBFMT=1;4;E;R' + CRLF + 'R=1;2;3;4' + CRLF + 'STHKFMT=1;4;E;R' + CRLF + 'R=5;6;7;8' + CRLF + 'T=60;80;120;140' + CRLF + 'DBL=18.0' + CRLF;
  for (const out of [lines({ body, profile: null, device: dev('EDG', 'V', 'M') }), uploadRecords(body).map(r => r[0] + '=' + r.slice(1).join(';'))]) {
    const i = out.indexOf('CRIBFMT=1;4;E;R'), j = out.indexOf('STHKFMT=1;4;E;R');
    assert.deepEqual(out.slice(i, i + 2), ['CRIBFMT=1;4;E;R', 'R=1;2;3;4']);
    assert.deepEqual(out.slice(j, j + 3), ['STHKFMT=1;4;E;R', 'R=5;6;7;8', 'T=60;80;120;140']);
  }
  assert.deepEqual(lines({ body, profile: { labels: ['CRIBFMT'] }, device: dev('EDG', 'V', 'M') }), ['DO=R', 'CRIBFMT=1;4;E;R', 'R=1;2;3;4'], '一覧で求めた見出しにも系列を付ける');
});

test('同じ眼の玉型が 2 つある、眼が R・L でない玉型があるときは送り出さない(5.4.12)', () => {
  const t = VCA.parse(sample).traces[0];
  const tr = (eye, r) => traceRecords({ ...t, radii: t.radii.map(() => r) }, { fmt: 1, eye }).map(x => x[0] + '=' + x.slice(1).join(';') + CRLF).join('');
  assert.ok(checkBody('DO=B' + CRLF + 'DBL=18' + CRLF + tr('R', 2500) + tr('R', 2000) + tr('L', 2200)).blockers.some(b => b.includes('右眼の玉型が 2 つ')));
  assert.ok(checkBody('DO=B' + CRLF + 'DBL=18' + CRLF + 'TRCFMT=1;4;E;B;F' + CRLF + 'R=2500;2500;2500;2500' + CRLF).blockers.some(b => b.includes('眼が B')));
});

test('初期化で DRLFMT を示した加工機と穴あけの基準を取り決め、DRILLE を送る(5.5.1.5・5.5.3)', async () => {
  const h = await hubWithJob('DO=R' + CRLF + sample + 'DRILLE=R;C;-18.40;10.30;1.60' + CRLF);
  try {
    const ini = await h.edger.initialize([['DEV', 'EDG'], ['VEN', 'V'], ['MODEL', 'M'], ['TRCFMT', '1', '360', 'E', 'R'], ['DRLFMT', 'C']], { tag: 'T', labels: ['DBL'] });
    assert.ok(ini.requestId);
    const r = await h.edger.request(ini.requestId, { job: 'J1' });
    assert.equal(r.status, 0);
    assert.equal((r.response.all.DRILLE || []).length, 1);
  } finally { await h.done(); }
});

test('派生レコード(LD・INS など)も、元のレコードが左右一対なら ?;? で送る(5.1.4・A.1.1.7)', () => {
  assert.deepEqual(lines({ body: 'JOB=X' + CRLF + 'DO=B' + CRLF, profile: { labels: ['ADD', 'LDADD', 'INSADD'] }, device: dev('EDG', 'V', 'M') }),
    ['DO=B', 'ADD=?;?', 'LDADD=?;?', 'INSADD=?;?']);
});

test('初期化しない加工機が、扱えない玉型の形式だけを要求に書いたら STATUS=17 に、形式が無いことを表す修飾子 256 を足したもの(5.4.17・表 A.25)', async () => {
  const h = await hubWithJob('DO=R' + CRLF + sample);
  try {
    const r = await h.edger.request('EDG', { job: 'J1', records: [['DEV', 'EDG'], ['VEN', 'V'], ['MODEL', 'M'], ['TRCFMT', '5', '400', 'E', 'R', 'F']] });
    assert.equal(r.status, 17 + 256);
    assert.equal(h.hub.store.get(h.e.id).status, 'queued', '送信待ちのまま');
  } finally { await h.done(); }
});

test('加工条件の例の拡張: BEVP に要る BEVM・BEVC も送り、書き出しでは同じラベルの機器ごとの値を外す', async () => {
  const exts = path.join(__dirname, '..', 'examples', 'extensions');
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: false }, extensionsDir: exts, extensions: { 'processing-conditions': true } }));
  try {
    const e = hub.store.saveReceived({ body: ['DO=R', 'JOB=X', 'ETYP=3', 'BEVP=4;4', 'PROC=ETYP;EDG;IGX;M;3', ''].join(CRLF), type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const call = (p, body) => hub.ext.get('processing-conditions').routes.find(r => r.method === 'POST' && r.path === p).handler({ method: 'POST', path: p, query: {}, body });
    call('conditions', { id: e.id, conditions: { ETYP: '1', BEVP: '3', BEVM: '1.0', BEVC: '0.5' } });
    const toDev = hub.recordsFor(hub.store.get(e.id), { kind: 'device', device: dev('EDG', 'X', 'Y'), profile: { labels: ['ETYP', 'BEVP'] } }).map(r => r[0]);
    assert.ok(toDev.includes('BEVM') && toDev.includes('BEVC'), toDev.join(','));
    const file = hub.recordsFor(hub.store.get(e.id), { kind: 'file' }).map(r => r.join('='));
    assert.ok(!file.some(l => l.startsWith('PROC=ETYP')), file.join(' | '));
    assert.ok(file.includes('ETYP=1'));
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('違うラベルが多すぎる本文は読まずに断り(保存しない)、取り込みでは「取り込めなかった」へ移す', () => {
  const dir = tmp();
  try {
    let b = 'JOB=X' + CRLF;
    for (let i = 0; i < 2100; i++) b += `X${i}=1` + CRLF;
    const s = new Store({ dir: path.join(dir, 'data') });
    const t = Date.now();
    assert.throws(() => s.saveReceived({ body: b, type: 'TRC', job: 'X', peer: 'p', crcOk: null }), e => e.code === 'too-many-labels');
    assert.ok(Date.now() - t < 1000, '読まずに断る');
    assert.equal(s.list().length, 0);
    const imp = path.join(dir, 'in');
    fs.mkdirSync(imp);
    fs.writeFileSync(path.join(imp, 'many.vca'), b);
    const w = watchFolder({ dir: imp, store: s, log: new Log({ dir: path.join(dir, 'log') }), settleMs: 0, intervalMs: 3600000 });
    w.stop();
    assert.deepEqual(fs.readdirSync(path.join(imp, '取り込めなかった')), ['many.vca']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('規格外の行が多くても、送る前の検査の知らせはラベルごとにまとめ、数を限る(索引が膨らまない)', () => {
  let b = 'JOB=X' + CRLF + 'DO=R' + CRLF;
  for (let i = 0; i < 5000; i++) b += 'XQ=\xe9' + CRLF;
  for (let i = 0; i < 30; i++) b += `_V${i}=` + 'x'.repeat(90) + CRLF;
  const { notices, blockers } = checkBody(b);
  assert.ok(notices.length <= 12, String(notices.length));
  assert.ok(notices.some(n => n.startsWith('ほかに 20 種類')));
  assert.equal(blockers.filter(x => /ASCII 以外/.test(x)).length, 1, 'ASCII 以外の文字は 1 つの理由にまとめる');
});

test('受け取った本文と情報のファイルは、ディスクへ書き切ってから索引に載せる', () => {
  const dir = tmp();
  const orig = fs.fsyncSync;
  let n = 0;
  fs.fsyncSync = fd => { n++; return orig(fd); };
  try {
    new Store({ dir }).saveReceived({ body: 'JOB=X' + CRLF + 'DBL=18' + CRLF, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
  } finally { fs.fsyncSync = orig; fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(n >= 3, `本文・情報・索引で ${n} 回`);
});
