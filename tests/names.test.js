'use strict';
// 人が付ける名前(設計書 6 章)。名前は加工機・送り先へのジョブ番号(JOB)と、書き出しのファイル名になる。
// JOB の型は limited(12 文字まで、文字の範囲 32-127。5.1.8。vca-guide の docs/conformance.md)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store/store.js');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const T = require('../src/lib/vca-tcp.js');

const bad = n => assert.throws(() => Store.checkName(n), e => e.code === 'bad-name', JSON.stringify(n));

test('名前: limited の 12 文字までを受け、13 文字は断る', () => {
  assert.equal(Store.checkName('ABCDEFGHIJKL'), 'ABCDEFGHIJKL');
  bad('ABCDEFGHIJKLM');
});

test('名前: 文字の範囲 32-127 の外(日本語・Latin-1 の文字・制御文字)は断る。127 は使える(5.1.8.1 は 32-127 を認め、3.2.12 の制御文字は 32 未満)', () => {
  for (const n of ['テスト1', 'Ä-1', 'A\tB']) bad(n);
  assert.equal(Store.checkName('A\x7fB'), 'A\x7fB');
  assert.equal(Store.checkName('A=B'), 'A=B');
  assert.equal(Store.checkName('P 1'), 'P 1');
});

test('名前: 値の区切りの ; を含むものは断る(JOB の値が ; の前で切れるため)', () => bad('A;B'));

test('名前: Windows の装置の名前は、拡張子を付けても断る(書き出したファイルを、ほかのソフトがファイルとして開けない)', () => {
  for (const n of ['CON', 'con', 'NUL', 'AUX', 'PRN', 'COM1', 'LPT9', 'CON.X', 'CONIN$', 'CLOCK$']) bad(n);
  for (const n of ['CONSOLE', 'COM', 'LPT10', 'NULL1']) assert.equal(Store.checkName(n), n);
});

test('名前: 付けた名前は、加工機が求めたジョブ番号としてそのまま届く', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-names-'));
  const cfg = merge(loadConfig(path.join(dir, 'none.json')), { dataDir: dir, web: { enabled: false }, remote: { enabled: true, port: 0 } });
  const hub = createHub(cfg);
  const ports = await hub.start();
  try {
    const body = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
    for (const name of ['ABCDEFGHIJKL', 'P 1', 'A=B', '~!@#$%^&()_+']) {
      const e = hub.store.saveReceived({ body, type: 'TRC', job: 'X', peer: 't', crcOk: null });
      hub.store.queue(e.id, name);
      const dev = await T.connectDevice('127.0.0.1', ports.remote, { connectDelay: 0 });
      try {
        const ini = await dev.initialize([['DEV', 'EDG'], ['VEN', 'T'], ['MODEL', 'E'], ['TRCFMT', '1', '400', 'E', 'B']], { tag: 'NAMES', labels: ['DBL'] });
        const dl = await dev.request(ini.requestId, { job: name });
        assert.equal(dl.status, 0, name);
        assert.equal(dl.response.records.find(r => r.label === 'JOB').fields.join(';'), name);
      } finally { dev.socket.destroy(); }
    }
  } finally {
    await hub.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
