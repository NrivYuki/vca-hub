'use strict';
// 送信データ作成(設計書 6 章)。保存した本文の値は変えず、入れ物だけを送信先に合わせる。

const VCA = require('../lib/vca-parser.js');
const { traceRecords, FORMATS } = require('../lib/trace.js');

// 通信用(インターフェイス)レコード。送信時に付け直すため取り除く。
const INTERFACE_LABELS = new Set([
  'REQ', 'ANS', 'JOB', 'STATUS', 'XSTATUS', 'CRC', 'DEV', 'VEN', 'MODEL', 'MNAME', 'MID', 'SN', 'OPERID',
  'DEF', 'D', 'ENDDEF', 'INFO', 'TIMEOUT', 'TXTENC', 'HVEN', 'HMODEL', 'HNAME', 'HSN', 'HVER', 'OMAV', 'REM', 'DO',
  // 送り手の名乗り・つなぎ方(表 A.2)。中継すると、vca-hub の名乗りと食い違う
  'HID', 'MVER', 'IP', 'PORT',
  // 穴あけの基準の取り決め。初期化か要求でだけ使い、データのパケットには入れない(5.5.3)
  'DRLFMT',
]);
// 玉型データ。送信先に合わせて作り直す。
const TRACE_LABELS = new Set(['TRCFMT', 'R', 'A', 'ZFMT', 'Z', 'ZA']);
// 機器ごとのレコード(5.16・5.17)。加工機へは、名乗った機器に向けた中身だけを、機器を示す欄を除いて渡す
const DEVICE_SPECIFIC = new Set(['PROC', 'PROCBLK']);
// データセットの中身の系列(見出しは名前が FMT で終わる)。機器向けのものは作り直せない
const DATASET_SERIES = new Set(['R', 'A', 'Z', 'ZA', 'T', 'S', 'SA', 'SD', 'SW', 'ZZ', 'DZY', 'DZX', 'DZXY', 'PP', 'WW', 'DD']);
// 見出しごとの系列(vca-parser.js の DATASETS と同じ。5.4・5.8-5.14)。ほかの見出しの系列の行は、その見出しに付けない
const SERIES_OF = {
  CRIBFMT: ['R', 'A'], STHKFMT: ['R', 'A', 'T'], SHLFFMT: ['S', 'SA', 'SD', 'SW'],
  SURFMT: ['ZZ', 'DZY', 'DZX', 'DZXY'], PASSFMT: ['ZZ', 'DZY', 'DZX', 'DZXY'], PMFMT: ['PP'], WMFMT: ['WW'], DDFMT: ['DD'],
};

// 行の頭。PROCBLK のブロックの中のレコードは「番号!ラベル=」になる(5.17.2)
// ラベルは英字か _ で始まり、空白と予約文字(表 1: 制御文字と ; = , * ? |)を含まない(5.1.6)。. と - と : は予約文字ではないので含める
// (メーカーの名前空間 ACME.X・ACME:MODE や、実験用のラベルを落とさない)
const LINE_LABEL = /^[\s\x1c\x1d\x1e\x1a]*\*?(?:(\d+)!)?([A-Za-z_][A-Za-z0-9_.:\-]*)\s*=/;

/**
 * 本文を「ラベルと、受け取った行そのもの」の並びにする。
 * PROCBLK のブロックの中の行は、block にブロックの番号が入る(line は番号を含む行のまま)。
 */
function recordLines(body) {
  const out = [];
  for (const line of body.split(/\r\n|\r|\n/)) {
    const m = line.match(LINE_LABEL);
    if (!m) continue;
    const r = { label: m[2].toUpperCase(), line: line.replace(/^[\s\x1c\x1d\x1e\x1a]+/, '') };
    if (m[1] !== undefined) r.block = m[1];
    out.push(r);
  }
  return out;
}

// 1 つの本文に置ける違うラベルの数の上限(規格のラベルは約 500)。超える本文は読まない
// (加工のデータとしてありえない本文で、読み取りと保存・検査の手間やメモリを使わないため)
const MAX_DISTINCT_LABELS = 2000;

/** 違うラベルの数が上限を超えていれば、その数を返す(超えていなければ 0)。読み取りの前に、軽く数えるだけ */
function tooManyLabels(body) {
  const seen = new Set();
  for (const r of recordLines(body)) { seen.add(r.label); if (seen.size > MAX_DISTINCT_LABELS) return seen.size; }
  return 0;
}

/** 受け取った行を、値を変えずにレコード([ラベル, = のあとの文字列])にする。 */
function lineRecord(line) {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}

const fail = (code, message) => Object.assign(new Error(message), { code });
const valueOf = line => line.slice(line.indexOf('=') + 1);
const fieldsOf = line => valueOf(line).split(';').map(v => v.trim());

/**
 * 機器を示す欄(DEV・VEN・MODEL・SN)が、名乗った機器に当てはまるか。当てはまれば合った欄の数、当てはまらなければ 0。
 * DEV は欠かせない欄で、VEN・MODEL・SN は空なら絞らない(表 A.1 の PROC・PROCBLK)。
 * 合った欄が多いほど、その機器に向けたものとする(5.9.3.2 の、左からできるだけ多くの欄が合うものを選ぶ決まりと同じ考え)。
 */
