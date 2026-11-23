'use strict';
// 人の操作の流れ: 確かめた中身と送る中身の突き合わせ、状態の印、記録に名前を書かないこと、機器へ返す説明文、
// 設定の確かめ、ローカル接続のつなぎ直し、送るレコードの形(5.1.6 のラベルの長さ、5.1.7 の予約文字)。
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
const { Store } = require('../src/store/store.js');
const { hostOptions } = require('../src/host/session.js');
const { checkBody } = require('../src/send/check.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-flow-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const CRLF = '\r\n';
const DAY = 86400000;
const BODY = 'DO=R' + CRLF + 'JOB=A' + CRLF + 'DBL=18' + CRLF;

function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `localhost:${port}`, 'X-VCA-Hub': '1', 'Content-Type': 'application/json' } }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// ---- 確かめた中身と送る中身 ----
test('確認の画面で確かめた後に拡張の説明(条件)が変わったら、送らずに changed で断る', async () => {
  const dir = tmp();
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'cond'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'cond', 'index.js'),
    "let v = 'ETYP=1';\nmodule.exports = { set: x => { v = x; }, setup(h) { h.on('describe', () => [v]); } };");
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: false }, extensionsDir: extDir, extensions: { cond: true },
  }));
  const ports = await hub.start();
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const d = await call(ports.web, 'GET', `/api/jobs/${e.id}`);
    assert.equal(typeof d.body.confirmKey, 'string');
    require(path.join(extDir, 'cond', 'index.js')).set('ETYP=2');   // 確かめた後に変わった
    const r = await call(ports.web, 'POST', `/api/jobs/${e.id}/queue`, { confirmed: true, name: 'A1', key: d.body.confirmKey });
    assert.equal(r.code, 409);
    assert.equal(r.body.error, 'changed');
    assert.equal(hub.store.get(e.id).status, 'received');
    const d2 = await call(ports.web, 'GET', `/api/jobs/${e.id}`);
    const ok = await call(ports.web, 'POST', `/api/jobs/${e.id}/queue`, { confirmed: true, name: 'A1', key: d2.body.confirmKey });
    assert.equal(ok.code, 200, '確かめ直した値なら送る');
    const none = await call(ports.web, 'POST', `/api/jobs/${e.id}/export`, { confirmed: true, name: 'A1' });
    assert.equal(none.body.error, 'changed', '値の無い要求も断る');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 状態の印 ----
