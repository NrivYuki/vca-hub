'use strict';
// 受信データの検査: 意味が曖昧な玉型は送信待ちにできず、規格外の行は警告として知らせる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const VCA = require('../src/lib/vca-parser.js');
const { checkBody } = require('../src/send/check.js');
const { Store } = require('../src/store/store.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const CRLF = '\r\n';
/** 形式 1 の玉型の R 行を、最後の 1 行だけ取り除いた本文(点数が足りない)。 */
const short = (() => { const lines = sample.split(CRLF); const last = lines.map(l => l.startsWith('R=')).lastIndexOf(true); lines.splice(last, 1); return lines.join(CRLF); })();
const bin2 = values => 'R=' + VCA.escapeBinary(VCA.encodeBinary(2, values));

test('正常なサンプルには止める理由も警告もない', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'samples')).filter(n => n.endsWith('.vca')).map(n => n.slice(0, -4))) {
    const body = fs.readFileSync(path.join(__dirname, '..', 'samples', f + '.vca'), 'latin1');
    assert.deepEqual(checkBody(body), { blockers: [], notices: [] }, f);
  }
});

test('玉型の点数が足りなければ止める', () => {
  const c = checkBody(short);
  assert.equal(c.blockers.length, 1);
  assert.match(c.blockers[0], /右眼の玉型: TRCFMT の点数 360 に対して半径が \d+ 個です/);
});

test('R 行がまるごと無い、復号できない、未対応の形式も止める', () => {
  assert.equal(checkBody('TRCFMT=1;360;E;R;F' + CRLF).blockers.length, 1, 'R なし');
  const broken = checkBody('TRCFMT=2;3;E;R;F' + CRLF + bin2([2500, 2500, 2500]).slice(0, -1) + CRLF);
  assert.equal(broken.blockers.length, 1, '途中で切れたバイナリ(重複して数えない)');
  assert.match(broken.blockers[0], /^R:/);
  assert.equal(checkBody('TRCFMT=4;8;E;R;F' + CRLF + 'R=\x01\x02' + CRLF).blockers.length, 1, '形式 4');
  assert.equal(checkBody('TRCFMT=1;2;E;R;F' + CRLF + 'R=2500;25x0' + CRLF).blockers.length, 1, '数値でない半径');
});

test('サグ(Z)の問題は中継しないので知らせるだけ', () => {
  const c = checkBody(sample + 'ZFMT=2;3;E;R;F' + CRLF + 'Z=\x01\x02\x03' + CRLF);
  assert.deepEqual(c.blockers, []);
  assert.equal(c.notices.length, 1);
});

test('そのまま中継する行が 80 文字を超える、ASCII 以外を含むときは知らせる', () => {
  const c = checkBody(sample + '_NOTE=' + 'x'.repeat(80) + CRLF + 'FRAM=ABC\xe9' + CRLF);
  assert.deepEqual(c.blockers, []);
  assert.equal(c.notices.length, 2);
  assert.match(c.notices[0], /_NOTE の行が 86 文字/);
  assert.match(c.notices[1], /FRAM の行に ASCII 以外/);
});

test('作り直す玉型の行と、付け直す通信用の行は検査しない', () => {
  const c = checkBody(sample.replace('REQ=FIL', 'REQ=FIL;' + 'y'.repeat(90)) + 'TRCFMT=2;3;E;L;F' + CRLF + bin2([2500, 2600, 2700]) + CRLF);
  assert.deepEqual(c, { blockers: [], notices: [] });
});

test('止める理由があると送信待ちにできず、状態は変わらない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-check-'));
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: short, type: 'TRC', job: 'K1', peer: 'p', crcOk: null });
    assert.equal(e.check.blockers.length, 1, '受信時の検査結果を索引に残す');
    assert.throws(() => store.queue(e.id, 'K1'), err => err.code === 'blocked' && err.blockers.length === 1);
    assert.equal(store.get(e.id).status, 'received');
    assert.equal(store.findQueued('K1'), null);
    const ok = store.saveReceived({ body: sample + '_NOTE=' + 'x'.repeat(80) + CRLF, type: 'TRC', job: 'K2', peer: 'p', crcOk: null });
    assert.equal(store.queue(ok.id, 'K2').status, 'queued', '警告だけなら送信待ちにできる');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('管理画面: 止める理由があれば 409 と理由を返し、詳細に検査結果を含める', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-check-web-'));
  const cfg = merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, remote: { enabled: false }, web: { enabled: true, host: '127.0.0.1', port: 0 } });
  const hub = createHub(cfg);
  const { web } = await hub.start();
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: web, method, path: p, headers: { Host: `localhost:${web}`, 'X-VCA-Hub': '1', 'Content-Type': 'application/json' } }, res => {
      let s = ''; res.on('data', c => { s += c; }); res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(s) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const e = hub.store.saveReceived({ body: short, type: 'TRC', job: 'K3', peer: 'p', crcOk: null });
    const d = await call('GET', `/api/jobs/${e.id}`);
    assert.equal(d.body.check.blockers.length, 1);
    const r = await call('POST', `/api/jobs/${e.id}/queue`, { confirmed: true, name: 'K3' });
    assert.equal(r.code, 409);
    assert.equal(r.body.error, 'blocked');
    assert.equal(r.body.blockers.length, 1);
    assert.equal(hub.store.get(e.id).status, 'received');
  } finally {
    await hub.stop();
    await new Promise(r => setTimeout(r, 50));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