function matchDevice(ids, device) {
  const want = [device.dev, device.ven, device.model, device.sn].map(v => String(v || '').trim());
  if (!ids[0] || ids[0] !== want[0]) return 0;
  let n = 1;
  for (let i = 1; i < 4; i++) {
    if (!ids[i]) continue;
    if (ids[i] !== want[i]) return 0;
    n++;
  }
  return n;
}

/**
 * 機器ごとのレコードの形の誤り(表 A.1 の PROC・PROCBLK)。どの機器に何を渡すかが決められないので、送り出せない理由にする。
 * - PROC: 欄は「ラベル;DEV;VEN;MODEL;右[;左]」。ラベルと DEV は欠かせない
 * - PROCBLK: 欄は「番号;DEV;[VEN];[MODEL];[SN]」。番号(整数)と DEV は欠かせない。同じ番号を 2 度宣言しない
 * - ブロックの行は、宣言に続けて置く(間にブロックの外の行を挟まない)
 * @param {Array<{label: string, line: string, block?: string}>} all recordLines の結果
 * @returns {string[]}
 */
function deviceSpecificProblems(all) {
  const out = [];
  const declared = new Set();
  let open = null;   // いま続いているブロックの番号
  for (const r of all) {
    if (r.block !== undefined) {
      if (!declared.has(r.block)) out.push(`ブロック ${r.block} の行(${r.label})に、前に PROCBLK の宣言がありません`);
      else if (r.block !== open) out.push(`ブロック ${r.block} の行(${r.label})が、PROCBLK の宣言に続いていません`);
      if (DEVICE_SPECIFIC.has(r.label)) out.push(`ブロック ${r.block} の中に ${r.label} は置けません`);
      continue;
    }
    open = null;
    if (r.label === 'PROC') {
      const f = fieldsOf(r.line);
      if (f.length < 5) out.push(`PROC=${valueOf(r.line)} の欄が足りません(ラベル;DEV;VEN;MODEL;値)`);
      else if (!f[0] || !f[1]) out.push(`PROC=${valueOf(r.line)} にラベルか DEV がありません`);
      // 1 つ目の欄は、機器に渡すときのラベルになる。ラベルの形でなければ(= や * や空白を含むなど)、別のラベルや 2 つ目の JOB として読まれる
      else if (!/^[A-Za-z_][A-Za-z0-9_.:\-]*$/.test(f[0])) out.push(`PROC=${valueOf(r.line)} の 1 つ目の欄 ${f[0]} はラベルの形ではありません`);
      else if (DEVICE_SPECIFIC.has(f[0].toUpperCase())) out.push(`PROC の中に ${f[0]} は置けません`);
    } else if (r.label === 'PROCBLK') {
      const f = fieldsOf(r.line);
      if (!/^\d+$/.test(f[0] || '') || !f[1]) out.push(`PROCBLK=${valueOf(r.line)} に番号か DEV がありません`);
      else if (declared.has(f[0])) out.push(`PROCBLK の番号 ${f[0]} が 2 度宣言されています`);
      else { declared.add(f[0]); open = f[0]; }
    }
  }
  return [...new Set(out)];
}

/**
 * LDPATH(面のデータの場所。5.9.3)を、機器に渡す 1 つにする(5.16・5.9.3.2)。
 * - 機器ごとの形(DEV;VEN;MODEL;SN;LDTYPE;パス[;左のパス])は、名乗った機器に合う欄がいちばん多いものを 1 つ選び、
 *   パスの欄だけを LDPATH に、種類を LDTYPE にして渡す(種類が空なら SDF)。機器が受け取る LDPATH は 1 つだけ
 * - 1 つ目の欄が整数の形は LDS から LMS へ送るもので、機器には渡さない(5.9.3.3)
 * - 合う機器ごとの形が無ければ、元の 1 欄の形(5.9.3.1)を渡す
 * - 決められない(同じ合い方で違うもの、名乗りが足りない、1 欄の形が 2 つ以上)ときは例外(STATUS=4)
 */
