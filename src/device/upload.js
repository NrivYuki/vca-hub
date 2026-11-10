'use strict';
// 機器役のアップロード(設計書 5 章): 別の PC やソフト(相手がホスト)へ、保存したデータを送る。
// 接続とセッションは vca-guide の vca-tcp.js(connectDevice)・vca-session.js(createDevice)が行う。

const T = require('../lib/vca-tcp.js');
const { buildDownload } = require('../send/build.js');

const INIT_REQUIRED = 5;   // 表 A.24 の 5(初期化が必要)

/**
 * 送り先へアップロードする。
 * 名乗りは DEV=UPL(汎用アップロード機器)、VEN・MODEL は vca-hub。送り先の type が 'TRC' なら REQ=TRC・DEV=TRC。
 * 相手が STATUS=5(初期化が必要)を返したら、プリセット初期化をしてから、割り当てられた要求 ID でやり直す。
 * @param {{host: string, port: number, type?: string, name?: string}} dest 送り先
 * @param {{body: string, name: string, records?: Array, timeouts?: object, connectDelay?: number}} job 送るデータと付けた名前
 *   records: 送るレコード(拡張を通したもの)。無ければ body から作る
 * @returns {Promise<{status: number, statusText?: string, initialized: boolean}>}
 */
async function uploadTo(dest, { body, name, records, timeouts, connectDelay }) {
  const type = String(dest.type || 'UPL').toUpperCase() === 'TRC' ? 'TRC' : 'UPL';
  const who = [['DEV', type], ['VEN', 'vca-hub'], ['MODEL', 'vca-hub']];
  // 送るデータ: 機器用のレコードはすべて、玉型は受け取った形式のまま(相手の求めが分からないため)
  const data = records || uploadRecords(body);
  const device = await T.connectDevice(dest.host, dest.port, { timeouts, connectDelay, kind: 'upload' });
  try {
    // 初期化しない要求には、DEV・VEN・MODEL を入れる(7.2.6.2)
    let r = await device.request(type, { job: name, records: who, data });
    let initialized = false;
    if (r.status === INIT_REQUIRED) {
      const ini = await device.initialize(who);
      if (ini.status !== 0 && ini.status !== 14) return { status: ini.status, statusText: ini.statusText, initialized: false };
      if (!ini.requestId) return { status: ini.hostStatus, statusText: '初期化で要求 ID が割り当てられませんでした', initialized: true };
      initialized = true;
      r = await device.request(ini.requestId, { job: name, data, kind: 'upload' });
    }
    return { status: r.status, statusText: r.statusText, initialized };
  } finally { device.socket.destroy(); }
}

/** 送り先へ送るレコード: 機器用のレコードはすべて、玉型は受け取った形式のまま(相手の求めが分からないため) */
function uploadRecords(body) { return buildDownload({ body, profile: null }); }

module.exports = { uploadTo, uploadRecords };
