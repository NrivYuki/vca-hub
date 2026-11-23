'use strict';
// vca-hub の VCA(DCS)の口を、乱数で作った入力で叩く。
//   node tools/fuzz-vca.js [回数の倍率]
// vca-hub はこのプロセスの中で一時フォルダのデータで動かす。捕まえていない例外や Promise の拒否が起きたら、失敗として数える。
//   A. リモート接続の口へ、セッションの前に乱数のバイト列・壊したパケット(FS と GS の間)・ACK・NAK・長いパケットを送る
//   B. 機器としてアップロードし、項目のラベル・値・玉型の形式の欄・半径の値・項目の数を乱数で崩す
//   C. 1 つの相手が何も送らない接続を多く開こうとしても、IP ごとの上限までしか受けず、ほかの機器がつなげるか
//   D. 終わりの GS を送らないパケットと、パケットの外の文字を送り続けて、ホスト(別のプロセスで動かす)のメモリがどれだけ増えるか
//   E. オートコネクトの口へ、壊れた通知と、許可範囲の外を指す通知を送る(つなぎに行かないこと)
//   F. 共有フォルダの取り込みに、壊れたファイル・大きいファイル・変わった名前のファイルを置く
//   G. 多くの機器が同時にアップロードしても、索引の数と保存したファイルが合うこと
// 最後に、正しい機器のアップロードと、加工機の要求が通ることを確かめる。

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const T = require('../src/lib/vca-tcp.js');
const VCA = require('../src/lib/vca-parser.js');

const scale = Number(process.argv[2] || 1);
const { FS, GS, RS, ACK, NAK, ESC, SUB } = VCA.CH;
let failed = 0, crashes = 0;
process.on('uncaughtException', e => { crashes++; console.log('捕まえていない例外:', e && e.stack); });
process.on('unhandledRejection', e => { crashes++; console.log('捕まえていない Promise の拒否:', e && e.stack); });
function check(name, ok, detail) {
  console.log(`${ok ? 'OK' : 'NG'}  ${name}${detail !== undefined ? `  [${detail}]` : ''}`);
  if (!ok) failed++;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const rnd = n => crypto.randomInt(n);
const pick = a => a[rnd(a.length)];
const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const sampleRecords = sample.split(/\r\n|\r|\n/).filter(l => l && !/^(REQ|JOB)=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), ...l.slice(i + 1).split(';')]; });
const LABELS = ['TRCFMT', 'R', 'A', 'ZFMT', 'Z', 'DBL', 'HBOX', 'VBOX', 'CIRC', 'ETYP', 'BEVP', 'BEVM', 'LIND', 'FCRV', 'JOB', 'DO', 'CRC', 'STATUS', 'DEF', 'ENDDEF', 'D', 'TIMEOUT', 'CLIENT', 'X', 'ZZZZZZZZ'];

function junkValue() {
  switch (rnd(10)) {
    case 0: return '9'.repeat(1 + rnd(40));
    case 1: return '-' + rnd(1e9);
    case 2: return '';
    case 3: return crypto.randomBytes(rnd(20)).toString('latin1').replace(/[\r\n;=]/g, 'x');
    case 4: return 'NaN';
    case 5: return '1e309';
    case 6: return String(rnd(5000));
    case 7: return '?';
    default: return (rnd(1e6) / 100).toFixed(2);
  }
}
function junkRecords() {
  const out = [];
  const w = rnd(6);
  if (w === 0) {   // 玉型を崩す
    out.push(['TRCFMT', pick(['1', '2', '3', '4', '0', '9', junkValue()]), pick(['4', '360', '0', '-1', '99999', junkValue()]), pick(['E', 'U', junkValue()]), pick(['R', 'L', 'B', junkValue()]), pick(['F', 'B', junkValue()])]);
    out.push(['R', ...Array.from({ length: rnd(500) }, junkValue)]);
    if (rnd(2)) out.push(['A', ...Array.from({ length: rnd(500) }, junkValue)]);
  } else if (w === 1) {   // 項目を多く
    for (let i = rnd(3000); i--;) out.push([pick(LABELS), junkValue()]);
  } else if (w === 2) {   // 正しい見本の一部を崩す
    for (const r of sampleRecords) out.push(rnd(10) ? r : [r[0], ...r.slice(1).map(v => (rnd(3) ? v : junkValue()))]);
  } else {
    for (let i = 1 + rnd(30); i--;) out.push([rnd(4) ? pick(LABELS) : crypto.randomBytes(1 + rnd(8)).toString('hex').toUpperCase(), ...Array.from({ length: 1 + rnd(5) }, junkValue)]);
  }
  return out;
}

