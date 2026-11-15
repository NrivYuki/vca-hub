'use strict';
// 管理画面の HTTP の口を、乱数で作った要求で叩く。
//   node tools/fuzz-web.js [回数]
// vca-hub をこのプロセスの中で一時フォルダのデータで動かし、全ての経路に、ばらばらな方法・パス・本文(壊れた JSON、null、
// 大きな本文、型の違う値)を送る。捕まえていない例外が起きないこと、500(中の誤り)を返さないこと、
// 拡張のフォルダの外のファイル(.. や装置の名前)を返さないことを確かめる。

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, merge } = require('../src/config.js');
const { createHub } = require('../src/app.js');

const n = Number(process.argv[2] || 5000);
let crashes = 0;
process.on('uncaughtException', e => { crashes++; console.log('捕まえていない例外:', e && e.stack); });
process.on('unhandledRejection', e => { crashes++; console.log('捕まえていない Promise の拒否:', e && e.stack); });
const rnd = k => crypto.randomInt(k);
const pick = a => a[rnd(a.length)];

function call(port, method, p, body, headers = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { Host: `localhost:${port}`, 'X-VCA-Hub': '1', ...headers } }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: s }));
    });
    req.on('error', e => resolve({ code: e.code }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ code: 'timeout' }); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vca-hub-fuzzweb-'));
  const extDir = path.join(dir, 'ext');
  fs.mkdirSync(path.join(extDir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(extDir, 'demo', 'index.js'), "module.exports = { title: 'demo', setup(hub) { hub.page({ title: 'デモ', file: 'page.html' }); hub.route('POST', 'echo', ({ body }) => ({ got: body && body.x })); } };");
  fs.writeFileSync(path.join(extDir, 'demo', 'page.html'), '<p>demo</p>');
  fs.writeFileSync(path.join(dir, 'secret.json'), '{"secret":"S3CR3T"}');
  const cfg = merge(loadConfig(path.join(dir, 'none.json')), {
    dataDir: path.join(dir, 'data'), web: { enabled: true, host: '127.0.0.1', port: 0 }, remote: { enabled: false },
    extensionsDir: extDir, extensions: { demo: true }, exportDir: path.join(dir, 'out'),
  });
  const hub = createHub(cfg);
  const ports = await hub.start();
  const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
  const ids = Array.from({ length: 5 }, () => hub.store.saveReceived({ body: sample, type: 'TRC', job: 'W', peer: 'fuzz', crcOk: null }).id);
  const codes = {};
  const five = [];
  let leaked = 0;
  try {
    // 拡張のフォルダの外を指すパス
    for (const p of ['/ext/demo/../secret.json', '/ext/demo/..%2F..%2Fsecret.json', '/ext/demo/%2e%2e/%2e%2e/secret.json', '/ext/demo/..%5C..%5Csecret.json',
      '/ext/demo/CON', '/ext/demo/NUL.html', '/ext/demo/page.html::$DATA', '/ext/demo/%c0%ae%c0%ae/secret.json', '/ext/demo/%', '/ext/demo/%E0%A4%A']) {
      const r = await call(ports.web, 'GET', p);
      if (String(r.body).includes('S3CR3T')) leaked++;
      codes[`外 ${r.code}`] = (codes[`外 ${r.code}`] || 0) + 1;
      if (r.code === 500) five.push(`GET ${p}`);
    }
    const paths = ['/', '/api/status', '/api/jobs', '/api/log', '/api/devices', '/api/export-check', '/api/ext/demo/echo', '/api/ext/demo/x', '/ext/demo/', '/ext/demo/page.html', '/ext/nope/'];
    for (const id of ids) for (const s of ['', '/queue', '/unqueue', '/export', '/send']) paths.push(`/api/jobs/${id}${s}`);
    const bodies = [undefined, '', 'null', '[]', '1', '"x"', '{', '{"name":', JSON.stringify({ name: 'A1', confirmed: true }), JSON.stringify({ name: null, confirmed: true }),
      JSON.stringify({ name: 123, confirmed: 'yes' }), JSON.stringify({ name: { a: 1 }, confirmed: true, replace: 'x' }), JSON.stringify({ name: 'x'.repeat(1000), confirmed: true }),
      JSON.stringify({ fingerprint: [1, 2] }), JSON.stringify({ x: '\u0000'.repeat(10) }), 'x'.repeat(200000), JSON.stringify({ __proto__: { polluted: 1 }, name: 'P', confirmed: true }),
      JSON.stringify({ constructor: { prototype: { polluted: 1 } } })];
    for (let i = 0; i < n; i++) {
      const method = pick(['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD']);
      let p = pick(paths);
      if (rnd(5) === 0) p += pick(['?', '?name=%', '?a[]=1&a[]=2', '/..', '//', '%00', '?' + 'x'.repeat(5000)]);
      const r = await call(ports.web, method, p, method === 'GET' || method === 'HEAD' ? undefined : pick(bodies), rnd(10) ? {} : { 'Content-Type': pick(['text/plain', 'application/xml']) });
      codes[r.code] = (codes[r.code] || 0) + 1;
      if (r.code === 500 && five.length < 20) five.push(`${method} ${p.slice(0, 60)}`);
    }
    const polluted = ({}).polluted !== undefined;
    console.log(`要求 ${n} 件の応答: ${JSON.stringify(codes)}`);
    console.log(`500 を返した要求: ${five.length ? [...new Set(five)].join(' / ') : 'なし'}`);
    console.log(`拡張のフォルダの外のファイルを返した: ${leaked} 件、プロトタイプの汚染: ${polluted ? 'あり' : 'なし'}、捕まえていない例外: ${crashes} 件`);
    const r = await call(ports.web, 'GET', '/api/jobs');
    console.log(`最後に一覧を取れる: ${r.code}`);
    process.exitCode = leaked || crashes || polluted || r.code !== 200 ? 1 : 0;
  } finally {
    await hub.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(e => { console.error(e); process.exit(2); });
