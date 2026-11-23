'use strict';
// 送信待ちのデータを、2 つの接続に渡さない(設計書 5 章)。
// 1 つの接続へ送っている途中(最後のパケットに ACK を受けるまで)は、ほかの接続には渡さず、
// 表 A.24 の 11(受け手が忙しく、いまは要求に応えられない)を返す。
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
const { Store } = require('../src/store/store.js');

const FAST = { ack: 1, packet: 2, char: 1 };
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const body = sample.replace('REQ=FIL', 'ANS=TRC');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-rsv-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- Store ----
test('押さえたデータは、押さえた接続にだけ渡し、ほかの接続には busy を返す。探すだけ(findQueued)でも返さない', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    store.queue(e.id, 'J1');
    const a = {}, b = {};
    assert.equal(store.reserve('J1', a).entry.id, e.id);
    assert.equal(store.reserve('J1', a).entry.id, e.id, '同じ接続がもう一度求めたら渡す');
    assert.deepEqual(store.reserve('J1', b), { busy: true });
    assert.equal(store.findQueued('J1'), null, '送っている途中のものは、探しても返さない(拡張の io.queued)');
    assert.equal(store.reserve('NONE', b), null, '無いジョブは null');
    assert.equal(store.get(e.id).status, 'queued', '押さえても索引の状態は変えない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('押さえたデータは、押さえた接続が放すか送信済みにするまで放さない。ほかの接続からは放せない', () => {
  const dir = tmp();
  try {
    const store = new Store({ dir });
    const e = store.saveReceived({ body, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
    store.queue(e.id, 'J1');
    const a = {}, b = {};
    store.reserve('J1', a);
    assert.equal(store.release(e.id, b), false, 'ほかの接続からは放せない');
    assert.deepEqual(store.reserve('J1', b), { busy: true });
    assert.equal(store.release(e.id, a), true);
    assert.equal(store.reserve('J1', b).entry.id, e.id, '放したら、ほかの接続に渡せる');
    assert.deepEqual(store.releaseAll(b), [e.id], '接続が切れたら、その接続が押さえたものを全て放す');
    assert.equal(store.findQueued('J1').id, e.id);
    store.reserve('J1', a);
    store.markSent(e.id, 'EDGER');
    assert.equal(store.sending.size, 0, '送信済みにしたら放す');
    assert.equal(store.reserve('J1', b), null, '送信済みのものは渡さない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 加工機の接続(TCP) ----
async function makeHub(over = {}) {
  const dir = tmp();
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, timeouts: FAST, connectDelay: 0, ...over,
  }));
  const ports = await hub.start();
  const port = ports.remote;
  const e = hub.store.saveReceived({ body, type: 'TRC', job: 'X', peer: 'p', crcOk: null });
  hub.store.queue(e.id, 'J1');
  return {
    hub, port, ports, id: e.id,
    edger: () => T.connectDevice('127.0.0.1', port, { connectDelay: 0, timeouts: FAST }),
    /** 要求だけを送り、ホストのデータに ACK を返さない加工機 */
    async silent() {
      const sock = net.connect(port, '127.0.0.1');
      await new Promise(r => sock.once('connect', r));
      sock.write(Buffer.from(VCA.buildPacket([['REQ', 'EDG'], ['JOB', 'J1']]), 'latin1'));
      return sock;
    },
    /** 送っている途中で押さえられるまで待つ */
    async untilSending(yes = true, ms = 8000) {
      const until = Date.now() + ms;
      while (Date.now() < until) { if (hub.store.sending.has(e.id) === yes) return; await wait(20); }
      assert.fail(yes ? '押さえられませんでした' : '放されませんでした');
    },
    unconfirmed: () => hub.log.list().filter(l => l.event === 'download-unconfirmed'),
    async done() { await hub.stop(); await wait(100); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('2 台の加工機が同時に同じジョブを求めても、データを渡すのは 1 台だけ。もう 1 台には STATUS=11', async () => {
  const h = await makeHub();
  const [a, b] = await Promise.all([h.edger(), h.edger()]);
  try {
    const r = await Promise.all([
      a.request('EDG', { job: 'J1', dev: 'EDG', ven: 'A', model: 'A' }),
      b.request('EDG', { job: 'J1', dev: 'EDG', ven: 'B', model: 'B' }),
    ]);
    assert.deepEqual(r.map(x => x.status).sort((p, q) => p - q), [0, 11]);
    const got = r.find(x => x.status === 0), busy = r.find(x => x.status === 11);
    assert.ok(got.response.rec.DBL && got.response.traces.length === 1, 'STATUS=0 の方はジョブのデータを受け取る');
    assert.ok(!busy.response.rec.DBL && busy.response.traces.length === 0, 'STATUS=11 の方にはジョブのデータを入れない');
    for (const t0 = Date.now(); !(h.hub.store.get(h.id).status === 'sent') && Date.now() - t0 < 3000;) await new Promise(r => setTimeout(r, 20));
    assert.equal(h.hub.store.get(h.id).status, 'sent');
    assert.equal(h.hub.store.get(h.id).sent.length, 1, '送信の記録は 1 件');
    assert.equal((await b.request('EDG', { job: 'J1', dev: 'EDG', ven: 'B', model: 'B' })).status, 1, '送り終えた後はジョブが無い(STATUS=1)');
  } finally { a.socket.destroy(); b.socket.destroy(); await h.done(); }
});

test('加工機が ACK を返す前に切れたら、送信済みにせず送信待ちに戻し、記録に残す。ほかの加工機が受け取れる', async () => {
  const h = await makeHub();
  const sock = await h.silent();
  const b = await h.edger();
  try {
    await h.untilSending();
    assert.equal((await b.request('EDG', { job: 'J1', dev: 'EDG', ven: 'B', model: 'B' })).status, 11, '送っている途中は渡さない');
    sock.destroy();
    await h.untilSending(false);
    assert.equal(h.hub.store.get(h.id).status, 'queued');
    assert.equal(h.unconfirmed().length, 1, '受け取ったか分からないことを記録に残す');
    const r = await b.request('EDG', { job: 'J1', dev: 'EDG', ven: 'B', model: 'B' });
    assert.equal(r.status, 0);
    for (const t0 = Date.now(); !(h.hub.store.get(h.id).status === 'sent') && Date.now() - t0 < 3000;) await new Promise(r => setTimeout(r, 20));
    assert.equal(h.hub.store.get(h.id).status, 'sent');
  } finally { sock.destroy(); b.socket.destroy(); await h.done(); }
});

test('加工機が ACK を返さないまま接続を保っても、送り直しの上限を過ぎたら送信待ちに戻す', async () => {
  const h = await makeHub();
  const sock = await h.silent();
  try {
    await h.untilSending();
    await h.untilSending(false);
    assert.equal(h.hub.store.get(h.id).status, 'queued');
    assert.equal(h.unconfirmed().length, 1);
    assert.equal(h.hub.store.findQueued('J1').id, h.id);
  } finally { sock.destroy(); await h.done(); }
});

/** vca-hub がつないでくるのを待つ加工機。ask() で要求だけを送り、ホストのデータに ACK を返さない */
async function silentListener() {
  let socket, connected;
  const ready = new Promise(r => { connected = r; });
  const server = await new Promise(r => {
    const s = net.createServer(c => { socket = c; c.on('error', () => {}); connected(); });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  return {
    server, port: server.address().port,
    async ask() { await ready; socket.write(Buffer.from(VCA.buildPacket([['REQ', 'EDG'], ['JOB', 'J1']]), 'latin1')); },
    cut: () => socket && socket.destroy(),
  };
}

for (const how of ['ローカル接続', 'オートコネクト']) {
  test(`${how}: 加工機が ACK を返す前に切れたら、送信待ちに戻す`, async () => {
    const dev = await silentListener();
    const h = await makeHub(how === 'ローカル接続'
      ? { remote: { enabled: false }, local: [{ name: 'E', host: '127.0.0.1', port: dev.port }] }
      : { remote: { enabled: false }, autoconnect: { enabled: true, port: 0 } });
    try {
      if (how === 'オートコネクト') {
        await T.announce({ ip: '127.0.0.1', port: dev.port, dev: 'EDG', ven: 'TEST', model: 'E-AC' }, { address: '127.0.0.1', port: h.ports.autoconnect });
      }
      await dev.ask();
      await h.untilSending();
      dev.cut();
      await h.untilSending(false, 500);   // 送り直しの上限(ACK の待ち時間 1 秒)より前に、切れたことで放す
      assert.equal(h.hub.store.get(h.id).status, 'queued');
      assert.ok(h.unconfirmed().some(l => /接続が切れた/.test(l.detail)));
    } finally { dev.cut(); dev.server.close(); await h.done(); }
  });
}
