'use strict';
// 起動用: node src/main.js

const { loadConfig } = require('./config.js');
const { createHub } = require('./app.js');

async function main() {
  const cfg = loadConfig();
  // 記録はコンソールへ出さない(cmd.exe の窓をクリックして選択の状態になると、コンソールへの出力が止まり、vca-hub 全体が止まるため)。
  // 記録は管理画面の「記録」と data/log/ で見る
  const hub = createHub(cfg, { echoLog: false });
  // 拡張の通信方式などで捕まえていない Promise の失敗は、記録に残して動き続ける(1 つの接続の失敗で全ての機器を止めないため)。
  // 捕まえていない例外(同期。拡張のタイマーの中など)は、状態が分からないので止める。止める前に記録に残す
  const brief = e => (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : String(e));
  process.on('uncaughtException', e => {
    try { hub.log.write('error', { event: 'uncaught', detail: brief(e) }); } catch { /* 記録できなくても止める */ }
    console.error('止まります(捕まえていない例外):', e);
    process.exit(1);
  });
  process.on('unhandledRejection', e => {
    hub.log.write('error', { event: 'unhandled', detail: brief(e) });
  });
  const ports = await hub.start();
  console.log(`vca-hub を起動しました。管理画面: http://localhost:${ports.web ?? '-'}  VCA 待ち受け: ${ports.remote ?? '-'}`);
  const shutdown = async () => { await hub.stop(); process.exit(0); };
  // Windows で窓を閉じると SIGHUP、Ctrl+Break は SIGBREAK が届く
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, shutdown);
}

main().catch(e => {
  const hint = e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EROFS'
    ? '\n書き込めない場所にあります。zip を、書き込めるフォルダ(例: C:\\vca-hub)に展開し直すか、config.json の dataDir を書き込める場所に変えてください' : '';
  console.error('起動に失敗しました:', e.message + hint);
  process.exit(1);
});