function rawConn(port, chunks, closeAfter = 100) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.on('data', () => {});
    s.on('close', resolve);
    s.on('connect', async () => {
      for (const c of chunks) { if (s.destroyed) break; s.write(Buffer.from(c, 'latin1')); if (rnd(3) === 0) await wait(rnd(10)); }
      setTimeout(() => s.destroy(), closeAfter);
    });
  });
}

// ホストを子のプロセスで動かし、20 の接続から chunk を 8 秒間送り続けて、子の最大の RSS を返す
function floodChild(first, chunk) {
  const { fork } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = fork(__filename, ['child-hub'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let sent = 0, baseRss = 0;
    child.on('error', reject);
    child.on('message', async m => {
      if (m.maxRss !== undefined) { child.kill(); resolve({ sent, baseRss, maxRss: m.maxRss }); return; }
      baseRss = m.baseRss;
      const socks = [];
      for (let i = 0; i < 20; i++) {
        const s = net.connect(m.port, '127.0.0.1'); s.on('error', () => {}); socks.push(s);
        await new Promise(r => s.once('connect', r));
        if (first) s.write(first);
      }
      const end = Date.now() + 8000;
      while (Date.now() < end) { for (const s of socks) if (!s.destroyed && s.writableLength < 1e6) { s.write(chunk); sent += chunk.length; } await wait(10); }
      for (const s of socks) s.destroy();
      await wait(1000);
      child.send('report');
    });
  });
}
if (process.argv[2] === 'child-hub') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vca-hub-flood-'));
  const h = createHub(merge(loadConfig(path.join(d, 'none.json')), { dataDir: d, web: { enabled: false }, remote: { enabled: true, port: 0 } }));
  h.start().then(p => process.send({ port: p.remote, baseRss: process.resourceUsage().maxRSS * 1024 }));
  process.on('message', () => process.send({ maxRss: process.resourceUsage().maxRSS * 1024 }));
  process.on('disconnect', () => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 消せなくてもよい */ } process.exit(0); });
  return;
}

