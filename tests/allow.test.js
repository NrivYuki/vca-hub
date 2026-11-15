'use strict';
// 接続できる相手を、許可した IP アドレスの範囲に限る(設計書 4 章)。リモート接続とローカル接続。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const { isAllowed, allowList } = require('../src/net/tcp.js');
const T = require('../src/lib/vca-tcp.js');

const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const records = sample.split(/\r\n|\r|\n/).filter(l => l && !/^(REQ|JOB)=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), ...l.slice(i + 1).split(';')]; });

async function hubWith(over) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-allow-'));
  const hub = createHub(merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 }, ...over }));
  return { hub, dir, done: async () => { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } };
}

test('許可する範囲: IPv4 と IPv6 の範囲、IPv6 の形で書いた IPv4 アドレス', () => {
  assert.equal(isAllowed('192.168.1.20', ['192.168.0.0/16']), true);
  assert.equal(isAllowed('192.169.1.20', ['192.168.0.0/16']), false);
  assert.equal(isAllowed('::ffff:192.168.1.20', ['192.168.0.0/16']), true);
  assert.equal(isAllowed('10.1.2.3', ['10.1.2.3']), true, '範囲の長さを書かなければ、そのアドレスだけ');
  assert.equal(isAllowed('10.1.2.4', ['10.1.2.3']), false);
  assert.equal(isAllowed('fd00::1', ['fd00::/8']), true);
  assert.equal(isAllowed('fe80::1', ['fd00::/8']), false);
  assert.equal(isAllowed('x', ['0.0.0.0/0']), false, 'IP アドレスでないもの');
});

test('許可する範囲の書き損じは、広い範囲として扱わずに、起動を止める', async () => {
  for (const c of ['10.0.0.0/', '10.0.0.0/33', '10.0.0.0/abc', '10.0.0.0/ 8', '999.1.1.1/8', '10.0.0.0/8/9', 'fd00::/129', '']) {
    assert.throws(() => allowList([c]), e => e.code === 'bad-config', JSON.stringify(c));
    const h = await hubWith({ allow: [c] });
    await assert.rejects(h.hub.start(), e => e.code === 'bad-config', JSON.stringify(c));
    await h.done();
  }
});

test('リモート接続: 許可する範囲の外からの接続は、セッションを始めずに閉じる', async () => {
  const h = await hubWith({ allow: ['10.0.0.0/8'] });
  const ports = await h.hub.start();
  try {
    const dev = await T.connectDevice('127.0.0.1', ports.remote, { kind: 'upload', connectDelay: 0, timeouts: { ack: 1, packet: 2, char: 1 } });
    await assert.rejects(dev.initialize([['DEV', 'TRC'], ['VEN', 'A'], ['MODEL', 'A'], ['TRCFMT', '1', '360', 'E', 'B']]));
    dev.socket.destroy();
    assert.equal(h.hub.store.list().length, 0);
    assert.ok(h.hub.log.list().some(r => r.event === 'rejected'));
  } finally { await h.done(); }
});

test('ローカル接続: 機器の待ち受けへつなぎ、機器のアップロードを受ける。許可する範囲の外の機器にはつながない', async () => {
  let reached = 0;
  const server = await T.listenDevice(0, { kind: 'upload', connectDelay: 0 }, async dev => {
    reached++;
    try {
      const ini = await dev.initialize([['DEV', 'TRC'], ['VEN', 'L'], ['MODEL', 'L'], ['TRCFMT', '1', '360', 'E', 'B']]);
      await dev.request(ini.requestId || 'TRC', { job: 'LOCAL1', data: records });
    } catch { /* 閉じられたとき */ }
  });
  const port = server.address().port;
  // 許可する範囲の外: つなぎに行かない
  const out = await hubWith({ remote: { enabled: false }, allow: ['10.0.0.0/8'], local: [{ name: '外', host: '127.0.0.1', port }] });
  await out.hub.start();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(reached, 0);
  assert.ok(out.hub.log.list().some(r => r.event === 'rejected'));
  await out.done();
  // 許可する範囲の中: つないで受ける
  const h = await hubWith({ remote: { enabled: false }, local: [{ name: '中', host: '127.0.0.1', port }] });
  await h.hub.start();
  try {
    for (let i = 0; i < 100 && !h.hub.store.list().length; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(reached, 1);
    assert.equal(h.hub.store.list()[0].job, 'LOCAL1');
  } finally { await h.done(); server.close(); }
});
