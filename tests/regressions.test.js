'use strict';
// ほかの働きと組み合わせたときにも正しく動くこと。保存期間の時刻、索引の戻し、系列の行、穴あけ、ラベルの形、アップロードの玉型、
// 拡張を通したバイナリの玉型、保存期間の「今」、一覧の版。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const VCA = require('../src/lib/vca-parser.js');
const { Store } = require('../src/store/store.js');
const { hostOptions } = require('../src/host/session.js');
const { checkBody } = require('../src/send/check.js');
const { buildDownload } = require('../src/send/build.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-reg-'));
const CRLF = '\r\n';
const DAY = 86400000;
const BODY = 'DO=R' + CRLF + 'JOB=A' + CRLF + 'DBL=18' + CRLF;
const req = lines => VCA.parse(lines.join(CRLF) + CRLF);

test('時刻が未来の記録が 1 件あっても、後に受け取った記録は保存期間で消す(未来の時刻は「今」として数える)', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const a = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = store.saveReceived({ body: BODY.replace('DBL=18', 'DBL=19'), type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    store.get(a.id).receivedAt = '2036-01-01T00:00:00.000Z';
    store.get(b.id).receivedAt = '2026-04-15T00:00:00.000Z';   // 保存期間(30 日)を過ぎ、30 日より多くは過ぎていない
    const purged = store.purge(30, new Date('2026-06-01T00:00:00Z')).map(e => e.id);
    assert.ok(purged.includes(b.id), '後に受け取ったものは消す');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('形の違う索引を読んだとき、正しい 1 つ前の索引(.bak)を壊れた中身で上書きしない', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    store.queue(e.id, 'A');
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ x: 1 }));
    const again = new Store({ dir });
    assert.ok(again.recovered);
    again.unqueue(e.id);   // 索引を書く(このときに 1 つ前の索引を残す)
    const bak = JSON.parse(fs.readFileSync(path.join(dir, 'index.json.bak'), 'utf8'));
    assert.ok(Array.isArray(bak), '1 つ前の索引は正しい形のまま');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('系列が 2 行以上のデータセット(STHKFMT の T など)を、1 つしか置けないレコードの重なりとして止めない(5.1.9)', () => {
  const body = ['DO=R', 'STHKFMT=1;8;U;R', 'R=1;2;3;4', 'R=5;6;7;8', 'A=0;45;90;135', 'A=180;225;270;315', 'T=200;210;220;230', 'T=240;250;260;270'].join(CRLF) + CRLF;
  assert.deepEqual(checkBody(body).blockers, []);
});

test('穴あけの基準を取り決めた機器に、DRILL だけのジョブは渡さない(DRILLE に作り直せない。5.5.1.5)', () => {
  assert.throws(() => buildDownload({ body: 'DO=B\r\nDRILL=B;1;2;3\r\nDBL=18\r\n', profile: { labels: ['DBL'], trcfmt: null, drill: 'C' } }), e => e.code === 'drill-reference');
  const store = { reserve: () => ({ entry: { id: 'x' } }), readBody: () => 'DO=B\r\nDRILL=B;1;2;3\r\nDBL=18\r\n', release() {}, checkOf: () => ({ blockers: [], notices: [] }) };
  const o = hostOptions({ store, registry: { get: () => null }, log: { write() {} }, peer: 'p' });
  assert.deepEqual(o.onRequest(req(['REQ=EDG', 'JOB=J', 'DEV=EDG', 'DRLFMT=C']), { type: 'EDG', job: 'J', kind: 'download' }), { status: 4, text: 'drill-reference' });
});

test('初期化のラベル一覧と PROC の 1 つ目の欄に、. と - を含むラベルを使える(5.1.6)', () => {
  const saved = [];
  const o = hostOptions({ store: {}, registry: { save: (id, v) => saved.push(v) }, log: { write() {} }, peer: 'p' });
  const r = o.onInit(req(['DEV=EDG', 'VEN=V', 'MODEL=M', 'DEF=T', 'D=DBL;ACME.X;X-1']), [], { requestId: '1' });
  assert.equal(r, undefined);
  assert.deepEqual(saved[0].labels, ['DBL', 'ACME.X', 'X-1']);
  assert.ok(!checkBody('DO=R\r\nPROC=ACME.X;EDG;;;1\r\n').blockers.some(b => /ラベルの形/.test(b)));
});

test('アップロードでは角度のモード C と 3600 点を超える玉型も受け、ダウンロードでは点数の上限を保つ', () => {
  const o = hostOptions({ store: {}, registry: { get: () => null }, log: { write() {} }, peer: 'p' });
  const up = lines => o.onRequest(req(['REQ=TRC', 'JOB=J', 'DEV=TRC', ...lines]), { type: 'TRC', job: 'J', kind: 'upload' });
  assert.deepEqual(up(['TRCFMT=1;4;C;R;F']).records, [['TRCFMT', '1', '4', 'C', 'R', 'F']]);
  assert.deepEqual(up(['TRCFMT=1;4000;E;R;F']).records, [['TRCFMT', '1', '4000', 'E', 'R', 'F']]);
  const store = { reserve: () => ({ entry: { id: 'x' } }), readBody: () => BODY, release() {}, checkOf: () => ({ blockers: [], notices: [] }) };
  const d = hostOptions({ store, registry: { get: () => null }, log: { write() {} }, peer: 'p' });
  assert.equal(d.onRequest(req(['REQ=EDG', 'JOB=J', 'DEV=EDG', 'TRCFMT=1;4000;E;R']), { type: 'EDG', job: 'J', kind: 'download' }).status, 17 + 512);
});

test('拡張が入っていても、バイナリの玉型(形式 2-4)を加工機へ渡せる(系列の行の制御文字は正しい。5.1.7.3)', () => {
  const dir = tmp();
  try {
    const extDir = path.join(dir, 'ext');
    fs.mkdirSync(path.join(extDir, 'x'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'x', 'index.js'), "module.exports = { setup(h) { h.on('send', ({ records }) => records); } };");
    const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, extensionsDir: extDir, extensions: { x: true } }));
    const radii = Array.from({ length: 36 }, (_, i) => String(2000 + i * 7));
    const body = ['DO=R', 'JOB=B', 'TRCFMT=1;36;E;R;F', ...[0, 1, 2].map(i => 'R=' + radii.slice(i * 12, i * 12 + 12).join(';'))].join(CRLF) + CRLF;
    const e = hub.store.saveReceived({ body, type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    for (const fmt of [2, 3, 4]) {
      const out = hub.recordsFor(e, { kind: 'device', device: { dev: 'EDG' }, profile: { labels: [], preset: true, trcfmt: { fmt, n: 36, mode: 'E', eye: 'R' } } });
      assert.ok(out.some(r => r[0] === 'TRCFMT' && r[1] === String(fmt)), `形式 ${fmt}`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('起動したときに時計が進んでいて、後で直したら、保存期間はすぐに直した時計に従う(今日のログを消さない)', async () => {
  const dir = tmp();
  const real = Date.now;
  Date.now = () => real() + 100 * DAY;   // 起動したときは時計が 100 日進んでいた
  let hub;
  try { hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, retentionDays: 90 })); } finally { Date.now = real; }
  try {
    hub.log.write('info', { event: 'test' });   // 今日のログ
    const today = path.join(dir, 'data', 'log', new Date().toISOString().slice(0, 10) + '.log');
    assert.ok(fs.existsSync(today));
    hub.purge();
    // 消したことの記録を後から書くので、ファイルがあるかではなく、前に書いた記録が残っているかを見る
    assert.ok(fs.readFileSync(today, 'utf8').includes('"event":"test"'), '今日のログを消さない');
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('管理画面の一覧の版は、起動し直すと前の起動の版と重ならない', async () => {
  const dir = tmp();
  const tagOf = async () => {
    const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: false } }));
    const ports = await hub.start();
    try {
      return await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: ports.web, path: '/api/jobs', headers: { Host: `localhost:${ports.web}` } }, res => { res.resume(); resolve(res.headers.etag); }).on('error', reject));
    } finally { await hub.stop(); }
  };
  try {
    const a = await tagOf(), b = await tagOf();
    assert.ok(a && b && a !== b);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
