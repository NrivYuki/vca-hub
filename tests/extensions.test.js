'use strict';
// 拡張(設計書 13 章): 読み込み、フック(received・check・send・describe)、通信方式、管理画面の API とページ。
// 例の拡張(examples/extensions)をそのまま読み込んで確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const VCA = require('../src/lib/vca-parser.js');
const T = require('../src/lib/vca-tcp.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { setRecord } = require('../src/ext/extensions.js');

const FAST = { ack: 1, packet: 2, char: 1 };
const EXAMPLES = path.join(__dirname, '..', 'examples', 'extensions');
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-both.vca'), 'latin1');
const body = sample.replace('REQ=FIL', 'ANS=TRC');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-ext-'));

function config(dir, over) {
  return merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), extensionsDir: EXAMPLES, web: { enabled: false }, remote: { enabled: false },
    timeouts: FAST, connectDelay: 0, ...over,
  });
}
async function makeHub(over) {
  const dir = tmp();
  const hub = createHub(config(dir, over));
  const ports = await hub.start();
  return { hub, dir, ports, async done() { await hub.stop(); await new Promise(r => setTimeout(r, 50)); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const route = (hub, ext, method, p) => hub.ext.get(ext).routes.find(r => r.method === method && r.path === p).handler;
const value = (records, label) => { const r = records.find(x => x[0] === label); return r ? r.slice(1).join(';') : undefined; };

/** 加工機として要求する(初期化しない REQ=EDG。7.2.6.2 のとおり DEV・VEN・MODEL を入れる) */
async function edgerRequest(port, job, { ven = 'ACME', model = 'E-100' } = {}) {
  const d = await T.connectDevice('127.0.0.1', port, { connectDelay: 0, timeouts: FAST });
  try { return await d.request('EDG', { job, records: [['DEV', 'EDG'], ['VEN', ven], ['MODEL', model]] }); } finally { d.socket.destroy(); }
}

// ---- 読み込み ----
test('config.json の extensions に書いていない拡張は読まない', async () => {
  const h = await makeHub({});
  try { assert.deepEqual(h.hub.ext.summary(), []); } finally { await h.done(); }
});

test('書いた拡張が無い・setup が無い・setup が失敗したときは起動しない(拡張が欠けたまま送らない)', () => {
  const dir = tmp();
  try {
    const exts = path.join(dir, 'ext');
    fs.mkdirSync(path.join(exts, 'nosetup'), { recursive: true });
    fs.writeFileSync(path.join(exts, 'nosetup', 'index.js'), 'module.exports = {};');
    fs.mkdirSync(path.join(exts, 'throws'), { recursive: true });
    fs.writeFileSync(path.join(exts, 'throws', 'index.js'), "module.exports = { setup() { throw new Error('だめ'); } };");
    for (const [name, re] of [['missing', /読めません/], ['nosetup', /setup がありません/], ['throws', /setup で失敗しました: だめ/], ['../x', /使えません/]]) {
      assert.throws(() => createHub(config(dir, { extensionsDir: exts, extensions: { [name]: true } })), e => e.code === 'ext-load' && re.test(e.message), name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('口の通信方式が、どの拡張にも無ければ起動しない', () => {
  const dir = tmp();
  try {
    assert.throws(() => createHub(config(dir, { listeners: [{ name: 'A', port: 0, protocol: 'maker-x' }] })), e => e.code === 'no-protocol' && /maker-x/.test(e.message));
    assert.throws(() => createHub(config(dir, { destinations: [{ name: 'B', host: '127.0.0.1', port: 1, protocol: 'maker-x' }] })), e => e.code === 'no-protocol');
    // 'vca' と書かないものは VCA(DCS)
    assert.doesNotThrow(() => createHub(config(dir, { listeners: [{ name: 'C', port: 0, protocol: 'VCA' }] })));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setRecord: 同じラベルは置き換え、無ければ玉型(TRCFMT)の前に入れる', () => {
  const recs = [['DO', 'B'], ['ETYP', '?'], ['TRCFMT', '1', '360', 'E', 'R', 'F'], ['R', '1']];
  assert.deepEqual(setRecord(recs, 'ETYP', 1), [['DO', 'B'], ['ETYP', '1'], ['TRCFMT', '1', '360', 'E', 'R', 'F'], ['R', '1']]);
  assert.deepEqual(setRecord(recs, 'polish', 1).map(r => r[0]), ['DO', 'ETYP', 'POLISH', 'TRCFMT', 'R']);
});

// ---- 加工条件の例(check・send・describe・route・data) ----
test('加工条件(required): 付けるまで送信待ちにできず、付けると加工機への応答に ETYP・BEVP・BEVM・BEVC・POLISH が入る', async () => {
  const h = await makeHub({ remote: { enabled: true, port: 0 }, extensions: { 'processing-conditions': { required: true } } });
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'P1', peer: 't', crcOk: null });
    assert.throws(() => h.hub.store.queue(e.id, 'PC-1'), err => err.code === 'blocked' && /加工条件: 加工条件が付いていません/.test(err.blockers.join()));
    assert.match(h.hub.ext.describe(e)[0].lines[0], /付けるまで送れません/);

    // BEVP=3(フレームカーブに沿う)では BEVC と BEVM が要る(表 A.1 の BEVP)
    const save = route(h.hub, 'processing-conditions', 'POST', 'conditions');
    assert.throws(() => save({ body: { id: e.id, conditions: { ETYP: '1', BEVP: '3', BEVM: '1.0' } } }), /BEVC/);
    assert.throws(() => save({ body: { id: e.id, conditions: { ETYP: '9' } } }), /ETYP/, '表 A.1 に無い ETYP');
    save({ body: { id: e.id, conditions: { ETYP: '1', BEVP: '3', BEVM: '1.0', BEVC: '4.00', POLISH: '1' } } });
    h.hub.store.queue(e.id, 'PC-1');

    // 初期化しない加工機には、プリセットの項目一式(7.2.6.2)。BEVP があるので BEVM・BEVC も添える(表 A.7 の注記)
    const r = await edgerRequest(h.ports.remote, 'PC-1');
    assert.equal(r.status, 0);
    const recs = r.response.records.map(x => [x.label, ...x.fields]);
    assert.equal(value(recs, 'ETYP'), '1');
    assert.equal(value(recs, 'BEVP'), '3;3');
    assert.equal(value(recs, 'BEVM'), '1.0;1.0');
    assert.equal(value(recs, 'BEVC'), '4.00;4.00');
    assert.equal(value(recs, 'POLISH'), '1');
    assert.ok(h.hub.log.list().some(l => l.event === 'ext-send' && /足した|変えた/.test(l.detail) && /ETYP/.test(l.detail)), '変えた項目を記録に残す');
    // 受け取った本文は変えていない
    assert.equal(h.hub.store.readBody(e), body.replace(/^CLIENT=.*\r\n/m, ''));
  } finally { await h.done(); }
});

test('加工条件: 加工機が初期化で求めていない項目は足さない', async () => {
  const h = await makeHub({ extensions: { 'processing-conditions': {} } });
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'P2', peer: 't', crcOk: null });
    route(h.hub, 'processing-conditions', 'POST', 'conditions')({ body: { id: e.id, conditions: { ETYP: '2', POLISH: '3' } } });
    const recs = h.hub.recordsFor(e, { kind: 'device', profile: { labels: ['ETYP', 'HBOX'], trcfmt: { fmt: 1, n: 360, mode: 'E', eye: 'B' } } });
    assert.equal(value(recs, 'ETYP'), '2');
    assert.equal(value(recs, 'POLISH'), undefined);
    // 共有フォルダへの書き出しには、付けた条件をすべて入れる
    const file = h.hub.recordsFor(e, { kind: 'file' });
    assert.equal(value(file, 'POLISH'), '3');
  } finally { await h.done(); }
});

test('受信データを消すと、拡張が残した情報も消える', async () => {
  const h = await makeHub({ extensions: { 'processing-conditions': {} } });
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'P3', peer: 't', crcOk: null });
    route(h.hub, 'processing-conditions', 'POST', 'conditions')({ body: { id: e.id, conditions: { ETYP: '2' } } });
    const f = path.join(h.hub.cfg.dataDir, 'ext', 'processing-conditions', e.id + '.json');
    assert.ok(fs.existsSync(f));
    h.hub.store.remove(e.id);
    assert.ok(!fs.existsSync(f));
  } finally { await h.done(); }
});

