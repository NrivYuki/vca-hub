'use strict';
// JSON ファイルを一時ファイル経由で置き換える。
// Windows ではウイルス対策ソフトや検索インデックスが一瞬ファイルを開いているだけで
// rename が EPERM などで失敗するため、少し待って再試行する。
// 電源断に備えて、一時ファイルの中身をディスクへ書き切ってから(fsync)名前を変え、
// 置き換える前のファイルを .bak として残す(読めなくなったときは readJsonWithBackup が .bak を読む)。

const fs = require('node:fs');

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
// このプロセスが書いたか、読んで形を確かめたファイルと、そのときの大きさ・時刻(.bak へ写すときに読み直さない。
// ほかから書き換えられていれば、大きさか時刻が変わるので、読み直して確かめる)
const GOOD = new Map();
const stamp = file => { const st = fs.statSync(file); return `${st.size}|${st.mtimeMs}`; };
const markGood = file => { try { GOOD.set(file, stamp(file)); } catch { GOOD.delete(file); } };
const isGood = file => { try { return GOOD.get(file) === stamp(file); } catch { return false; } };

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 中身を書いて、ディスクへ書き切る */
function writeSynced(file, text) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} file
 * @param {unknown} data
 * @param {{tries?: number, waitMs?: number, text?: string, valid?: Function}} [opts] text は書く文字列(JSON にし直さない)、valid は 1 つ前のもの(.bak)に写すときの形の確かめ
 */
function writeJsonAtomic(file, data, { tries = 10, waitMs = 20, text, valid = () => true } = {}) {
  const tmp = file + '.tmp';
  // 字下げはしない(索引が大きいときに、書く量と時間を減らす)。text を渡されたら、それを書く(JSON にし直さない)
  writeSynced(tmp, text !== undefined ? text : JSON.stringify(data));
  // 置き換える前のものを残す。読めるものだけを残す(壊れたものを残すと、戻す先が無くなる)。
  // このプロセスが書いたか読めたファイルは、確かめずに写す(索引が大きいときに、読み直して確かめる時間を省く)
  try {
    if (isGood(file)) {
      fs.copyFileSync(file, file + '.bak');
      const fd = fs.openSync(file + '.bak', 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else {
      const prev = fs.readFileSync(file, 'utf8');
      // 形の違うもの(読めるが中身が違う)も残さない。正しい .bak を壊れたもので上書きしないため
      if (!valid(JSON.parse(prev))) throw new Error('形が違う');
      writeSynced(file + '.bak', prev);
    }
  } catch { /* 前が無い・読めない: 前の .bak をそのまま残す */ }
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(tmp, file);
      markGood(file);
      return;
    } catch (e) {
      if (!RETRY_CODES.has(e.code) || i >= tries) {
        try { fs.unlinkSync(tmp); } catch { /* 消せなくても次回の書き込みで上書きされる */ }
        throw e;
      }
      sleepSync(waitMs * i);
    }
  }
}

/**
 * JSON ファイルを読む。読めなければ 1 つ前のもの(.bak)を読み、onRecovered を呼ぶ。
 * どちらも無ければ empty()。どちらも読めなければ例外(code: json-broken。消えたデータを黙って空として扱わないため)。
 * @param {string} file
 * @param {{empty: () => unknown, valid?: (v: unknown) => boolean, onRecovered?: (e: Error) => void}} opts
 */
function readJsonWithBackup(file, { empty, valid = () => true, onRecovered = () => {} }) {
  const parse = p => {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!valid(v)) throw new Error('形が正しくありません');
    return v;
  };
  const bak = file + '.bak';
  let first;
  if (fs.existsSync(file)) {
    try { const v = parse(file); markGood(file); return v; } catch (e) { first = e; GOOD.delete(file); }
  } else {
    first = new Error('ありません');
  }
  if (!fs.existsSync(bak)) {
    if (!fs.existsSync(file)) return empty();
    throw Object.assign(new Error(`${file} を読めません(${first.message})。1 つ前のもの(.bak)もありません`), { code: 'json-broken' });
  }
  let v;
  try { v = parse(bak); } catch (e) {
    throw Object.assign(new Error(`${file} と 1 つ前のもの(.bak)を読めません(${first.message} / ${e.message})`), { code: 'json-broken' });
  }
  onRecovered(first);
  return v;
}

/**
 * .bak を今のファイルと同じにする。消したものを .bak に残さないため(記録を消して書いた直後に呼ぶ)。
 * 今のファイルがこのプロセスの書いたままでなければ、何もしない(壊れたものを .bak にしない)
 */
function refreshBackup(file) {
  if (!isGood(file)) return false;
  fs.copyFileSync(file, file + '.bak');
  const fd = fs.openSync(file + '.bak', 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return true;
}

module.exports = { writeJsonAtomic, readJsonWithBackup, refreshBackup, writeSynced };