function resolveLdpath(all, device) {
  // LDCRYPT の 2 欄の形は LDS から LMS へのもので、機器へは 1 欄の形で送る(5.9.7.4)。作り直せないので渡さない
  const crypt = all.find(r => r.block === undefined && r.label === 'LDCRYPT' && fieldsOf(r.line).length > 1);
  if (crypt) throw fail('device-specific-unsupported', `LDCRYPT=${valueOf(crypt.line)} は LDS から LMS への形で、機器へは渡せません(5.9.7.4)`);
  const ld = all.filter(r => r.block === undefined && r.label === 'LDPATH');
  if (!ld.length) return all;
  const known = [device.dev, device.ven, device.model, device.sn].map(v => String(v || '').trim());
  const single = [], cands = [];
  for (const r of ld) {
    const f = fieldsOf(r.line);
    if (f.length === 1) { single.push(r); continue; }
    // LDS から LMS への形(5.9.3.3。暗号化した面データ)。機器へ渡す形に作り直せないので渡さない
    if (/^\d+$/.test(f[0])) throw fail('device-specific-unsupported', `LDPATH=${valueOf(r.line)} は LDS から LMS への形で、機器へは渡せません(5.9.3.3・5.9.7)`);
    if (f.length < 6) throw fail('device-specific-invalid', `LDPATH=${valueOf(r.line)} の欄の数が正しくありません(5.9.3)`);
    const ids = f.slice(0, 4);
    const unknown = () => fail('device-specific-unknown', `LDPATH=${valueOf(r.line)} がこの機器に向けたものか、機器の名乗り(${known.filter(Boolean).join(' ') || 'なし'})では決められません`);
    if (!known[0]) throw unknown();
    // 名乗っていない欄で絞ったものは合わないとし、合う欄の多いものを選ぶ(5.9.3.2: matching as much of the series as possible)
    const n = matchDevice(ids, device);
    if (n) cands.push({ n, type: f[4] || 'SDF', paths: f.slice(5), from: r });
  }
  let chosen = null;
  if (cands.length) {
    const best = cands.reduce((m, c) => Math.max(m, c.n), 0);
    const top = cands.filter(c => c.n === best);
    if (new Set(top.map(c => c.type + ';' + c.paths.join(';'))).size > 1) throw fail('device-specific-ambiguous', 'この機器に向けた LDPATH が同じ合い方で 2 つ以上あり、どれを渡すか決められません(5.9.3.2)');
    chosen = top[0];
  } else if (single.length > 1) {
    throw fail('device-specific-ambiguous', 'LDPATH が 2 つ以上あり、どれを渡すか決められません(機器が受け取る LDPATH は 1 つだけ。5.9.3.2)');
  }
  const out = [];
  let placed = false;
  for (const r of all) {
    if (r.block === undefined && r.label === 'LDPATH') {
      if (placed) continue;
      placed = true;
      if (chosen) {
        out.push({ label: 'LDPATH', line: 'LDPATH=' + chosen.paths.join(';') });
        out.push({ label: 'LDTYPE', line: 'LDTYPE=' + chosen.type });
      } else if (single.length) out.push(single[0]);
      continue;
    }
    // 機器ごとの形を選んだときは、種類はその LDPATH のものにする
    if (chosen && r.block === undefined && r.label === 'LDTYPE') continue;
    out.push(r);
  }
  return out;
}

/**
 * 加工機へ渡す機器用レコードの行を決める(5.16・5.17)。
 * - PROC・PROCBLK の宣言とブロックの中身は、そのままは渡さない(機器を示す欄は機器へ渡さない。5.16)
 * - 名乗った機器に当てはまる PROC は「ラベル=右;左」にし、当てはまるブロックの中身は番号を除いて加える
 * - 複数置けるレコード(表の P)は、全体のものに足す(5.17.1.1。足し合わせる)。LDPATH・LDTYPE は機器が 1 つだけ受けるので置き換える
 * - 1 つしか置けないレコードは、合った欄がいちばん多いものに置き換える。同じ合い方で値が違えば決められないので渡さない
 * - 機器向けの玉型・データセットは作り直せないので、当てはまれば渡さない
 * 渡せないときは例外(加工機には STATUS=4 を返し、送信待ちのまま残る)。
 */
