'use strict';
// 管理画面に、受け取ったデータの中のスクリプトが入り込まないこと(tools/check-xss.js を、ヘッドレスのブラウザで動かす)。
// Chrome か Edge が無ければ飛ばす。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('管理画面: 受け取ったデータ(JOB・玉型の形式の欄・項目の値・機器の名乗り)の HTML は、どの画面でもスクリプトとして動かない', t => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'check-xss.js')], { encoding: 'utf8', timeout: 120000 });
  if (r.status === 2 && /見つかりません/.test(r.stderr)) { t.skip('Chrome か Edge が無い'); return; }
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