// ---- メーカー別の項目の例(機器ごとの send) ----
test('メーカー別の項目: 名乗った VEN・MODEL に合う決まりだけを当てる(足す・外す)', async () => {
  const rules = [{ ven: 'acme', model: 'E-100', add: [['_ACMEMODE', '2']], remove: ['POLISH'] }];
  const h = await makeHub({ remote: { enabled: true, port: 0 }, extensions: { 'vendor-records': { rules } } });
  try {
    const e = h.hub.store.saveReceived({ body: body.replace('TRCFMT', 'POLISH=1\r\nTRCFMT'), type: 'TRC', job: 'V1', peer: 't', crcOk: null });
    h.hub.store.queue(e.id, 'V-1');
    let r = await edgerRequest(h.ports.remote, 'V-1');
    let recs = r.response.records.map(x => [x.label, ...x.fields]);
    assert.equal(value(recs, '_ACMEMODE'), '2');
    assert.equal(value(recs, 'POLISH'), undefined);
    // 送信済みになる(加工機の ACK を受けてから)のを待って、もう一度送信待ちにする
    for (let i = 0; i < 100 && h.hub.store.get(e.id).status !== 'sent'; i++) await new Promise(res => setTimeout(res, 20));
    h.hub.store.queue(e.id, 'V-1');
    r = await edgerRequest(h.ports.remote, 'V-1', { ven: 'OTHER', model: 'X' });
    assert.equal(r.status, 0);
    recs = r.response.records.map(x => [x.label, ...x.fields]);
    assert.equal(value(recs, '_ACMEMODE'), undefined);
    assert.equal(value(recs, 'POLISH'), '1');
  } finally { await h.done(); }
});

