'use strict';
// 加工機への応答の作り方を、規格の本文から確かめる: 穴あけ(5.5.1.5・5.5.3)、初期化しない機器の要求の形式(7.2.8・5.4.11.2)、
// 取り決めた玉型の点数とモード(7.2.8)、通信用レコード(表 A.2・5.5.3)、個人情報の項目の除去(設計書 7 章)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VCA = require('../src/lib/vca-parser.js');
const { buildDownload } = require('../src/send/build.js');
const { traceRecords } = require('../src/lib/trace.js');
const { hostOptions } = require('../src/host/session.js');
const { Store } = require('../src/store/store.js');
const { uploadRecords } = require('../src/device/upload.js');

const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const job = sample.replace('REQ=FIL', 'ANS=TRC');
const build = args => buildDownload(args).map(r => r[0] + '=' + r.slice(1).join(';'));
const DRILL = 'DRILLE=R;C;-18.40;10.30;1.60\r\nDRILLE=R;C;-15.00;9.00;1.60\r\n';

// ---- 穴あけ ----
test('穴あけの基準(DRLFMT)を取り決めた機器には、ラベル一覧に無くても DRILLE を送る(5.5.1.5)', () => {
  const out = build({ body: job + DRILL, profile: { labels: ['DBL'], trcfmt: null, drill: 'C' } });
  assert.deepEqual(out.filter(l => l.startsWith('DRILLE=')), ['DRILLE=R;C;-18.40;10.30;1.60', 'DRILLE=R;C;-15.00;9.00;1.60']);
  assert.ok(!build({ body: job + DRILL, profile: { labels: ['DBL'], trcfmt: null } }).some(l => l.startsWith('DRILLE=')),
    '取り決めず、ラベル一覧にも無ければ送らない');
});

test('穴あけの基準を取り決めた機器には、廃止された DRILL を送らない(5.5.1.5)', () => {
  const out = build({ body: job + DRILL + 'DRILL=R;-18.4;10.3;1.6\r\n', profile: { labels: ['DBL', 'DRILL'], trcfmt: null, drill: 'C' } });
  assert.ok(!out.some(l => l.startsWith('DRILL=')));
});

test('保存した DRILLE の基準が取り決めた基準と違えば、作り直せないので渡さない(STATUS=8)', () => {
  assert.throws(() => buildDownload({ body: job + DRILL, profile: { labels: ['DBL'], trcfmt: null, drill: 'E' } }), e => e.code === 'drill-reference');
});

// ---- 初期化しない機器の要求 ----
function presetRequest(records) {
  const store = { reserve: () => ({ entry: { id: 'x' } }), readBody: () => job + DRILL, release() {}, checkOf: () => ({ blockers: [], notices: [] }) };
  const o = hostOptions({ store, registry: { get: () => null }, log: { write() {} }, peer: 'p' });
  // ジョブには DRILLE があるので、DRLFMT の無い要求には渡さない(5.5.1.5)。玉型のテストでは C を書き足す
  if (!records.some(r => r[0] === 'DRLFMT')) records = records.concat([['DRLFMT', 'C']]);
  const req = VCA.parse(records.map(r => r.join('=')).join('\r\n'));
  const r = o.onRequest(req, { type: 'EDG', job: 'J', kind: 'download' });
  if (!r.records) return r;
  return r.records.map(r => r[0] + '=' + r.slice(1).join(';'));
}

test('初期化しない機器が要求に書いた TRCFMT の形式・点数で、玉型を送る(7.2.8・5.4.11.2)', () => {
  const out = presetRequest([['REQ', 'EDG'], ['JOB', 'J'], ['DEV', 'EDG'], ['TRCFMT', '1;400;E;R;F']]);
  const t = VCA.parse(out.join('\r\n')).traces;
  assert.equal(t.length, 1);
  assert.equal(t[0].fmt, 1);
  assert.equal(t[0].radii.length, 400);
});

test('初期化しない機器が要求に書いた候補は、書いた順に、扱える最初の形式を使う(7.2.8)', () => {
  const out = presetRequest([['REQ', 'EDG'], ['JOB', 'J'], ['DEV', 'EDG'], ['TRCFMT', '9;100;E;R;F'], ['TRCFMT', '1;200;E;R;F']]);
  assert.equal(VCA.parse(out.join('\r\n')).traces[0].radii.length, 200);
});

