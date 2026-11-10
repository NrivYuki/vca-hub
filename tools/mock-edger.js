'use strict';
// 模擬加工機: vca-hub に初期化してから、ジョブ番号で加工データを要求し、受け取った内容を表示する
// (vca-guide の vca-tcp.js の connectDevice)。
// 使い方: node tools/mock-edger.js <ジョブ番号> [ホスト] [ポート]

const T = require('../src/lib/vca-tcp.js');

async function main() {
  const [job = 'A0001', host = '127.0.0.1', port = '33512'] = process.argv.slice(2);
  console.log(`${host}:${port} に接続します(規格どおり 3 秒待ってから始めます)`);
  const dev = await T.connectDevice(host, Number(port), {});
  try {
    const ini = await dev.initialize([['DEV', 'EDG'], ['VEN', 'MOCK'], ['MODEL', 'EDGER'], ['TRCFMT', '1', '400', 'E', 'B']],
      { tag: 'MOCKEDG', labels: ['HBOX', 'VBOX', 'DBL', 'CIRC', 'ETYP', 'LIND', 'FCRV'] });
    console.log(`初期化: STATUS=${ini.status}、要求 ID=${ini.requestId}、玉型の形式=${(ini.trace || []).join(';')}`);
    const dl = await dev.request(ini.requestId, { job });
    console.log(`ダウンロード(JOB=${job}): STATUS=${dl.status}`);
    if (dl.status === 0) {
      const d = dl.response;
      for (const r of d.records) console.log(`  ${r.label}=${r.fields.join(';')}`);
      for (const t of d.traces) console.log(`  玉型: 形式 ${t.fmt}、${t.radii.length} 点、眼 ${t.eye}、0° の半径 ${(t.radii[0] / 100).toFixed(2)} mm`);
      for (const w of d.warnings) console.log(`  警告: ${w}`);
    }
  } finally { dev.socket.destroy(); }
}

main().catch(e => { console.error('失敗:', e.code || e.message); process.exit(1); });
