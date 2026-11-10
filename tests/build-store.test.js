'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VCA = require('../src/lib/vca-parser.js');
const { buildDownload } = require('../src/send/build.js');
const { Store, safeName } = require('../src/store/store.js');

const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const both = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-both.vca'), 'latin1');
const body = sample.replace('REQ=FIL', 'ANS=TRC').concat('ETYP=1\r\nFCRV=4.25;4.25\r\n');
// 組み立てたレコードを行の文字列にする(vca-session.js の buildPacket と同じ書き方)
const build = args => buildDownload(args).map(r => r[0] + '=' + r.slice(1).join(';'));

test('プリセットの無い要求種別の機器へは、全レコードを値を変えずに送り、玉型は元の形式のまま', () => {
  const lines = build({ body, profile: null });
  assert.equal(lines[0], 'DO=R', 'ANS・JOB・STATUS は vca-session.js が付ける');
  assert.ok(lines.includes('IPD=31.5;31.0'), '元の行がそのまま');
  assert.ok(lines.includes('FCRV=4.25;4.25'));
  assert.ok(!lines.some(l => l.startsWith('REQ=') || l.startsWith('ANS=TRC')), '通信用レコードは除く');
  const t = VCA.parse(lines.join('\r\n')).traces[0];
  assert.equal(t.fmt, 1);
  assert.equal(t.radii.length, 360);
});

test('初期化しない機器へは、プリセットの項目だけを送り、無い項目は ? にする。玉型は元の形式のまま(7.2.6.2・5.1.4)', () => {
  const lines = build({ body, profile: { labels: ['DBL', 'IPD', 'LMATTYPE'], preset: true } });
  assert.deepEqual(lines.slice(0, 4), ['DO=R', 'DBL=18.0', 'IPD=31.5;31.0', 'LMATTYPE=?']);
  assert.ok(!lines.some(l => l.startsWith('HBOX=')), 'プリセットに無い項目は送らない');
  assert.equal(VCA.parse(lines.join('\r\n')).traces[0].radii.length, 360);
});

test('一覧に BEVP があれば、BEVM・BEVC も送る(7.2.4.3、表 A.7)', () => {
  const lines = build({ body: body + 'BEVP=3\r\nBEVC=4.00\r\n', profile: { labels: ['BEVP', 'DBL'], preset: true } });
  assert.deepEqual(lines.slice(1, 5), ['BEVP=3', 'BEVM=?', 'BEVC=4.00', 'DBL=18.0']);
  assert.ok(!build({ body, profile: { labels: ['DBL'], preset: true } }).some(l => /^BEV[MC]=/.test(l)), 'BEVP が無ければ足さない');
});

test('受け取りたい一覧がある機器へは、その項目だけを送り、無い項目は ?', () => {
  const profile = { labels: ['HBOX', 'LIND', 'ETYP'], trcfmt: { fmt: 1, n: 512, mode: 'E', eye: 'B' } };
  const lines = build({ body, profile });
  assert.ok(lines.includes('HBOX=52.00;52.00'));
  assert.ok(lines.includes('LIND=?'));
  assert.ok(lines.includes('ETYP=1'));
  assert.ok(!lines.some(l => l.startsWith('IPD=')), '一覧にない項目は送らない');
  assert.ok(lines.includes('TRCFMT=1;512;E;R;F'));
});

test('玉型を求めない初期化済み機器には玉型を送らない', () => {
  const lines = build({ body, profile: { labels: ['HBOX'], trcfmt: null } });
  assert.ok(!lines.some(l => l.startsWith('TRCFMT') || l.startsWith('R=')));
});

test('両眼データで、機器が右眼だけを求めたら右眼だけ送る', () => {
  const lines = build({ body: both, profile: { labels: [], trcfmt: { fmt: 1, n: 360, mode: 'E', eye: 'R' } } });
  assert.ok(lines.includes('DO=R'));
  assert.equal(lines.filter(l => l.startsWith('TRCFMT=')).length, 1);
});

test('右眼データしかないとき、左眼を求められたら反転して送る', () => {
  const lines = build({ body, profile: { labels: [], trcfmt: { fmt: 1, n: 360, mode: 'E', eye: 'L' } } });
  assert.ok(lines.includes('DO=L'));
  const t = VCA.parse(lines.join('\r\n')).traces[0];
  assert.equal(t.eye, 'L');
});

test('保存: 個人情報の項目を除いて保存し、索引に記録する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-'));
  try {
    const store = new Store({ dir, removePII: true });
    const e = store.saveReceived({ body: 'ANS=TRC\r\nJOB=A1\r\nCLIENT=YAMADA\r\nCLAGE=40\r\nCLAMP=5\r\n' + sample, type: 'TRC', job: 'A1', peer: '127.0.0.1:5000', crcOk: true });
    const saved = store.readBody(e);
    assert.ok(!saved.includes('YAMADA') && !saved.includes('CLAGE'));
    assert.ok(saved.includes('CLAMP=5'), '加工機の項目(CLAMP)は消さない');
    assert.deepEqual(e.piiRemoved.sort(), ['CLAGE', 'CLIENT']);
    assert.equal(e.hbox, 52);
    assert.equal(store.findQueued('A1'), null);
    store.queue(e.id, 'A1');
    assert.equal(store.findQueued('A1').id, e.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('保存: 除去を無効にすると受け取ったまま保存する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-'));
  try {
    const store = new Store({ dir, removePII: false });
    const e = store.saveReceived({ body: 'CLIENT=YAMADA\r\n', type: 'UPL', job: 'B1', peer: 'p', crcOk: null });
    assert.equal(store.readBody(e), 'CLIENT=YAMADA\r\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ファイル名: 使えない文字とフォルダのさかのぼりを除く', () => {
  assert.equal(safeName('..\\..\\evil:job'), 'eviljob');
  assert.equal(safeName(''), 'nojob');
});
