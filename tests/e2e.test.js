'use strict';
// 模擬トレーサー・模擬加工機(vca-guide の vca-session.js の createDevice)を TCP でつなぎ、受信から送信までを通しで確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const VCA = require('../src/lib/vca-parser.js');
const T = require('../src/lib/vca-tcp.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const FAST = { ack: 1, packet: 2, char: 1 };
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
// サンプルファイルの本文(REQ・JOB 以外)に、加工機向けの項目と個人情報を足したもの
const tracerRecords = sample.split(/\r\n/).filter(l => l && !/^(REQ|JOB)=/.test(l)).concat(['ETYP=1', 'CLIENT=YAMADA'])
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; });

let hub, port, dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-e2e-'));
  const cfg = merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, timeouts: FAST,
  });
  hub = createHub(cfg);
  ({ remote: port } = await hub.start());
});

test.after(async () => {
  await hub.stop();
  await new Promise(r => setTimeout(r, 100));     // 切断の記録が書き終わるのを待つ
  fs.rmSync(dir, { recursive: true, force: true });
});

const connect = (o = {}) => T.connectDevice('127.0.0.1', port, { connectDelay: 0, timeouts: FAST, ...o });
const close = d => d.socket.destroy();

/** ホストは加工機の ACK を受けてから送信済みにするため、反映を待つ。 */
async function waitStatus(id, status, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (hub.store.get(id).status === status) return;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.fail(`状態が ${status} になりませんでした(${hub.store.get(id).status})`);
}

test('トレーサー: プリセット初期化のあと、割り当てられた要求 ID で玉型をアップロードすると保存される(7.2・7.3)', async () => {
  const tracer = await connect({ kind: 'upload' });
  try {
    const ini = await tracer.initialize([['DEV', 'TRC'], ['VEN', 'TEST'], ['MODEL', 'T-1'], ['TRCFMT', '1', '360', 'E', 'R']]);
    assert.equal(ini.status, 0);
    assert.equal(ini.hostStatus, 0);
    assert.deepEqual(ini.trace.slice(0, 4), ['1', '360', 'E', 'R']);
    assert.ok(Number(ini.requestId) >= 1000, '要求 ID');
    const up = await tracer.request(ini.requestId, { job: 'A0001', data: tracerRecords });
    assert.equal(up.status, 0);
    assert.equal(VCA.value(up.final, 'JOB'), 'A0001');
  } finally { close(tracer); }
  const e = hub.store.list()[0];
  assert.equal(e.job, 'A0001');
  assert.equal(e.type, 'TRC', '要求 ID のアップロードは、初期化した機器の種類で残す');
  assert.deepEqual(e.piiRemoved, ['CLIENT']);
  assert.ok(!hub.store.readBody(e).includes('YAMADA'));
});

test('トレーサー: 初期化しない REQ=TRC のアップロードも保存される(7.2.6.2)', async () => {
  const tracer = await connect();
  try {
    const up = await tracer.request('TRC', { job: 'A0002', data: tracerRecords });
    assert.equal(up.status, 0);
  } finally { close(tracer); }
  assert.equal(hub.store.list()[0].job, 'A0002');
});

test('加工機: 送信待ちにする前は STATUS=1(ジョブが見つからない)', async () => {
  const edger = await connect();
  try {
    assert.equal((await edger.request('EDG', { job: 'A0001' })).status, 1);
  } finally { close(edger); }
});

test('加工機: 自動フォーマット初期化(候補の 1 つ目の形式が使えなければ次を選ぶ)→ 要求 ID でダウンロード', async () => {
  const a1 = hub.store.list().find(e => e.job === 'A0001');
  hub.store.queue(a1.id, 'A0001', { replace: true });
  const edger = await connect();
  try {
    const ini = await edger.initialize(
      [['DEV', 'EDG'], ['VEN', 'TEST'], ['MODEL', 'E-1'], ['TRCFMT', '1', '1000', 'X', 'B'], ['TRCFMT', '1', '512', 'E', 'B']],
      { tag: 'EDGREQ', labels: ['HBOX', 'VBOX', 'DBL', 'ETYP', 'LIND', 'CLIENT'] });
    assert.equal(ini.status, 0);
    assert.deepEqual(ini.trace.slice(0, 4), ['1', '512', 'E', 'B']);
    const dl = await edger.request(ini.requestId, { job: 'A0001' });
    assert.equal(dl.status, 0);
    const d = dl.response;
    assert.equal(VCA.value(d, 'ANS'), ini.requestId);
    assert.equal(VCA.value(d, 'DO'), 'R');
    assert.deepEqual(d.rec.HBOX, ['52.00', '52.00']);
    assert.equal(VCA.value(d, 'ETYP'), '1');
    assert.deepEqual(d.rec.LIND, ['?'], '持っていない項目は ?(5.1.4)');
    assert.deepEqual(d.rec.CLIENT, ['?'], '除去した個人情報は送らない');
    assert.equal(d.rec.IPD, undefined, '一覧にない項目は送らない(7.2.4)');
    assert.equal(d.traces[0].radii.length, 512);
    assert.equal(d.traces[0].fmt, 1);
  } finally { close(edger); }
  await waitStatus(a1.id, 'sent');
});