function linesForDevice(all, device) {
  const problems = deviceSpecificProblems(all);
  if (problems.length) throw fail('device-specific-invalid', `機器ごとの値の形が正しくありません: ${problems.join(' / ')}`);
  // 大文字・小文字だけが違って合うものは、書き誤りか機器の名乗りの揺れか分からない。全体の値を黙って渡さず、断る
  const upper = d => ({ dev: String(d.dev || '').toUpperCase(), ven: String(d.ven || '').toUpperCase(), model: String(d.model || '').toUpperCase(), sn: String(d.sn || '').toUpperCase() });
  for (const r of all) {
    if (r.block !== undefined || !DEVICE_SPECIFIC.has(r.label)) continue;
    const f = fieldsOf(r.line);
    const ids = r.label === 'PROC' ? f.slice(1, 4) : f.slice(1, 5);
    if (!matchDevice(ids, device) && matchDevice(ids.map(v => v.toUpperCase()), upper(device))) {
      throw fail('device-specific-case', `${r.label}=${valueOf(r.line)} は、名乗った機器(${[device.dev, device.ven, device.model, device.sn].filter(Boolean).join(' ')})と大文字・小文字だけが違います`);
    }
  }
  // 機器が DEV を名乗らなければ、どれが合うか決められないので、全体の値を黙って渡さず断る。
  // 名乗っていない欄(SN など)で絞った値は、表 A.1 の優先順位どおり、その機器には合わないものとし、合う欄の少ない段を使う(下の matchDevice)
  const known = [device.dev, device.ven, device.model, device.sn].map(v => String(v || '').trim());
  if (!known[0]) {
    const r = all.find(x => x.block === undefined && DEVICE_SPECIFIC.has(x.label));
    if (r) throw fail('device-specific-unknown', `${r.label}=${valueOf(r.line)} がこの機器に向けたものか、機器の名乗り(なし)では決められません`);
  }
  const plain = all.filter(r => r.block === undefined && !DEVICE_SPECIFIC.has(r.label));
  const extra = [];    // { label, line, n, from }
  const blocks = {};   // 当てはまったブロックの番号 → 合った欄の数
  for (const r of all) {
    if (r.block !== undefined || !DEVICE_SPECIFIC.has(r.label)) continue;
    const f = fieldsOf(r.line);
    if (r.label === 'PROC') {
      const n = matchDevice(f.slice(1, 4), device);
      const label = String(f[0] || '').toUpperCase();
      if (n && label) extra.push({ label, line: label + '=' + valueOf(r.line).split(';').slice(4).join(';'), n, from: 'PROC' });
    } else {
      const n = matchDevice(f.slice(1, 5), device);
      if (n && f[0]) blocks[f[0]] = n;
    }
  }
  for (const r of all) {
    if (r.block === undefined || !blocks[r.block]) continue;
    extra.push({ label: r.label, line: r.line.slice(r.line.indexOf('!') + 1), n: blocks[r.block], from: `PROCBLK ${r.block}` });
  }
  if (!extra.length) return plain;

  const bad = extra.find(e => /FMT$/.test(e.label) || DATASET_SERIES.has(e.label));
  if (bad) throw fail('device-specific-dataset', `この機器に向けた ${bad.label}(${bad.from})は玉型・データセットなので、vca-hub からは渡せません`);

  const byLabel = new Map();
  for (const e of extra) {
    if (INTERFACE_LABELS.has(e.label)) continue;   // 通信用のレコードは vca-hub が付ける
    if (!byLabel.has(e.label)) byLabel.set(e.label, []);
    byLabel.get(e.label).push(e);
  }
  // ラベルごとに、置き換える値(1 つしか置けないもの)と足す行(複数置けるもの)を決める
  const replace = new Map(), append = new Map();
  for (const [label, list] of byLabel) {
    const def = VCA.recordDef(label);
    // 複数置けるレコードは足す(5.17.1.1)。ただし LDPATH・LDTYPE は機器が 1 つだけ受ける(5.9.3.2)ので置き換える
    if (def && def.repeat && label !== 'LDPATH' && label !== 'LDTYPE') { append.set(label, list.map(e => ({ label, line: e.line }))); continue; }
    const best = list.reduce((m, e) => Math.max(m, e.n), 0);
    const top = list.filter(e => e.n === best);
    const values = new Set(top.map(e => fieldsOf(e.line).join(';')));
    if (values.size > 1) {
      throw fail('device-specific-ambiguous', `この機器に向けた ${label} が同じ合い方で ${values.size} 通りあり、どれを渡すか決められません(${top.map(e => e.from).join('・')})`);
    }
    replace.set(label, { label, line: top[0].line });
  }
  // 全体の行を 1 度だけたどって組み立てる(行が多いデータでも、ラベルごとに全体をたどり直さない)。
  // 置き換えるものは全体の最初の位置に、足すものは全体の最後の同じラベルのあとに、全体に無いものは末尾に置く
  const last = new Map();
  plain.forEach((r, i) => last.set(r.label, i));
  const out = [], placed = new Set();
  plain.forEach((r, i) => {
    const rep = replace.get(r.label);
    if (rep) { if (!placed.has(r.label)) { out.push(rep); placed.add(r.label); } return; }
    out.push(r);
    if (append.has(r.label) && last.get(r.label) === i) { out.push(...append.get(r.label)); placed.add(r.label); }
  });
  for (const label of byLabel.keys()) {
    if (placed.has(label)) continue;
    if (replace.has(label)) out.push(replace.get(label));
    else if (append.has(label)) out.push(...append.get(label));
  }
  return out;
}

// BEVP の値ごとに要るもの(表 A.1 の BEVP)。1・2・5 は BEVM、3 は BEVM と BEVC。0・4・7・10 はどちらも要らない
const BEVEL_NEEDS = { 0: [], 1: ['BEVM'], 2: ['BEVM'], 3: ['BEVM', 'BEVC'], 4: [], 5: ['BEVM'], 7: [], 10: [] };

/**
 * 一覧に BEVP があれば、BEVP の値によって要る BEVM・BEVC も送る(7.2.4.3、表 A.7 の注記)。
 * BEVP が無い・? ・表で意味の決まっていない値(6・8・9 など)のときは、要るかどうか決められないので両方送る(ジョブに無ければ ?)。
 */
function withBevel(labels, lines) {
  if (!labels.includes('BEVP')) return labels;
  const bevp = lines.find(r => r.label === 'BEVP');
  const values = bevp ? fieldsOf(bevp.line).filter(v => v !== '') : [];
  const need = new Set();
  if (!values.length || values.some(v => !/^\d+$/.test(v) || !BEVEL_NEEDS[Number(v)])) { need.add('BEVM'); need.add('BEVC'); }
  else values.forEach(v => BEVEL_NEEDS[Number(v)].forEach(l => need.add(l)));
  const out = labels.slice();
  let at = out.indexOf('BEVP');
  for (const l of ['BEVM', 'BEVC']) if (need.has(l) && !out.includes(l)) out.splice(++at, 0, l);
  return out;
}

/** 左右一対のレコードか(派生レコードは元のレコードと同じ形。A.1.1.7) */
function isChiral(label) {
  const d = VCA.recordDef(label);
  return !!d && (d.chiral || d.k === 'c' || d.k === 'o');
}

