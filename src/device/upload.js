'use strict';
// 機器役のアップロード(設計書 5 章): 別の PC やソフト(相手がホスト)へ、保存したデータを送る。
// 接続とセッションは vca-guide の vca-tcp.js(connectDevice)・vca-session.js(createDevice)が行う。

const T = require('../lib/vca-tcp.js');
const VCA = require('../lib/vca-parser.js');
const { buildDownload } = require('../send/build.js');

const INIT_REQUIRED = 5;   // 表 A.24 の 5(初期化が必要)
// アップロードのセッション全体の期限(つないでから最後の応答まで)。少しずつ送ってくる相手でも終わらせるため
const UPLOAD_DEADLINE_MS = 120000;

/**
 * 送る玉型の形式の申し出(TRCFMT)。玉型を送る機器は、初期化か要求のパケットで形式を申し出る(5.4.1・7.2.8)。
 * 全てのホストが対応する形式 1 だけを申し出て、玉型も形式 1 にして送る(相手の返事を待ってから玉型を作り直せないため)。
 * 点数と角度のモードは、受け取ったまま。玉型が無ければ申し出ない(5.4.1)
 */
function traceProposal(body) {
  const traces = VCA.parse(body).traces.filter(t => t.radii.length >= 3 && t.radii.every(Number.isFinite));
  if (!traces.length) return [];
  const eyes = new Set(traces.map(t => t.eye));
  const t = traces[0];
  const mode = t.equi ? 'E' : String(t.mode || 'U').toUpperCase();
  return [['TRCFMT', '1', String(t.radii.length), mode, eyes.size > 1 ? 'B' : [...eyes][0], t.kind || 'F']];
}

/** シェルフ・切り抜き・厚みのデータセットを、保存した形式のまま申し出る(作り直さずに送るため。5.8.1・5.10.5・5.11.3) */
function datasetProposals(body) {
  const out = [], seen = new Set();
  for (const line of String(body).split(/\r\n|\r|\n/)) {
    const m = /^\s*(SHLFFMT|CRIBFMT|STHKFMT)\s*=(.*)$/i.exec(line);
    if (!m) continue;
    const label = m[1].toUpperCase(), fields = m[2].split(';').map(v => v.trim());
    const key = label + fields.slice(0, 4).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([label, ...fields.slice(0, 4)]);
  }
  return out;
}

/** ジョブの DRILLE の基準を、穴あけの基準(DRLFMT)として申し出る(5.5.1.5・5.5.3)。穴が無ければ申し出ない */
function drillProposal(body) {
  const refs = new Set();
  for (const line of String(body).split(/\r\n|\r|\n/)) {
    const m = /^\s*DRILLE\s*=(.*)$/i.exec(line);
    if (!m) continue;
    const f = m[1].split(';').map(v => v.trim());
    if (['0', '?'].includes(f[0]) || f[1] === '0') continue;
    const c = (f[1] || '').toUpperCase().charAt(0) || 'C';
    if (c !== 'R') refs.add(c);
  }
  return refs.size === 1 ? [['DRLFMT', [...refs][0]]] : [];
}

/**
 * 送り先へアップロードする。
 * 名乗りは DEV=UPL(汎用アップロード機器)、VEN・MODEL は vca-hub。送り先の type が 'TRC' なら REQ=TRC・DEV=TRC。
 * 相手が STATUS=5(初期化が必要)を返したら、プリセット初期化をしてから、割り当てられた要求 ID でやり直す。
 * @param {{host: string, port: number, type?: string, name?: string}} dest 送り先
 * @param {{body: string, name: string, records?: Array, timeouts?: object, connectDelay?: number}} job 送るデータと付けた名前
 *   records: 送るレコード(拡張を通したもの)。無ければ body から作る
 *   deadlineMs: セッション全体の期限(既定 UPLOAD_DEADLINE_MS)
 * @returns {...} warnings は、送れたが知らせること(ホストが申し出と違う玉型の形式を返した など)
 * @returns {Promise<{status: number, statusText?: string, initialized: boolean, warnings: string[]}>}
 *   送り先に届いたか分からないとき(データのパケットに ACK を受けた後で切れた・最後の応答が来ない・最後の応答に STATUS が無い)は、
 *   code 'unconfirmed' の例外にする(送れなかったときと分ける。送り直すと 2 度届くことがあるため)
 */
