'use strict';
// 規格の本文との照らし合わせ(5 章・6 章・7 章)。期待値は規格の文から決める:
// 5.1(左右一対・余分な区切り)、5.1.8(ASCII)、5.1.10(1 つしか置けないレコード)、5.4.9.2-5.4.9.5(寸法・CIRC3D)、
// 5.5.1.5・5.5.2.2・5.5.2.10.9・5.5.3(穴あけ)、5.8.1・5.10.5・5.11.3(データセットの取り決め)、5.9.3.2・5.9.7.4(LDPATH・LDTYPE・EDATA)、
// 5.15.1.3(ENGMARK)、表 A.1(PROCBLK の優先順位)、表 A.2(DEF は limited)、6.1.3.5(時間切れ)、7.1.6(JOB)、7.2.3.3(要求 ID)、7.2.8(形式の取り決め)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VCA = require('../src/lib/vca-parser.js');
const { hostOptions } = require('../src/host/session.js');
const { buildDownload } = require('../src/send/build.js');
const { checkBody } = require('../src/send/check.js');
const { drillProposal, datasetProposals } = require('../src/device/upload.js');
const { Registry } = require('../src/host/registry.js');
const { loadConfig } = require('../src/config.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-s12-'));
const CRLF = '\r\n';
const text = recs => recs.map(r => r[0] + '=' + r.slice(1).join(';'));
const parse = lines => VCA.parse(lines.join(CRLF) + CRLF);
const build = (body, profile, device = { dev: 'EDG', ven: 'V', model: 'M', sn: '' }) => text(buildDownload({ body: body.join(CRLF) + CRLF, profile, device }));
function host(body, registry = { get: () => null }) {
  const store = { reserve: () => ({ entry: { id: 'x' } }), readBody: () => body.join(CRLF) + CRLF, release() {}, checkOf: () => ({ blockers: [], notices: [] }) };
  return hostOptions({ store, registry, log: { write() {} }, peer: 'p' });
}