/** 一覧に LDPATH があれば、LDTYPE も送る(LDPATH の種類は LDTYPE で機器に渡す。5.9.3.2) */
function withLdtype(labels) {
  if (!labels.includes('LDPATH') || labels.includes('LDTYPE')) return labels;
  const out = labels.slice();
  out.splice(out.indexOf('LDPATH') + 1, 0, 'LDTYPE');
  return out;
}

/** ENGMARK の種類が DCS なら、指すレコードもデータに入れる(5.15.1.3) */
function withEngmark(labels, lines) {
  if (!labels.includes('ENGMARK')) return labels;
  const out = labels.slice();
  for (const r of lines.filter(x => x.block === undefined && x.label === 'ENGMARK')) {
    const f = fieldsOf(r.line);
    const ref = String(f[1] || '').trim().toUpperCase();
    if (String(f[0]).trim().toUpperCase() === 'DCS' && ref && !out.includes(ref)) out.splice(out.indexOf('ENGMARK'), 0, ref);
  }
  return out;
}

/** EDATA は LDCRYPT の後に続ける(5.9.7.4)。LDCRYPT を送るなら EDATA も送る */
function withEdata(labels) {
  if (!labels.includes('LDCRYPT')) return labels;
  const out = labels.filter(l => l !== 'EDATA');
  out.splice(out.indexOf('LDCRYPT') + 1, 0, 'EDATA');
  return out;
}

// データセットの見出し(5.1.9)。見出しのあとに、決まった系列の行(R・A・T など)が続く
const DATASET_HEADERS = new Set(['TRCFMT', 'ZFMT', 'CRIBFMT', 'STHKFMT', 'SHLFFMT', 'SURFMT', 'PASSFMT', 'PMFMT', 'WMFMT', 'DDFMT']);

/**
 * 送る行から通信用レコードを除き、データセットの系列の行を見出しにまとめる。
 * - 玉型(TRCFMT)とサグ(ZFMT)のデータセットは、送り先に合わせて作り直すので、見出しも系列も除く
 * - ほかのデータセット(CRIBFMT・STHKFMT など)は、見出しのあとに続く系列の行(R・A・T など)を見出しの series に入れ、
 *   見出しと一緒にそのまま送る(5.10.4・5.11.1。系列の行を玉型の R・A と取り違えて落とさない)
 * - 見出しの無い系列の行は送らない
 * ブロックの中の行(別の PC へそのまま残すもの)は、そのまま残す
 */
function datasetLines(source) {
  const out = [];
  let head = null;   // 続いているデータセットの見出し(送る行)。玉型・サグなら 'drop'
  for (const r of source) {
    if (r.block !== undefined) { head = null; out.push(r); continue; }
    if (DATASET_HEADERS.has(r.label)) {
      if (r.label === 'TRCFMT' || r.label === 'ZFMT') { head = 'drop'; continue; }
      head = { ...r, series: [] };
      out.push(head);
      continue;
    }
    if (DATASET_SERIES.has(r.label)) {
      if (head === 'drop') continue;
      // その見出しの系列なら付ける。ほかの見出しの系列(見出しの無い系列の行)は送らず、データセットを閉じる(vca-parser と同じ読み方)
      if (head && (SERIES_OF[head.label] || []).includes(r.label)) { head.series.push(r); continue; }
      head = null;
      continue;
    }
    // REM(注記)はどのパケットにも置けるので、データセットの途中にあっても閉じない(系列の続きを落とさない)。REM は送らない
    if (r.label === 'REM') continue;
    head = null;
    if (!INTERFACE_LABELS.has(r.label)) out.push(r);
  }
  return out;
}

/** 行をレコードにする。データセットの見出しなら、続く系列の行も一緒に */
const withSeries = r => [lineRecord(r.line), ...(r.series || []).map(x => lineRecord(x.line))];

/**
 * 取り決めたデータセット(SHLFFMT・CRIBFMT・STHKFMT)は、保存した形(形式・点数・角度のモード)が取り決めと同じときだけ渡す。
 * 作り直さないので、違えば渡さない(この機器には合わない。STATUS=4)
 */
function datasetChecked(r, profile) {
  const want = profile && profile.datasets && profile.datasets[r.label];
  if (want) {
    const have = fieldsOf(r.line).map(v => String(v).trim());
    const same = [0, 1, 2].every(i => !want[i] || String(want[i]).toUpperCase() === String(have[i] || '').toUpperCase());
    if (!same) throw fail('dataset-format', `${r.label}=${have.join(';')} は、取り決めた形式(${want.join(';')})と違い、作り直せません`);
  }
  return withSeries(r);
}

/**
 * 加工するレンズ(DO の値)。DO は、玉型などの左右のデータがあるかどうかにかかわらず、どちらのレンズを加工するかを表す(表 A.2)。
 * 受け取ったジョブの DO を、そのまま渡す。玉型の有無や、機器が求めた玉型の向き(TRCFMT の眼)からは決めない。
 * ジョブに DO が無いときだけ、玉型のある眼から決める(送る前の確認で知らせる)
 */
function jobDo(parsed) {
  const v = String(VCA.value(parsed, 'DO') || '').trim().toUpperCase();
  if (['R', 'L', 'B', 'N'].includes(v)) return v;
  const have = new Set(parsed.traces.map(t => t.eye));
  if (have.size === 1) return [...have][0];
  return 'B';
}

