'use strict';
// 受信データの検査(送信前の確認、設計書 6 章)。
// 「受信は寛容に」は書式の揺れに対してだけ適用し、意味が曖昧なデータは加工機へ送らない。
//   blockers: 送信待ちにできない理由(玉型の点数の不一致や復号できないデータなど)
//   notices : 送信はできるが、確認画面で知らせる点(値を変えずに中継するため規格外のまま送られる行など)

const VCA = require('../lib/vca-parser.js');
const { FORMATS } = require('../lib/trace.js');
const { recordLines, INTERFACE_LABELS, TRACE_LABELS } = require('./build.js');

const MAX_LINE = 80;                       // ASCII の 1 行の上限(DCS)
// サグ(ZFMT・Z・ZA)にかかわる vca-parser.js のエラー
const SAG_MESSAGE = /^(Z|ZA):|ZFMT|^Z に|角度データ ZA/;
const EYE = { R: '右眼', L: '左眼' };

/**
 * @param {string} body 保存した本文
 * @returns {{blockers: string[], notices: string[]}}
 */
function checkBody(body) {
  const parsed = VCA.parse(body);
  const blockers = [], notices = [];

  // 玉型: パーサーのエラーのうち、玉型(R・A)にかかわるものは止める。サグ(Z)は中継しないので知らせるだけ
  for (const e of parsed.errors) (SAG_MESSAGE.test(e) ? notices : blockers).push(e);
  // 中身(R)の無い TRCFMT: パーサーは対応形式の候補とみなすが、保存したデータでは玉型が欠けている(5.4.5)
  for (const p of parsed.proposals) {
    if (p.label === 'TRCFMT') blockers.push(`TRCFMT=${p.fields.join(';')} のあとに玉型のデータ(R)がありません`);
  }
  // 点数の不一致: データが欠けているのか点数の誤記なのか区別できないため止める
  for (const t of parsed.traces) {
    // 未対応の形式や復号できなかった R は、パーサーのエラーとして上で止めている
    const failed = !FORMATS.includes(t.fmt) || parsed.errors.some(e => e.startsWith('R:') && e.endsWith(`(TRCFMT ${t.eye})`));
    if (!failed && t.n && t.radii.length !== t.n) {
      blockers.push(`${EYE[t.eye] || t.eye}の玉型: TRCFMT の点数 ${t.n} に対して半径が ${t.radii.length} 個です`);
    }
  }

  // そのまま中継する機器用レコードの行: 規格外の行は値を変えずに送るので、確認画面で知らせる
  for (const r of recordLines(body)) {
    if (INTERFACE_LABELS.has(r.label) || TRACE_LABELS.has(r.label)) continue;
    if (r.line.length > MAX_LINE) notices.push(`${r.label} の行が ${r.line.length} 文字です(規格の上限は ${MAX_LINE} 文字)`);
    if (/[^\x20-\x7e]/.test(r.line)) notices.push(`${r.label} の行に ASCII 以外の文字や制御文字があります`);
  }
  return { blockers, notices };
}

module.exports = { checkBody };
