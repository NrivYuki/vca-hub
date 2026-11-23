'use strict';
// 受信データの検査(送信前の確認、設計書 6 章)。
// 「受信は寛容に」は書式の揺れに対してだけ適用し、意味が曖昧なデータは加工機へ送らない。
//   blockers: 送信待ちにできない理由(玉型の点数の不一致や復号できないデータなど)
//   notices : 送信はできるが、確認画面で知らせる点(値を変えずに中継するため規格外のまま送られる行など)

const VCA = require('../lib/vca-parser.js');
const { FORMATS } = require('../lib/trace.js');
const { recordLines, deviceSpecificProblems, INTERFACE_LABELS, TRACE_LABELS, DEVICE_SPECIFIC, DATASET_SERIES } = require('./build.js');

// 長い行の目安(文字)。規格のレコード全般の上限ではない(値は 255 文字まで。附属書 D)。80 文字を超えると読めない機器があるので知らせる
// (形式 1 の玉型の行は 80 文字まで。5.4.15.1)
const MAX_LINE = 80;
const MAX_NOTICE_LABELS = 10;              // 知らせに名前を出すラベルの数(残りは数だけを出す)
// 送り出せない理由・知らせの数と 1 つの長さ(文字)。値は送り手から届いたままなので、索引と画面が膨らまないように切る
const MAX_ITEMS = 20, MAX_ITEM_LENGTH = 300;
// サグ(ZFMT・Z・ZA)にかかわる vca-parser.js のエラー
const SAG_MESSAGE = /^(Z|ZA):|ZFMT|^Z に|角度データ ZA/;
const EYE = { R: '右眼', L: '左眼' };

/**
 * @param {string} body 保存した本文
 * @returns {{blockers: string[], notices: string[]}}
 */
