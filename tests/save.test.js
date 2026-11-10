'use strict';
// 保存の失敗に関するテスト。Windows で rename が EPERM になる状況を、fs.renameSync の差し替えで再現する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic } = require('../src/lib/atomic.js');
const { Store } = require('../src/store/store.js');
const { Registry } = require('../src/host/registry.js');

const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const realRename = fs.renameSync;

/** 最初の times 回だけ code のエラーで失敗する rename に差し替える(Infinity なら毎回失敗)。 */
function failRename(times, code = 'EPERM') {
  let n = 0;
  fs.renameSync = (...args) => {
    if (n++ < times) throw Object.assign(new Error(`${code}: mock`), { code });
    return realRename(...args);
  };
  return () => n;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-save-')); }

test.afterEach(() => { fs.renameSync = realRename; });

test('rename が一時的に EPERM になっても、再試行して保存できる', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'a.json');
    const calls = failRename(2);
    writeJsonAtomic(file, { ok: 1 });
    assert.equal(calls(), 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: 1 });
    assert.equal(fs.existsSync(file + '.tmp'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('失敗が続けば例外を投げ、一時ファイルは残さない。再試行しないエラーはすぐ投げる', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'a.json');
    let calls = failRename(Infinity);
    assert.throws(() => writeJsonAtomic(file, {}, { waitMs: 1 }), { code: 'EPERM' });
    assert.equal(calls(), 10);
    assert.equal(fs.existsSync(file + '.tmp'), false);
    calls = failRename(Infinity, 'ENOSPC');
    assert.throws(() => writeJsonAtomic(file, {}), { code: 'ENOSPC' });
    assert.equal(calls(), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('送信済みの記録に失敗したら、メモリ上も送信待ちのまま(ファイルと食い違わない)', () => {
  const dir = tmpDir();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: sample, type: 'TRC', job: 'S1', peer: '127.0.0.1:5000', crcOk: null });
    store.queue(e.id, 'S1');
    failRename(Infinity);
    assert.throws(() => store.markSent(e.id, 'EDGER'), { code: 'EPERM' });
    fs.renameSync = realRename;
    assert.equal(store.get(e.id).status, 'queued');
    assert.deepEqual(store.get(e.id).sent, []);
    assert.equal(new Store({ dir }).get(e.id).status, 'queued', '読み直しても同じ');
    store.markSent(e.id, 'EDGER');
    assert.equal(new Store({ dir }).get(e.id).status, 'sent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('受信の保存で索引に書けなければ、ファイルを残さず索引も変えない', () => {
  const dir = tmpDir();
  try {
    const store = new Store({ dir });
    failRename(Infinity);
    assert.throws(() => store.saveReceived({ body: sample, type: 'TRC', job: 'S2', peer: '127.0.0.1:5000', crcOk: null }));
    fs.renameSync = realRename;
    assert.equal(store.list().length, 0);
    const day = fs.readdirSync(path.join(dir, 'inbox'))[0];
    assert.deepEqual(fs.readdirSync(path.join(dir, 'inbox', day)), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('削除で索引に書けなければ、ファイルも索引も残る', () => {
  const dir = tmpDir();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: sample, type: 'TRC', job: 'S3', peer: 'p', crcOk: null });
    failRename(Infinity);
    assert.throws(() => store.remove(e.id));
    fs.renameSync = realRename;
    assert.ok(store.get(e.id));
    assert.ok(fs.existsSync(path.join(dir, e.file)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('要求 ID の割り当てで保存に失敗したら、番号を進めない', () => {
  const dir = tmpDir();
  try {
    const reg = new Registry({ file: path.join(dir, 'devices.json') });
    const def = { tag: 'T', labels: [], device: { ven: 'V', model: 'M' }, trcfmt: null, zfmt: false, kind: 'download', drill: null, peer: 'p' };
    failRename(Infinity);
    assert.throws(() => reg.nextId());
    assert.throws(() => reg.save('1000', def));
    fs.renameSync = realRename;
    assert.equal(reg.list().length, 0);
    assert.equal(reg.nextId(), '1000');
    reg.save('1000', def);
    reg.save(reg.nextId(), def);
    assert.deepEqual(reg.list().map(r => r.id), ['1001'], '同じ機器・同じタグの前の要求 ID は消す');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ファイル名の受信元は IP とポートを - で区切る', () => {
  const dir = tmpDir();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: sample, type: 'TRC', job: 'S4', peer: '127.0.0.1:54435', crcOk: null });
    assert.match(path.basename(e.file), /^S4_\d{6}_127\.0\.0\.1-54435\.vca$/);
    assert.equal(e.peer, '127.0.0.1:54435', '索引の受信元は元の表記のまま');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