/**
 * 送る玉型を選ぶ。
 * - 機器が 1 組だけを求めた(取り決めた TRCFMT の眼が R か L)ときは、加工する眼(DO が R・L ならその眼、B・N なら求めた向きの眼)の玉型を、
 *   求めた向きにして 1 組送る。その眼の玉型が無ければ、反対眼のものを反転して使う(5.4.11.3・5.4.11.4・5.4.13)
 * - それ以外は、持っている玉型をそれぞれの向きのまま送る
 * @returns {Array<{trace: object, eye: string}>}
 */
function chooseTraces(usable, doEye, wantEye) {
  if (wantEye === 'R' || wantEye === 'L') {
    const from = doEye === 'R' || doEye === 'L' ? doEye : wantEye;
    const t = usable.find(x => x.eye === from) || usable[0];
    return t ? [{ trace: t, eye: wantEye }] : [];
  }
  return usable.slice(0, 2).map(t => ({ trace: t, eye: t.eye }));
}

/**
 * 片眼の玉型と、左右で違う 2 つの CIRC(または CIRC3D)があり、BSIZ・CSIZ が無いか分からないか。
 * このとき左右の周長の差は、送らない眼の形を変える量(CSIZ)を表す(5.4.9.4)。反転して送る眼の寸法を元の眼の値にそろえると
 * この差が消え、違う大きさのレンズになる。反転せず、受け取った向きと寸法のまま送る(加工機はどちらの向きも受ける。5.4.13)
 */
function impliedSize(lines, traces) {
  if (new Set(traces.map(t => t.eye)).size !== 1) return false;
  const top = label => lines.filter(r => r.block === undefined && r.label === label);
  const unknown = label => top(label).every(r => fieldsOf(r.line).every(v => v === '' || v === '?'));
  if (!unknown('BSIZ') || !unknown('CSIZ')) return false;
  return ['CIRC', 'CIRC3D'].some(label => top(label).some(r => {
    const [a, b] = fieldsOf(r.line).map(Number);
    return Number.isFinite(a) && Number.isFinite(b) && fieldsOf(r.line)[0] !== '' && fieldsOf(r.line)[1] !== '' && a !== b;
  }));
}

/**
 * 使う穴あけの基準。初期化で取り決めたもの(profile.drill)か、初期化しない機器が要求に書いた候補(profile.drillOffers。5.5.3)から、
 * ジョブの DRILLE の基準に合うものを選ぶ。DRILLE が無ければ候補の 1 つ目。取り決めが無ければ null
 */
function drillReference(lines, profile) {
  if (!profile) return null;
  const offers = (profile.drillOffers || (profile.drill ? [profile.drill] : [])).map(v => String(v).toUpperCase()).filter(Boolean);
  if (!offers.length) return null;
  const refs = drillRefs(lines);
  return refs.size === 1 && offers.includes([...refs][0]) ? [...refs][0] : offers[0];
}

/**
 * 穴の無いこと・分からないことを表す行か。2 つ目の欄の "0" は穴が無いこと(5.5.2.2)、DRILLE=0・DRILLE=? も同じに扱う(5.5.2.10.9)。基準を持たない
 */
const noHoles = r => { const f = fieldsOf(r.line).map(v => String(v).trim()); return ['0', '?'].includes(f[0]) || f[1] === '0'; };
/**
 * DRILLE の基準(5.5.2.2): 2 つ目の欄の 1 文字目(C・E・B)。欄が空なら中心基準(C)。2 文字目以降は穴の側と取り付ける面なので比べない。
 * R(相対基準)は、制御する穴の基準に従うので、基準として数えない(null)
 */
function drillRef(r) {
  const c = String(fieldsOf(r.line)[1] || '').trim().toUpperCase().charAt(0) || 'C';
  return c === 'R' ? null : c;
}
/** 穴のある DRILLE の基準の集まり */
function drillRefs(lines) {
  return new Set(lines.filter(r => r.block === undefined && r.label === 'DRILLE' && !noHoles(r)).map(drillRef).filter(Boolean));
}

/**
 * 穴あけ(DRILLE)。機器が穴あけの基準(DRLFMT)を取り決めたら、ラベル一覧に無くても送る(5.5.1.5)。
 * 保存した DRILLE の基準(2 つ目の欄の 1 文字目)が取り決めた基準と違えば、作り直せないので渡さない(例外。STATUS=4)
 */
