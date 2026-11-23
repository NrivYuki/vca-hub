'use strict';
// 共有フォルダへの書き出しと、フォルダ監視による取り込み(設計書 6 章)。

const fs = require('node:fs');
const path = require('node:path');
const VCA = require('../lib/vca-parser.js');
const { buildDownload, tooManyLabels } = require('./build.js');
const { writeJsonAtomic, readJsonWithBackup, refreshBackup } = require('../lib/atomic.js');

const DONE_DIR = '取り込み済み';
// 1 回の走査で取り込むファイルの数と、残りがあるときに続けるまでの間(数千のファイルを置かれても、1 度に長く止まらないように)
const MAX_PER_SCAN = 20, MORE_DELAY_MS = 200;
const FAILED_DIR = '取り込めなかった';
// 取り込むファイルの大きさの上限(VCA の口のパケットの上限と同じ 1 MiB)
const MAX_IMPORT_BYTES = 1024 * 1024;
// 取り込みをやり直すファイルの記録を書く間隔(同じファイル・同じ理由)
const RETRY_LOG_MS = 600000;

/** 共有フォルダへ書き出すレコード(機器用のレコードはすべて、玉型は形式 1)。拡張の send はこのあとに通す */
function fileRecords(body) {
  return buildDownload({ body, profile: { labels: [], trcfmt: { fmt: 1 }, ownFormat: true } });
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
 * 同じ名前のファイルは、overwrite が true のとき(確認の画面で上書きを知らせたとき)だけ上書きする。
 * そうでなければ、確認の後に現れたファイルも上書きせず、例外(code: file-exists)にする。
 * @returns {{file: string, overwrote: boolean}}
 */
function exportFile(dir, name, body, records, { overwrite = false } = {}) {
  // 書き出し先に書けない(共有フォルダの PC が止まっているなど)ときは、理由を返す
  const cannot = e => Object.assign(new Error(`書き出し先に書けません(${e.code || e.message})`), { code: 'export-failed' });
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { throw cannot(e); }
  const { file, exists } = exportTarget(dir, name);
  const taken = () => Object.assign(new Error(`書き出し先に ${name}.vca があります(上書きするかを確かめてください)`), { code: 'file-exists' });
  if (exists && !overwrite) throw taken();
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  // 書き出し先のファイルを受け手のソフトが開いたままなどで置けないときは、理由を返す(一時ファイルは残さない)
  const busy = e => Object.assign(new Error(`書き出し先の ${name}.vca に書けません。ほかのソフトが開いているかもしれません(${e.code})`), { code: 'file-busy' });
  const place = () => {
    if (overwrite) {
      fs.renameSync(tmp, file);
      return exists;
    }
    // 上書きしない: 同じ名前があれば失敗する作り方(ハードリンク)で置く。確かめてから置くまでの間に現れたファイルも上書きしない
    try {
      fs.linkSync(tmp, file);
      return false;
    } catch (e) {
      if (e.code === 'EEXIST') throw taken();
      // ハードリンクを作れないフォルダ(FAT・exFAT、一部のネットワークのフォルダ)では、確かめてから名前を変える。
      // 確かめてから名前を変えるまでの間に現れたファイルは上書きしてしまう(設計書 11 章)
      if (fs.existsSync(file)) throw taken();
      fs.renameSync(tmp, file);
      return false;
    }
  };
  try { fs.writeFileSync(tmp, Buffer.from(fileText(body, name, records), 'latin1')); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* 無視 */ } throw cannot(e); }
  try {
    return { file, overwrote: place() };
  } catch (e) {
    if (e.code === 'file-exists') throw e;
    throw ['EPERM', 'EBUSY', 'EACCES'].includes(e.code) ? busy(e) : e;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ウイルス対策ソフトなどが開いていれば残る。名前は . で始まり、拡張子は .vca でない */ }
  }
}

/** ネットワークのパス(\\server\share など)か */
const isNetworkPath = p => /^(\\\\|\/\/)/.test(String(p || ''));
const probes = new Map();   // 確かめている途中のネットワークのフォルダ → Promise
/**
 * ネットワークのフォルダに届くかを、vca-hub を止めずに確かめる(届かない共有フォルダへの同期の読み書きは、
 * Windows の接続待ちの間 vca-hub 全体を数十秒止め、加工機とのセッションが時間切れになるため)。
 * ネットワークのパスでなければ確かめない(true)。前の確かめが終わっていなければ、届かないとみなす
 * @returns {Promise<boolean>}
 */
