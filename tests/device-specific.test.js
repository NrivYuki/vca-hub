'use strict';
// 機器ごとのレコード(DCS 5.16・5.17 の PROC・PROCBLK)と、BEVP に伴う BEVM・BEVC(7.2.4.3・表 A.1)。
// 期待値は規格の本文と例から決める。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../src/lib/vca-tcp.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { buildDownload } = require('../src/send/build.js');
const { uploadRecords } = require('../src/device/upload.js');
const { checkBody } = require('../src/send/check.js');

const text = rows => rows.join('\r\n') + '\r\n';
const lines = args => buildDownload(args).map(r => r[0] + '=' + r.slice(1).join(';'));
const dev = (d, v, m, sn = '') => ({ dev: d, ven: v, model: m, sn });

// 5.17.1.2 の例
const PROC_EXAMPLE = text([
  'JOB=P1', 'LMATID=14;14',
  'PROC=_P1PROC;POL;IGX;TURBO;010702250607000000;010702250607000000',
  'PROC=LMATID;FSG;IGX;MARKX;62;62',
]);
// 5.17.2.2 の例(抜き出し。ブロック 2 には CRIBFMT のデータセットがある)
const PROCBLK_EXAMPLE = text([
  'JOB=PROCBLKEXFSG', 'LMATID=14;14', 'GAX=90.00;90.00', 'RNGH=0.00;0.00', 'BLKD=59.00;59.00',
  'PROCBLK=1;FSG;SOM;HSC101;', '1!LMATID=70;70', '1!SCSBRD=2.50;2.50', '1!SCSBCCA=0;180', '1!GAX=0;0',
  'PROCBLK=2;FSG;LOH;VFT;', '2!RNGH=3.00;3.00', '2!BLKD=40.00;40.00', '2!CRIBFMT=1;4;E;L;F', '2!R=2988;2981;2997;3010',
]);

test('PROC: 名乗った機器が求めたラベルを、機器を示す欄を除いて渡す(5.17.1.2 の _P1PROC と LMATID の例)', () => {
  assert.deepEqual(lines({ body: PROC_EXAMPLE, profile: { labels: ['_P1PROC'] }, device: dev('POL', 'IGX', 'TURBO') }),
    ['DO=B', '_P1PROC=010702250607000000;010702250607000000']);
  assert.deepEqual(lines({ body: PROC_EXAMPLE, profile: { labels: ['LMATID'] }, device: dev('FSG', 'IGX', 'MARKX') }),
    ['DO=B', 'LMATID=62;62'], '全体の LMATID=14;14 ではなく、この機器に向けた値');
});

test('PROC・PROCBLK は、当てはまらない機器へも当てはまる機器へも、そのままは渡さない(5.16: 機器を示す欄を含めない)', () => {
  for (const d of [dev('FSG', 'IGX', 'MARKX'), dev('EDG', 'X', 'Y'), dev('POL', 'IGX', 'TURBO')]) {
    const out = lines({ body: PROCBLK_EXAMPLE + PROC_EXAMPLE, profile: null, device: d });
    assert.ok(!out.some(l => /^(PROC|PROCBLK|\d+!)/.test(l)), JSON.stringify(out));
  }
  assert.deepEqual(lines({ body: PROC_EXAMPLE, profile: { labels: ['LMATID', '_P1PROC'] }, device: dev('FSG', 'LOH', 'VFT') }),
    ['DO=B', 'LMATID=14;14', '_P1PROC=?'], '当てはまらない機器には全体の値。PROC にしか無いものは ?(5.1.4)');
});

test('PROCBLK: 当てはまるブロックの中身を、番号を除いて全体の値に代えて渡す(5.17.2.2 のブロック 1)', () => {
  const out = lines({ body: PROCBLK_EXAMPLE, profile: null, device: dev('FSG', 'SOM', 'HSC101') });
  assert.deepEqual(out, ['DO=B', 'LMATID=70;70', 'GAX=0;0', 'RNGH=0.00;0.00', 'BLKD=59.00;59.00', 'SCSBRD=2.50;2.50', 'SCSBCCA=0;180']);
  assert.deepEqual(lines({ body: PROCBLK_EXAMPLE, profile: { labels: ['LMATID', 'GAX'] }, device: dev('FSG', 'SOM', 'HSC101') }),
    ['DO=B', 'LMATID=70;70', 'GAX=0;0']);
});

