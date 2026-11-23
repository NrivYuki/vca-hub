'use strict';
// 設定の書き損じ、ラベルの形(5.1.6・表 1)、拡張の出力の確かめ、見本の拡張(text-protocol)の送信。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { fileRecords } = require('../src/send/folder.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-ec-'));
const CRLF = '\r\n';
const BODY = 'DO=R' + CRLF + 'JOB=A' + CRLF + 'DBL=18' + CRLF;
const text = recs => recs.map(r => r[0] + '=' + r.slice(1).join(';'));

test('config.json の知らない項目(書き損じ)は、項目の名前を出して起動しない', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'config.json');
    for (const [obj, name] of [[{ alow: ['10.0.0.0/8'] }, 'alow'], [{ retentiondays: 30 }, 'retentiondays'], [{ web: { prot: 8765 } }, 'web.prot']]) {
      fs.writeFileSync(f, JSON.stringify(obj));
      assert.throws(() => loadConfig(f), e => e.code === 'config' && e.message.includes(name), name);
    }
    fs.writeFileSync(f, JSON.stringify({ remote: { enabled: true, port: 33512, protocol: 'vca' }, destinations: [{ name: 'D', host: 'h', port: 1, fingerprint: 'x' }] }));
    assert.doesNotThrow(() => loadConfig(f), '口の protocol・送り先の拡張の項目は通す');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('名前空間の付いたラベル(ACME:MODE)の行も落とさずに送る(: は予約文字ではない。5.1.6・表 1)', () => {
  assert.ok(text(fileRecords('DO=R\r\nACME:MODE=2\r\n')).includes('ACME:MODE=2'));
});

function extHub(dir, code) {
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'x'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'x', 'index.js'), code);
  return createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, extensionsDir: extDir, extensions: { x: true } }));
}

test('拡張の出力の確かめは、受け取った行の読み方とそろえる(- 入りのラベル・ラベルの後ろの空白を止めない)', () => {
  const dir = tmp();
  try {
    const hub = extHub(dir, "module.exports = { setup(h) { h.on('send', ({ records }) => records); } };");
    const e = hub.store.saveReceived({ body: BODY + 'ACME-X=1\r\nLNAM =ABC\r\n', type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    const out = text(hub.recordsFor(e, { kind: 'file' }));
    assert.ok(out.some(l => l.startsWith('ACME-X=')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('拡張の send が、データセットの系列に生の CR・LF を入れたら送らない(別の行が紛れ込むため)', () => {
  const dir = tmp();
  try {
    const hub = extHub(dir, "module.exports = { setup(h) { h.on('send', ({ records }) => records.concat([['R', '1;2\\r\\nJOB=EVIL']])); } };");
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    assert.throws(() => hub.recordsFor(e, { kind: 'file' }), err => err.code === 'ext-send');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('見本の拡張(text-protocol): データを送った後で応答が無ければ、届いたか分からないとして知らせる', async () => {
  const dir = tmp();
  const conns = [];
  const sink = net.createServer(c => conns.push(c));   // 受け取るが答えない
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const exts = path.join(__dirname, '..', 'examples', 'extensions');
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false }, timeouts: { ack: 1, packet: 1, char: 1 },
    extensionsDir: exts, extensions: { 'text-protocol': true }, destinations: [{ name: 'T', host: '127.0.0.1', port: sink.address().port, protocol: 'text-line' }],
  }));
  await hub.start();
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    await assert.rejects(hub.sendTo(e.id, 'A1', 'T'), err => err.code === 'upload-unconfirmed');
  } finally { for (const c of conns) c.destroy(); await hub.stop(); await new Promise(r => sink.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('見本の拡張(text-protocol): ACK のときに送信済みを書けなくても、vca-hub は止まらない', async () => {
  const dir = tmp();
  const exts = path.join(__dirname, '..', 'examples', 'extensions');
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: false },
    extensionsDir: exts, extensions: { 'text-protocol': true }, listeners: [{ name: 'L', port: 0, protocol: 'text-line' }],
  }));
  const ports = await hub.start();
  let uncaught = 0;
  const onErr = () => { uncaught++; };
  process.on('uncaughtException', onErr);
  try {
    const e = hub.store.saveReceived({ body: BODY, type: 'TRC', job: 'A', peer: 'p', crcOk: null });
    hub.store.queue(e.id, 'TP1');
    hub.store.markSent = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    const sock = net.connect(ports.listeners.L, '127.0.0.1');
    await new Promise(r => sock.once('connect', r));
    let got = '';
    sock.on('data', d => { got += d; });
    sock.write('GET TP1\r\n');
    for (const t0 = Date.now(); !got.includes('END') && Date.now() - t0 < 3000;) await new Promise(r => setTimeout(r, 20));
    sock.write('ACK\r\n');
    await new Promise(r => setTimeout(r, 200));
    sock.destroy();
    assert.equal(uncaught, 0);
    assert.deepEqual(hub.store.reserve('TP1', {}), { busy: true }, '送信済みとして押さえたまま');
  } finally { process.off('uncaughtException', onErr); await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
