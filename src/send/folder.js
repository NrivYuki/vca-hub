'use strict';
// 共有フォルダへの書き出しと、フォルダ監視による取り込み(設計書 6 章)。

const fs = require('node:fs');
const path = require('node:path');
const VCA = require('../lib/vca-parser.js');
const { buildDownload } = require('./build.js');

const DONE_DIR = '取り込み済み';
const FAILED_DIR = '取り込めなかった';

/** 共有フォルダへ書き出すレコード(機器用のレコードはすべて、玉型は形式 1)。拡張の send はこのあとに通す */
function fileRecords(body) {
  return buildDownload({ body, profile: { labels: [], trcfmt: { fmt: 1 } } });
}

/**
 * 共有フォルダへ書き出すファイルの中身(REQ=FIL の VCA ファイル)。
 * records を渡せば、それを書く(拡張を通したもの)。
 * 1 行目 REQ=FIL、2 行目 JOB(付けた名前)。制御文字・CRC・STATUS は入れず、玉型は形式 1 にする。
 */
function fileText(body, name, records = fileRecords(body)) {
  const all = [['REQ', 'FIL'], ['JOB', name], ...records];
  return all.map(r => r[0] + '=' + r.slice(1).join(';') + '\r\n').join('');
}

/** 書き出し先のファイル名と、同じ名前のファイルがすでにあるか(あれば上書きになる)。 */
function exportTarget(dir, name) {
  const file = path.join(dir, name + '.vca');
  return { file, exists: fs.existsSync(file) };
}

/**
 * 書き出す。受け取る側のソフトが書きかけのファイルを読まないよう、一時ファイルに書いてから名前を変える。
 * @returns {{file: string, overwrote: boolean}}
 */
function exportFile(dir, name, body, records) {
  fs.mkdirSync(dir, { recursive: true });
  const { file, exists } = exportTarget(dir, name);
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, Buffer.from(fileText(body, name, records), 'latin1'));
  fs.renameSync(tmp, file);
  return { file, overwrote: exists };
}

/** 同じ名前があれば、番号を付けて別の名前にする(取り込み済みのフォルダへ移すとき)。 */
function freeName(dir, base) {
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  let p = path.join(dir, base), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${stem}_${++i}${ext}`);
  return p;
}

/**
 * フォルダを監視し、置かれた VCA ファイル(.vca)を取り込む。
 * ネットワークのフォルダでは変更の知らせが届かないことがあるので、一定の間隔で見に行く。
 * 書きかけのファイルを読まないよう、最後の書き込みから settleMs たったものだけを取り込む。
 * 取り込んだファイルは「取り込み済み」へ、読めなかったものは「取り込めなかった」へ移す(消さない)。
 * @param {{dir: string, store: object, log: object, intervalMs?: number, settleMs?: number}} opts
 */
function watchFolder({ dir, store, log, intervalMs = 5000, settleMs = 2000 }) {
  let timer = null, stopped = false;
  const imported = new Set();   // 取り込んだが、まだ移せていないファイル(二度取り込まない)
  // 移せなければ(ほかのソフトが開いているなど)、次の回にもう一度試す
  const tryMove = (file, sub, n) => {
    try {
      const to = path.join(dir, sub);
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(file, freeName(to, path.basename(file)));
      return true;
    } catch (e) {
      log.write('warn', { event: 'import-move', detail: `${n} を ${sub} へ移せません: ${e.code || e.message}` });
      return false;
    }
  };
  function scan() {
    if (stopped) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { log.write('warn', { event: 'import', detail: `フォルダを読めません: ${e.code || e.message}` }); }
    for (const n of names) {
      const file = path.join(dir, n);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || path.extname(n).toLowerCase() !== '.vca' || Date.now() - st.mtimeMs < settleMs) continue;
      const key = `${n}|${st.size}|${st.mtimeMs}`;
      if (imported.has(key)) { tryMove(file, DONE_DIR, n); continue; }   // 取り込んだが移せなかったもの
      let entry;
      try {
        const body = fs.readFileSync(file).toString('latin1');
        const parsed = VCA.parse(body);
        if (!parsed.records.length && !parsed.traces.length) throw new Error('VCA のレコードがありません');
        entry = store.saveReceived({ body, type: 'FIL', job: VCA.value(parsed, 'JOB'), peer: `フォルダ:${n}`, crcOk: null });
      } catch (e) {
        log.write('warn', { event: 'import-failed', detail: `${n}: ${e.message}` });
        tryMove(file, FAILED_DIR, n);
        continue;
      }
      imported.add(key);
      log.write('info', { event: 'imported', job: entry.job, detail: `${n} ${entry.id}` });
      if (tryMove(file, DONE_DIR, n)) imported.delete(key);
    }
    timer = setTimeout(scan, intervalMs);
  }
  fs.mkdirSync(dir, { recursive: true });
  scan();
  return { scan, stop() { stopped = true; clearTimeout(timer); } };
}

module.exports = { fileText, fileRecords, exportTarget, exportFile, watchFolder, DONE_DIR, FAILED_DIR };
