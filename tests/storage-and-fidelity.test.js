'use strict';
// 保存の形と復旧、受け取った中身を出力まで保つこと、個人情報の行方。
// 期待値の根拠: 5.1.6(ラベルに含められない文字)、5.1.8.4(literal は大文字・小文字を区別する)、
// 5.4.3.1(角度のモード C は等角度に作り直せない)、5.1.9 と 5.8-5.14(見出しごとの系列)、REM はどのパケットにも置ける(表 A.1)、
// 設計書 5 章(サグは中継しない)・7 章(個人情報)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const VCA = require('../src/lib/vca-parser.js');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');
const { watchFolder, fileRecords, DONE_DIR } = require('../src/send/folder.js');
const { checkBody } = require('../src/send/check.js');
const { hostOptions } = require('../src/host/session.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-sf-'));
const CRLF = '\r\n';
const DAY = 86400000;
const text = recs => recs.map(r => r[0] + '=' + r.slice(1).join(';'));
const BODY = 'DO=R' + CRLF + 'JOB=A' + CRLF + 'DBL=18' + CRLF;

// ---- 取り込み ----
test('同じ名前のファイルを、前のものを片付けた後にまた置いたら、取り込む(前の取り込みと取り違えない)', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    fs.mkdirSync(watch);
    const store = new Store({ dir: path.join(dir, 'data') });
    const w = watchFolder({ dir: watch, store, log: new Log({ dir: path.join(dir, 'log') }), settleMs: 0, intervalMs: 3600000 });
    fs.writeFileSync(path.join(watch, 'A.vca'), BODY);
    w.scan();
    fs.unlinkSync(path.join(watch, DONE_DIR, 'A.vca'));   // 人が片付けた
    fs.writeFileSync(path.join(watch, 'A.vca'), BODY.replace('DBL=18', 'DBL=19'));
    w.scan();
    w.stop();
    assert.equal(store.list().length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('取り込み途中の印が抜けたら(1 つ前の印から読んだ)、記録に残し、最近移したファイルを取り込み直す', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    const data = path.join(dir, 'data');
    fs.mkdirSync(path.join(watch, DONE_DIR), { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(watch, DONE_DIR, 'X.vca'), BODY);   // 移した後・保存の前に止まった
    fs.writeFileSync(path.join(data, 'import-pending.json'), '[壊れた');
    fs.writeFileSync(path.join(data, 'import-pending.json.bak'), '[]');
    const store = new Store({ dir: data });
    const log = new Log({ dir: path.join(dir, 'log') });
    watchFolder({ dir: watch, store, log, settleMs: 0, intervalMs: 3600000 }).stop();
    assert.equal(store.list().length, 1, '取り込み直す');
    assert.ok(log.list().some(l => l.level === 'error' && /印が抜けている/.test(l.detail)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('取り込み途中の印が空になったら、1 つ前の印も空にする(取り込んだファイルの名前を残さない)', () => {
  const dir = tmp();
  try {
    const watch = path.join(dir, 'in');
    fs.mkdirSync(watch);
    const store = new Store({ dir: path.join(dir, 'data') });
    fs.writeFileSync(path.join(watch, 'Yamada_Hanako.vca'), BODY);
    watchFolder({ dir: watch, store, log: new Log({ dir: path.join(dir, 'log') }), settleMs: 0, intervalMs: 3600000 }).stop();
    const bak = path.join(dir, 'data', 'import-pending.json.bak');
    assert.ok(!fs.existsSync(bak) || !fs.readFileSync(bak, 'utf8').includes('Yamada'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- ロック ----
test('ロックの番号を、vca-hub ではない別のプロセスが使っていても起動する(電源断の後に番号が使い回されたとき)', async () => {
  const dir = tmp();
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const other = process.platform === 'win32'
    ? cp.spawn('cmd', ['/c', 'ping -n 6 127.0.0.1 > nul'], { windowsHide: true })
    : cp.spawn('sleep', ['5']);
  try {
    fs.writeFileSync(path.join(data, 'vca-hub.lock'), String(other.pid));
    const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: data, web: { enabled: false }, remote: { enabled: false } }));
    await hub.stop();
  } finally { other.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 送信済みを書けなかったもの ----
test('送信済みを書けなかったものは、接続が切れても押さえたままにし、あとで書き直す(同じジョブをもう一度渡さない)', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    store.queue(e.id, 'A');
    const holder = {};
    store.reserve('A', holder);
    store.holdSent(e.id, 'edger');
    assert.deepEqual(store.releaseAll(holder), []);
    assert.deepEqual(store.reserve('A', {}), { busy: true }, 'ほかの接続には渡さない');
    assert.deepEqual(store.retrySent(), [e.id]);
    assert.equal(store.get(e.id).status, 'sent');
    assert.equal(store.sending.has(e.id), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 索引 ----
test('索引の変更の途中で例外になっても、メモリの索引を元に戻す', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    assert.throws(() => store._commit(() => { store.get(e.id).status = 'sent'; throw new Error('途中'); }));
    assert.equal(store.get(e.id).status, 'received');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('索引の要素の形が違えば 1 つ前の索引から読み、古い版の記録で欠けている欄は補う', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const good = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    delete good[0].sent;   // 古い版の記録
    fs.writeFileSync(path.join(dir, 'index.json.bak'), JSON.stringify(good));
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify([null]));
    const again = new Store({ dir });
    assert.ok(again.recovered);
    assert.deepEqual(again.get(e.id).sent, []);
    again.queue(e.id, 'A');
    again.markSent(e.id, 'edger');
    assert.equal(again.get(e.id).status, 'sent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('消し直しの一覧: データのフォルダの外のファイルは消さず、索引を戻したときは消し直しを待つ記録を戻さずに消す(消した操作を守る)', () => {
  const dir = tmp();
  const outside = path.join(os.tmpdir(), `vcahub-outside-${process.pid}.txt`);
  try {
    const data = path.join(dir, 'data');
    const store = new Store({ dir: data });
    const e = store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    store.queue(e.id, 'A');   // 索引をもう 1 度書き、1 つ前の索引(.bak)を作る
    fs.writeFileSync(outside, 'x');
    fs.writeFileSync(path.join(data, 'pending-delete.json'), JSON.stringify([outside, path.join(data, e.file)]));
    fs.writeFileSync(path.join(data, 'index.json'), '');   // 長さ 0(1 つ前から読む)
    const again = new Store({ dir: data });
    again.retryDeletes();
    assert.ok(fs.existsSync(outside), 'フォルダの外は消さない');
    assert.equal(again.get(e.id), null, '消し直しを待つ記録は、索引を戻しても登録し直さない');
    assert.equal(fs.existsSync(path.join(data, e.file)), false, '消し直す');
  } finally { fs.rmSync(outside, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の情報の書く途中の一時ファイルも、保存期間で消す', async () => {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, retentionDays: 30 }));
  try {
    const f = path.join(dir, 'data', 'ext', 'x', '20200101-000000-abcde.json.tmp');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{');
    const old = new Date(Date.now() - 60 * DAY);
    fs.utimesSync(f, old, old);
    hub.purge();
    assert.equal(fs.existsSync(f), false);
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 中身の忠実さ ----
test('データセットの途中に REM があっても、後の系列の行を落とさない', () => {
  const out = text(fileRecords(['DO=R', 'CRIBFMT=1;6;E;R', 'R=1;2;3', 'REM=hello', 'R=4;5;6'].join(CRLF) + CRLF));
  assert.ok(out.includes('R=1;2;3') && out.includes('R=4;5;6'));
});

test('ほかのデータセットの系列の行は、いま開いているデータセットに付けない', () => {
  const out = text(fileRecords(['DO=R', 'CRIBFMT=1;3;E;R', 'R=1;2;3', 'T=9;9;9'].join(CRLF) + CRLF));
  assert.ok(out.includes('R=1;2;3'));
  assert.ok(!out.includes('T=9;9;9'));
});

const CTRACE = ['DO=R', 'JOB=C1', 'TRCFMT=1;7;C;R;F', 'R=2000;2000;2000;2000;2000;2000;2000', 'A=0;9000;18000;20000;19000;21000;27000'].join(CRLF) + CRLF;
test('角度のモード C の玉型は、角度を並べ替えずに送り、E・U を取り決めた加工機には合わないと答える(5.4.3.1)', () => {
  const out = text(fileRecords(CTRACE));
  assert.ok(out.includes('A=0;9000;18000;20000;19000;21000;27000'), out.join(' | '));
  assert.ok(out.some(l => /^TRCFMT=1;7;C;R/.test(l)));
  const store = { reserve: () => ({ entry: { id: 'x' } }), readBody: () => CTRACE, release() {}, checkOf: () => ({ blockers: [], notices: [] }) };
  const o = hostOptions({ store, registry: { get: () => null }, log: { write() {} }, peer: 'p' });
  const r = o.onRequest(VCA.parse('REQ=EDG\r\nJOB=C1\r\nDEV=EDG\r\nTRCFMT=1;400;E;R\r\n'), { type: 'EDG', job: 'C1', kind: 'download' });
  assert.deepEqual(r, { status: 4, text: 'trace-unconvertible' });
});

test('サグは中継しないことを、送る前の確認で知らせる', () => {
  const c = checkBody(['DO=R', 'TRCFMT=1;4;E;R;F', 'R=2000;2000;2000;2000', 'ZFMT=1;4;E;R;F', 'Z=100;200;100;200'].join(CRLF) + CRLF);
  assert.ok(c.notices.some(n => /サグは中継しない/.test(n)));
});

test('点数が 3 未満の玉型は送れないとして止める(加工機に玉型が無いと答えないように)', () => {
  const c = checkBody(['DO=R', 'TRCFMT=1;2;E;R;F', 'R=2000;2000'].join(CRLF) + CRLF);
  assert.ok(c.blockers.some(b => /点数が 2/.test(b)));
});

test('. や - を含むラベル(メーカーの名前空間など)の行も落とさずに送る(5.1.6)', () => {
  const out = text(fileRecords(['DO=R', 'ACME.X=1', '_A-B=2'].join(CRLF) + CRLF));
  assert.ok(out.includes('ACME.X=1') && out.includes('_A-B=2'));
});

test('DO は大文字・小文字を区別する(5.1.8.4)。DO=b は止める', () => {
  assert.ok(checkBody('DO=b' + CRLF).blockers.some(b => /DO=b/.test(b)));
  assert.equal(checkBody('DO=B' + CRLF).blockers.length, 0);
});

// ---- 個人情報 ----
test('拡張から受けた 1 バイトでない文字は、書くときと同じ形にそろえてから個人情報を除く', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: 'DO=R\r\nREM=xĊCLIENT=Yamada\r\n', type: 'X', job: 'A', peer: 'p', crcOk: null });
    assert.ok(!store.readBody(e).includes('Yamada'));
    assert.ok(e.piiRemoved.includes('CLIENT'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('引用符で囲んだ PROC の 1 つ目の欄が個人情報の項目なら、その行も除く', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body: 'DO=R\r\nPROC="CLIENT";EDG;;;Yamada\r\n', type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    assert.ok(!store.readBody(e).includes('Yamada'));
    assert.ok(!JSON.stringify(store.get(e.id)).includes('Yamada'), '索引にも残さない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('加工機へ渡せないときの記録に、レコードの値を書かない', () => {
  const lines = [];
  const body = 'DO=R\r\nSPH=-1.00;-1.00\r\nPROC=SPH;EDG;;;-3.25;-2.75\r\n';
  const store = { reserve: () => ({ entry: { id: 'x' } }), readBody: () => body, release() {}, checkOf: () => ({ blockers: [], notices: [] }) };
  const o = hostOptions({ store, registry: { get: () => null }, log: { write: (l, x) => lines.push(x) }, peer: 'p' });
  const r = o.onRequest(VCA.parse('REQ=EDG\r\nJOB=A\r\nDEV=edg\r\n'), { type: 'EDG', job: 'A', kind: 'download' });
  assert.equal(r.status, 4);
  assert.ok(!JSON.stringify(lines).includes('-3.25'));
});

test('保存期間で消したことの記録に、名前と取り込んだファイルの名前を書かない', async () => {
  const dir = tmp();
  const imp = path.join(dir, 'in');
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, retentionDays: 30, importDir: imp }));
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'Yamada', peer: 'p', crcOk: null });
    hub.store.index.find(x => x.id === e.id).receivedAt = new Date(Date.now() - 45 * DAY).toISOString();
    const f = path.join(imp, DONE_DIR, 'Yamada_Hanako.vca');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, BODY);
    const old = new Date(Date.now() - 60 * DAY);
    fs.utimesSync(f, old, old);
    hub.purge();
    const logged = JSON.stringify(hub.log.list().filter(l => /^purged/.test(l.event)));
    assert.ok(logged.includes(e.id));
    assert.ok(!logged.includes('Yamada'));
  } finally { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
