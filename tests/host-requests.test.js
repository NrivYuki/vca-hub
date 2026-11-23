'use strict';
// 機器から話しかけられたときの応答(DCS 7 章、表 A.24・A.25)と、相手から届いた値の大きさ・同時に起きる操作の扱い。
// 期待値は規格の文から決める: 7.1.6(JOB)、7.2.1(REQ の種別が機器の種類)、7.2.3.2(要求での上書き)、
// 7.2.8(TRCFMT を 1 つ返す・ZFMT=0)、7.4.3(ダウンロードの種別)、表 A.24 の 4・6・7・13・17、表 A.25 の修飾子、附属書 D(値は 255 文字まで)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const VCA = require('../src/lib/vca-parser.js');
const T = require('../src/lib/vca-tcp.js');
const { hostOptions } = require('../src/host/session.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { Store } = require('../src/store/store.js');
const { Log } = require('../src/log.js');
const { checkBody } = require('../src/send/check.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-req-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const CRLF = '\r\n';
const DAY = 86400000;
// 玉型(等角度 4 点より多い。形式 1)を持つジョブ
const radii = Array.from({ length: 36 }, () => '2500');
const TRACE = ['TRCFMT=1;36;E;R;F', ...Array.from({ length: 3 }, (_, i) => 'R=' + radii.slice(i * 12, i * 12 + 12).join(';'))];
const JOB = ['DO=R', 'JOB=J', 'DBL=18', ...TRACE].join(CRLF) + CRLF;

/** 送信待ちのデータ 1 つを持つ、応答の関数(createHost に渡すもの) */
function host(body = JOB, registry = { get: () => null }) {
  const log = { lines: [], write(level, o) { this.lines.push(o); } };
  const store = {
    reserve: () => ({ entry: { id: 'x' } }), readBody: () => body, release() {}, unqueue() {},
    checkOf: () => ({ blockers: [], notices: [] }),
  };
  return { o: hostOptions({ store, registry, log, peer: 'p' }), log };
}
const req = lines => VCA.parse(lines.join(CRLF) + CRLF);
const text = recs => recs.map(r => r[0] + '=' + r.slice(1).join(';'));

// ---- JOB の無い要求(7.1.6、表 A.24 の 7) ----
test('JOB の無い要求には、足りないレコードとして STATUS=7 と説明 JOB を返す(アップロードもダウンロードも)', () => {
  const { o } = host();
  assert.deepEqual(o.onRequest(req(['REQ=UPL']), { type: 'UPL', job: undefined, kind: 'upload' }), { status: 7, text: 'JOB' });
  assert.deepEqual(o.onRequest(req(['REQ=EDG']), { type: 'EDG', job: undefined, kind: 'download' }), { status: 7, text: 'JOB' });
});

// ---- アップロードの形式の取り決め(7.2.8) ----
test('初期化しない機器のアップロード: 申し出た TRCFMT から使うものを 1 つ返し、ZFMT を求めたら ZFMT=0 で答える', () => {
  const { o } = host();
  const r = o.onRequest(req(['REQ=TRC', 'JOB=U1', 'DEV=TRC', 'TRCFMT=9;400;E;R', 'TRCFMT=1;400;E;R', 'ZFMT=1;400;E;R']), { type: 'TRC', job: 'U1', kind: 'upload' });
  assert.deepEqual(text(r.records), ['TRCFMT=1;400;E;R', 'ZFMT=0']);
});

test('アップロードで扱える玉型の形式が 1 つも無ければ STATUS=17 に修飾子を足して返し、データを受けない(表 A.24・A.25)', () => {
  const { o } = host();
  assert.deepEqual(o.onRequest(req(['REQ=TRC', 'JOB=U1', 'TRCFMT=9;400;E;R']), { type: 'TRC', job: 'U1', kind: 'upload' }), { status: 17 + 256 });
});

test('アップロードの JOB が値の長さの上限(255 文字)を超えたら STATUS=6 で断る(附属書 D、表 A.24 の 6)', () => {
  const { o } = host();
  const job = 'J'.repeat(256);
  assert.deepEqual(o.onRequest(req(['REQ=UPL', 'JOB=' + job]), { type: 'UPL', job, kind: 'upload' }), { status: 6, text: 'JOB' });
  assert.deepEqual(o.onRequest(req(['REQ=UPL', 'JOB=' + job.slice(1)]), { type: 'UPL', job: job.slice(1), kind: 'upload' }), {});
});

// ---- 申し出た形式の中身(表 A.25 の修飾子) ----
test('点数・角度のモード・眼が扱えない TRCFMT は使わず、どれも扱えなければ当てはまる修飾子を足した 17 を返す', () => {
  const { o } = host();
  const ask = lines => o.onRequest(req(['REQ=EDG', 'JOB=J', 'DEV=EDG', ...lines]), { type: 'EDG', job: 'J', kind: 'download' });
  assert.equal(ask(['TRCFMT=1;400;X;R']).status, 17 + 1024, '角度のモード X');
  assert.equal(ask(['TRCFMT=1;99999;E;R']).status, 17 + 512, '点数が多すぎる');
  // 上限は 360 度を 0.1 度刻みで表せる 3600 点(設計書 5 章)
  assert.equal(ask(['TRCFMT=1;3601;E;R']).status, 17 + 512, '3601 点は受けない');
  assert.equal(ask(['TRCFMT=1;3600;E;R']).status, undefined, '3600 点は受ける');
  assert.equal(ask(['TRCFMT=2;400;E;Q']).status, 17, '眼 Q');
  const ok = ask(['TRCFMT=1;99999;E;R', 'TRCFMT=1;100;E;R']);
  assert.equal(VCA.parse(text(ok.records).join(CRLF)).traces[0].radii.length, 100, '扱える最初のもの');
});

// ---- DEV の無い要求(7.2.1) ----
test('初期化しない機器が DEV を書かなくても、REQ の種別を機器の種類として、機器ごとの値を渡す', () => {
  const { o } = host(['DO=R', 'JOB=P1', 'ETYP=?', 'PROC=ETYP;EDG;;;1'].join(CRLF) + CRLF);
  const r = o.onRequest(req(['REQ=EDG', 'JOB=P1', 'VEN=GC', 'MODEL=X']), { type: 'EDG', job: 'P1', kind: 'download' });
  assert.equal(r.status, undefined);
  assert.ok(text(r.records).includes('ETYP=1'));
});

// ---- ダウンロードの種別(7.4.3) ----
test('7.4.3 のダウンロードの種別(GEN・SBK など)にも、その種類のプリセットで応える', () => {
  const { o } = host();
  for (const type of ['PTG', 'FBK', 'SBK', 'GEN', 'AGN', 'COA', 'FSG', 'LMD']) {
    const r = o.onRequest(req(['REQ=' + type, 'JOB=J', 'DEV=' + type]), { type, job: 'J', kind: 'download' });
    assert.equal(r.status, undefined, type);
    const want = VCA.presetRecords(type).map(x => x.label).filter(l => l !== 'JOB');
    const got = new Set(r.records.map(x => x[0]));
    assert.ok(want.every(l => got.has(l)), type);
  }
});

// ---- 玉型の無いジョブ(7.2.8・5.4.1) ----
test('玉型の無いジョブでも、サグを求めた機器には ZFMT=0 を返す(7.2.8)', () => {
  const { o } = host(['DO=R', 'JOB=N1', 'DBL=18'].join(CRLF) + CRLF);
  const r = o.onRequest(req(['REQ=EDG', 'JOB=N1', 'DEV=EDG', 'TRCFMT=1;400;E;R', 'ZFMT=1;400;E;R']), { type: 'EDG', job: 'N1', kind: 'download' });
  const t = text(r.records);
  assert.ok(t.includes('TRCFMT=0'));
  assert.ok(t.includes('ZFMT=0'));
});

// ---- 要求での上書き(7.2.3.2) ----
test('初期化した機器が要求に TRCFMT を書けば、そのセッションだけ初期化の取り決めに代わる', () => {
  const p = { device: { dev: 'EDG', ven: 'V', model: 'M', sn: '' }, labels: ['DBL'], preset: false, trcfmt: { fmt: 1, n: 400, mode: 'E', eye: 'R' }, zfmt: false, drill: null };
  const { o } = host(JOB, { get: () => p });
  const pts = lines => VCA.parse(text(o.onRequest(req(['REQ=1001', 'JOB=J', ...lines]), { type: '1001', job: 'J', kind: 'download' }).records).join(CRLF)).traces[0].radii.length;
  assert.equal(pts([]), 400, '初期化の取り決め');
  assert.equal(pts(['TRCFMT=1;100;E;R']), 100, '要求に書いたもの');
  assert.equal(pts([]), 400, '次のセッションは初期化の取り決めに戻る');
});

// ---- 初期化の名乗り(附属書 D、表 A.24 の 13) ----
test('初期化の名乗りの値が 255 文字を超えたら、要求 ID を残さず STATUS=13 で断る', () => {
  const saved = [];
  const o = hostOptions({ store: {}, registry: { save: (id, v) => saved.push(v) }, log: { write() {} }, peer: 'p' });
  const ini = lines => VCA.parse(lines.join(CRLF) + CRLF);
  assert.equal(o.onInit(ini(['DEV=EDG', 'VEN=' + 'V'.repeat(256), 'MODEL=M']), [], { requestId: '1' }).status, 'invalidInit');
  assert.equal(saved.length, 0);
  assert.equal(o.onInit(ini(['DEV=EDG', 'VEN=' + 'V'.repeat(255), 'MODEL=M']), [], { requestId: '2' }), undefined);
  assert.equal(saved.length, 1);
});

// ---- 記録の値の長さ ----
test('ログには、相手から届いた長い値を切って書く(ファイルと画面の一覧が膨らまない)', () => {
  const dir = tmp();
  try {
    const log = new Log({ dir });
    log.write('warn', { event: 'download', job: 'J'.repeat(1000000), detail: 'D'.repeat(1000000) });
    const e = log.list()[0];
    assert.ok(e.job.length < 400 && e.detail.length < 2100);
    assert.ok(fs.readdirSync(dir).every(f => fs.statSync(path.join(dir, f)).size < 5000));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('受け取ったデータの索引には、長いジョブ番号と送り出せない理由を切って残す', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const long = 'X'.repeat(480000);
    const e = store.saveReceived({ body: 'JOB=A' + CRLF + 'DO=' + long + CRLF, type: 'TRC', job: long, peer: 'p', crcOk: null });
    assert.ok(e.job.length <= 255);
    assert.ok(JSON.stringify(e).length < 5000, '1 件の記録が膨らまない');
    assert.ok(e.check.blockers.length >= 1, '理由は残す');
    const many = Array.from({ length: 200 }, (_, i) => `DO=V${i}`).join(CRLF) + CRLF;
    assert.ok(checkBody(many).blockers.join('').length < 1000);
    // 形の崩れた PROC が多い本文: 理由は 20 件と「ほかに」の 1 件まで、1 つ 300 文字まで
    const procs = Array.from({ length: 100 }, (_, i) => `PROC=L${i}${'Y'.repeat(500)}`).join(CRLF) + CRLF;
    const b = checkBody('DO=R' + CRLF + procs).blockers;
    assert.equal(b.length, 21);
    assert.match(b[20], /ほかに 80 件/);
    assert.ok(b.every(x => x.length <= 301));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 保存期間と、送信待ちから外したもの ----
test('送信待ちから外したもの(索引を戻したとき・人が外したとき)は、外した時から保存期間を数える', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const a = store.saveReceived({ body: 'DO=R' + CRLF + 'JOB=A' + CRLF, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const b = store.saveReceived({ body: 'DO=R' + CRLF + 'JOB=B' + CRLF, type: 'TRC', job: 'B', peer: 'p', crcOk: null });
    store.queue(a.id, 'A');
    store.queue(b.id, 'B');
    store.unqueue(b.id);
    const later = new Date(Date.now() + 100 * DAY);
    // 受け取ってから 100 日たっていても、外した時からは数えない限り消さない
    for (const e of store.index) e.receivedAt = new Date(Date.now() - 100 * DAY).toISOString();
    store.unqueue(a.id);
    assert.deepEqual(store.purge(90).map(e => e.id), [], '外した直後には消さない');
    assert.deepEqual(store.purge(90, later).map(e => e.id).sort(), [a.id, b.id].sort(), '外した時から保存期間を過ぎたら消す');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('索引を 1 つ前のものから読んで送信待ちから外したものは、直後の保存期間の処理で消さない', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const a = store.saveReceived({ body: 'DO=R' + CRLF + 'JOB=A' + CRLF, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    store.queue(a.id, 'A');
    store.index[0].receivedAt = new Date(Date.now() - 100 * DAY).toISOString();
    store._commit(() => {});
    store.queue(a.id, 'A');   // 1 つ前の索引にも同じ状態を残す
    fs.writeFileSync(path.join(dir, 'index.json'), '{壊れた');
    const again = new Store({ dir });
    assert.ok(again.recovered);
    assert.equal(again.get(a.id).status, 'received');
    assert.deepEqual(again.purge(90), []);
    assert.ok(fs.existsSync(path.join(dir, again.get(a.id).file)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 送り先への送信を 2 度走らせない ----
test('送り先へ送っている途中のデータを、送り終える前にもう一度送らない', async () => {
  const dir = tmp();
  // つないでも何も答えない送り先(送り終えるまでに時間がかかる)
  const conns = [];
  const sink = net.createServer(c => conns.push(c));
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, connectDelay: 0,
    timeouts: { ack: 1, packet: 1, char: 1 }, destinations: [{ name: 'D', host: '127.0.0.1', port: sink.address().port }],
  }));
  await hub.start();
  try {
    const e = hub.store.saveReceived({ body: 'DO=R' + CRLF + 'JOB=A' + CRLF + 'DBL=18' + CRLF, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const first = hub.sendTo(e.id, 'A1', 'D');
    await assert.rejects(hub.sendTo(e.id, 'A1', 'D'), err => err.code === 'uploading');
    // 送り先が切れたら、1 度目は失敗で終わる。終わった後は、もう一度送れる(断らない)
    await wait(200);
    for (const c of conns) c.destroy();
    await assert.rejects(first, err => err.code === 'upload-failed');
    const again = hub.sendTo(e.id, 'A1', 'D');
    await wait(200);
    for (const c of conns) c.destroy();
    await assert.rejects(again, err => err.code === 'upload-failed');
  } finally {
    await hub.stop();
    await new Promise(r => sink.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- オートコネクトの接続の数 ----
test('オートコネクトでつなぎに行く接続も、接続の数の上限(IP ごと)に数える', async () => {
  const dir = tmp();
  const accepted = [];
  const servers = [];
  for (let i = 0; i < 5; i++) {
    const s = net.createServer(c => accepted.push(c));
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    servers.push(s);
  }
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, connectDelay: 0,
    autoconnect: { enabled: true, port: 0 }, connections: { total: 64, perAddress: 2 },
  }));
  const ports = await hub.start();
  const sock = dgram.createSocket('udp4');
  try {
    for (const s of servers) {
      const msg = Buffer.from(VCA.buildPacket([['REQ', 'CON'], ['IP', '127.0.0.1'], ['PORT', String(s.address().port)], ['DEV', 'EDG'], ['VEN', 'V'], ['MODEL', 'M']]), 'latin1');
      await new Promise(r => sock.send(msg, ports.autoconnect, '127.0.0.1', r));
      await wait(100);
    }
    await wait(300);
    assert.equal(accepted.length, 2, '1 つのアドレスへは上限の数まで');
  } finally {
    sock.close();
    for (const c of accepted) c.destroy();
    await hub.stop();
    for (const s of servers) await new Promise(r => s.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
