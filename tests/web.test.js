'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
let hub, web, dir, id;

/** Host ヘッダーを自由に指定できるよう http モジュールで呼ぶ。 */
function call(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: web, method, path: p, headers: { Host: `localhost:${web}`, ...headers } }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: s ? JSON.parse(s.startsWith('<') ? '""' : s) : null, raw: s }));
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-web-'));
  const cfg = merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: dir, remote: { enabled: false }, web: { enabled: true, host: '127.0.0.1', port: 0 },
  });
  hub = createHub(cfg);
  ({ web } = await hub.start());
  id = hub.store.saveReceived({ body: sample.replace('REQ=FIL', 'ANS=TRC'), type: 'TRC', job: 'W1', peer: 'test', crcOk: null }).id;
});

test.after(async () => {
  await hub.stop();
  await new Promise(r => setTimeout(r, 50));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('画面と一覧・詳細を取得できる', async () => {
  const page = await call('GET', '/');
  assert.equal(page.code, 200);
  assert.ok(page.raw.includes('vca-hub'));
  const list = await call('GET', '/api/jobs');
  assert.equal(list.body[0].job, 'W1');
  const d = await call('GET', `/api/jobs/${id}`);
  assert.equal(d.body.traces[0].points.length, 360);
});

test('localhost 以外の Host 名は拒否する(DNS リバインディング対策)', async () => {
  const r = await call('GET', '/api/jobs', { headers: { Host: 'evil.example:8765' } });
  assert.equal(r.code, 403);
});

test('独自ヘッダーのない変更操作は拒否する(CSRF 対策)', async () => {
  const r = await call('POST', `/api/jobs/${id}/queue`, { body: { confirmed: true, name: 'W1' } });
  assert.equal(r.code, 403);
});

test('送信待ちにするには、確認(confirmed)と、人が付けた名前が要る', async () => {
  const h = { 'X-VCA-Hub': '1', 'Content-Type': 'application/json' };
  assert.equal(hub.store.get(id).name, null, '受け取ったときは名前なし');
  assert.equal((await call('POST', `/api/jobs/${id}/queue`, { body: { name: 'W1' }, headers: h })).code, 400, '確認なし');
  assert.equal((await call('POST', `/api/jobs/${id}/queue`, { body: { confirmed: true }, headers: h })).code, 400, '名前なし');
  const bad = await call('POST', `/api/jobs/${id}/queue`, { body: { confirmed: true, name: '../W1' }, headers: h });
  assert.equal(bad.body.error, 'bad-name', 'フォルダをさかのぼる名前');
  const ok = await call('POST', `/api/jobs/${id}/queue`, { body: { confirmed: true, name: 'W-NAME' }, headers: h });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.status, 'queued');
  assert.equal(ok.body.name, 'W-NAME');
  assert.equal(ok.body.job, 'W1', '受け取った JOB は残す');
  const un = await call('POST', `/api/jobs/${id}/unqueue`, { body: {}, headers: h });
  assert.equal(un.body.status, 'received');
});

test('削除すると一覧から消え、ファイルも消える', async () => {
  const h = { 'X-VCA-Hub': '1' };
  const file = path.join(dir, hub.store.get(id).file);
  assert.ok(fs.existsSync(file));
  assert.equal((await call('DELETE', `/api/jobs/${id}`, { headers: h })).code, 200);
  assert.equal(fs.existsSync(file), false);
  assert.equal((await call('GET', '/api/jobs')).body.length, 0);
});

test('管理画面は 127.0.0.1 だけで待ち受ける', () => {
  assert.equal(loadConfig(path.join(dir, 'none.json')).web.host, '127.0.0.1');
});
