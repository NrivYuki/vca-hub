'use strict';
// 起動用: node src/main.js

const { loadConfig } = require('./config.js');
const { createHub } = require('./app.js');

async function main() {
  const cfg = loadConfig();
  const hub = createHub(cfg, { echoLog: true });
  const ports = await hub.start();
  console.log(`vca-hub を起動しました。管理画面: http://localhost:${ports.web ?? '-'}  VCA 待ち受け: ${ports.remote ?? '-'}`);
  const shutdown = async () => { await hub.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => { console.error('起動に失敗しました:', e.message); process.exit(1); });