function checkBody(body, parsed = VCA.parse(body)) {
  const blockers = [], notices = [];

  // 玉型: パーサーのエラーのうち、玉型(R・A)にかかわるものは止める。サグ(Z)は中継しないので知らせるだけ
  for (const e of parsed.errors) (SAG_MESSAGE.test(e) ? notices : blockers).push(e);
  // 中身(R)の無い TRCFMT: パーサーは対応形式の候補とみなすが、保存したデータでは玉型が欠けている(5.4.5)
  for (const p of parsed.proposals) {
    if (p.label === 'TRCFMT') blockers.push(`TRCFMT=${p.fields.join(';')} のあとに玉型のデータ(R)がありません`);
  }
  // 点数の不一致: データが欠けているのか点数の誤記なのか区別できないため止める
  // 復号できなかった R のある眼(エラーは 1 度だけ見る。玉型ごとに全てのエラーを見ると、玉型とエラーが多いデータで長く止まるため)
  const badEyes = new Set();
  for (const e of parsed.errors) {
    const m = e.startsWith('R:') && e.match(/\(TRCFMT ([^)]*)\)$/);
    if (m) badEyes.add(m[1]);
  }
  for (const t of parsed.traces) {
    // 未対応の形式や復号できなかった R は、パーサーのエラーとして上で止めている
    const failed = !FORMATS.includes(t.fmt) || badEyes.has(t.eye);
    if (!failed && t.n && t.radii.length !== t.n) {
      blockers.push(`${EYE[t.eye] || t.eye}の玉型: TRCFMT の点数 ${t.n} に対して半径が ${t.radii.length} 個です`);
    } else if (!failed && t.radii.length < 3 && t.radii.every(Number.isFinite)) {
      // 点数が 3 未満の玉型は形にならないので送れない(送ると、加工機には玉型が無いと答えることになるため)
      blockers.push(`${EYE[t.eye] || t.eye}の玉型: 点数が ${t.radii.length} で、送れません(3 点以上が要ります)`);
    }
  }

  // 玉型の眼: データのパケットの TRCFMT の眼は R か L で、眼ごとに 1 つ(5.4.12)。
  // B などの眼や、同じ眼が 2 つあると、どの玉型を渡すかが確認の画面の形と食い違うので送り出さない
  const perEye = new Map();
  for (const t of parsed.traces) perEye.set(t.eye, (perEye.get(t.eye) || 0) + 1);
  for (const [eye, n] of perEye) {
    if (eye !== 'R' && eye !== 'L') blockers.push(`玉型の眼が ${eye} です。データの玉型の眼は R か L です(5.4.12)`);
    else if (n > 1) blockers.push(`${EYE[eye]}の玉型が ${n} つあります。眼ごとに 1 つです(5.4.12)`);
  }

  // そのまま中継する機器用レコードの行: 規格外の行は値を変えずに送るので、確認画面で知らせる。
  // 知らせはラベルごとにまとめ、名前を出すラベルの数も限る(行の多いデータで、知らせと索引が膨らまないように)
  const longLines = new Map(), nonAscii = new Map();
  for (const r of recordLines(body)) {
    // データセットの系列(バイナリの形式では 8 ビットの文字を含む。5.1.7.3)は除く
    if (INTERFACE_LABELS.has(r.label) || TRACE_LABELS.has(r.label) || DATASET_SERIES.has(r.label)) continue;
    if (r.line.length > MAX_LINE) longLines.set(r.label, Math.max(longLines.get(r.label) || 0, r.line.length));
    if (/[^\x20-\x7e]/.test(r.line)) nonAscii.set(r.label, (nonAscii.get(r.label) || 0) + 1);
  }
  const some = (m, fmt) => {
    const all = [...m];
    for (const e of all.slice(0, MAX_NOTICE_LABELS)) notices.push(fmt(...e));
    if (all.length > MAX_NOTICE_LABELS) notices.push(`ほかに ${all.length - MAX_NOTICE_LABELS} 種類のラベルにも同じことがあります`);
  };
  some(longLines, (label, len) => `${label} の行が ${len} 文字です(${MAX_LINE} 文字を超えると読めない機器があります)。値は変えずにそのまま送ります`);
  // ASCII 以外の文字は、TXTENC で取り決めたときだけ使える(5.1.8.2)。vca-hub は ASCII だけを取り決めるので、送り出さない
  if (nonAscii.size) blockers.push(`ASCII 以外の文字があります(${[...nonAscii.keys()].slice(0, 5).join('・')})。vca-hub は ASCII だけを扱うので送れません(5.1.8)`);

  // 機器ごとのレコード(5.16・5.17): 加工機には、名乗った機器に合うものだけを、全体の値に代えて渡す
  const lines = recordLines(body);
  // 送るレコード(通信用のものと、バイナリになりうるデータセットの系列を除く)の形(5.1.6・5.1.7):
  // ラベルは 16 文字まで。ASCII のレコードの値に制御文字(予約文字)は置けない。相手から受けたものも中継しない(加工機の側でパケットが切れるなど)
  const longLabels = new Set(), ctrlLabels = new Set();
  for (const r of lines) {
    if (INTERFACE_LABELS.has(r.label) || DATASET_SERIES.has(r.label)) continue;
    if (r.label.length > 16) longLabels.add(r.label);
    if (/[\x00-\x1f\x7f]/.test(r.line.slice(r.line.indexOf('=') + 1))) ctrlLabels.add(r.label);
  }
  if (longLabels.size) blockers.push(`ラベルが 16 文字を超えています(${[...longLabels].slice(0, 5).map(l => l.slice(0, 20)).join('・')})。ラベルは 16 文字までです(5.1.6)`);
  // バイナリの形式のデータセットの系列: ESC で逃がしていない予約文字(FS・GS・RS など)があれば、加工機の側でパケットが切れるので止める
  const rawLabels = new Set();
  for (const r of lines) {
    if (!DATASET_SERIES.has(r.label)) continue;
    const v = r.line.slice(r.line.indexOf('=') + 1);
    // 逃がす予約文字は、表 1 のうち 32 未満のもの(ACK・DC1・DC3・NAK・SUB・FS・GS・RS。CR・LF は行を分けるので現れない)
    if (/[\x06\x11\x13\x15\x1a\x1c-\x1e]/.test(v) || /\x1b(?![\x80-\xff])/.test(v)) rawLabels.add(r.label);
  }
  if (rawLabels.size) blockers.push(`データセットの系列(${[...rawLabels].slice(0, 5).join('・')})に、逃がしていない予約文字があります(5.1.7.3)`);
  if (ctrlLabels.size) blockers.push(`値に制御文字があります(${[...ctrlLabels].slice(0, 5).join('・')})。ASCII のレコードには置けません(5.1.7)`);
  // 形の崩れた PROC・PROCBLK は、どの機器に何を渡すかが決められないので送り出さない(表 A.1)
  for (const p of deviceSpecificProblems(lines)) blockers.push(p);
  // DO は加工するレンズ(表 A.2)。値違いで 2 回ある・R L B N 以外の値(? を含む)なら、どのレンズを加工するか決まらないので送り出さない。
  // 無ければ玉型のある眼から決めるので、そのことを知らせる
  // 後ろの余分な区切り(DO=L; など)は無いものとして読む(5.1: 余分な区切りは受け入れる)
  const doRaw = lines.filter(r => r.block === undefined && r.label === 'DO').map(r => r.line.slice(r.line.indexOf('=') + 1).trim().replace(/[;\s]+$/, ''));
  const dos = doRaw.map(v => v.toUpperCase());
  const doValues = [...new Set(dos)];
  const shortValue = v => (v.length > 40 ? v.slice(0, 40) + '…' : v);
  if (doValues.length > 1) blockers.push(`DO が値違いで ${dos.length} 回あります(${doValues.slice(0, 5).map(shortValue).join(' / ')}${doValues.length > 5 ? ' ほか' : ''})。加工するレンズが決まりません(5.1.10)`);
  // literal の値は大文字・小文字を区別する(5.1.8.4)。小文字の r などは R とみなさない
  else if (doValues.length === 1 && !['R', 'L', 'B', 'N'].includes(doRaw[0])) blockers.push(`DO=${shortValue(doRaw[0])} は、加工するレンズ(R・L・B・N)を表していません(表 A.2)`);
  else if (!doValues.length) notices.push('DO がありません。加工するレンズは、玉型のある眼から決めます');
  // 1 つしか置けないレコード(5.1.10)が 2 回以上ある: 値が違えば、加工機がどちらを使うか決まらないので送り出さない。同じ値なら知らせる
  const seen = new Map();
  for (const r of lines) {
    // データセットの系列(T・S・ZZ・PP など)は、系列を複数のレコードに分けて書くので数えない(5.1.9)
    if (r.block !== undefined || INTERFACE_LABELS.has(r.label) || TRACE_LABELS.has(r.label) || DEVICE_SPECIFIC.has(r.label) || DATASET_SERIES.has(r.label)) continue;
    const def = VCA.recordDef(r.label);
    if (!def || def.repeat || /FMT$/.test(r.label)) continue;
    const value = r.line.slice(r.line.indexOf('=') + 1).split(';').map(v => v.trim()).join(';').replace(/;+$/, '');
    if (!seen.has(r.label)) seen.set(r.label, new Set());
    seen.get(r.label).add(value);
    seen.get(r.label).count = (seen.get(r.label).count || 0) + 1;
  }
  for (const [label, values] of seen) {
    if (values.count < 2) continue;
    // 出す値は 5 つまで、1 つ 40 文字まで(知らせと索引が膨らまないように)
    const shown = [...values].slice(0, 5).map(v => (v.length > 40 ? v.slice(0, 40) + '…' : v));
    if (values.size > 1) blockers.push(`${label} が ${values.count} 回あり、値が違います(${shown.join(' / ')}${values.size > 5 ? ' ほか' : ''})。1 つしか置けないレコードです(5.1.10)`);
    else notices.push(`${label} が ${values.count} 回あります(同じ値)。1 つしか置けないレコードです(5.1.10)`);
  }
  const valueOf = r => r.line.slice(r.line.indexOf('=') + 1);
  const fieldsOfLine = r => valueOf(r).split(';').map(v => v.trim());
  const byLabel = new Map();
  for (const r of lines) if (r.block === undefined) { if (!byLabel.has(r.label)) byLabel.set(r.label, []); byLabel.get(r.label).push(r); }
  const plainOf = label => byLabel.get(label) || [];
  // LDTYPE は分からない(?)にできない(5.9.3.2)。機器ごとの LDPATH の種類の欄も同じ
  if (plainOf('LDTYPE').some(r => fieldsOfLine(r)[0] === '?') || plainOf('LDPATH').some(r => { const f = fieldsOfLine(r); return f.length >= 6 && f[4] === '?'; })) {
    blockers.push('LDTYPE(面のデータの種類)が ? です。種類は分からないにできません(5.9.3.2)');
  }
  // 標準の面のデータ(SDF)の LDPATH にパスの欄は 1 つ(2 つは、標準でない左右一対の面のデータだけ。5.9.3.2)
  const ldtype = (plainOf('LDTYPE')[0] && fieldsOfLine(plainOf('LDTYPE')[0])[0]) || 'SDF';
  for (const r of plainOf('LDPATH')) {
    const f = fieldsOfLine(r);
    const sdf2 = (f.length === 2 && !/^\d+$/.test(f[0]) && ldtype.toUpperCase() === 'SDF') || (f.length >= 7 && !/^\d+$/.test(f[0]) && (f[4] || 'SDF').toUpperCase() === 'SDF');
    if (sdf2) { blockers.push(`LDPATH=${valueOf(r).slice(0, 40)} は種類が SDF なのにパスが 2 つあります(5.9.3.2)`); break; }
  }
  // ENGMARK の種類が DCS なら、指すレコードがジョブに要る(5.15.1.3)
  for (const r of plainOf('ENGMARK')) {
    const f = fieldsOfLine(r);
    if (String(f[0]).toUpperCase() === 'DCS' && f[1] && !plainOf(f[1].toUpperCase()).length) blockers.push(`ENGMARK が指すレコード ${f[1].slice(0, 16)} がありません(5.15.1.3)`);
  }
  // CIRC3D には z のデータか FCRV が要る(5.4.9.5)。サグは中継しないので、FCRV が要る
  if (plainOf('CIRC3D').some(r => fieldsOfLine(r).some(v => v && v !== '?')) && !plainOf('FCRV').some(r => fieldsOfLine(r).some(v => v && v !== '?'))) {
    blockers.push('CIRC3D があるのに FCRV がありません。サグは中継しないので、FCRV が要ります(5.4.9.5)');
  }
  // BSIZ と CSIZ の両方に 0 でない値を入れてはならない(5.4.9.2)
  const nonZero = label => plainOf(label).some(r => fieldsOfLine(r).some(v => v && v !== '?' && Number(v) !== 0));
  if (nonZero('BSIZ') && nonZero('CSIZ')) blockers.push('BSIZ と CSIZ の両方に 0 でない値があります(5.4.9.2)');
  // データセットの決まりに合わない値(角度の範囲、重みの範囲、数の食い違いなど)は、読み取りの警告から知らせる
  for (const w of parsed.warnings) if (/^(S|SA|SD|SW|ZZ|DZY|DZX|DZXY|PP|WW|DD|T|SDLPATH|SHLFFMT|CRIBFMT|STHKFMT|SURFMT|PASSFMT|PMFMT|WMFMT|DDFMT)\b/.test(w)) notices.push(w);
  // 1 つのパケットの DRILLE は全て同じ基準(5.5.1.5)。基準の欄が空なら中心基準
  // 基準は 2 つ目の欄の 1 文字目(5.5.2.2)。2 つ目の欄の 0 は穴が無いこと。R(相対基準)は制御する穴に従うので数えない
  const refs = new Set(lines.filter(r => r.block === undefined && r.label === 'DRILLE').map(r => r.line.slice(r.line.indexOf('=') + 1).split(';').map(v => v.trim()))
    .filter(f => !['0', '?'].includes(f[0]) && f[1] !== '0').map(f => (f[1] || '').toUpperCase().charAt(0) || 'C').filter(c => c !== 'R'));
  if (refs.size > 1) blockers.push(`DRILLE の基準が混ざっています(${[...refs].join('・')})。1 つのジョブの DRILLE は同じ基準にします(5.5.1.5)`);
  // DRILL だけのジョブは、穴あけの基準を取り決めた加工機には渡せない(DRILLE に作り直せない。5.5.1.5)
  if (plainOf('DRILL').length && !plainOf('DRILLE').length) notices.push('穴あけが DRILL だけです。穴あけの基準(DRLFMT)を取り決めた加工機には渡せません');
  // 注記(REM)は通信用のレコードとして扱い、どの送り先にも送らない
  if (plainOf('REM').length) notices.push('注記(REM)があります。注記は送りません(加工機・送り先・共有フォルダのどれにも)');
  // サグ(ZFMT・Z・ZA)は中継しない(設計書 5 章)。どの送り先にも送らないことを知らせる
  if (lines.some(r => r.block === undefined && r.label === 'ZFMT')) notices.push('サグ(ZFMT)のデータがあります。サグは中継しないので、どの送り先にも送りません');
  if (lines.some(r => r.block === undefined && DEVICE_SPECIFIC.has(r.label))) {
    notices.push('機器ごとの値(PROC・PROCBLK)があります。加工機には、名乗った機器(DEV・VEN・MODEL・SN)に合う値を渡します');
  }
  const datasetBlocks = [...new Set(lines.filter(r => r.block !== undefined && (/FMT$/.test(r.label) || TRACE_LABELS.has(r.label))).map(r => r.block))];
  for (const b of datasetBlocks) notices.push(`PROCBLK のブロック ${b} に玉型・データセットがあります。このブロックに合う加工機には渡せません`);
  return { blockers: limitItems(blockers, 'ほかに %d 件の理由があります'), notices: limitItems(notices, 'ほかに %d 件の知らせがあります') };
}

/** 数と 1 つの長さを切る(切ったことは分かるように残す) */
function limitItems(items, rest) {
  const out = items.slice(0, MAX_ITEMS).map(s => (s.length > MAX_ITEM_LENGTH ? s.slice(0, MAX_ITEM_LENGTH) + '…' : s));
  if (items.length > MAX_ITEMS) out.push(rest.replace('%d', items.length - MAX_ITEMS));
  return out;
}

module.exports = { checkBody };