function drillRecords(lines, drill) {
  const all = lines.filter(r => r.block === undefined && r.label === 'DRILLE');
  // 穴の無いこと・分からないことを表す行(DRILLE=0・DRILLE=?)は、基準を持たないのでそのまま渡す
  if (all.length && all.every(noHoles)) return all.map(r => lineRecord(r.line));
  const recs = all.filter(r => !noHoles(r));
  // DRILLE を扱う機器には、廃止された DRILL を送らない(5.5.1.5)。DRILL だけのジョブは、基準が分からず DRILLE に作り直せないので渡さない
  if (!recs.length && lines.some(r => r.block === undefined && r.label === 'DRILL')) {
    throw fail('drill-reference', 'ジョブの穴あけは DRILL だけで、取り決めた DRILLE に作り直せません(5.5.1.5)。穴の位置を DRILLE で作り直すか、加工機で穴の位置を入れてください');
  }
  // ジョブに穴あけの情報が無い: 分からないことを DRILLE=? で示す(5.5.2.10.9)
  if (!recs.length) return [['DRILLE', '?']];
  for (const r of recs) {
    const ref = drillRef(r);
    if (ref !== null && ref !== drill) throw fail('drill-reference', `DRILLE=${valueOf(r.line)} の基準 ${ref || '(なし)'} が、取り決めた基準 ${drill} と違います(vca-hub は基準を作り直せません)。加工機が ${ref || 'C'} も扱えるなら、加工機の設定で穴あけの基準に ${ref || 'C'} を選ぶか、加工機で穴の位置を入れてください`);
  }
  return recs.map(r => lineRecord(r.line));
}

/**
 * 加工機などへのダウンロード応答のレコードを組み立てる(ANS・JOB・STATUS は vca-session.js が付ける)。
 * @param {{body: string, profile: object|null, device?: object|null}} args
 *   profile: 送信先の希望。
 *     初期化した機器: { labels: 受け取りたいラベル, trcfmt: 取り決めた玉型の形式 | null, zfmt: サグを求めたか }
 *     初期化しない機器・プリセット初期化の機器: { labels: プリセットの項目, preset: true, trcfmt: 要求に書いた形式 | null }
 *     どちらでもない: null(すべての項目)。玉型の形式の取り決めが無ければ形式 1 で送る(7.2.8)
 *     ownFormat: 送り先・書き出しのように vca-hub が形式を決めたもの(玉型が無くても TRCFMT=0 を付けない。5.4.1)
 *   device: 機器へ送るときは、名乗った機器 { dev, ven, model, sn }(分からなければ null)。
 *     PROC・PROCBLK は、この機器に向けた中身にして渡す(5.16・5.17)。
 *     書かない(undefined)ときは、別の PC や共有フォルダへ送るもので、PROC・PROCBLK とブロックの中身をそのまま残す。
 * @returns {Array<string[]>}
 */
function buildDownload({ body, profile, device }) {
  const parsed = VCA.parse(body);
  const all = recordLines(body);
  const toDevice = device !== undefined;
  const source = toDevice ? linesForDevice(resolveLdpath(all, device || {}), device || {}) : all;
  // ブロックの中の行(別の PC へそのまま残すもの)は、玉型の行でも取り除かない
  const lines = datasetLines(source);
  const doEye = jobDo(parsed);

  // 機器レコード: 受け取りたい一覧があればそれだけ。持っていない項目は "?"(DCS 5.1.4。左右一対のレコードは ?;?)
  const deviceRecords = [];
  const drill = drillReference(lines, profile);
  // 穴あけの基準を取り決めていない加工機には DRILLE を使えない(5.5.1.5: Absent Initialization, DRILLE records cannot be used)。
  // 穴のある DRILLE を持つジョブは、黙って穴の無いデータにせず断る(STATUS=4)
  const noDrillDevice = toDevice && profile && !drill;
  if (noDrillDevice && drillRefs(lines).size) {
    throw fail('drill-reference', 'ジョブの穴あけは DRILLE で、この加工機とは穴あけの基準(DRLFMT)を取り決めていないので渡せません(5.5.1.5)。加工機の設定で穴あけの基準を送るようにする(初期化・要求の DRLFMT)か、加工機で穴の位置を入れてください');
  }
  if (profile && profile.labels && profile.labels.length) {
    for (const label of withEdata(withEngmark(withLdtype(withBevel(profile.labels, lines)), lines))) {
      if (TRACE_LABELS.has(label) || INTERFACE_LABELS.has(label) || DEVICE_SPECIFIC.has(label)) continue;
      if (drill && (label === 'DRILLE' || label === 'DRILL')) continue;   // 下で送る(DRILL は送らない。5.5.1.5)
      if (noDrillDevice && label === 'DRILLE') { deviceRecords.push(['DRILLE', '?']); continue; }
      const found = lines.filter(r => r.label === label && r.block === undefined);
      if (found.length) found.forEach(r => deviceRecords.push(...datasetChecked(r, profile)));
      // 求められたデータセットが無い: 見出しを 0 にして示す(5.8.1。TRCFMT=0 と同じ)
      else if (DATASET_HEADERS.has(label) && label !== 'TRCFMT' && label !== 'ZFMT') deviceRecords.push([label, '0']);
      // LDTYPE が無ければ SDF とみなす(5.9.3.2。種類は ? にできない)
      else if (label === 'LDTYPE' && lines.some(r => r.block === undefined && r.label === 'LDPATH')) deviceRecords.push(['LDTYPE', 'SDF']);
      // EDATA が無ければ送らない(LDCRYPT に続くもの。? にしない)
      else if (label === 'EDATA') continue;
      else deviceRecords.push(isChiral(label) ? [label, '?', '?'] : [label, '?']);
    }
    if (drill) deviceRecords.push(...drillRecords(lines, drill));
  } else {
    // 穴あけの基準を取り決めた機器には、廃止された DRILL を送らず、DRILLE の基準を確かめる(5.5.1.5)
    if (drill) drillRecords(lines, drill);
    lines.forEach(r => {
      if (drill && r.label === 'DRILL' && r.block === undefined) return;
      if (noDrillDevice && r.label === 'DRILLE' && r.block === undefined) return;   // 取り決めの無い加工機には DRILLE を使わない
      deviceRecords.push(...datasetChecked(r, profile));
    });
  }

  // 玉型データ: 形式を取り決めた機器(初期化、または初期化しない機器の要求の TRCFMT。7.2.8)にはその形式で。
  // 取り決めのない初期化済み機器には送らない
  const out = [];
  const negotiated = profile ? profile.trcfmt || null : null;
  const wantsTrace = !profile || profile.preset || !!negotiated;
  if (wantsTrace) {
    const usable = parsed.traces.filter(t => t.radii.length >= 3 && t.radii.every(Number.isFinite));
    // 片眼の玉型で、左右の周長の差が寸法の変更(CSIZ)を表すときは反転しない(下の impliedSize)
    const chosen = chooseTraces(usable, doEye, impliedSize(lines, usable) ? null : negotiated && negotiated.eye);
    // 反対眼の玉型を反転して送るときは、送る眼の寸法(CIRC・HBOX・VBOX)を、反転した形の寸法(元の眼の値)にする(5.4.9.3・5.4.9.4)
    for (const { trace, eye } of chosen) {
      if (trace.eye === eye || !['R', 'L'].includes(trace.eye) || !['R', 'L'].includes(eye)) continue;
      const from = trace.eye === 'R' ? 1 : 2, to = eye === 'R' ? 1 : 2;
      for (const rec of deviceRecords) {
        if (!SHAPE_SIZES.has(String(rec[0]))) continue;
        // 行から作ったレコードは値を 1 つの文字列で持つので、欄に分けて入れ替える
        const f = rec.slice(1).join(';').split(';');
        if (f.length < 2) continue;
        f[to - 1] = f[from - 1];
        rec.splice(1, rec.length - 1, ...f);
      }
    }
    if (chosen.length) {
      for (const { trace, eye } of chosen) {
        // 取り決めが無ければ形式 1(全ての機器とホストが扱える形式。7.2.8)。点数・角度のモード・向きは受け取ったまま
        out.push(...traceRecords(trace, { ...(negotiated || { fmt: 1 }), eye }));
        // サグを求めた機器には、サグが無いことを ZFMT=0 で示す(サグの中継は未対応。5.4.1)
        if (negotiated && profile.zfmt) out.push(['ZFMT', '0']);
      }
    } else if (negotiated && !profile.ownFormat) {
      // 機器が玉型を求めたのに持っていない(5.4.1)。vca-hub が自分で形式を決めた送り先・書き出しには付けない
      out.push(['TRCFMT', '0']);
      // 5.4.1 は TRCFMT=0 で ZFMT=0 を含むとして要らないとするが、7.2.8 はサグを求めた機器に ZFMT=0 を返すとするので、付ける
      if (profile.zfmt) out.push(['ZFMT', '0']);
    }
  }

  return [['DO', doEye], ...tidyRecords(deviceRecords), ...out];
}

