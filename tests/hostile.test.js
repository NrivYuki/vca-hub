'use strict';
// 悪意のある入力・壊れた入力: 個人情報の除去をすり抜けないこと、長く止まらないこと、記録が膨らまないこと、
// 取り込むフォルダの外を触らないこと。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const VCA = require('../src/lib/vca-parser.js');
const T = require('../src/lib/vca-tcp.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { Store } = require('../src/store/store.js');
const { checkBody } = require('../src/send/check.js');
const { buildDownload } = require('../src/send/build.js');
const { purgeImported, watchFolder, DONE_DIR } = require('../src/send/folder.js');
const { Log } = require('../src/log.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-hos-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const FAST = { ack: 1, packet: 2, char: 1 };
const DAY = 86400000;
const windows = process.platform === 'win32';

// ---- PROC の 1 つ目の欄 ----
test('PROC の 1 つ目の欄に * や = があっても、個人情報の項目なら除き、ラベルの形でなければ送り出さない', () => {
  const s = Object.create(Store.prototype);
  const { body, removed } = s.stripPII('PROC=CLIENT=x;EDG;;;Hanako\r\nPROC=*CLIENT;EDG;;;Jiro\r\nPROC= cllnam ;EDG;;;A\r\nPROC=LMATID;EDG;;;1;1\r\n');
  assert.equal(body, 'PROC=LMATID;EDG;;;1;1\r\n');
  assert.deepEqual(removed.sort(), ['CLIENT', 'CLLNAM']);
  for (const first of ['JOB=EVIL', 'R=1', '*LMATID', 'A B', '']) {
    const b = `JOB=X\r\nPROC=${first};EDG;;;1;1\r\n`;
    assert.ok(checkBody(b).blockers.length > 0, first);
    assert.throws(() => buildDownload({ body: b, profile: null, device: { dev: 'EDG', ven: 'V', model: 'M', sn: '' } }), e => e.code === 'device-specific-invalid', first);
  }
});

// ---- 長く止まらないこと ----
test('壊れた玉型をたくさん含むデータでも、検査は長くかからない(玉型とエラーの数の積にならない)', () => {
  let b = 'JOB=X\r\n';
  for (let i = 0; i < 20000; i++) b += 'TRCFMT=1;3;E;R;F\r\nR=x;y;z\r\n';
  const t = Date.now();
  checkBody(b);
  assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
});

test('機器ごとの値の行が多いデータでも、加工機への応答は長くかからない', () => {
  let b = 'JOB=X\r\nDBL=18\r\n';
  for (let i = 0; i < 40000; i++) b += `PROC=L${i};EDG;;;1\r\n`;
  const t = Date.now();
  const out = buildDownload({ body: b, profile: null, device: { dev: 'EDG', ven: 'V', model: 'M', sn: '' } });
  assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms`);
  assert.equal(out.length, 40002);
});

// ---- 初期化のラベル一覧 ----
test('初期化のラベル一覧が多すぎるか、ラベルの形でないものがあれば、初期化を断る(STATUS=13)。要求 ID の記録に残さない', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, timeouts: FAST, connectDelay: 0 }));
  const { remote } = await hub.start();
  const dev = await T.connectDevice('127.0.0.1', remote, { connectDelay: 0, timeouts: { ack: 4, packet: 6, char: 2 } });
  try {
    const who = [['DEV', 'EDG'], ['VEN', 'V'], ['MODEL', 'M']];
    const many = Array.from({ length: 1001 }, (_, i) => 'L' + i);
    const ng = await dev.initialize(who, { tag: 'T', labels: many });
    assert.equal(ng.hostStatus, 13);
    assert.equal(hub.registry.list().length, 0);
    const ok = await dev.initialize(who, { tag: 'T', labels: ['DBL', 'DBL', 'IPD'] });
    assert.ok(ok.requestId, '重なりは 1 つにして受ける');
    assert.deepEqual(hub.registry.get(ok.requestId).labels, ['DBL', 'IPD']);
  } finally { dev.socket.destroy(); await hub.stop(); await wait(50); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 取り込むフォルダの外 ----
test('「取り込み済み」がジャンクションで外を指していたら、外のファイルを消さず、移さない', { skip: !windows && 'Windows のジャンクションを使う' }, () => {
  const dir = tmp();
  try {
    const imp = path.join(dir, 'in'), victim = path.join(dir, 'victim');
    fs.mkdirSync(imp); fs.mkdirSync(victim);
    const keep = path.join(victim, 'important.docx');
    fs.writeFileSync(keep, 'x');
    const old = new Date(Date.now() - 200 * DAY);
    fs.utimesSync(keep, old, old);
    cp.execFileSync('cmd', ['/c', 'mklink', '/J', path.join(imp, DONE_DIR), victim], { stdio: 'ignore' });
    assert.throws(() => purgeImported(imp, 90), e => e.code === 'unsafe-folder');
    assert.ok(fs.existsSync(keep));
    fs.writeFileSync(path.join(imp, 'J1.vca'), 'JOB=J1\r\nDBL=18\r\n');
    const log = new Log({ dir: path.join(dir, 'log') });
    const w = watchFolder({ dir: imp, store: new Store({ dir: path.join(dir, 'data') }), log, settleMs: 0, intervalMs: 3600000 });
    w.stop();
    assert.deepEqual(fs.readdirSync(victim), ['important.docx'], '外へ移さない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