// ---- 7 章 ----
test('アップロードする機器は、実際の初期化でも角度のモード C の玉型の形式を取り決められる(7.2.8)', async () => {
  const { loadConfig: load, merge } = require('../src/config.js');
  const { createHub } = require('../src/app.js');
  const T = require('../src/lib/vca-tcp.js');
  const dir = tmp();
  const hub = createHub(merge(load(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: true, port: 0 } }));
  const ports = await hub.start();
  const dev = await T.connectDevice('127.0.0.1', ports.remote, { connectDelay: 0, kind: 'upload' });
  try {
    const ini = await dev.initialize([['DEV', 'TRC'], ['VEN', 'V'], ['MODEL', 'M'], ['TRCFMT', '1', '400', 'C', 'R']]);
    assert.equal(ini.hostStatus, 0);
    assert.ok(/^\d+$/.test(String(ini.requestId)), '要求 ID を割り当てる');
  } finally { dev.socket.destroy(); await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('アップロードする機器の初期化で、角度のモード C の玉型の形式を取り決める(7.2.8)', () => {
  const saved = [];
  const o = hostOptions({ store: {}, registry: { save: (id, v) => saved.push(v) }, log: { write() {} }, peer: 'p' });
  const reply = [['TRCFMT', '1', '400', 'C', 'R']];
  assert.equal(o.onInit(parse(['DEV=TRC', 'VEN=V', 'MODEL=M', 'TRCFMT=1;400;C;R']), reply, { requestId: '1' }), undefined);
  assert.equal(saved[0].trcfmt.mode, 'C');
  // 加工機には C を作れないので、扱えない形式として断る
  const d = hostOptions({ store: {}, registry: { save() {} }, log: { write() {} }, peer: 'p' });
  assert.equal(d.onInit(parse(['DEV=EDG', 'VEN=V', 'MODEL=M', 'TRCFMT=1;400;C;R']), [['TRCFMT', '1', '400', 'C', 'R']], { requestId: '2' }).status, 17 + 1024);
});

test('アップロードのデータのパケットに JOB が無ければ 7、要求と違えば 6 で断り、保存しない(7.1.6)', () => {
  let saved = 0;
  const o = hostOptions({ store: { saveReceived: () => { saved++; return { id: 'x' }; } }, registry: { get: () => null }, log: { write() {} }, peer: 'p' });
  const data = lines => Object.assign(parse(lines), { raw: '\x1c' + lines.join(CRLF) + CRLF + '\x1e\x1d', crcOk: null });
  assert.deepEqual(o.onData(parse(['REQ=TRC', 'JOB=C1']), data(['ANS=TRC', 'DBL=18']), { type: 'TRC', job: 'C1' }), { status: 7, text: 'JOB' });
  assert.deepEqual(o.onData(parse(['REQ=TRC', 'JOB=C1']), data(['ANS=TRC', 'JOB=ZZ9', 'DBL=18']), { type: 'TRC', job: 'C1' }), { status: 6, text: 'JOB' });
  assert.equal(saved, 0);
  assert.deepEqual(o.onData(parse(['REQ=TRC', 'JOB=C1']), data(['ANS=TRC', 'JOB=C1', 'DBL=18']), { type: 'TRC', job: 'C1' }), { status: 0 });
  assert.equal(saved, 1);
});

test('要求 ID の記録が無いときは、時刻から始める(入れ直しても前の番号と重ならない。7.2.3.3)', () => {
  const dir = tmp();
  try {
    const before = Math.floor(Date.now() / 1000) % 100000000;
    const r = new Registry({ file: path.join(dir, 'devices.json') });
    assert.ok(Number(r.nextId()) >= 1000 + before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config.json の時間切れは 2-255 秒(6.1.3.5)', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ timeouts: { ack: 1, packet: 12, char: 5 } }));
    assert.throws(() => loadConfig(f), e => e.code === 'config' && /2-255/.test(e.message));
    fs.writeFileSync(f, JSON.stringify({ timeouts: { ack: 2, packet: 255, char: 5 } }));
    assert.doesNotThrow(() => loadConfig(f));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('初期化の定義の名前は limited(12 文字まで。表 A.2・5.1.8.3)', () => {
  const o = hostOptions({ store: {}, registry: { save() {} }, log: { write() {} }, peer: 'p' });
  assert.equal(o.onInit(parse(['DEV=EDG', 'DEF=ABCDEFGHIJKLM', 'D=DBL']), [], { requestId: '1' }).status, 'invalidInit');
  assert.equal(o.onInit(parse(['DEV=EDG', 'DEF=ABCDEFGHIJKL', 'D=DBL']), [], { requestId: '2' }), undefined);
});

// ---- 穴あけ ----
const DRILL_C = { labels: ['DBL'], trcfmt: null, drill: 'C' };
test('穴の無いこと(DRILLE=0、2 つ目の欄の 0)と分からないこと(DRILLE=?)は、基準によらず渡す(5.5.2.2・5.5.2.10.9)', () => {
  assert.ok(build(['DO=B', 'DRILLE=0'], DRILL_C).includes('DRILLE=0'));
  assert.ok(build(['DO=B', 'DRILLE=B;0'], DRILL_C).includes('DRILLE=B;0'));
  assert.ok(build(['DO=B', 'DRILLE=?'], DRILL_C).includes('DRILLE=?'));
});

test('DRILLE の基準は 2 つ目の欄の 1 文字目。空なら中心基準、ENF・ETF は E(5.5.2.2)', () => {
  assert.ok(build(['DO=B', 'DRILLE=R;;-17;10;2'], DRILL_C).includes('DRILLE=R;;-17;10;2'));
  const e = { labels: ['DBL'], trcfmt: null, drill: 'E' };
  const out = build(['DO=B', 'DRILLE=B;ENF;3;2;1.4', 'DRILLE=B;ETF;2.5;4;1.2;5.5;4'], e);
  assert.equal(out.filter(l => l.startsWith('DRILLE=')).length, 2);
  assert.deepEqual(checkBody(['DO=B', 'DRILLE=B;ENF;3;2;1.4', 'DRILLE=B;ETF;2.5;4;1.2'].join(CRLF) + CRLF).blockers, [], '同じ E 基準');
});

test('1 つのジョブの DRILLE の基準が混ざっていれば止める(5.5.1.5)', () => {
  assert.ok(checkBody(['DO=B', 'DRILLE=R;E;1;2;3', 'DRILLE=R;B;1;2;3'].join(CRLF) + CRLF).blockers.some(b => /基準が混ざって/.test(b)));
});

test('基準を取り決めた機器で、ジョブに穴あけの情報が無ければ DRILLE=? を送る(5.5.2.10.9)', () => {
  assert.ok(build(['DO=B', 'DBL=18'], DRILL_C).includes('DRILLE=?'));
});

test('基準を取り決めていない加工機には、穴のある DRILLE を渡さず(STATUS=4)、一覧で求められたら DRILLE=? を送る(5.5.1.5)', () => {
  assert.throws(() => build(['DO=B', 'DRILLE=R;C;1;2;3'], { labels: ['DBL', 'DRILLE'], trcfmt: null }), e => e.code === 'drill-reference');
  assert.ok(build(['DO=B', 'DBL=18'], { labels: ['DBL', 'DRILLE'], trcfmt: null }).includes('DRILLE=?'));
  const o = host(['DO=B', 'DRILLE=R;C;1;2;3']);
  assert.deepEqual(o.onRequest(parse(['REQ=EDG', 'JOB=J', 'DEV=EDG']), { type: 'EDG', job: 'J', kind: 'download' }), { status: 4, text: 'drill-reference' });
  // 書き出し・送り先(機器ではない)へは、そのまま渡す
  assert.ok(text(buildDownload({ body: 'DO=B\r\nDRILLE=R;C;1;2;3\r\n', profile: { labels: [], ownFormat: true } })).includes('DRILLE=R;C;1;2;3'));
});

test('機器の役: ジョブの DRILLE の基準を DRLFMT で申し出る(5.5.3)', () => {
  assert.deepEqual(drillProposal('DRILLE=B;ENF;3;2;1.4\r\nDRILLE=B;ETF;1;2;3\r\n'), [['DRLFMT', 'E']]);
  assert.deepEqual(drillProposal('DRILLE=0\r\n'), []);
});

// ---- データセット ----
test('シェルフ・切り抜き・厚みのデータセットは、初期化で形式を取り決めて返し、保存した形と違えば渡さない(5.8.1・5.10.5・5.11.3)', () => {
  const saved = [];
  const o = hostOptions({ store: {}, registry: { save: (id, v) => saved.push(v) }, log: { write() {} }, peer: 'p' });
  const reply = [];
  o.onInit(parse(['DEV=EDG', 'VEN=V', 'MODEL=M', 'DEF=T', 'D=CRIBFMT', 'CRIBFMT=1;40;E;R']), reply, { requestId: '1' });
  assert.ok(reply.some(r => r[0] === 'CRIBFMT' && r.slice(1).join(';') === '1;40;E;R'), '選んだ形式を返す');
  const profile = { labels: ['CRIBFMT'], trcfmt: null, datasets: saved[0].datasets };
  assert.ok(build(['DO=B', 'CRIBFMT=1;40;E;R', 'R=' + Array(40).fill(2000).join(';')], profile).some(l => l.startsWith('CRIBFMT=1;40;E;R')));
  assert.throws(() => build(['DO=B', 'CRIBFMT=1;20;E;R', 'R=' + Array(20).fill(2000).join(';')], profile), e => e.code === 'dataset-format');
});

test('求められたデータセットがジョブに無ければ、見出しを 0 にして示す(5.8.1)', () => {
  const out = build(['DO=B', 'DBL=18'], { labels: ['SHLFFMT', 'CRIBFMT', 'STHKFMT'], trcfmt: null });
  assert.deepEqual(out.filter(l => /FMT=/.test(l)), ['SHLFFMT=0', 'CRIBFMT=0', 'STHKFMT=0']);
});

test('機器の役: シェルフ・切り抜き・厚みのデータセットを、保存した形式で申し出る(5.8.1)', () => {
  assert.deepEqual(datasetProposals('SHLFFMT=1;4;E;R;B\r\nS=1;2;3;4\r\nCRIBFMT=1;4;E;R\r\n'), [['SHLFFMT', '1', '4', 'E', 'R'], ['CRIBFMT', '1', '4', 'E', 'R']]);
});

test('データセットの決まりに合わない値(角度・重みの範囲)を、送る前の確認で知らせる', () => {
  const c = checkBody(['DO=B', 'WMFMT=1;2;2', 'WW=0.5;2'].join(CRLF) + CRLF);
  assert.ok(c.notices.some(n => /^WW/.test(n)));
});

// ---- LDPATH・LDTYPE・EDATA・ENGMARK ----
test('LDTYPE が無ければ SDF として送り、? にはしない。? の LDTYPE は止める(5.9.3.2)', () => {
  assert.ok(build(['DO=B', 'LDPATH=A.SDF'], { labels: ['LDPATH'], trcfmt: null }).includes('LDTYPE=SDF'));
  assert.ok(checkBody('DO=B\r\nLDPATH=A.SDF\r\nLDTYPE=?\r\n').blockers.some(b => /LDTYPE/.test(b)));
});

test('PROC に入った LDPATH は、全体の LDPATH に足さずに置き換える(機器が受け取る LDPATH は 1 つ。5.9.3.2)', () => {
  const out = build(['DO=B', 'LDPATH=A.SDF', 'PROC=LDPATH;FSG;SOM;;B.SDF'], { labels: ['LDPATH'], trcfmt: null }, { dev: 'FSG', ven: 'SOM', model: 'X', sn: '' });
  assert.deepEqual(out.filter(l => l.startsWith('LDPATH=')), ['LDPATH=B.SDF']);
});

test('種類が SDF の LDPATH に、パスが 2 つあれば止める(5.9.3.2)', () => {
  assert.ok(checkBody('DO=B\r\nLDPATH=A.SDF;B.SDF\r\n').blockers.some(b => /SDF なのにパスが 2 つ/.test(b)));
  assert.ok(checkBody('DO=B\r\nLDPATH=FSG;;;;;A.SDF;B.SDF\r\n').blockers.some(b => /SDF なのにパスが 2 つ/.test(b)));
  assert.ok(!checkBody('DO=B\r\nLDPATH=FSG;;;;STF;A.STF;B.STF\r\n').blockers.some(b => /パスが 2 つ/.test(b)), '標準でない種類なら 2 つでよい');
});

test('LDCRYPT を送るなら、EDATA をその後に続ける(5.9.7.4)', () => {
  const out = build(['DO=B', 'LDCRYPT=3', 'EDATA=ABC'], { labels: ['EDATA', 'LDCRYPT'], trcfmt: null });
  assert.deepEqual(out.filter(l => /^(LDCRYPT|EDATA)=/.test(l)), ['LDCRYPT=3', 'EDATA=ABC']);
});

test('ENGMARK の種類が DCS なら、指すレコードもデータに入れ、無ければ止める(5.15.1.3)', () => {
  const out = build(['DO=B', 'LNAM=ABC;ABC', 'ENGMARK=DCS;LNAM;;B;F;F'], { labels: ['ENGMARK'], trcfmt: null });
  assert.ok(out.includes('LNAM=ABC;ABC'));
  assert.ok(checkBody('DO=B\r\nENGMARK=DCS;FOO;;B;F;F\r\n').blockers.some(b => /ENGMARK が指すレコード FOO/.test(b)));
});

// ---- 寸法 ----
const RADII = Array.from({ length: 36 }, (_, i) => String(2000 + i * 5));
const RIGHT = ['TRCFMT=1;36;E;R;F', ...[0, 1, 2].map(i => 'R=' + RADII.slice(i * 12, i * 12 + 12).join(';'))];
const WANT_L = { labels: ['CIRC', 'HBOX', 'CSIZ'], trcfmt: { fmt: 1, n: 36, mode: 'E', eye: 'L' } };
test('反対眼の玉型を反転して送るときは、寸法(CIRC・HBOX)を送る形のものにする(5.4.9.3)', () => {
  const out = build(['DO=L', 'CIRC=150.00;150.00', 'HBOX=50.00;51.00', ...RIGHT], WANT_L);
  assert.ok(out.includes('TRCFMT=1;36;E;L;F'), '反転して送る');
  assert.ok(out.includes('CIRC=150.00;150.00') && out.includes('HBOX=50.00;50.00'));
  // 寸法の変更(CSIZ)を書いたジョブでは、周長の差は形の違いを表さないので、反転して寸法をそろえる(5.4.9.4 は BSIZ・CSIZ が無いか分からないときだけ)
  const sized = build(['DO=L', 'CIRC=150.00;152.00', 'CSIZ=0.00;2.00', ...RIGHT], WANT_L);
  assert.ok(sized.includes('TRCFMT=1;36;E;L;F') && sized.includes('CIRC=150.00;150.00') && sized.includes('CSIZ=0.00;2.00'));
});

test('片眼の玉型で左右の CIRC が違い、BSIZ・CSIZ が無いか分からなければ、反転せず受け取った向きと寸法のまま送る(5.4.9.4・5.4.13)', () => {
  // 5.4.9.4: 周長の差は暗に示した CSIZ で、送らない眼の形をその差だけ変える。反転して寸法をそろえると差が消え、違う大きさのレンズになる
  for (const extra of [[], ['CSIZ=?;?'], ['BSIZ=?;?', 'CSIZ=?;?']]) {
    const out = build(['DO=L', 'CIRC=150.00;152.00', 'HBOX=50.00;51.00', ...extra, ...RIGHT], WANT_L);
    assert.ok(out.includes('TRCFMT=1;36;E;R;F'), '右の向きのまま: ' + extra.join(' '));
    assert.ok(out.includes('CIRC=150.00;152.00') && out.includes('HBOX=50.00;51.00'), '寸法は受け取ったまま: ' + extra.join(' '));
  }
  // CIRC3D の差も同じ(5.4.9.4)
  const c3 = build(['DO=L', 'CIRC3D=150.00;152.00', 'FCRV=4.00;4.00', ...RIGHT], { ...WANT_L, labels: ['CIRC3D', 'FCRV'] });
  assert.ok(c3.includes('TRCFMT=1;36;E;R;F') && c3.includes('CIRC3D=150.00;152.00'));
  // 片方の CIRC が分からなければ、差を表さないので反転する
  assert.ok(build(['DO=L', 'CIRC=150.00;?', ...RIGHT], WANT_L).includes('TRCFMT=1;36;E;L;F'));
});

test('CIRC3D があるのに FCRV が無ければ止める(サグは中継しない。5.4.9.5)。BSIZ と CSIZ の両方に値があれば止める(5.4.9.2)', () => {
  assert.ok(checkBody('DO=B\r\nCIRC3D=130.00;?\r\n').blockers.some(b => /CIRC3D/.test(b)));
  assert.ok(!checkBody('DO=B\r\nCIRC3D=130.00;?\r\nFCRV=4.00;4.00\r\n').blockers.some(b => /CIRC3D/.test(b)));
  assert.ok(checkBody('DO=B\r\nBSIZ=1;1\r\nCSIZ=2;2\r\n').blockers.some(b => /BSIZ と CSIZ/.test(b)));
  assert.ok(!checkBody('DO=B\r\nBSIZ=1;1\r\nCSIZ=0;0\r\n').blockers.some(b => /BSIZ と CSIZ/.test(b)));
});

// ---- レコードの形 ----
test('後ろの余分な区切りは無いものとして読む(5.1)。DO=L; は L、SPH=1.00;1.00; は SPH=1.00;1.00 と同じ値', () => {
  assert.deepEqual(checkBody('DO=L;\r\n').blockers, []);
  assert.ok(!checkBody('DO=B\r\nSPH=1.00;1.00\r\nSPH=1.00;1.00;\r\n').blockers.some(b => /SPH/.test(b)));
});

test('1 つしか置けないレコードが同じ値で 2 つあれば、1 つだけ送る(5.1.10)。左右一対の値が 1 つの形は変えない(5.1: 両眼に当てはめる)', () => {
  const out = build(['DO=B', 'SPH=1.00;1.00', 'SPH=1.00;1.00', 'BEVP=3'], { labels: ['SPH', 'BEVP'], trcfmt: null });
  assert.equal(out.filter(l => l.startsWith('SPH=')).length, 1);
  assert.ok(out.includes('BEVP=3'));
});
