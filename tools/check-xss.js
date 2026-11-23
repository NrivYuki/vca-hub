'use strict';
// 管理画面に、受け取ったデータの中のスクリプトが入り込まないかを、実際のブラウザ(ヘッドレスの Chrome か Edge)で確かめる。
//   node tools/check-xss.js [ブラウザの実行ファイル]
// vca-hub をこのプロセスの中で一時フォルダのデータで動かし、模擬トレーサーと同じ VCA のアップロードで、HTML を含む値を
// あらゆる項目(JOB、玉型の形式の欄、項目の値、機器の名乗り)に入れて送る。管理画面を開いて、一覧・詳細・送る前の確認・記録・設定を
// 順に表示させ、入れた HTML のスクリプトが動いたか(window.__xss が立ったか)を、Chrome DevTools Protocol で調べる。
// 大文字にされる値のために、スクリプトは文字参照で書く(大文字だけでも、文字参照で任意の文字を書ける)。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');
const T = require('../src/lib/vca-tcp.js');

const BROWSERS = [
  process.argv[2],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const wait = ms => new Promise(r => setTimeout(r, ms));

// window.__xss=1 を、小文字を使わずに書く(&#X77 は w。区切りの ; は VCA の値の区切りなので使わない)
const JS = 'window.__xss=1'.split('').map(c => (/[a-z]/.test(c) ? `&#X${c.charCodeAt(0).toString(16).toUpperCase()}` : c)).join('');
const TAG = `<IMG/SRC="X"ONERROR=${JS}>`;   // 空白を使わない(引用符で閉じた値の直後から、次の属性になる)
const tag = `<img src=x onerror="window.__xss=1">`;

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result;
  return { send, evaluate, close: () => ws.close() };
}

async function main() {
  const exe = BROWSERS.find(p => fs.existsSync(p));
  if (!exe) { console.error('Chrome か Edge が見つかりません'); process.exit(2); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vca-hub-xss-'));
  const cfg = merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: true, port: 0 }, connectDelay: 0,
    exportDir: path.join(dir, 'out'), destinations: [{ name: `送り先${tag}`, host: '127.0.0.1', port: 1 }],
  });
  const hub = createHub(cfg);
  const ports = await hub.start();
  let browser, failed = 0;
  try {
    // 1. HTML を含む値を、VCA のアップロードで送る(機器の名乗りにも入れる)
    const dev = await T.connectDevice('127.0.0.1', ports.remote, { kind: 'upload', connectDelayMs: 0 });
    const ini = await dev.initialize([['DEV', 'TRC'], ['VEN', TAG], ['MODEL', TAG], ['TRCFMT', '1', '4', 'E', 'B']]);
    const up = await dev.request(ini.requestId || 'TRC', {
      job: `J${TAG}`,
      data: [['DBL', '18'], ['ETYP', TAG], ['TRCFMT', '1', '4', TAG, 'R', TAG], ['R', '2400', '2400', '2400', '2400'], ['TRCFMT', '1', '4', 'E', TAG, 'F'], ['R', '2400', '2400', '2400', '2400']],
    });
    // 送り出せるジョブ(送り出せない理由が無いので、送る前の確認の画面を開ける)。値と送り先の名前に HTML を入れる
    const up2 = await dev.request(ini.requestId || 'TRC', {
      job: 'OK1',
      data: [['DO', 'R'], ['DBL', '18'], ['ETYP', TAG], ['TRCFMT', '1', '4', 'E', 'R', 'F'], ['R', '2400', '2400', '2400', '2400']],
    });
    dev.socket.destroy();
    console.log(`アップロード: STATUS=${up.status}・${up2.status}`);
    const id = hub.store.list().find(e => e.job !== 'OK1').id;
    const okId = hub.store.list().find(e => e.job === 'OK1').id;

    // 2. ブラウザで管理画面を開き、各画面を表示させる
    const prof = path.join(dir, 'profile');
    browser = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${prof}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    browser.stderr.on('data', d => { err += d; });
    const t0 = Date.now();
    while (!/ws:\/\/127\.0\.0\.1:(\d+)/.test(err) && Date.now() - t0 < 15000) await wait(100);
    const port = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(err)[1];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?http://localhost:${ports.web}/`, { method: 'PUT' })).json();
    const c = await cdp(target.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    // 画面が一覧を読み終えるまで待つ(遅い PC では、開いてから決まった時間では出きらないことがある)
    for (const t1 = Date.now(); Date.now() - t1 < 20000; await wait(200)) {
      const r = await c.evaluate("document.querySelectorAll('#list li').length >= 2");
      if (r.result && r.result.value === true) break;
    }
    // 各段の式は、その画面が本当に出たときだけ true を返す(出ないまま OK としないため)
    const steps = [
      ['一覧', `document.querySelectorAll('#list li').length >= 2`],
      ['詳細', `select(${JSON.stringify(id)}).then(() => !!current && current.id === ${JSON.stringify(id)})`],
      ['内容・原文のタブ', `(document.querySelectorAll('[data-view]').forEach(b => b.click()), document.body.innerText.includes('ONERROR'))`],
      ['送る前の確認(送り先)', `select(${JSON.stringify(okId)}).then(() => openConfirm('send')).then(() => document.getElementById('confirm').open && document.getElementById('confirmKv').innerText.includes('onerror'))`],
      ['送る前の確認を閉じる', `(document.getElementById('confirm').close(), true)`],
      ['記録', `(document.querySelectorAll('[data-tab]').forEach(b => b.click()), true)`],
    ];
    for (const [name, expr] of steps) {
      const shown = await c.evaluate(expr);
      if (shown.exceptionDetails || !(shown.result && shown.result.value === true)) {
        console.log(`NG  ${name}: 画面を出せず、確かめられない(${shown.exceptionDetails ? shown.exceptionDetails.text : JSON.stringify(shown.result && shown.result.value)})`);
        failed++;
        break;
      }
      await wait(800);
      const r = await c.evaluate('window.__xss === 1');
      const hit = r.result && r.result.value === true;
      console.log(`${hit ? 'NG' : 'OK'}  ${name}${hit ? ': 受け取ったデータのスクリプトが動いた' : ''}`);
      if (hit) { failed++; break; }
    }
    c.close();
  } finally {
    if (browser) browser.kill();
    await hub.stop();
    await wait(500);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(failed ? '管理画面に、受け取ったデータのスクリプトが入り込む' : '受け取ったデータのスクリプトは動かなかった');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