function reachable(dir, ms = 2000) {
  if (!isNetworkPath(dir)) return Promise.resolve(true);
  // 確かめの途中なら、その結果を待つ(同じフォルダを重ねて確かめない。届くのに届かないと答えないため)
  let p = probes.get(dir);
  if (!p) {
    p = fs.promises.stat(dir).then(() => true, e => e.code === 'ENOENT');   // フォルダが無いだけなら、共有には届いている
    probes.set(dir, p);
    p.finally(() => probes.delete(dir));
  }
  let timer;
  return Promise.race([p, new Promise(r => { timer = setTimeout(() => r(false), ms); timer.unref(); })]).finally(() => clearTimeout(timer));
}

/** 同じ名前があれば、番号を付けて別の名前にする(取り込み済みのフォルダへ移すとき)。 */
function freeName(dir, base) {
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  if (!fs.existsSync(path.join(dir, base))) return path.join(dir, base);
  // 同じ名前があれば、フォルダの中を一度だけ読んで、使われていない番号を探す
  // (1 つずつ確かめると、決まった名前で書き出すソフトのとき、取り込み済みのファイル数に比例して長く止まるため)
  const fold = n => (process.platform === 'win32' ? n.toLowerCase() : n);
  let used;
  try { used = new Set(fs.readdirSync(dir).map(fold)); } catch { used = new Set(); }
  let i = 2;
  while (used.has(fold(`${stem}_${i}${ext}`))) i++;
  return path.join(dir, `${stem}_${i}${ext}`);
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
  // 「取り込み済み」へ移したが、まだ保存を終えていないファイル(取り込み済みの中の名前)。
  // 先に移してから読むので(書く側が開いたままのファイルは移せず、書きかけを読まない)、移した後・保存の前に止まっても、
  // 起動し直したときにここから取り込み直す。データのフォルダに残す
  const pendingFile = store.dir ? path.join(store.dir, 'import-pending.json') : null;
  // 印は「取り込み済みの中の名前|使い捨ての番号」。番号は、受信データに残す取り込み元(source)を一意にするため
  // (同じ名前のファイルを後でまた取り込んだとき、前の取り込みと取り違えない)
  const pending = new Set();
  let pendingLost = null;
  if (pendingFile) {
    try {
      for (const k of readJsonWithBackup(pendingFile, { empty: () => [], valid: Array.isArray, onRecovered: e => { pendingLost = `1 つ前の印から読んだ(${e.message})`; } })) pending.add(String(k));
    } catch (e) { pendingLost = `印を読めない(${e.code || e.message})`; }
  }
  const token = () => require('node:crypto').randomBytes(6).toString('hex');
  const splitPending = k => { const i = k.lastIndexOf('|'); return i < 0 ? { rel: k, tok: '' } : { rel: k.slice(0, i), tok: k.slice(i + 1) }; };
  const savePending = () => {
    if (!pendingFile) return true;
    try { writeJsonAtomic(pendingFile, [...pending], { valid: Array.isArray }); if (!pending.size) refreshBackup(pendingFile); return true; } catch (e) {
      log.write('warn', { event: 'import', detail: `取り込み途中のファイルの印を残せません: ${e.code || e.message}` });
      return false;
    }
  };
  // 更新時刻が未来のファイルの、前の回の大きさと時刻(ファイル名 → 印)
  const future = new Map();
  // 次の回にもう一度試すファイル。記録は同じファイル・同じ理由なら RETRY_LOG_MS に 1 度だけ書く
  const retries = new Map();   // ファイル名 → { reason, at }
  const retryLater = (n, reason) => {
    const r = retries.get(n), now = Date.now();
    if (r && r.reason === reason && now >= r.at && now - r.at < RETRY_LOG_MS) return;
    if (retries.size >= 1000) retries.clear();
    retries.set(n, { reason, at: now });
    log.write('warn', { event: 'import-retry', detail: `${n}: ${reason}。次の回にもう一度試す` });
  };
  // 移せなければ(ほかのソフトが開いているなど)、次の回にもう一度試す。移した先の名前を返す
  const tryMove = (file, sub, n) => {
    try {
      const to = path.join(dir, sub);
      fs.mkdirSync(to, { recursive: true });
      assertInside(dir, to);
      const moved = freeName(to, path.basename(file));
      fs.renameSync(file, moved);
      // 保存期間は移した時から数える(元のファイルの書き込みの時刻は古いことがある)
      try { const now = new Date(); fs.utimesSync(moved, now, now); } catch { /* 時刻を変えられなくても移すことはできた */ }
      return path.basename(moved);
    } catch (e) {
      retryLater(n, `${sub} へ移せません(${e.code || e.message})`);
      return null;
    }
  };
  // 取り込めないファイルを「取り込み済み」から「取り込めなかった」へ移す(移せなくても、取り込み済みの中に残るだけ)
  const reject = (rel, n, why) => {
    tryMove(path.join(dir, DONE_DIR, rel), FAILED_DIR, n);
    log.write('warn', { event: 'import-failed', detail: `${n}: ${why}` });
  };

  /**
   * 「取り込み済み」へ移したファイルを読み、保存する。終わった(取り込んだ・取り込めなかった・無くなった)なら true、
   * vca-hub の側の失敗で次の回にもう一度試すなら false
   */
  function importMoved(key) {
    const { rel, tok } = splitPending(key);
    const source = `${DONE_DIR}/${rel}${tok ? '#' + tok : ''}`;
    if (store.hasSource(source)) return true;   // 保存を終えた後、印を消す前に止まった
    const file = path.join(dir, DONE_DIR, rel);
    let st;
    try { st = fs.lstatSync(file); } catch { return true; }   // 人が動かした・保存期間で消えた
    if (!st.isFile()) return true;
    let body;
    try { body = fs.readFileSync(file).toString('latin1'); } catch (e) { retryLater(rel, `読めません(${e.code || e.message})`); return false; }
    // 違うラベルが多すぎる本文は読まない(読むと長く止まる)
    if (tooManyLabels(body)) { reject(rel, rel, '違うラベルが多すぎます'); return true; }
    const parsed = VCA.parse(body);
    if (!parsed.records.length && !parsed.traces.length) { reject(rel, rel, 'VCA のレコードがありません'); return true; }
    let entry;
    try { entry = store.saveReceived({ body, type: 'FIL', job: VCA.value(parsed, 'JOB'), peer: `フォルダ:${rel}`, crcOk: null, source }); } catch (e) {
      // vca-hub の側の失敗(索引を書けない・ディスク不足など)。ファイルの誤りではないので、次の回にもう一度試す
      retryLater(rel, `保存できません(${e.code || e.message})`);
      return false;
    }
    retries.delete(rel);
    log.write('info', { event: 'imported', job: entry.job, detail: `${rel} ${entry.id}` });
    return true;
  }

  function recoverCandidates() {
    const d = path.join(dir, DONE_DIR);
    let names = [];
    try { assertInside(dir, d); names = fs.readdirSync(d); } catch { return []; }
    const sources = store.list().filter(e => typeof e.source === 'string' && e.source.startsWith(DONE_DIR + '/'));
    const known = new Set(sources.map(e => e.source.slice(DONE_DIR.length + 1).replace(/#[^#]*$/, '')));
    // 取り込み済みのうち取り込み元として記録の無いものを、移した時刻が 1 日以内なら取り込み直す
    // (最後の受信の時刻では絞らない。時計がずれていると、移しただけのファイルを候補から漏らすため)
    // 1 つ前の印(.bak)を書いた時より後に移したものだけを候補にする(それより前に移したものは、印に載り、取り込み終えている。
    // 人が消した取り込みを生き返らせないため)。.bak も無ければ 1 日以内
    let since = Date.now() - 86400000;
    try { since = Math.max(since, fs.statSync(pendingFile + '.bak').mtimeMs - 5000); } catch { /* 無ければ 1 日以内 */ }
    const out = [];
    for (const n of names) {
      if (known.has(n) || path.extname(n).toLowerCase() !== '.vca') continue;
      try { const st = fs.lstatSync(path.join(d, n)); if (st.isFile() && st.mtimeMs >= since) out.push(n); } catch { /* 無ければよい */ }
    }
    return out;
  }

  function scan() {
    if (stopped) return;
    if (!isNetworkPath(dir)) { scanNow(); return; }
    // ネットワークの共有フォルダは、先に届くかを確かめる。届かなければこの回は読まない(vca-hub を止めないため)
    reachable(dir).then(ok => {
      if (stopped) return;
      if (ok) { scanNow(); return; }
      retryLater('(取り込むフォルダ)', '共有フォルダに届きません(共有フォルダの PC が止まっているなど)');
      clearTimeout(timer);
      timer = setTimeout(scan, intervalMs);
    });
  }

  function scanNow() {
    if (stopped) return;
    if (isNetworkPath(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 下の読み取りで記録する */ } }
    // 移したが保存を終えていないもの(前の回の失敗、または起動し直す前に止まったもの)
    let changed = false;
    for (const rel of [...pending]) if (importMoved(rel)) { pending.delete(rel); changed = true; }
    if (changed) savePending();
    let names = [];
    // フォルダが読めない(共有フォルダの PC が止まっているなど)。記録は同じ理由なら 10 分に 1 度
    try { names = fs.readdirSync(dir); } catch (e) { retryLater('(取り込むフォルダ)', `フォルダを読めません(${e.code || e.message})`); }
    let taken = 0, more = false;
    for (const n of names) {
      if (taken >= MAX_PER_SCAN) { more = true; break; }
      const file = path.join(dir, n);
      let st;
      // リンクは辿らない(取り込むフォルダの外のファイルを読み込まない。st.isFile() はリンクなら偽)
      try { st = fs.lstatSync(file); } catch { continue; }
      // 書きかけを避けるため、最後の書き込みから settleMs たっていないものは次の回にする。
      // settleMs が 0 なら待たない(Date.now() はミリ秒の端数を切り捨てるので、書いた直後は差がわずかに負になることがある)
      if (!st.isFile() || path.extname(n).toLowerCase() !== '.vca') continue;
      if (settleMs > 0 && Date.now() - st.mtimeMs < settleMs) {
        // 更新時刻が未来(書いた PC の時計が進んでいる・この PC の時計が戻った): 時刻では書き終えたかを見られないので、
        // 前の回から大きさと時刻が変わっていなければ書き終えたとみなす。初めて見たときは記録に残す
        if (st.mtimeMs - Date.now() <= settleMs) continue;
        const seen = future.get(n), mark = `${st.size}|${st.mtimeMs}`;
        if (!seen) { future.set(n, mark); retryLater(n, '更新時刻が未来です(PC の時計のずれ)。大きさが変わらなければ次の回に取り込む'); continue; }
        if (seen !== mark) { future.set(n, mark); continue; }
        future.delete(n);
      }
      // 大きすぎるものは読まない(読むと vca-hub が長く止まり、メモリを使い切る。TCP のパケットの上限と同じ)
      if (st.size > MAX_IMPORT_BYTES) {
        // 記録は移せたときに 1 度だけ書く(移せなければ、tryMove が間隔をあけて記録し、次の回にやり直す)
        if (tryMove(file, FAILED_DIR, n)) log.write('warn', { event: 'import-failed', detail: `${n}: ${st.size} バイトで、上限 ${MAX_IMPORT_BYTES} バイトを超えます` });
        continue;
      }
      // 先に「取り込み済み」へ移してから読む。書く側が開いたままなら移せないので、書きかけのものを読まない。
      // 移した後は、元のフォルダに残らないので、2 度取り込まない。移す前に印を残す(移した後・保存の前に止まっても、取り込み直す。
      // 移す前に止まったら、印のファイルが無いので印を捨て、元のフォルダから取り込む)
      let to;
      try {
        const d = path.join(dir, DONE_DIR);
        fs.mkdirSync(d, { recursive: true });
        assertInside(dir, d);
        to = freeName(d, n);
      } catch (e) { retryLater(n, `${DONE_DIR} へ移せません(${e.code || e.message})`); continue; }
      const rel = path.basename(to);
      const key = `${rel}|${token()}`;
      pending.add(key);
      if (!savePending()) { pending.delete(key); continue; }
      try { fs.renameSync(file, to); } catch (e) {
        pending.delete(key); savePending();
        retryLater(n, `${DONE_DIR} へ移せません(${e.code || e.message})`);
        continue;
      }
      // 保存期間は移した時から数える(元のファイルの書き込みの時刻は古いことがある)
      try { const now = new Date(); fs.utimesSync(to, now, now); } catch { /* 時刻を変えられなくても移すことはできた */ }
      taken++;
      if (importMoved(key)) { pending.delete(key); savePending(); }
    }
    clearTimeout(timer);   // 手で呼んだときも、予約は 1 つだけにする
    // 残りがあれば、少し間をあけて続ける(その間に加工機とのセッションが進む)
    timer = setTimeout(scan, more ? MORE_DELAY_MS : intervalMs);
  }
  // 取り込むフォルダを作れなくても(共有フォルダの PC が止まっているなど)、vca-hub は止めない。
  // 加工機の中継は続け、取り込みは読めるようになるまで回ごとにやり直す
  // ネットワークの共有フォルダは、届くかを確かめてから作る(scanNow)
  if (!isNetworkPath(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { log.write('error', { event: 'import', detail: `取り込むフォルダを作れません(${e.code || e.message})。読めるようになるまでやり直す` }); } }
  if (pendingLost) {
    // 印が抜けると、移した後・保存の前に止まったファイルが取り込まれないまま残る。
    // 取り込み済みのうち、1 つ前の印より後に移したもの(1 つ前の印が無ければ 1 日以内)で、取り込み元の記録の無いものを、取り込み直す候補にする
    const again = recoverCandidates();
    for (const rel of again) pending.add(`${rel}|${token()}`);
    if (again.length) savePending();
    log.write('error', { event: 'import', detail: `取り込み途中のファイルの印が抜けている(${pendingLost})。取り込み済みのうち ${again.length} 件を取り込み直す。ほかに取り込まれていないファイルが無いかを確かめてください` });
  }
  scan();
  return { scan, stop() { stopped = true; clearTimeout(timer); } };
}

/**
 * 書き出し先に残った、書き出しの途中で止まったときの一時ファイル(.<名前>.<プロセスの番号>.tmp)を消す。
 * 中身は個人情報を含む書き出す前のデータなので、残さない。消すのは、この形の名前で、動いているプロセスのものでなく、
 * minAgeMs より前に書かれたものだけ(ほかの vca-hub が書いている途中のものを消さない)。消したファイル名を返す
 */
function cleanExportTemps(dir, { now = Date.now(), minAgeMs = 600000 } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  const alive = pid => {
    if (pid === process.pid) return true;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  };
  for (const n of names) {
    const m = n.match(/^\..+\.(\d+)\.tmp$/);
    if (!m || alive(Number(m[1]))) continue;
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && now - st.mtimeMs >= minAgeMs) { fs.unlinkSync(p); out.push(n); }
    } catch { /* 次の回にもう一度試す */ }
  }
  return out;
}

/**
 * 書き出し先と取り込むフォルダが同じか、片方がもう片方の中にあれば、理由を返す(書き出したものを取り込み直すため)。
 * Windows では大文字・小文字を区別しない
 */
function folderOverlap(exportDir, importDir) {
  if (!exportDir || !importDir) return null;
  const norm = p => {
    const r0 = path.resolve(p), r = r0.endsWith(path.sep) ? r0 : r0 + path.sep;
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const a = norm(exportDir), b = norm(importDir);
  if (a === b) return '書き出し先(exportDir)と取り込むフォルダ(importDir)が同じです';
  if (a.startsWith(b) || b.startsWith(a)) return '書き出し先(exportDir)と取り込むフォルダ(importDir)の片方が、もう片方の中にあります';
  return null;
}

/**
 * 取り込み済み・取り込めなかったのフォルダに移したファイルのうち、保存期間(日)を過ぎたものを消す。
 * 元のファイルは個人情報の項目を除く前のものなので、受信データと同じ期間で消す(設計書 7 章)。消したファイルのパスを返す。
 */
function purgeImported(dir, days, now = new Date()) {
  if (!(days > 0)) return [];
  const limit = now.getTime() - days * 86400000;
  const out = [];
  for (const sub of [DONE_DIR, FAILED_DIR]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    assertInside(dir, d);
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      const file = path.join(d, n);
      try {
        // リンクは辿らない(リンク先のファイルを消さない)
        const st = fs.lstatSync(file);
        if (st.isFile() && st.mtimeMs < limit) { fs.unlinkSync(file); out.push(path.join(sub, n)); }
      } catch { /* 次の回にもう一度試す */ }
    }
  }
  return out;
}

/**
 * sub が、本当に dir の中のフォルダか(リンク・ジャンクションで外を指していないか)を確かめる。
 * 「取り込み済み」などをリンクにされると、取り込むフォルダの外へ移したり、外のファイルを消したりするため。外を指していれば例外
 */
function assertInside(dir, sub) {
  const st = fs.lstatSync(sub);
  const real = fs.realpathSync.native(sub), base = fs.realpathSync.native(dir);
  const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  // ドライブの直下(F:\)は realpath が区切りで終わるので、区切りを重ねない
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (st.isSymbolicLink() || !st.isDirectory() || !norm(real).startsWith(norm(prefix))) {
    throw Object.assign(new Error(`${sub} が取り込むフォルダの中のフォルダではありません(リンク・ジャンクションは使わない)`), { code: 'unsafe-folder' });
  }
}

module.exports = { fileText, fileRecords, exportTarget, exportFile, watchFolder, purgeImported, cleanExportTemps, folderOverlap, reachable, isNetworkPath, DONE_DIR, FAILED_DIR };