async function uploadTo(dest, { body, name, records, timeouts, connectDelay, deadlineMs = UPLOAD_DEADLINE_MS }) {
  const type = String(dest.type || 'UPL').toUpperCase() === 'TRC' ? 'TRC' : 'UPL';
  const who = [['DEV', type], ['VEN', 'vca-hub'], ['MODEL', 'vca-hub']];
  const offer = traceProposal(body).concat(datasetProposals(body), drillProposal(body));
  const data = records || uploadRecords(body);
  const warnings = [];
  const device = await T.connectDevice(dest.host, dest.port, { timeouts, connectDelay, kind: 'upload' });
  // データのパケット(ANS=種別 か ANS=要求 ID。初期化のデータ ANS=INI は除く)に ACK を受けたか。受けた後の失敗は、届いたか分からない
  let dataAcked = false;
  const send = device.link.sendPacket;
  device.link.sendPacket = async (recs, ...rest) => {
    const out = await send(recs, ...rest);
    const head = recs && recs[0];
    // 同期ずれで中止するときのパケット(ANS と STATUS=12)は、機器のデータではないので数えない
    const isAbort = (recs || []).some(r => String(r[0]).toUpperCase() === 'STATUS');
    if (head && String(head[0]).toUpperCase() === 'ANS' && String(head[1]).toUpperCase() !== 'INI' && !isAbort) dataAcked = true;
    return out;
  };
  // セッション全体の期限(少しずつ送ってくる相手でも、文字の間の時間切れにかからず、いつまでも終わらないことがないように)
  let overdue = false;
  const timer = setTimeout(() => { overdue = true; device.socket.destroy(); }, deadlineMs);
  timer.unref();
  const unconfirmed = why => Object.assign(new Error(`送り先に届いたか分かりません(${why})`), { code: 'unconfirmed' });
  try {
    // 初期化しない要求には、DEV・VEN・MODEL と玉型の形式の申し出を入れる(7.2.6.2・7.2.8)
    let r = await device.request(type, { job: name, records: [...who, ...offer], data });
    let initialized = false;
    if (r.status === INIT_REQUIRED) {
      const ini = await device.initialize([...who, ...offer]);
      if (ini.status !== 0 && ini.status !== 14) return { status: ini.status, statusText: ini.statusText, initialized: false, warnings };
      // 初期化のデータの応答が 0 以外なら、要求 ID があっても続けない(A.4: 0 以外はセッションを中止させる)。ホストの説明文はそのまま返す
      if (ini.hostStatus !== 0) return { status: ini.hostStatus, statusText: ini.statusText, initialized: false, warnings };
      // 要求 ID は整数(表 A.2 の DEF)。無ければホストの誤りで、データは送っていない
      if (!/^\d+$/.test(String(ini.requestId ?? ''))) {
        throw Object.assign(new Error('初期化で要求 ID が割り当てられませんでした(データは送っていません)'), { code: 'no-request-id' });
      }
      initialized = true;
      // ホストは申し出のうち 1 つを返す(7.2.8)。初期化で違う形式を返したら知らせる(データは申し出の形式で送る)
      const chosen = (ini.response && ini.response.proposals || []).find(x => x.label === 'TRCFMT') || (ini.trace ? { fields: [].concat(ini.trace) } : null);
      if (chosen && offer.length && chosen.fields.slice(0, 2).map(v => String(v).trim()).join(';') !== offer[0].slice(1, 3).join(';')) {
        warnings.push(`ホストが初期化で申し出と違う玉型の形式(${chosen.fields.join(';')})を返しました`);
      }
      r = await device.request(ini.requestId, { job: name, data, kind: 'upload' });
    }
    // 最後の応答に STATUS が無い(A.4: 応答には必ず入る)。データを受けたかどうか分からない
    if (r.status === 0 && r.final && r.final.rec.STATUS === undefined) throw unconfirmed('最後の応答に STATUS がありません');
    // ホストは申し出のうち 1 つを返す(7.2.8)。違う形式を返したら知らせる(データは申し出の形式で送った)
    // 中身の無い TRCFMT(データの無い形式の申し出・返事)は、読み取りでは proposals に入る
    const back = ((r.response && r.response.proposals) || []).find(x => x.label === 'TRCFMT');
    if (back && offer.length && String(back.fields[0]).trim() !== offer[0][1]) warnings.push(`ホストが申し出と違う玉型の形式(${back.fields.join(';')})を返しました`);
    return { status: r.status, statusText: r.statusText, initialized, warnings };
  } catch (e) {
    if (e.code === 'no-request-id' || e.code === 'unconfirmed') throw e;
    // データのパケットに ACK を受けた後の失敗は、届いたか分からない
    if (dataAcked) throw unconfirmed(overdue ? '期限を過ぎた' : (e.code || e.message));
    if (overdue) throw Object.assign(new Error(`${deadlineMs / 1000} 秒で終わりませんでした`), { code: 'timeout' });
    throw e;
  } finally { clearTimeout(timer); device.socket.destroy(); }
}

/**
 * 送り先へ送るレコード: 機器用のレコードはすべて。玉型は形式 1 にし、点数と角度のモードは 1 つ目の玉型(申し出)にそろえ、左右は受け取ったまま
 * (traceProposal で申し出た形式。全てのホストが対応する。7.2.8)
 */
function uploadRecords(body) {
  // 申し出た点数・角度のモードにそろえる(左右で点数が違うデータでも、申し出と送る玉型を食い違わせない)
  const p = traceProposal(body)[0];
  const trcfmt = p ? { fmt: 1, n: Number(p[2]), mode: p[3], eye: 'B' } : { fmt: 1, eye: 'B' };
  return buildDownload({ body, profile: { labels: [], trcfmt, ownFormat: true } });
}

module.exports = { uploadTo, uploadRecords, traceProposal, drillProposal, datasetProposals, UPLOAD_DEADLINE_MS };