test('メーカー別の項目: 16 文字を超えるラベルは起動のときに断る(DCS 5.1.6)', () => {
  const dir = tmp();
  try {
    assert.throws(() => createHub(config(dir, { extensions: { 'vendor-records': { rules: [{ ven: 'A', add: [['_' + 'X'.repeat(16), '1']] }] } } })), /16 文字/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の send が失敗したら、加工機には STATUS=8 を返し、送信待ちのまま残す', async () => {
  const dir = tmp();
  const exts = path.join(dir, 'ext');
  fs.mkdirSync(path.join(exts, 'bad'), { recursive: true });
  fs.writeFileSync(path.join(exts, 'bad', 'index.js'), "module.exports = { setup(h) { h.on('send', () => { throw new Error('壊れた'); }); } };");
  const hub = createHub(config(dir, { extensionsDir: exts, extensions: { bad: true }, remote: { enabled: true, port: 0 } }));
  const ports = await hub.start();
  try {
    const e = hub.store.saveReceived({ body, type: 'TRC', job: 'B1', peer: 't', crcOk: null });
    hub.store.queue(e.id, 'B-1');
    const r = await edgerRequest(ports.remote, 'B-1');
    assert.equal(r.status, 8);
    assert.equal(hub.store.get(e.id).status, 'queued');
  } finally { await hub.stop(); await new Promise(r => setTimeout(r, 50)); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 通信方式の例(listen・upload) ----
/** text-line の相手: 行を送り、END か 1 行の返事までを受け取る */
function textCall(port, text, { untilEnd = false } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    s.setEncoding('latin1');
    s.on('error', reject);
    s.on('connect', () => s.write(text));
    s.on('data', c => {
      buf += c;
      if (untilEnd ? /(^|\n)(END|NG [^\r]*)\r\n$/.test(buf) : buf.endsWith('\r\n')) resolve({ text: buf, socket: s });
    });
  });
}

test('通信方式 text-line: 受け取ったものは名前なしで保存し、名前を付けて送信待ちにすると GET で渡し、ACK で送信済みにする', async () => {
  const h = await makeHub({ extensions: { 'text-protocol': true }, listeners: [{ name: 'メーカー A', port: 0, protocol: 'text-line' }] });
  try {
    const port = h.ports.listeners['メーカー A'];
    const lines = body.split('\r\n').filter(l => l && !/^(ANS|JOB)=/.test(l)).join('\r\n');
    const put = await textCall(port, `PUT T-RAW\r\n${lines}\r\nEND\r\n`);
    put.socket.destroy();
    assert.match(put.text, /^OK /);
    const e = h.hub.store.list()[0];
    assert.equal(e.job, 'T-RAW');
    assert.equal(e.name, null, '名前は人が付ける');
    assert.equal(e.type, 'text-line');
    assert.deepEqual(e.eyes, ['R', 'L']);

    const ng = await textCall(port, 'GET T-RAW\r\n');
    ng.socket.destroy();
    assert.equal(ng.text, 'NG notfound\r\n', '名前を付けるまで渡さない');

    h.hub.store.queue(e.id, 'TL-1');
    const got = await textCall(port, 'GET TL-1\r\n', { untilEnd: true });
    const parsed = VCA.parse(got.text.replace(/END\r\n$/, ''));
    assert.equal(VCA.value(parsed, 'JOB'), 'TL-1');
    assert.equal(parsed.traces.length, 2);
    got.socket.write('ACK\r\n');
    await new Promise(r => setTimeout(r, 100));
    got.socket.destroy();
    assert.equal(h.hub.store.get(e.id).status, 'sent');
  } finally { await h.done(); }
});

test('通信方式 text-line の送り先へ送る(送り先ごとに VCA と通信方式を選べる)', async () => {
  let received = '';
  const server = net.createServer(s => {
    s.setEncoding('latin1');
    s.on('data', c => { received += c; if (received.endsWith('END\r\n')) s.write('OK\r\n'); });
  });
  await new Promise(r => server.listen(0, r));
  const h = await makeHub({
    extensions: { 'text-protocol': true },
    destinations: [{ name: 'メーカー A のソフト', host: '127.0.0.1', port: server.address().port, protocol: 'text-line' }],
  });
  try {
    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'U1', peer: 't', crcOk: null });
    const r = await h.hub.sendTo(e.id, 'TL-UP', 'メーカー A のソフト');
    assert.equal(r.status, 0);
    assert.match(received, /^PUT TL-UP\r\n/);
    assert.match(received, /\r\nTRCFMT=1;360;E;R;F\r\n/);
    assert.equal(h.hub.store.get(e.id).status, 'sent');
  } finally { await h.done(); server.close(); }
});

// ---- 管理画面 ----
function call(port, method, p, { body: b, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `localhost:${port}`, ...headers } }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => resolve({ code: res.statusCode, type: res.headers['content-type'], raw: s, body: /json/.test(res.headers['content-type'] || '') && s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    if (b) req.end(JSON.stringify(b)); else req.end();
  });
}