async function upload(port, records, job = 'F-' + rnd(1e6)) {
  const dev = await T.connectDevice('127.0.0.1', port, { kind: 'upload', connectDelay: 0, timeouts: { ack: 2, packet: 4, char: 2 } });
  try {
    const ini = await dev.initialize([['DEV', 'TRC'], ['VEN', 'FUZZ'], ['MODEL', 'F'], ['TRCFMT', '1', '360', 'E', 'B']]);
    const up = await dev.request(ini.requestId || 'TRC', { job, data: records });
    return up.status;
  } finally { dev.socket.destroy(); }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vca-hub-fuzz-'));
  const watch = path.join(dir, 'watch');
  fs.mkdirSync(watch);
  const cfg = merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: false }, remote: { enabled: true, port: 0 }, connectDelay: 0,
    autoconnect: { enabled: true, port: 0 }, importDir: watch,
    // C で、正しい機器(127.0.0.1)とは別の相手(127.0.0.2)から接続を開くため
    allow: ['127.0.0.0/8', '::1/128'],
  });
  const hub = createHub(cfg);
  const ports = await hub.start();
  const remote = ports.remote;
  const count = () => hub.store.list().length;

  try {
    // A. セッションの前の壊れた入力
    const nA = 1500 * scale;
    let t0 = Date.now();
    for (let i = 0; i < nA; i += 25) {
      await Promise.all(Array.from({ length: 25 }, () => {
        const chunks = [];
        for (let k = 1 + rnd(5); k--;) {
          const w = rnd(9);
          if (w === 0) chunks.push(crypto.randomBytes(rnd(400)).toString('latin1'));
          else if (w === 1) chunks.push(FS + crypto.randomBytes(rnd(300)).toString('latin1') + GS);
          else if (w === 2) chunks.push(pick([ACK, NAK, ESC, SUB, RS, FS, GS]).repeat(1 + rnd(20)));
          else if (w === 3) chunks.push(FS + `REQ=${pick(['INI', 'TRC', 'EDG', 'UPL', 'TIM', 'INF', 'MNT', 'XXX', ''])}\r\nJOB=${junkValue()}\r\n` + (rnd(2) ? `CRC=${rnd(65536)}\r\n` : '') + GS);
          else if (w === 4) chunks.push(FS + 'REQ=TRC\r\n' + 'R=1\r\n'.repeat(rnd(5000)) + GS);
          else if (w === 5) chunks.push(FS + FS + GS + GS);
          else if (w === 6) chunks.push(FS + 'REQ=INI\r\nDEF=' + junkValue() + '\r\n' + 'D=' + junkValue() + '\r\n'.repeat(rnd(3)) + GS);
          else chunks.push(FS + junkRecords().map(r => r.join('=')).join('\r\n') + GS);
        }
        return rawConn(remote, chunks, 50);
      }));
    }
    check(`A. セッションの前に壊れたものを ${nA} 接続で送っても、ホストは止まらない`, crashes === 0, `${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

    // B. 中身を崩したアップロード
    const nB = 200 * scale;
    const st = {};
    const before = count();
    t0 = Date.now();
    for (let i = 0; i < nB; i += 10) {
      const rs = await Promise.all(Array.from({ length: 10 }, () => upload(remote, junkRecords(), pick(['', junkValue(), '../../x', 'CON', 'a'.repeat(300)])).catch(e => e.code || e.message)));
      for (const r of rs) st[r] = (st[r] || 0) + 1;
    }
    const savedB = count() - before;
    check(`B. 中身を崩したアップロード ${nB} 回でも、ホストは止まらない`, crashes === 0, `結果 ${JSON.stringify(st)}、保存 ${savedB}、${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
    const files = [];
    const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
    walk(path.join(dir, 'data', 'inbox'));
    const outside = files.filter(f => !path.resolve(f).startsWith(path.resolve(dir, 'data', 'inbox')));
    check('B. JOB に ../ や長い名前があっても、保存したファイルは受信のフォルダの中にある', outside.length === 0, `${files.length} ファイル`);
    const missing = hub.store.list().filter(e => !fs.existsSync(path.join(dir, 'data', e.file)));
    check('B. 索引の全ての記録に、保存したファイルがある', missing.length === 0, missing.length);

    // C. 何も送らない接続
    const idle = [];
    for (let i = 0; i < 200; i++) { const s = net.connect({ port: remote, host: '127.0.0.1', localAddress: '127.0.0.2' }); s.on('error', () => {}); s.closedAt = null; s.on('close', () => { s.closedAt = Date.now(); }); idle.push(s); }
    await wait(500);
    const held = idle.filter(s => !s.closedAt).length;
    check(`C. 1 つの相手が何も送らない接続を 200 開こうとしても、受けるのは IP ごとの上限(${cfg.connections.perAddress})まで`, held === cfg.connections.perAddress, held);
    const okC = await upload(remote, sampleRecords).catch(e => e.code || e.message);
    check('C. そのあいだも、ほかの機器はアップロードできる', okC === 0, okC);
    await wait(20000);
    const closed = idle.filter(s => s.closedAt).length;
    console.log(`    (何も送らない接続のうち、20 秒でホストが閉じたもの: ${closed} / 200。上限を超えて断ったものを含む)`);
    for (const s of idle) s.destroy();

    // D. 終わらないパケットと、パケットの外の文字。ホストを別のプロセスで動かし、そのプロセスの最大の RSS を見る
    //    (同じプロセスで測ると、送る側のバッファも数えてしまう)
    for (const [kind, first, chunk] of [
      ['終わりの GS を送らないパケット', FS, 'R=2400;2400;2400;2400;2400;2400;2400;2400\r\n'.repeat(1000)],
      ['パケットの外の文字', '', 'X'.repeat(43000)],
    ]) {
      const r = await floodChild(first, Buffer.from(chunk, 'latin1'));
      console.log(`    (${kind}を 20 接続で計 ${(r.sent / 1048576).toFixed(0)} MiB 送った。ホストの最大の RSS ${(r.maxRss / 1048576).toFixed(0)} MiB、何も送らないときは ${(r.baseRss / 1048576).toFixed(0)} MiB)`);
      // 直す前(パケットの外の文字ごとに警告を残していたとき)は、12 MiB を送っただけで 1 GB を超えた
      check(`D. ${kind}を送り続けても、ホストのメモリは 512 MiB を超えない`, r.maxRss < 512 * 1048576, `${(r.maxRss / 1048576).toFixed(0)} MiB`);
    }

    // E. オートコネクト
    {
      const target = net.createServer(s => { target.hits++; s.destroy(); });
      target.hits = 0;
      await new Promise(r => target.listen(0, '0.0.0.0', r));
      const lan = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
      const udp = dgram.createSocket('udp4');
      const sendU = b => new Promise(r => udp.send(b, ports.autoconnect, '127.0.0.1', () => r()));
      for (let i = 0; i < 2000 * scale; i++) await sendU(crypto.randomBytes(rnd(200)));
      for (const ip of ['8.8.8.8', '10.255.255.1', ...(lan ? [lan.address] : [])]) {
        await sendU(Buffer.from(`${FS}REQ=CON\r\nIP=${ip}\r\nPORT=${target.address().port}\r\n${GS}`, 'latin1'));
      }
      await sendU(Buffer.from(`${FS}REQ=CON\r\nIP=127.0.0.1\r\nPORT=99999\r\n${GS}`, 'latin1'));
      await sendU(Buffer.from(`${FS}REQ=CON\r\nIP=../..\r\nPORT=1\r\n${GS}`, 'latin1'));
      await wait(1500);
      udp.close();
      check('E. 壊れた通知・別のアドレスを指す通知・許可範囲の外を指す通知では、つなぎに行かない', target.hits === 0 && crashes === 0, `つないできた数 ${target.hits}`);
      target.close();
    }

    // F. 共有フォルダの取り込み
    {
      const names = ['a.vca', 'b.VCA', 'CON.vca', 'nul.vca', ' sp .vca', 'x'.repeat(200) + '.vca', '日本語.vca', '..vca', 'no-ext', 'big.vca', 'bin.vca', 'empty.vca', 'pii.vca'];
      const bodies = {
        'big.vca': 'REQ=FIL\r\nJOB=BIG\r\n' + 'R=2400\r\n'.repeat(600000),
        'bin.vca': crypto.randomBytes(50000).toString('latin1'),
        'empty.vca': '',
        'pii.vca': 'REQ=FIL\r\nJOB=P\r\nCLIENT=YAMADA\r\n' + sample,
      };
      const placed = [];
      for (const n of names) {
        const body = bodies[n] ?? (rnd(2) ? sample : junkRecords().map(r => r.join('=')).join('\r\n'));
        try { fs.writeFileSync(path.join(watch, n), Buffer.from(body, 'latin1')); placed.push(n); } catch (e) { console.log(`    (${n} は置けなかった: ${e.code})`); }
      }
      await wait(16000);   // 取り込みは 5 秒ごと、書き込みから 2 秒たったものだけ
      const left = fs.readdirSync(watch).filter(f => !fs.statSync(path.join(watch, f)).isDirectory() && /\.vca$/i.test(f));
      const done = fs.existsSync(path.join(watch, '取り込み済み')) ? fs.readdirSync(path.join(watch, '取り込み済み')).length : 0;
      const bad = fs.existsSync(path.join(watch, '取り込めなかった')) ? fs.readdirSync(path.join(watch, '取り込めなかった')).length : 0;
      console.log(`    (置いた ${placed.length}、取り込み済み ${done}、取り込めなかった ${bad}、残った .vca ${left.length}: ${left.join(' ')})`);
      check('F. 置いた .vca のファイルは、全て取り込み済みか取り込めなかったのどちらかへ移る', left.length === 0 && crashes === 0, left.join(' '));
      const pii = hub.store.list().find(e => String(e.peer).endsWith('pii.vca'));
      check('F. 取り込んだファイルからも、個人情報の項目を除いて保存する', pii && !/YAMADA/.test(hub.store.readBody(pii)), pii ? pii.piiRemoved.join() : '取り込まれていない');
    }

    // G. 同時のアップロード
    {
      const b0 = count();
      const n = 50;
      // 50 台を 1 つのアドレス(127.0.0.1)から模すので、IP ごとの上限をこの間だけ広げる(確かめるのは保存の同時の書き込み)
      cfg.connections = { total: 64, perAddress: 64 };
      const rs = await Promise.all(Array.from({ length: n }, (_, i) => upload(remote, sampleRecords, `G-${i}`).catch(e => e.code || e.message)));
      const ok = rs.filter(r => r === 0).length;
      const ids = new Set(hub.store.list().map(e => e.id));
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'index.json'), 'utf8'));
      check(`G. ${n} 台が同時にアップロードしても、全て保存し、索引の数と ID が合う`, ok === n && count() - b0 === n && ids.size === count() && saved.length === count(), `成功 ${ok}、増えた記録 ${count() - b0}、索引のファイル ${saved.length}`);
    }

    // 最後: 正しい流れ
    const e = hub.store.saveReceived({ body: sample, type: 'TRC', job: 'END', peer: 'fuzz', crcOk: null });
    hub.store.queue(e.id, 'END1');
    const dev = await T.connectDevice('127.0.0.1', remote, { connectDelay: 0 });
    const ini = await dev.initialize([['DEV', 'EDG'], ['VEN', 'F'], ['MODEL', 'E'], ['TRCFMT', '1', '400', 'E', 'B']], { tag: 'FUZZEND', labels: ['DBL'] });
    const dl = await dev.request(ini.requestId, { job: 'END1' });
    dev.socket.destroy();
    check('最後に、加工機の要求が通る', dl.status === 0, `STATUS=${dl.status}`);
    check('捕まえていない例外・Promise の拒否が起きなかった', crashes === 0, crashes);
  } finally {
    await hub.stop();
    await wait(300);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(failed ? `失敗 ${failed} 件` : 'すべて通った');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
