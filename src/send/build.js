'use strict';
// 送信データ作成(設計書 6 章)。保存した本文の値は変えず、入れ物だけを送信先に合わせる。

const VCA = require('../lib/vca-parser.js');
const { traceRecords, FORMATS } = require('../lib/trace.js');

// 通信用(インターフェイス)レコード。送信時に付け直すため取り除く。
const INTERFACE_LABELS = new Set([
  'REQ', 'ANS', 'JOB', 'STATUS', 'XSTATUS', 'CRC', 'DEV', 'VEN', 'MODEL', 'MNAME', 'MID', 'SN', 'OPERID',
  'DEF', 'D', 'ENDDEF', 'INFO', 'TIMEOUT', 'TXTENC', 'HVEN', 'HMODEL', 'HNAME', 'HSN', 'HVER', 'OMAV', 'REM', 'DO',
]);
// 玉型データ。送信先に合わせて作り直す。
const TRACE_LABELS = new Set(['TRCFMT', 'R', 'A', 'ZFMT', 'Z', 'ZA']);

const LINE_LABEL = /^[\s\x1c\x1d\x1e\x1a]*\*?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** 本文を「ラベルと、受け取った行そのもの」の並びにする。 */
function recordLines(body) {
  const out = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    const m = line.match(LINE_LABEL);
    if (m) out.push({ label: m[1].toUpperCase(), line: line.replace(/^[\s\x1c\x1d\x1e\x1a]+/, '') });
  }
  return out;
}

/** 受け取った行を、値を変えずにレコード([ラベル, = のあとの文字列])にする。 */
function lineRecord(line) {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}

/**
 * 一覧に BEVP があれば、BEVM・BEVC も送る(7.2.4.3、表 A.7 の注記: BEVP の値によって必要なら BEVM・BEVC も応答に入れる)。
 * どの値のときに必要かは見分けず、いつも足す(ジョブに無ければ ?)。
 */
function withBevel(labels) {
  if (!labels.includes('BEVP')) return labels;
  const out = labels.slice();
  for (const l of ['BEVM', 'BEVC']) if (!out.includes(l)) out.splice(out.indexOf('BEVP') + 1 + ['BEVM', 'BEVC'].indexOf(l), 0, l);
  return out;
}

/** 送るべき眼(DO の値)を決める。 */
function decideEyes(traces, profile) {
  const have = new Set(traces.map(t => t.eye));
  const want = profile && profile.trcfmt && profile.trcfmt.eye;
  if (want === 'R' || want === 'L') return want;
  if (have.has('R') && have.has('L')) return 'B';
  if (have.size === 1) return [...have][0];
  return 'B';
}

/**
 * 加工機などへのダウンロード応答のレコードを組み立てる(ANS・JOB・STATUS は vca-session.js が付ける)。
 * @param {{body: string, profile: object|null}} args
 *   profile: 送信先の希望。
 *     初期化した機器: { labels: 受け取りたいラベル, trcfmt: 取り決めた玉型の形式 | null, zfmt: サグを求めたか }
 *     初期化しない機器: { labels: プリセットの項目, preset: true }(玉型は元の形式で送る)
 *     どちらでもない(プリセットの無い要求種別): null(すべての項目と元の形式の玉型を送る)
 * @returns {Array<string[]>}
 */
function buildDownload({ body, profile }) {
  const parsed = VCA.parse(body);
  const lines = recordLines(body).filter(r => !INTERFACE_LABELS.has(r.label) && !TRACE_LABELS.has(r.label));
  const eyes = decideEyes(parsed.traces, profile);

  // 機器レコード: 受け取りたい一覧があればそれだけ。持っていない項目は "?"(DCS 5.1.4)
  const deviceRecords = [];
  if (profile && profile.labels && profile.labels.length) {
    for (const label of withBevel(profile.labels)) {
      if (TRACE_LABELS.has(label) || INTERFACE_LABELS.has(label)) continue;
      const found = lines.filter(r => r.label === label);
      if (found.length) found.forEach(r => deviceRecords.push(lineRecord(r.line)));
      else deviceRecords.push([label, '?']);
    }
  } else {
    lines.forEach(r => deviceRecords.push(lineRecord(r.line)));
  }

  // 玉型データ: 初期化で形式を取り決めた機器にはその形式で。取り決めのない初期化済み機器には送らない。
  const out = [];
  const negotiated = profile && !profile.preset ? profile.trcfmt : null;
  const wantsTrace = !profile || profile.preset || !!negotiated;
  if (wantsTrace) {
    const usable = parsed.traces.filter(t => t.radii.length >= 3 && t.radii.every(Number.isFinite));
    const pick = eyes === 'B' ? usable : usable.filter(t => t.eye === eyes).slice(0, 1);
    // 指定の眼のデータがなければ、反対眼のデータを反転して使う(DCS 5.4.13)
    const chosen = pick.length ? pick : usable.slice(0, eyes === 'B' ? 2 : 1);
    if (chosen.length) {
      for (const t of chosen) {
        const want = negotiated ? { ...negotiated } : {};
        want.eye = eyes === 'B' ? t.eye : eyes;
        out.push(...traceRecords(t, want));
        // サグを求めた機器には、サグが無いことを ZFMT=0 で示す(サグの中継は未対応。5.4.1)
        if (negotiated && profile.zfmt) out.push(['ZFMT', '0']);
      }
    } else if (negotiated) {
      out.push(['TRCFMT', '0']);
    }
  }

  return [['DO', eyes], ...deviceRecords, ...out];
}

/** 初期化で取り決めた TRCFMT のレコード(['TRCFMT', 形式, 点数, モード, 眼, ...])を、送信の希望にする。 */
function traceWant(fields) {
  if (!fields || !FORMATS.includes(+fields[0])) return null;
  return { fmt: +fields[0], n: +fields[1] || 0, mode: String(fields[2] || 'E').toUpperCase(), eye: String(fields[3] || 'R').toUpperCase() };
}

module.exports = { buildDownload, recordLines, traceWant, INTERFACE_LABELS, TRACE_LABELS };