test('管理画面: 拡張の一覧と通信方式、拡張のページ、拡張の API(変更は独自ヘッダーが要る)、拡張の検査と説明', async () => {
  const h = await makeHub({
    web: { enabled: true, host: '127.0.0.1', port: 0 },
    extensions: { 'processing-conditions': { required: true }, 'text-protocol': true },
    listeners: [{ name: 'メーカー A', port: 0, protocol: 'text-line' }],
  });
  const port = h.ports.web;
  try {
    const st = (await call(port, 'GET', '/api/status')).body;
    assert.deepEqual(st.extensions.map(x => x.name), ['processing-conditions', 'text-protocol']);
    assert.deepEqual(st.extensions[1].protocols, [{ id: 'text-line', title: 'text-line(例)' }]);
    assert.deepEqual(st.listeners.map(l => l.protocol), ['text-line']);
    assert.equal(st.remoteProtocol, 'vca');

    const page = await call(port, 'GET', '/ext/processing-conditions/');
    assert.equal(page.code, 200);
    assert.match(page.type, /text\/html/);
    assert.equal((await call(port, 'GET', '/ext/processing-conditions/..%2F..%2Fpackage.json')).code, 404, '拡張のフォルダの外は返さない');
    assert.equal((await call(port, 'GET', '/ext/text-protocol/')).code, 404, 'ページの無い拡張');

    const e = h.hub.store.saveReceived({ body, type: 'TRC', job: 'W1', peer: 't', crcOk: null });
    const list = (await call(port, 'GET', '/api/jobs')).body;
    assert.match(list[0].check.blockers.join(), /加工条件/, '一覧の印にも拡張の検査が入る');
    const det = (await call(port, 'GET', `/api/jobs/${e.id}`)).body;
    assert.equal(det.extensions[0].title, '加工条件');

    const conditions = { ETYP: '3', BEVP: '4' };
    assert.equal((await call(port, 'POST', '/api/ext/processing-conditions/conditions', { body: { id: e.id, conditions } })).code, 403);
    const ok = await call(port, 'POST', '/api/ext/processing-conditions/conditions', { body: { id: e.id, conditions }, headers: { 'X-VCA-Hub': '1' } });
    assert.equal(ok.code, 200);
    const bad = await call(port, 'POST', '/api/ext/processing-conditions/conditions', { body: { id: e.id, conditions: { ETYP: '1' } }, headers: { 'X-VCA-Hub': '1' } });
    assert.equal(bad.code, 400);
    assert.match(bad.body.message, /BEVP/);
    assert.deepEqual((await call(port, 'GET', `/api/ext/processing-conditions/conditions?id=${e.id}`)).body.conditions, conditions);
    assert.deepEqual((await call(port, 'GET', '/api/jobs')).body[0].check.blockers, []);
    assert.equal((await call(port, 'GET', '/api/ext/processing-conditions/none')).code, 404);
  } finally { await h.done(); }
});
