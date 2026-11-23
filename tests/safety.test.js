'use strict';
// 安全の側に倒す既定と制限: 待ち受けの接続の数、保存期間(ログ・取り込んだ元のファイル)、管理画面と許可範囲の既定。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { loadConfig, merge, DEFAULTS } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { Log } = require('../src/log.js');
const { watchFolder, purgeImported, DONE_DIR, FAILED_DIR } = require('../src/send/folder.js');
const { startWeb } = require('../src/web/server.js');
const { isAllowed } = require('../src/net/tcp.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-safe-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const DAY = 86400000;

// ---- 待ち受けの接続の数 ----
function open(port, localAddress) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1', localAddress });
    const state = { socket: s, closed: false };
    s.once('close', () => { state.closed = true; });
    s.once('error', () => {});
    s.once('connect', () => resolve(state));
  });
}

test('待ち受けは、相手の IP ごとと全体の接続の数を限り、超えた接続は断って記録に残す。切れたら数から外す', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, allow: ['127.0.0.0/8'],
    connections: { total: 3, perAddress: 2 },
  }));
  const { remote: port } = await hub.start();
  const all = [];
  try {
    all.push(await open(port, '127.0.0.1'), await open(port, '127.0.0.1'));
    const third = await open(port, '127.0.0.1');
    all.push(third);
    await wait(200);
    assert.equal(third.closed, true, '同じ IP の 3 本目は断る');
    assert.ok(!all[0].closed && !all[1].closed);
    const other = await open(port, '127.0.0.2');
    all.push(other);
    const over = await open(port, '127.0.0.3');
    all.push(over);
    await wait(200);
    assert.equal(other.closed, false, 'ほかの IP からは受ける');
    assert.equal(over.closed, true, '全体で 3 本を超えたら断る');
    const rejected = hub.log.list().filter(l => l.event === 'rejected').map(l => l.detail);
    assert.equal(rejected.length, 2);
    assert.ok(rejected.some(d => /この相手から同時に開いておける接続の数/.test(d)) && rejected.some(d => /全体/.test(d)));
    all[0].socket.destroy();
    await wait(200);
    const again = await open(port, '127.0.0.1');
    all.push(again);
    await wait(200);
    assert.equal(again.closed, false, '切れた分だけ、また受ける');
  } finally {
    all.forEach(s => s.socket.destroy());
    await hub.stop(); await wait(100); fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 保存期間 ----
test('保存期間の既定は 90 日。config.json に null を書けば無期限', () => {
  assert.equal(DEFAULTS.retentionDays, 90);
  const dir = tmp();
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ retentionDays: null }));
    assert.equal(loadConfig(file).retentionDays, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ログは、保存期間を過ぎた日のファイルを消す。期限の日と、ログでないファイルは残す', () => {
  const dir = tmp();
  try {
    const log = new Log({ dir });
    for (const n of ['2026-01-01.log', '2026-02-18.log', '2026-02-19.log', 'memo.txt']) fs.writeFileSync(path.join(dir, n), '');
    const removed = log.purge(30, new Date('2026-03-21T12:00:00Z'));
    assert.deepEqual(removed.sort(), ['2026-01-01.log', '2026-02-18.log']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-02-19.log', 'memo.txt']);
    assert.deepEqual(log.purge(null), [], '無期限なら消さない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('取り込んだ元のファイルは、移した時から数えて保存期間を過ぎたら消す(取り込み済み・取り込めなかった)', async () => {
  const dir = tmp();
  try {
    const store = { saveReceived: () => ({ id: 'x', job: 'J' }), hasSource: () => false };
    const log = new Log({ dir: path.join(dir, 'log') });
    const old = new Date(Date.now() - 400 * DAY);
    fs.writeFileSync(path.join(dir, 'a.vca'), 'JOB=A\r\nDBL=18\r\n');
    fs.writeFileSync(path.join(dir, 'b.vca'), 'これは VCA ではない');
    for (const n of ['a.vca', 'b.vca']) fs.utimesSync(path.join(dir, n), old, old);
    const w = watchFolder({ dir, store, log, settleMs: 0, intervalMs: 60000 });
    w.stop();
    const moved = path.join(dir, DONE_DIR, 'a.vca'), failed = path.join(dir, FAILED_DIR, 'b.vca');
    assert.ok(Date.now() - fs.statSync(moved).mtimeMs < DAY, '書き込みの古いファイルも、移した時から数える');
    assert.deepEqual(purgeImported(dir, 90), [], 'まだ期間の中');
    fs.utimesSync(moved, old, old);
    fs.utimesSync(failed, old, old);
    assert.deepEqual(purgeImported(dir, 90).sort(), [path.join(DONE_DIR, 'a.vca'), path.join(FAILED_DIR, 'b.vca')].sort());
    assert.deepEqual(fs.readdirSync(path.join(dir, DONE_DIR)), []);
    assert.deepEqual(purgeImported(dir, null), [], '無期限なら消さない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 管理画面と許可範囲 ----
test('管理画面は、この PC 以外のアドレスでは待ち受けない(認証が無いため)', async () => {
  await assert.rejects(startWeb({ host: '0.0.0.0', port: 0 }), e => e.code === 'web-host');
  await assert.rejects(startWeb({ host: '192.168.1.10', port: 0 }), e => e.code === 'web-host');
});

test('許可範囲の既定は、この PC だけ', () => {
  assert.ok(isAllowed('127.0.0.1', DEFAULTS.allow) && isAllowed('::1', DEFAULTS.allow));
  for (const ip of ['192.168.1.10', '10.0.0.5', '172.16.0.1', 'fd00::1']) assert.equal(isAllowed(ip, DEFAULTS.allow), false, ip);
});

test('書き出し先と取り込むフォルダが同じか、片方がもう片方の中にあれば起動しない(書き出したものを取り込み直すため)', async () => {
  const dir = tmp();
  try {
    const base = { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false } };
    for (const [ex, im] of [['share', 'share'], ['share', 'share/in'], ['share/out', 'share'], ['SHARE', 'share']]) {
      if (ex !== ex.toLowerCase() && process.platform !== 'win32') continue;
      const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { ...base, exportDir: path.join(dir, ex), importDir: path.join(dir, im) }));
      await assert.rejects(hub.start(), e => e.code === 'folder-overlap', `${ex} と ${im}`);
      await hub.stop();
    }
    const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { ...base, exportDir: path.join(dir, 'out'), importDir: path.join(dir, 'in') }));
    await hub.start();
    await hub.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('書き出し先に残った書き出しの途中の一時ファイルは、動いていないプロセスの古いものだけ消す', () => {
  const { cleanExportTemps } = require('../src/send/folder.js');
  const dir = tmp();
  try {
    const old = new Date(Date.now() - DAY);
    const dead = 999999;   // 動いていないプロセスの番号
    const files = { [`.J1.${dead}.tmp`]: old, [`.J2.${process.pid}.tmp`]: old, [`.J3.${dead}.tmp`]: new Date(), 'J4.vca': old, [`J5.${dead}.tmp`]: old };
    for (const [n, t] of Object.entries(files)) { fs.writeFileSync(path.join(dir, n), 'x'); fs.utimesSync(path.join(dir, n), t, t); }
    assert.deepEqual(cleanExportTemps(dir), [`.J1.${dead}.tmp`]);
    assert.deepEqual(fs.readdirSync(dir).sort(), [`.J2.${process.pid}.tmp`, `.J3.${dead}.tmp`, 'J4.vca', `J5.${dead}.tmp`].sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