test('PROCBLK: 機器向けのデータセット(ブロック 2 の CRIBFMT)は作り直せないので、その機器には渡さない', () => {
  assert.throws(() => buildDownload({ body: PROCBLK_EXAMPLE, profile: null, device: dev('FSG', 'LOH', 'VFT') }),
    e => e.code === 'device-specific-dataset');
  assert.doesNotThrow(() => buildDownload({ body: PROCBLK_EXAMPLE, profile: null, device: dev('FSG', 'SOM', 'HSC101') }),
    'ほかのブロックに当てはまる機器には渡せる');
});

test('PROCBLK の SN: 書いてあれば、その製造番号の機器にだけ当てはまる。名乗らない機器には当てはまらず、下の段へ進む(表 A.1)', () => {
  const body = text(['JOB=S', 'LMATID=14;14', 'PROCBLK=1;FSG;SOM;HSC100;1234', '1!LMATID=70;70']);
  assert.deepEqual(lines({ body, profile: { labels: ['LMATID'] }, device: dev('FSG', 'SOM', 'HSC100', '1234') }), ['DO=B', 'LMATID=70;70']);
  assert.deepEqual(lines({ body, profile: { labels: ['LMATID'] }, device: dev('FSG', 'SOM', 'HSC100', '9') }), ['DO=B', 'LMATID=14;14']);
  assert.deepEqual(lines({ body, profile: { labels: ['LMATID'] }, device: dev('FSG', 'SOM', 'HSC100') }), ['DO=B', 'LMATID=14;14'],
    '製造番号を名乗らない機器には、製造番号で絞ったブロックは当てはまらない(全体の値)');
});

test('1 つしか置けないレコード: 合う欄が多い方を渡す。同じ合い方で値が違えば、どちらも選ばずに断る', () => {
  const body = text(['JOB=M', 'LMATID=14;14', 'PROC=LMATID;FSG;;;1;1', 'PROC=LMATID;FSG;IGX;MARKX;62;62']);
  assert.deepEqual(lines({ body, profile: { labels: ['LMATID'] }, device: dev('FSG', 'IGX', 'MARKX') }), ['DO=B', 'LMATID=62;62']);
  assert.deepEqual(lines({ body, profile: { labels: ['LMATID'] }, device: dev('FSG', 'LOH', 'VFT') }), ['DO=B', 'LMATID=1;1'],
    'VEN・MODEL が空の PROC は、DEV が合う機器すべてに当てはまる');
  const twice = text(['JOB=M', 'PROC=LMATID;FSG;IGX;;1;1', 'PROCBLK=1;FSG;IGX;;', '1!LMATID=2;2']);
  assert.throws(() => buildDownload({ body: twice, profile: { labels: ['LMATID'] }, device: dev('FSG', 'IGX', 'MARKX') }),
    e => e.code === 'device-specific-ambiguous');
  const same = text(['JOB=M', 'PROC=LMATID;FSG;IGX;;2;2', 'PROCBLK=1;FSG;IGX;;', '1!LMATID=2;2']);
  assert.deepEqual(lines({ body: same, profile: { labels: ['LMATID'] }, device: dev('FSG', 'IGX', 'MARKX') }), ['DO=B', 'LMATID=2;2'],
    '値が同じなら決められる');
});

test('複数置けるレコードは、全体のものに足す(5.17.1.1: Plural records の効果は足し合わせ)', () => {
  const body = text(['JOB=E', 'ENGMARK=A;1', 'PROC=ENGMARK;ENG;;;B;2']);
  assert.deepEqual(lines({ body, profile: { labels: ['ENGMARK'] }, device: dev('ENG', 'X', 'Y') }), ['DO=B', 'ENGMARK=A;1', 'ENGMARK=B;2']);
  assert.deepEqual(lines({ body, profile: { labels: ['ENGMARK'] }, device: dev('EDG', 'X', 'Y') }), ['DO=B', 'ENGMARK=A;1']);
});

test('別の PC や共有フォルダへは、PROC・PROCBLK とブロックの中身をそのまま残す(受け手が機器に合わせる)', () => {
  const out = uploadRecords(PROCBLK_EXAMPLE + PROC_EXAMPLE).map(r => r[0] + '=' + r.slice(1).join(';'));
  for (const l of ['PROCBLK=1;FSG;SOM;HSC101;', '1!LMATID=70;70', '1!GAX=0;0', '2!CRIBFMT=1;4;E;L;F', '2!R=2988;2981;2997;3010', 'PROC=LMATID;FSG;IGX;MARKX;62;62']) {
    assert.ok(out.includes(l), l);
  }
  const i = out.indexOf('PROCBLK=2;FSG;LOH;VFT;');
  assert.deepEqual(out.slice(i, i + 5), ['PROCBLK=2;FSG;LOH;VFT;', '2!RNGH=3.00;3.00', '2!BLKD=40.00;40.00', '2!CRIBFMT=1;4;E;L;F', '2!R=2988;2981;2997;3010'],
    'ブロックの中身は宣言に続けたまま(表 A.1)');
});