test('一覧と詳細に、送り先へ送っている途中・送信済みを書けていない・渡す直前の検査で外した、の印を出す', async () => {
  const dir = tmp();
  const conns = [];
  const sink = net.createServer(c => conns.push(c));
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: false }, connectDelay: 0,
    timeouts: { ack: 1, packet: 1, char: 1 }, destinations: [{ name: 'D', host: '127.0.0.1', port: sink.address().port }],
  }));
  const ports = await hub.start();
  try {
    const a = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const sending = hub.sendTo(a.id, 'A1', 'D');
    await wait(100);
    assert.equal((await call(ports.web, 'GET', '/api/jobs')).body.find(x => x.id === a.id).uploading, true);
    for (const c of conns) c.destroy();
    await assert.rejects(sending);

    const b = hub.store.saveReceived({ body: BODY.replace('JOB=A', 'JOB=B'), type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    hub.store.queue(b.id, 'B1');
    hub.store.reserve('B1', {});
    hub.store.holdSent(b.id, 'edger');
    assert.equal((await call(ports.web, 'GET', `/api/jobs/${b.id}`)).body.sentUnrecorded, true);

    const c = hub.store.saveReceived({ body: BODY.replace('JOB=A', 'JOB=C'), type: 'TRC', job: 'C', peer: 'p', crcOk: null });
    hub.store.queue(c.id, 'C1');
    hub.store.unqueue(c.id, { blocked: true });
    assert.equal((await call(ports.web, 'GET', `/api/jobs/${c.id}`)).body.unqueuedByCheck, true);
    hub.store.queue(c.id, 'C1');
    assert.equal(hub.store.get(c.id).unqueuedByCheck, undefined, '送信待ちに戻したら印を外す');
  } finally { await hub.stop(); await new Promise(r => sink.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 保存期間 ----
test('置き換えで送信待ちから外したものも、外した時から保存期間を数える', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const a = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = store.saveReceived({ body: BODY.replace('DBL=18', 'DBL=19'), type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    store.queue(a.id, 'X');
    for (const e of store.index) e.receivedAt = new Date(Date.now() - 100 * DAY).toISOString();
    store.queue(b.id, 'X', { replace: true });
    assert.deepEqual(store.purge(90).map(e => e.id), [], '外した直後には消さない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 記録 ----
test('消せなかったファイルの記録に、ファイルの名前(JOB や取り込んだファイルの名前が入る)を書かない', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false } }));
  try {
    hub.store.hooks.deleteFailed(path.join(dir, 'data', 'inbox', 'x', 'Yamada_1_p.vca'), Object.assign(new Error('busy'), { code: 'EBUSY' }));
    const l = hub.log.list().find(x => x.event === 'delete-failed');
    assert.ok(l && !l.detail.includes('Yamada') && l.detail.includes('EBUSY'));
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 機器へ返す説明文 ----
test('STATUS=8 の説明文は ASCII のコードだけにする(日本語の文は latin1 で化けて、レコードを壊すため)', () => {
  const store = { reserve: () => ({ entry: { id: 'x' } }), readBody: () => BODY, release() {}, checkOf: () => ({ blockers: [], notices: [] }),
    saveReceived: () => { throw Object.assign(new Error('違うラベルが多すぎる「」、'), { code: 'too-many-labels' }); } };
  const o = hostOptions({ store, registry: { get: () => null }, log: { write() {} }, peer: 'p',
    recordsFor: () => { throw Object.assign(new Error('拡張「x」で送るデータを作れませんでした'), { code: 'ext-send' }); } });
  const r = o.onRequest(VCA.parse('REQ=EDG\r\nJOB=A\r\nDEV=EDG\r\n'), { type: 'EDG', job: 'A', kind: 'download' });
  assert.deepEqual(r, { status: 8, text: 'ext-send' });
  // データのパケット(JOB が要る。7.1.6)
  const data = Object.assign(VCA.parse('ANS=TRC\r\nJOB=A\r\nDBL=18\r\n'), { raw: '\x1cANS=TRC\r\nJOB=A\r\nDBL=18\r\n\x1e\x1d', crcOk: null });
  const d = o.onData(VCA.parse('REQ=TRC\r\nJOB=A\r\n'), data, { type: 'TRC', job: 'A' });
  assert.deepEqual(d, { status: 8, text: 'too-many-labels' });
  assert.ok(/^[\x20-\x7e]+$/.test(r.text + d.text));
});

// ---- 設定 ----
test('送り先の type は UPL か TRC だけ(書き損じを黙って UPL として送らない)', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ destinations: [{ name: 'D', host: '127.0.0.1', port: 1, type: 'TRACE' }] }));
    assert.throws(() => loadConfig(f), e => e.code === 'config' && /destinations\[0\]\.type/.test(e.message));
    fs.writeFileSync(f, JSON.stringify({ destinations: [{ name: 'D', host: '127.0.0.1', port: 1, type: 'trc' }] }));
    assert.doesNotThrow(() => loadConfig(f));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- ローカル接続のつなぎ直し ----
test('ローカル接続は、つなげなかったときも、切れたときも、決めた間隔でつなぎ直す', async () => {
  const dir = tmp();
  let accepted = 0;
  const server = net.createServer(c => { accepted++; setTimeout(() => c.destroy(), 50); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, local: [{ name: 'E', host: '127.0.0.1', port: server.address().port }],
  }), { localRetryMs: 100 });
  await hub.start();
  try {
    for (const t0 = Date.now(); accepted < 3 && Date.now() - t0 < 5000;) await wait(20);
    assert.ok(accepted >= 3, `切れるたびにつなぎ直す(${accepted} 回)`);
  } finally { await hub.stop(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 送るレコードの形 ----
test('値に予約文字(制御文字)のあるデータは送り出さない: 受けたものを止め、送信待ちにもできない(5.1.7)', () => {
  const dir = tmp();
  try {
    assert.ok(checkBody('DO=R\r\nFRAM=AB\x1dCD\r\n').blockers.some(b => /制御文字/.test(b)), '受ける側: 止める理由にする');
    const store = new Store({ dir });
    const e = store.saveReceived({ body: 'DO=R\r\nFRAM=AB\x06CD\r\n', type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    assert.throws(() => store.queue(e.id, 'A1'), err => err.code === 'blocked', '送る側: 送信待ちにしない');
    // バイナリの玉型(形式 2)の系列の行は、逃がした形で制御文字を含みうるので止めない
    const bin = 'R=' + VCA.escapeBinary(VCA.encodeBinary(2, [2500, 2500, 2500]));
    assert.ok(!checkBody('DO=R\r\nTRCFMT=2;3;E;R;F\r\n' + bin + '\r\n').blockers.some(b => /制御文字/.test(b)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('16 文字を超えるラベルの行は送り出さない(5.1.6)', () => {
  assert.ok(checkBody('DO=R\r\n_ABCDEFGHIJKLMNOPQRS=1\r\n').blockers.some(b => /16 文字/.test(b)));
  assert.ok(!checkBody('DO=R\r\n_ABCDEFGHIJKLMNO=1\r\n').blockers.some(b => /16 文字/.test(b)), '16 文字ちょうどは送る');
});
