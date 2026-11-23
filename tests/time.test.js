'use strict';
// 時刻: 時計が戻った・進んだ・ずれていたときに、データを早く消さない・要求 ID を消さない・取り込みが止まらない・記録が出なくならないこと。
// システムの時計は変えず、Date.now を一時的に差し替えるか、記録の時刻を書き換えて確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Registry } = require('../src/host/registry.js');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');
const { watchFolder, DONE_DIR } = require('../src/send/folder.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-time-'));
const CRLF = '\r\n';
const DAY = 86400000;
const BODY = 'DO=R' + CRLF + 'JOB=A' + CRLF + 'DBL=18' + CRLF;
/** Date.now だけを一時的にずらす(new Date() は変わらない) */
function shiftNow(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try { return fn(); } finally { Date.now = real; }
}

test('要求 ID の記録が上限のとき、時計が戻っても、割り当てたばかりの要求 ID は消さない(古さは割り当てた順)', () => {
  const dir = tmp();
  try {
    const r = new Registry({ file: path.join(dir, 'devices.json') });
    const def = { tag: '', labels: [], device: { dev: 'EDG' }, trcfmt: null, kind: 'download', drill: null, peer: 'p' };
    const ids = [];
    for (let i = 0; i < 500; i++) { const id = r.nextId(); ids.push(id); r.save(id, def); }
    // 前に時計が進んでいた: 保存済みの記録の作った時刻が未来
    for (const v of Object.values(r.data.requests)) v.createdAt = new Date(Date.now() + 365 * DAY).toISOString();
    const fresh = r.nextId();
    r.save(fresh, def);
    assert.ok(r.get(fresh), '割り当てたばかりの要求 ID は残す');
    assert.equal(r.get(ids[0]), null, 'いちばん先に割り当てたものを消す');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('時計が遅れていた間に受け取ったデータは、前に受け取ったものの時刻から数え、時計を直した直後に消さない', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const a = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = store.saveReceived({ body: BODY.replace('DBL=18', 'DBL=19'), type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    store.get(b.id).receivedAt = '2020-01-01T00:00:00.000Z';   // 時計が遅れていた
    assert.deepEqual(store.purge(90, new Date()).map(e => e.id), []);
    assert.deepEqual(store.purge(90, new Date(Date.now() + 100 * DAY)).map(e => e.id).sort(), [a.id, b.id].sort(), '前のものの時刻から 90 日たてば消す');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('動いている間に時計を大きく進めても、保存期間は起動したときの時計から数え、一度に消さない。ずれは記録に残す', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, retentionDays: 90 }));
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    shiftNow(10 * 365 * DAY, () => hub.purge());   // 年を打ち間違えた
    assert.ok(hub.store.get(e.id), '消さない');
    assert.ok(hub.log.list().some(l => l.event === 'clock-skew'));
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('更新時刻が未来のファイルも、大きさと時刻が変わらなければ次の回に取り込み、初めて見たときは記録に残す', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    fs.mkdirSync(watch);
    const store = new Store({ dir: path.join(dir, 'data') });
    const log = new Log({ dir: path.join(dir, 'log') });
    const f = path.join(watch, 'F.vca');
    fs.writeFileSync(f, BODY);
    const future = new Date(Date.now() + 3 * 3600000);
    fs.utimesSync(f, future, future);
    const w = watchFolder({ dir: watch, store, log, settleMs: 2000, intervalMs: 3600000 });
    assert.equal(store.list().length, 0, '初めて見たときは取り込まない');
    assert.ok(log.list().some(l => /更新時刻が未来/.test(l.detail || '')));
    w.scan();
    w.stop();
    assert.equal(store.list().length, 1, '変わらなければ次の回に取り込む');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('時計が戻ったら、間引いている記録を戻った分だけ止めず、次の失敗を書く', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    fs.mkdirSync(watch);
    const store = new Store({ dir: path.join(dir, 'data') });
    store.saveReceived = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    const log = new Log({ dir: path.join(dir, 'log') });
    fs.writeFileSync(path.join(watch, 'J.vca'), BODY);
    const w = watchFolder({ dir: watch, store, log, settleMs: 0, intervalMs: 3600000 });
    shiftNow(-3600000, () => w.scan());   // 1 時間戻った
    w.stop();
    assert.equal(log.list().filter(l => l.event === 'import-retry').length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('取り込み途中の印を失ったとき、最後の受信の時刻が未来でも、移しただけのファイルを取り込み直す', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    const data = path.join(dir, 'data');
    fs.mkdirSync(path.join(watch, DONE_DIR), { recursive: true });
    const store = new Store({ dir: data });
    const e = store.saveReceived({ body: BODY, type: 'FIL', job: 'A', peer: 'p', crcOk: null, source: `${DONE_DIR}/OLD.vca#x` });
    store.get(e.id).receivedAt = new Date(Date.now() + 365 * DAY).toISOString();   // 前に時計が進んでいた
    fs.writeFileSync(path.join(watch, DONE_DIR, 'X.vca'), BODY.replace('DBL=18', 'DBL=20'));
    fs.writeFileSync(path.join(data, 'import-pending.json'), '[壊れた');
    watchFolder({ dir: watch, store, log: new Log({ dir: path.join(dir, 'log') }), settleMs: 0, intervalMs: 3600000 }).stop();
    assert.equal(store.list().length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('前に受け取ったものが無いまま時計が遅れていた記録は、保存期間を大きく過ぎていても自動では消さず、件数を記録に出す', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, retentionDays: 90 }));
  try {
    // 新しく入れた PC で、時計が古い年に戻っていた間に受け取った(STATUS=0 を返した)
    const a = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = hub.store.saveReceived({ body: BODY.replace('DBL=18', 'DBL=19'), type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    hub.store.get(a.id).receivedAt = '2020-01-01T00:00:00.000Z';
    hub.store.get(b.id).receivedAt = '2020-01-01T00:01:00.000Z';
    hub.purge();
    assert.ok(hub.store.get(a.id) && hub.store.get(b.id), '消さない');
    assert.equal(hub.store.purgeHeld, 2);
    assert.ok(hub.log.list().some(l => l.event === 'purge-held' && /2 件/.test(l.detail)));
    // 保存期間を過ぎた直後のもの(1 時間ごとに消しに行くときのふつうの形)は消す
    const c = hub.store.saveReceived({ body: BODY.replace('DBL=18', 'DBL=17'), type: 'TRC', job: 'C', peer: 'p', crcOk: null });
    assert.deepEqual(hub.store.purge(90, new Date(Date.now() + 91 * DAY)).map(e => e.id), [c.id]);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('1 つ前の索引から読み直しても、索引の並び(受け取った順)を変えない(時計が遅れていた記録の守りを外さない)', () => {
  const dir = tmp();
  try {
    const s = new Store({ dir });
    const old = s.saveReceived({ body: BODY, type: 'TRC', job: 'O', peer: 'p', crcOk: null });
    const c = s.saveReceived({ body: BODY.replace('DBL=18', 'DBL=19'), type: 'TRC', job: 'C', peer: 'p', crcOk: null });
    const d = s.saveReceived({ body: BODY.replace('DBL=18', 'DBL=17'), type: 'TRC', job: 'D', peer: 'p', crcOk: null });
    const file = path.join(dir, 'index.json');
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of index) if (e.id !== old.id) e.receivedAt = '2020-01-01T00:00:00.000Z';   // 時計が遅れていた間に受け取った
    fs.writeFileSync(file + '.bak', JSON.stringify(index));
    fs.writeFileSync(file, '{書きかけ');
    const again = new Store({ dir });
    assert.deepEqual(again.list().map(e => e.id).sort(), [old.id, c.id, d.id].sort());
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map(e => e.id), [old.id, c.id, d.id], '受け取った順のまま');
    assert.deepEqual(again.purge(90, new Date()).map(e => e.id), [], '前のものの時刻から数えるので消さない');
    assert.equal(again.purgeHeld, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
