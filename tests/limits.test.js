'use strict';
// 取り違えを起こさないこと・限りなく増えないこと: 送信待ちの名前、管理画面、要求 ID の記録、オートコネクトの記録、保存期間の処理。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const dgram = require('node:dgram');
const VCA = require('../src/lib/vca-parser.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { Store } = require('../src/store/store.js');
const { Registry } = require('../src/host/registry.js');
const { hostOptions } = require('../src/host/session.js');
const { Log } = require('../src/log.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-lim-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const BODY = 'JOB=X\r\nDBL=18\r\n';
const DAY = 86400000;

async function makeHub(over = {}) {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, connectDelay: 0, ...over(dir),
  }));
  const ports = await hub.start();
  return { hub, dir, ports, async done() { await hub.stop(); await wait(50); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ---- 送信待ちの名前(設計書 6 章: 送信待ちの別のデータと同じ名前は付けられない。加工機は名前で求める) ----
test('書き出し・送り先への送信で、送信待ちのデータの名前を変えない(同じ名前が 2 つ送信待ちにならない)', async () => {
  const h = await makeHub(dir => ({ exportDir: path.join(dir, 'out') }));
  try {
    const a = h.hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = h.hub.store.saveReceived({ body: BODY + 'LMATID=1;1\r\n', type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    h.hub.store.queue(a.id, 'X');
    h.hub.store.queue(b.id, 'Y');
    assert.throws(() => h.hub.exportJob(a.id, 'Y'), e => e.code === 'queued-rename');
    assert.equal(fs.existsSync(path.join(h.dir, 'out', 'Y.vca')), false, '別のデータの送信待ちの名前で書き出さない');
    assert.equal(h.hub.store.get(a.id).name, 'X');
    assert.equal(h.hub.store.findQueued('Y').id, b.id, '加工機が Y を求めたら、Y として送信待ちにした B を渡す');
    assert.equal(h.hub.store.findQueued('X').id, a.id);
    assert.ok(h.hub.exportJob(a.id, 'X').file, '同じ名前なら書き出せる');
  } finally { await h.done(); }
});

// ---- 管理画面 ----
function request(port, method, p, headers = {}, bodyParts = []) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `localhost:${port}`, ...headers } }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    resolve.req = req;
    (async () => { for (const part of bodyParts) { if (typeof part === 'function') await part(); else req.write(part); } req.end(); })();
  });
}

test('管理画面は、ほかのサイトの枠(iframe)に入れさせない', async () => {
  const h = await makeHub(() => ({ web: { enabled: true, host: '127.0.0.1', port: 0 } }));
  try {
    const r = await request(h.ports.web, 'GET', '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'self'/);
  } finally { await h.done(); }
});

test('送信待ちにする要求の本文を読む間にデータが消されたら、500 ではなく 404 を返す', async () => {
  const h = await makeHub(() => ({ web: { enabled: true, host: '127.0.0.1', port: 0 } }));
  try {
    const e = h.hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const body = JSON.stringify({ confirmed: true, name: 'N1' });
    const r = await request(h.ports.web, 'POST', `/api/jobs/${e.id}/queue`,
      { 'X-VCA-Hub': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      [body.slice(0, 5), async () => { await wait(100); h.hub.store.remove(e.id); }, body.slice(5)]);
    assert.equal(r.status, 404);
  } finally { await h.done(); }
});

// ---- 要求 ID の記録 ----
test('要求 ID の記録は 500 件までとし、古いものから消す。消した要求 ID の要求には STATUS=5(7.2.1: 初期化し直す)', () => {
  const dir = tmp();
  try {
    const r = new Registry({ file: path.join(dir, 'devices.json') });
    const ids = [];
    for (let i = 0; i < 503; i++) {
      const id = r.nextId();
      ids.push(id);
      r.save(id, { tag: 'T', labels: ['DBL'], device: { dev: 'EDG', ven: 'V', model: 'M', sn: String(i) }, trcfmt: null, kind: 'download', drill: null, peer: 'p' });
    }
    assert.equal(r.list().length, 500);
    assert.equal(r.get(ids[0]), null);
    assert.ok(r.get(ids[502]));
    const store = { reserve: () => { throw new Error('探さない'); } };
    const o = hostOptions({ store, registry: r, log: { write() {} }, peer: 'p' });
    assert.deepEqual(o.onRequest(VCA.parse('REQ=' + ids[0] + '\r\nJOB=J\r\n'), { type: ids[0], job: 'J', kind: 'download' }), { status: 5 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- オートコネクトの記録 ----
test('オートコネクトで断った知らせは、同じ相手・同じ理由なら 1 分に 1 度だけ記録する', async () => {
  const h = await makeHub(() => ({ autoconnect: { enabled: true, port: 0 } }));
  const sock = dgram.createSocket('udp4');
  try {
    // 知らせた IP が送り主と違う知らせ(つなぎに行かない)
    const msg = Buffer.from(VCA.buildPacket([['REQ', 'CON'], ['IP', '10.0.0.9'], ['PORT', '50000'], ['DEV', 'EDG'], ['VEN', 'V'], ['MODEL', 'M']]), 'latin1');
    for (let i = 0; i < 30; i++) await new Promise(r => sock.send(msg, h.ports.autoconnect, '127.0.0.1', r));
    await wait(300);
    assert.equal(h.hub.log.list().filter(l => l.event === 'autoconnect-ignored').length, 1);
  } finally { sock.close(); await h.done(); }
});

// ---- 保存期間 ----
test('保存期間の処理は、消す件数によらず索引を 1 回だけ書く', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push(store.saveReceived({ body: BODY, type: 'TRC', job: 'X' + i, peer: 'p', crcOk: null }).id);
    let writes = 0;
    const orig = fs.renameSync;
    fs.renameSync = (a, b) => { if (String(b).endsWith('index.json')) writes++; return orig(a, b); };
    try { assert.equal(store.purge(1, new Date(Date.now() + 3 * DAY)).length, 20); } finally { fs.renameSync = orig; }
    assert.equal(writes, 1);
    assert.equal(store.list().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('保存期間でログを消したら、画面に出す直近の記録からも消す', () => {
  const dir = tmp();
  try {
    const log = new Log({ dir });
    log.write('info', { event: 'queued', job: 'YAMADA01' });
    log.purge(90, new Date(Date.now() + 100 * DAY));
    assert.deepEqual(log.list(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張が受信データごとに残した情報のうち、索引に無く保存期間を過ぎたものを消す。拡張そのもののファイルは消さない', async () => {
  const h = await makeHub(() => ({ retentionDays: 30 }));
  try {
    const d = path.join(h.dir, 'data', 'ext', 'some');
    fs.mkdirSync(d, { recursive: true });
    const e = h.hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    const old = new Date(Date.now() - 60 * DAY);
    for (const n of ['20200101-000000-abcde.json', `${e.id}.json`, 'host-key.json']) { fs.writeFileSync(path.join(d, n), '{}'); fs.utimesSync(path.join(d, n), old, old); }
    h.hub.purge();
    assert.deepEqual(fs.readdirSync(d).sort(), [`${e.id}.json`, 'host-key.json'].sort());
  } finally { await h.done(); }
});