// 玉型の寸法のレコード(5.4.9.3: 送る形の寸法を表す)。反対眼の玉型を反転して送るときは、反転した形の寸法にそろえる
const SHAPE_SIZES = new Set(['CIRC', 'HBOX', 'VBOX', 'CIRC3D']);

/**
 * 送るレコードを規格の形にそろえる(値は変えない)。
 * - 1 つしか置けないレコード(5.1.10)が同じ値で 2 つあれば、1 つにする(値が違うものは送る前の検査で止めている)
 * 値の欄は変えない(5.1 は、左右一対のレコードの値が 1 つなら両眼に当てはめ、片眼だけの注文で SPH=;2.75 のように空にする形も認める)
 * データセットの見出しと系列、メーカーや独自のラベル(定義の無いもの)はそのまま
 */
function tidyRecords(records) {
  const seen = new Set(), out = [];
  for (const rec of records) {
    const label = String(rec[0]);
    const def = VCA.recordDef(label);
    if (!def || DATASET_HEADERS.has(label) || DATASET_SERIES.has(label) || /FMT$/.test(label)) { out.push(rec); continue; }
    if (!def.repeat) {
      // 行から作ったレコードは値を 1 つの文字列で持つので、欄に分けて、前後の空白を除いて比べる
      const key = label + '=' + rec.slice(1).join(';').split(';').map(v => v.trim()).join(';').replace(/;+$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(rec);
  }
  return out;
}

/** 初期化で取り決めた TRCFMT のレコード(['TRCFMT', 形式, 点数, モード, 眼, ...])を、送信の希望にする。 */
function traceWant(fields) {
  if (!fields || !FORMATS.includes(+fields[0])) return null;
  return { fmt: +fields[0], n: +fields[1] || 0, mode: String(fields[2] || 'E').toUpperCase(), eye: String(fields[3] || 'R').toUpperCase() };
}

module.exports = { buildDownload, recordLines, tooManyLabels, MAX_DISTINCT_LABELS, traceWant, deviceSpecificProblems, INTERFACE_LABELS, TRACE_LABELS, DEVICE_SPECIFIC, DATASET_SERIES };
