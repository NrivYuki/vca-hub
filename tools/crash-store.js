'use strict';
// アップロードの途中で vca-hub のプロセスを強制終了し(電源が落ちたのと同じ)、起動し直したときに保存が壊れていないかを確かめる。
//   node tools/crash-store.js [回数]
// 1 回ごとに、同じデータのフォルダで vca-hub を子のプロセスとして起動し、10 台の機器が続けてアップロードしている途中の
// ばらばらな時点で強制終了する。そのあと、索引(index.json)が読めること、索引の全ての記録に本文と受信情報のファイルがあること、
// 起動し直してアップロードが通ることを確かめる。索引に無いファイル(書いた直後に止まったもの)の数も数える。

const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../src/lib/vca-tcp.js');

if (process.argv[2] === 'child') {
  const { loadConfig, merge } = require('../src/config.js');
  const { createHub } = require('../src/app.js');
  const hub = createHub(merge(loadConfig(path.join(process.argv[3], 'none.json')), { dataDir: process.argv[3], web: { enabled: false }, remote: { enabled: true, port: 0 } }));
  hub.start().then(p => process.send({ port: p.remote }), e => { process.send({ error: e.message }); process.exit(1); });
  return;
}

const rounds = Number(process.argv[2] || 30);
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const records = sample.split(/\r\n|\r|\n/).filter(l => l && !/^(REQ|JOB)=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), ...l.slice(i + 1).split(';')]; });
const wait = ms => new Promise(r => setTimeout(r, ms));

function startChild(dir) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ['child', dir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.once('message', m => (m.error ? reject(new Error(m.error)) : resolve({ child, port: m.port })));
    child.once('exit', code => reject(new Error(`起動できません(${code}): ${err}`)));
  });
}

async function uploader(port, stop) {
  while (!stop.v) {
    try {
      const dev = await T.connectDevice('127.0.0.1', port, { kind: 'upload', connectDelay: 0 });
      try {
        const ini = await dev.initialize([['DEV', 'TRC'], ['VEN', 'C'], ['MODEL', 'C'], ['TRCFMT', '1', '360', 'E', 'B']]);
        await dev.request(ini.requestId || 'TRC', { job: 'C' + crypto.randomInt(1e6), data: records });
      } finally { dev.socket.destroy(); }
    } catch { await wait(5); }
  }
}

function check(dir) {
  const problems = [];
  let index = [];
  try { index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch (e) { problems.push(`索引を読めない: ${e.message}`); }
  for (const e of index) {
    if (!fs.existsSync(path.join(dir, e.file))) problems.push(`本文が無い: ${e.file}`);
    if (!fs.existsSync(path.join(dir, e.file.replace(/\.vca$/, '.json')))) problems.push(`受信情報が無い: ${e.file}`);
  }
  const listed = new Set(index.map(e => e.file));
  let orphans = 0;
  const inbox = path.join(dir, 'inbox');
  if (fs.existsSync(inbox)) for (const day of fs.readdirSync(inbox)) for (const f of fs.readdirSync(path.join(inbox, day))) {
    if (f.endsWith('.vca') && !listed.has(`inbox/${day}/${f}`)) orphans++;
  }
  const ids = new Set(index.map(e => e.id));
  if (ids.size !== index.length) problems.push('ID が重なっている');
  return { problems, count: index.length, orphans };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vca-hub-crash-'));
  let failed = 0, last = { count: 0, orphans: 0 };
  try {
    for (let r = 1; r <= rounds; r++) {
      const { child, port } = await startChild(dir);
      const stop = { v: false };
      const ups = Array.from({ length: 10 }, () => uploader(port, stop));
      await wait(200 + crypto.randomInt(1500));
      child.kill('SIGKILL');
      stop.v = true;
      await Promise.all(ups);
      await new Promise(res => (child.exitCode !== null || child.signalCode !== null ? res() : child.once('exit', res)));
      const c = check(dir);
      if (c.problems.length) { failed++; console.log(`${r} 回目: ${c.problems.slice(0, 5).join(' / ')}`); }
      last = c;
      if (r % 10 === 0) console.log(`${r} 回: 索引の記録 ${c.count}、索引に無い本文 ${c.orphans}`);
    }
    // 起動し直して、アップロードが通ること
    const { child, port } = await startChild(dir);
    const dev = await T.connectDevice('127.0.0.1', port, { kind: 'upload', connectDelay: 0 });
    const ini = await dev.initialize([['DEV', 'TRC'], ['VEN', 'C'], ['MODEL', 'C'], ['TRCFMT', '1', '360', 'E', 'B']]);
    const up = await dev.request(ini.requestId || 'TRC', { job: 'AFTER', data: records });
    dev.socket.destroy();
    child.kill();
    console.log(`起動し直した後のアップロード: STATUS=${up.status}`);
    if (up.status !== 0) failed++;
  } finally {
    await wait(300);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(failed ? `壊れたことが ${failed} 回あった` : `${rounds} 回の強制終了の後も、索引は読め、索引の全ての記録にファイルがあった(索引に無い本文 ${last.orphans})`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