test('送る前の確認で、機器ごとの値があることと、渡せないブロックを知らせる', () => {
  const { notices } = checkBody(PROCBLK_EXAMPLE);
  assert.ok(notices.some(n => n.includes('PROC・PROCBLK')));
  assert.ok(notices.some(n => n.includes('ブロック 2')));
  assert.ok(!notices.some(n => n.includes('ブロック 1')));
});

// ---- BEVP に伴う BEVM・BEVC(7.2.4.3: 要るときに入れる。表 A.1 の BEVP の値の意味) ----
test('BEVP の値で要るものだけを足す: 1・2・5 は BEVM、3 は BEVM と BEVC、0・4・7・10 は足さない', () => {
  const bev = bevp => lines({ body: text(['JOB=B', `BEVP=${bevp}`]), profile: { labels: ['BEVP'], preset: true } }).slice(1);
  assert.deepEqual(bev('4;4'), ['BEVP=4;4']);
  assert.deepEqual(bev('0'), ['BEVP=0']);
  assert.deepEqual(bev('7;10'), ['BEVP=7;10']);
  assert.deepEqual(bev('1;1'), ['BEVP=1;1', 'BEVM=?;?']);
  assert.deepEqual(bev('5'), ['BEVP=5', 'BEVM=?;?']);
  assert.deepEqual(bev('3;4'), ['BEVP=3;4', 'BEVM=?;?', 'BEVC=?;?'], '片眼でも要れば足す');
});

test('BEVP が無い・? ・意味の決まっていない値のときは、要るかどうか決められないので両方足す', () => {
  const bev = rows => lines({ body: text(['JOB=B', ...rows]), profile: { labels: ['BEVP'], preset: true } }).slice(1);
  assert.deepEqual(bev([]), ['BEVP=?;?', 'BEVM=?;?', 'BEVC=?;?']);
  assert.deepEqual(bev(['BEVP=?;?']), ['BEVP=?;?', 'BEVM=?;?', 'BEVC=?;?']);
  assert.deepEqual(bev(['BEVP=6']), ['BEVP=6', 'BEVM=?;?', 'BEVC=?;?']);
});

