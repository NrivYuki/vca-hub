'use strict';
// 共有フォルダからの取り込み(設計書 6 章): 「取り込めなかった」へ移すのは VCA ファイルとして読めないものだけ。
// vca-hub の側の一時的な失敗と、ほかのソフトが開いているファイルは、移さずにやり直す。大きすぎるファイルは読まない。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { watchFolder, DONE_DIR, FAILED_DIR } = require('../src/send/folder.js');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-imp-'));
const BODY = 'JOB=J1\r\nDBL=18\r\n';
const windows = process.platform === 'win32';

function setup() {
  const dir = tmp();
  const watch = path.join(dir, 'in');
  fs.mkdirSync(watch);
  const store = new Store({ dir: path.join(dir, 'data') });
  const log = new Log({ dir: path.join(dir, 'log') });
  // 1 つの監視を続けて、手で回を進める(次の回の予約は長くしておき、最後に止める)
  let w = null;
  const scan = () => { if (w) w.scan(); else w = watchFolder({ dir: watch, store, log, settleMs: 0, intervalMs: 3600000 }); return w; };
  return { dir, watch, store, log, scan, stop: () => w && w.stop(), ls: sub => { try { return fs.readdirSync(sub ? path.join(watch, sub) : watch).filter(n => !n.startsWith('取り込')); } catch { return []; } } };
}

test('大きすぎるファイル(1 MiB を超える)は読まずに「取り込めなかった」へ移し、理由を記録に残す', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.watch, 'big.vca'), Buffer.alloc(1024 * 1024 + 1, 'A'));
    s.scan();
    assert.deepEqual(s.ls(FAILED_DIR), ['big.vca']);
    assert.equal(s.store.list().length, 0);
    assert.ok(s.log.list().some(l => l.event === 'import-failed' && /上限/.test(l.detail)));
  } finally { s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('保存できない(vca-hub の側の失敗)ときは、「取り込めなかった」へ移さず、次の回に取り込む', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.watch, 'J1.vca'), BODY);
    const orig = s.store.saveReceived;
    s.store.saveReceived = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    s.scan();
    s.scan();
    assert.deepEqual(s.ls(FAILED_DIR), []);
    assert.equal(s.store.list().length, 0);
    assert.equal(s.log.list().filter(l => l.event === 'import-retry').length, 1, '同じ理由の記録は間隔をあけて 1 度');
    s.store.saveReceived = orig;
    s.scan();
    assert.deepEqual(s.ls(DONE_DIR), ['J1.vca']);
    assert.equal(s.store.list().length, 1);
    s.scan();
    assert.equal(s.store.list().length, 1, '取り込めたら、もう取り込まない');
  } finally { s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('書く側が開いたまま(移せない)のファイルは読まない。書き終えてから 1 度だけ取り込む', { skip: !windows && 'Windows のファイルの共有の制限を使う' }, async () => {
  const s = setup();
  const file = path.join(s.watch, 'W.vca');
  fs.writeFileSync(file, 'JOB=W1\r\n');
  // 書く側: ほかから読むことは許し、名前を変えること(移すこと)は許さない。途中まで書いて止まり、あとで残りを書く
  const ps = cp.spawn('powershell', ['-NoProfile', '-Command',
    `$f=[System.IO.File]::Open('${file}','Open','Write','Read'); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Seek(0,'End') | Out-Null; $b=[Text.Encoding]::ASCII.GetBytes("DBL=18\`r\`n"); $f.Write($b,0,$b.Length); $f.Close()`]);
  await new Promise(r => ps.stdout.on('data', d => { if (String(d).includes('locked')) r(); }));
  try {
    for (let i = 0; i < 3; i++) s.scan();
    assert.equal(s.store.list().length, 0, '書きかけを取り込まない');
    assert.deepEqual(s.ls(), ['W.vca']);
    await new Promise(r => { ps.once('exit', r); ps.stdin.end('\n'); });
    s.scan();
    s.scan();
    const list = s.store.list();
    assert.equal(list.length, 1);
    assert.ok(s.store.readBody(list[0]).includes('DBL=18'), '書き終えた中身');
  } finally {
    s.stop();
    if (ps.exitCode === null) await new Promise(r => { ps.once('exit', r); ps.stdin.end('\n'); });
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('VCA のレコードが無いファイルは「取り込めなかった」へ移す', () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.watch, 'x.vca'), 'これは VCA ではない');
    s.scan();
    assert.deepEqual(s.ls(FAILED_DIR), ['x.vca']);
  } finally { s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('ほかのソフトが開いていて読めないファイルは、移さずに残し、記録は間隔をあけて 1 度', { skip: !windows && 'Windows のファイルの共有の制限を使う' }, async () => {
  const s = setup();
  const file = path.join(s.watch, 'L.vca');
  fs.writeFileSync(file, BODY);
  const ps = cp.spawn('powershell', ['-NoProfile', '-Command',
    `$f=[System.IO.File]::Open('${file}','Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Close()`]);
  await new Promise(r => ps.stdout.on('data', d => { if (String(d).includes('locked')) r(); }));
  try {
    for (let i = 0; i < 5; i++) s.scan();
    assert.deepEqual(s.ls(), ['L.vca']);
    assert.deepEqual(s.ls(FAILED_DIR), []);
    assert.equal(s.log.list().filter(l => l.event === 'import-retry').length, 1);
  } finally {
    s.stop();
    await new Promise(r => { ps.once('exit', r); ps.stdin.end('\n'); });
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('移した後・保存の前に止まったら、起動し直したときに取り込む。保存の後に止まっても、2 度は取り込まない', () => {
  const s = setup();
  try {
    const pendingFile = path.join(s.dir, 'data', 'import-pending.json');
    // 移した後・保存の前に止まった: 取り込み済みにファイルがあり、印が残っている
    fs.mkdirSync(path.join(s.watch, DONE_DIR));
    fs.writeFileSync(path.join(s.watch, DONE_DIR, 'J1.vca'), BODY);
    fs.writeFileSync(pendingFile, JSON.stringify(['J1.vca']));
    const start = () => watchFolder({ dir: s.watch, store: new Store({ dir: path.join(s.dir, 'data') }), log: s.log, settleMs: 0, intervalMs: 3600000 }).stop();
    start();
    assert.equal(new Store({ dir: path.join(s.dir, 'data') }).list().length, 1, '取り込み直す');
    assert.deepEqual(JSON.parse(fs.readFileSync(pendingFile, 'utf8')), []);
    // 保存の後・印を消す前に止まった: 印だけが残っている
    fs.writeFileSync(pendingFile, JSON.stringify(['J1.vca']));
    start();
    assert.equal(new Store({ dir: path.join(s.dir, 'data') }).list().length, 1, '同じファイルを 2 度取り込まない');
    // 印を残した後・移す前に止まった: 印のファイルは取り込み済みに無く、元のフォルダにある
    fs.writeFileSync(path.join(s.watch, 'J2.vca'), 'JOB=J2\r\nDBL=18\r\n');
    fs.writeFileSync(pendingFile, JSON.stringify(['J2.vca']));
    start();
    const list = new Store({ dir: path.join(s.dir, 'data') }).list();
    assert.equal(list.length, 2, '元のフォルダから 1 度取り込む');
    assert.deepEqual(s.ls(DONE_DIR).sort(), ['J1.vca', 'J2.vca']);
  } finally { s.stop(); fs.rmSync(s.dir, { recursive: true, force: true }); }
});