test('加工機: 初期化しない機器(REQ=EDG)には、プリセットの項目と元の形式の玉型を送る(7.2.6.2)', async () => {
  const a1 = hub.store.list().find(e => e.job === 'A0001');
  hub.store.queue(a1.id, 'A0001', { replace: true });
  const edger = await connect();
  try {
    const dl = await edger.request('EDG', { job: 'A0001' });
    assert.equal(dl.status, 0);
    const d = dl.response;
    assert.deepEqual(d.rec.IPD, ['31.5', '31.0']);
    assert.deepEqual(d.rec.LMATTYPE, ['?'], 'プリセットの項目で持っていないものは ?(5.1.4)');
    assert.equal(d.rec.HBOX, undefined, 'プリセットに無い項目は送らない');
    assert.equal(d.traces[0].radii.length, 360);
  } finally { close(edger); }
  await waitStatus(a1.id, 'sent');
});

test('加工機が最後のデータに ACK を返さなければ、送信済みにしない', async () => {
  const a1 = hub.store.list().find(e => e.job === 'A0001');
  hub.store.queue(a1.id, 'A0001', { replace: true });
  // 要求だけを送り、ホストのデータには何も返さない
  const sock = net.connect(port, '127.0.0.1');
  await new Promise(r => sock.once('connect', r));
  try {
    sock.write(Buffer.from(VCA.buildPacket([['REQ', 'EDG'], ['JOB', 'A0001']]), 'latin1'));
    await new Promise(r => setTimeout(r, FAST.ack * 1000 + 500));
    assert.equal(hub.store.get(a1.id).status, 'queued');
  } finally { sock.destroy(); }
});

test('割り当てていない要求 ID は STATUS=5、規格にある非対応種別と規格にない種別は 16、REQ なしは ANS=ERR と 18', async () => {
  const dev = await connect();
  try {
    assert.equal((await dev.request('99999', { job: 'A0001' })).status, 5);
    assert.equal((await dev.request('GEN', { job: 'A0001' })).status, 16);
    const sock = net.connect(port, '127.0.0.1');
    await new Promise(r => sock.once('connect', r));
    const got = new Promise(r => { let s = ''; sock.on('data', b => { s += b.toString('latin1'); if (s.includes(VCA.CH.GS)) r(s); }); });
    sock.write(Buffer.from(VCA.buildPacket([['JOB', 'A0001']]), 'latin1'));
    const p = VCA.parsePacket((await got).slice((await got).indexOf(VCA.CH.FS)));
    sock.destroy();
    assert.equal(VCA.value(p, 'ANS'), 'ERR');
    assert.equal(VCA.number(p, 'STATUS'), 18);
  } finally { close(dev); }
});

test('時刻合わせ(TIM)', async () => {
  const dev = await connect();
  try {
    const r = await dev.request('TIM');
    assert.match(VCA.value(r.response, 'TIME'), /^\d{14}$/);
  } finally { close(dev); }
});

test('CRC なしで要求した機器には CRC なしで返し、CRC 付きなら CRC 付きで返す(6.1.2.1)', async () => {
  for (const crc of [false, true]) {
    const dev = await connect({ crc });
    try {
      const r = await dev.request('TIM');
      assert.equal(r.response.crcOk, crc ? true : null);
    } finally { close(dev); }
  }
});

test('つなぎ直しても、前の接続で割り当てた要求 ID を使える', async () => {
  let id;
  const a = await connect();
  try {
    id = (await a.initialize([['DEV', 'EDG'], ['VEN', 'TEST'], ['MODEL', 'E-2'], ['TRCFMT', '1', '360', 'E', 'R']], { tag: 'X', labels: ['DBL'] })).requestId;
  } finally { close(a); }
  const b = await connect();
  try {
    assert.equal((await b.request(id, { job: 'NOJOB' })).status, 1, '要求 ID は知っているので 5 ではなく、ジョブが無いので 1');
  } finally { close(b); }
});

test('ログにレコードの中身(氏名など)が書かれていない', () => {
  const logDir = path.join(dir, 'log');
  const text = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  assert.ok(text.includes('"event":"received"'));
  assert.ok(!text.includes('YAMADA'));
  assert.ok(!text.includes('31.5'));
});

test('許可していない IP からの接続は切断される(判定のみ確認)', () => {
  const { isAllowed } = require('../src/net/tcp.js');
  assert.equal(isAllowed('::ffff:192.168.1.20', ['192.168.0.0/16']), true);
  assert.equal(isAllowed('203.0.113.5', ['127.0.0.1/32', '192.168.0.0/16']), false);
});

test('写した 4 つのライブラリは vca-guide の src と同じ(設計書 3 章)', t => {
  const guide = path.join(__dirname, '..', '..', 'vca-guide', 'src');
  if (!fs.existsSync(guide)) { t.skip('vca-guide が隣のフォルダにありません'); return; }
  // 行末は、git の設定(取り出すときの CRLF への変換)で変わるので、そろえてから比べる
  const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  for (const f of ['vca-parser.js', 'vca-records.js', 'vca-session.js', 'vca-tcp.js']) {
    assert.equal(read(path.join(__dirname, '..', 'src', 'lib', f)), read(path.join(guide, f)), f);
  }
});