// ---- 加工機とのセッション ----
test('加工機の要求: 名乗った機器に向けた値を渡す。渡せないときは STATUS=4(表 A.24: データはあるが、求めた機器には合わない)で、送信待ちのまま残す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-proc-'));
  const FAST = { ack: 1, packet: 2, char: 1 };
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, timeouts: FAST, connectDelay: 0,
  }));
  const ports = await hub.start();
  const save = (body, name) => { const e = hub.store.saveReceived({ body, type: 'TRC', job: name, peer: 'p', crcOk: null }); hub.store.queue(e.id, name); return e.id; };
  const ok = save(text(['JOB=J1', 'LMATID=14;14', 'PROC=LMATID;EDG;IGX;MARKX;62;62']), 'J1');
  const ng = save(text(['JOB=J2', 'LMATID=14;14', 'PROCBLK=1;EDG;IGX;MARKX;', '1!CRIBFMT=1;4;E;R;F', '1!R=1;2;3;4']), 'J2');
  const edger = await T.connectDevice('127.0.0.1', ports.remote, { connectDelay: 0, timeouts: FAST });
  try {
    const r = await edger.request('EDG', { job: 'J1', records: [['DEV', 'EDG'], ['VEN', 'IGX'], ['MODEL', 'MARKX']] });
    assert.equal(r.status, 0);
    assert.deepEqual(r.response.rec.LMATID, ['62', '62']);
    assert.equal(r.response.rec.PROC, undefined);
    const r2 = await edger.request('EDG', { job: 'J2', records: [['DEV', 'EDG'], ['VEN', 'IGX'], ['MODEL', 'MARKX']] });
    assert.equal(r2.status, 4);
    for (const t0 = Date.now(); !(hub.store.get(ok).status === 'sent' && hub.store.sending.size === 0) && Date.now() - t0 < 3000;) await new Promise(r => setTimeout(r, 20));
    assert.equal(hub.store.get(ng).status, 'queued');
    assert.equal(hub.store.sending.size, 0, '押さえたままにしない');
    assert.ok(hub.log.list().some(l => /この加工機には渡せません: 機器ごとのブロックに、渡せない玉型・データセットがある/.test(String(l.detail))), '理由を記録に残す');
    assert.equal(hub.store.get(ok).status, 'sent');
  } finally { edger.socket.destroy(); await hub.stop(); await new Promise(res => setTimeout(res, 100)); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 形の崩れた PROC・PROCBLK(表 A.1)。どの機器に何を渡すか決められないので、送り出さない ----
test('形の崩れた PROC・PROCBLK は送り出せない理由にし、加工機にも渡さない', () => {
  const D = dev('FSG', 'IGX', 'MARKX');
  const cases = [
    ['PROC の値の欄が無い', ['LMATID=14;14', 'PROC=LMATID;FSG;IGX;MARKX'], /欄が足りません/],
    ['PROC の DEV が空', ['PROC=LMATID;;IGX;MARKX;62;62'], /DEV がありません/],
    ['PROC の中の PROC', ['PROC=PROC;FSG;;;X;Y'], /置けません/],
    ['同じ番号の宣言', ['PROCBLK=1;FSG;IGX;MARKX', '1!LMATID=70;70', 'PROCBLK=1;EDG;;', '1!GAX=5;5'], /2 度宣言/],
    ['宣言から離れたブロックの行', ['PROCBLK=1;FSG;IGX;MARKX', '1!LMATID=70;70', 'DBL=18', '1!GAX=5;5'], /続いていません/],
    ['宣言の無いブロックの行', ['LMATID=14;14', '3!LMATID=99;99'], /宣言がありません/],
    ['ブロックの中の PROCBLK', ['PROCBLK=1;FSG;;', '1!PROCBLK=2;EDG'], /置けません/],
    ['番号の無い PROCBLK', ['PROCBLK=;FSG;IGX'], /番号か DEV/],
  ];
  for (const [name, rows, re] of cases) {
    const body = text(rows);
    assert.ok(checkBody(body).blockers.some(b => re.test(b)), name);
    assert.throws(() => buildDownload({ body, profile: null, device: D }), e => e.code === 'device-specific-invalid', name);
  }
  assert.deepEqual(checkBody(PROCBLK_EXAMPLE + PROC_EXAMPLE).blockers, [], '規格の例は形が正しい');
});

test('名乗った機器と大文字・小文字だけが違う PROC・PROCBLK があれば、全体の値を黙って渡さず断る', () => {
  for (const rows of [['LMATID=14;14', 'PROC=LMATID;FSG;igx;MarkX;62;62'], ['LMATID=14;14', 'PROCBLK=1;fsg;IGX;MARKX', '1!LMATID=70;70']]) {
    assert.throws(() => buildDownload({ body: text(rows), profile: { labels: ['LMATID'] }, device: dev('FSG', 'IGX', 'MARKX') }),
      e => e.code === 'device-specific-case');
  }
  assert.deepEqual(lines({ body: text(['LMATID=14;14', 'PROC=LMATID;FSG;igx;MarkX;62;62']), profile: { labels: ['LMATID'] }, device: dev('FSG', 'LOH', 'VFT') }),
    ['DO=B', 'LMATID=14;14'], 'ほかの機器向けと分かるものは、そのまま全体の値');
});

test('機器が DEV を名乗らなければ決められないので断る。名乗っていない欄で絞った値は、その機器には合わない(表 A.1 の優先順位)', () => {
  const P = text(['LMATID=14;14', 'PROC=LMATID;FSG;IGX;MARKX;62;62']);
  const want = { labels: ['LMATID'] };
  for (const d of [null, dev('', '', '')]) {
    assert.throws(() => buildDownload({ body: P, profile: want, device: d }), e => e.code === 'device-specific-unknown', JSON.stringify(d));
  }
  for (const d of [dev('FSG', '', ''), dev('FSG', 'IGX', '')]) {
    assert.deepEqual(lines({ body: P, profile: want, device: d }), ['DO=B', 'LMATID=14;14'], JSON.stringify(d));
  }
  const SN = text(['LMATID=14;14', 'PROCBLK=1;FSG;SOM;HSC100;1234', '1!LMATID=70;70']);
  assert.deepEqual(lines({ body: SN, profile: want, device: dev('FSG', 'SOM', 'HSC100') }), ['DO=B', 'LMATID=14;14'],
    '製造番号で絞ったブロックは、製造番号を名乗らない機器には当てはまらない');
  assert.deepEqual(lines({ body: SN, profile: want, device: dev('FSG', 'LOH', 'VFT') }), ['DO=B', 'LMATID=14;14'],
    '名乗った欄でほかの機器向けと分かれば、全体の値');
  assert.deepEqual(lines({ body: P, profile: want, device: dev('EDG', '', '') }), ['DO=B', 'LMATID=14;14'], 'DEV が違えば、全体の値');
  assert.deepEqual(lines({ body: text(['LMATID=14;14']), profile: want, device: null }), ['DO=B', 'LMATID=14;14'], '機器向けの値が無ければ、名乗りは要らない');
});