test('初期化しない機器がサグ(ZFMT)を求めたら、ZFMT=0 で答える(7.2.8: サグを扱わないホスト)', () => {
  const out = presetRequest([['REQ', 'EDG'], ['JOB', 'J'], ['DEV', 'EDG'], ['TRCFMT', '1;400;E;R;F'], ['ZFMT', '1;400;E;R']]);
  assert.ok(out.includes('ZFMT=0'));
});

test('初期化しない機器が要求に書いた DRLFMT の中から、ジョブの DRILLE の基準に合うものを使う(5.5.3)', () => {
  const out = presetRequest([['REQ', 'EDG'], ['JOB', 'J'], ['DEV', 'EDG'], ['DRLFMT', 'E'], ['DRLFMT', 'C']]);
  assert.equal(out.filter(l => l.startsWith('DRILLE=')).length, 2);
  // 合う基準が無ければ、データはあるがこの機器には合わない(表 A.24 の 4)
  assert.deepEqual(presetRequest([['REQ', 'EDG'], ['JOB', 'J'], ['DEV', 'EDG'], ['DRLFMT', 'E']]), { status: 4, text: 'drill-reference' });
});

// ---- 取り決めた点数とモード ----
test('取り決めた点数・角度のモード(TRCFMT)どおりに玉型を送る(7.2.8: ホストが返すのは実際に使うもの)', () => {
  const send = (t, want) => VCA.parse(traceRecords(t, want).map(r => r[0] + '=' + r.slice(1).join(';')).join('\r\n')).traces[0];
  const equi = VCA.parse(job).traces[0];   // 等角度 360 点
  const u = send(equi, { fmt: 1, n: 400, mode: 'U', eye: 'R' });
  assert.deepEqual([u.mode, u.radii.length], ['U', 400], '等角度のデータでも、角度つき(U)を取り決めたら U');
  // 角度つきのデータを、違う点数で求められた
  const angled = send(equi, { fmt: 1, n: 40, mode: 'U', eye: 'R' });
  const again = send(angled, { fmt: 1, n: 400, mode: 'U', eye: 'R' });
  assert.deepEqual([again.mode, again.radii.length], ['U', 400], '取り決めた点数');
  const e = send(angled, { fmt: 1, n: 400, mode: 'E', eye: 'R' });
  assert.deepEqual([e.mode, e.radii.length], ['E', 400]);
});

// ---- 通信用レコード ----
test('送り手の名乗り(HID・MVER)・つなぎ方(IP・PORT)と DRLFMT は、データのパケットに入れない(表 A.2・5.5.3)', () => {
  const out = uploadRecords(job + 'MVER=2.1\r\nHID=LAB1\r\nIP=10.0.0.5\r\nPORT=50000\r\nDRLFMT=C\r\n').map(r => r[0]);
  for (const l of ['MVER', 'HID', 'IP', 'PORT', 'DRLFMT']) assert.ok(!out.includes(l), l);
});

// ---- 個人情報の項目の除去 ----
test('PROC と PROCBLK のブロックの中の個人情報の項目も除く(設計書 7 章: 読み取りがその項目として読む行は全て除く)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-pii-'));
  try {
    const store = new Store({ dir, removePII: true });
    const e = store.saveReceived({
      body: 'JOB=P\r\nCLIENT=YAMADA\r\nPROCBLK=1;EDG;ACME;E1;\r\n1!CLIENT=SUZUKI\r\n1!*CLAGE=73\r\n1!GAX=0;0\r\nPROC=CLLNAM;EDG;;;TANAKA;TANAKA\r\nPROC=LMATID;EDG;;;1;1\r\nDBL=18\r\n',
      type: 'TRC', job: 'P', peer: 'p', crcOk: null,
    });
    const saved = store.readBody(e);
    for (const s of ['YAMADA', 'SUZUKI', 'CLAGE', 'TANAKA']) assert.ok(!saved.includes(s), s);
    assert.deepEqual(e.piiRemoved.sort(), ['CLAGE', 'CLIENT', 'CLLNAM']);
    const p = VCA.parse(saved);
    assert.ok(!p.all.CLIENT && !p.all.CLAGE && !p.all.CLLNAM);
    assert.deepEqual(VCA.deviceRecords(p, { dev: 'EDG', ven: 'ACME', model: 'E1', sn: '' }).map(r => r.label).sort(), ['GAX', 'LMATID']);
    assert.ok(saved.includes('1!GAX=0;0\r\nPROC=LMATID'), '残す行の改行はそのまま');
    assert.ok(!/\r\n\n/.test(saved), '除いた行の改行を残さない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
