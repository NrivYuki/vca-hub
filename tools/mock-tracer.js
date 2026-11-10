'use strict';
// 模擬トレーサー: VCA ファイルの玉型を vca-hub へアップロードする(vca-guide の vca-tcp.js の connectDevice)。
// 使い方: node tools/mock-tracer.js <ジョブ番号> [VCAファイル] [ホスト] [ポート]

const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/lib/vca-tcp.js');

async function main() {
  const [job = 'A0001', file = path.join(__dirname, '..', 'samples', 'frame-right.vca'), host = '127.0.0.1', port = '33512'] = process.argv.slice(2);
  const data = fs.readFileSync(file, 'latin1').split(/\r\n|\r|\n/).filter(l => l && !/^(REQ|JOB)=/.test(l))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; });
  console.log(`${host}:${port} に接続します(規格どおり 3 秒待ってから始めます)`);
  const dev = await T.connectDevice(host, Number(port), { kind: 'upload' });
  try {
    const ini = await dev.initialize([['DEV', 'TRC'], ['VEN', 'MOCK'], ['MODEL', 'TRACER'], ['TRCFMT', '1', '360', 'E', 'B']]);
    console.log(`初期化: STATUS=${ini.status}、要求 ID=${ini.requestId ?? 'なし'}`);
    const up = await dev.request(ini.requestId || 'TRC', { job, data });
    console.log(`アップロード(JOB=${job}): STATUS=${up.status}`);
  } finally { dev.socket.destroy(); }
}

main().catch(e => { console.error('失敗:', e.code || e.message); process.exit(1); });
