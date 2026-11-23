'use strict';
// 受信データの保存と索引(設計書 6 章・7 章)。
// 受信した本文はそのまま保存する。個人情報項目の除去が有効なら、その行だけ除いて保存する。

const fs = require('node:fs');
const path = require('node:path');
const VCA = require('../lib/vca-parser.js');
const { writeJsonAtomic, readJsonWithBackup, refreshBackup, writeSynced } = require('../lib/atomic.js');
const { checkBody } = require('../send/check.js');
const { tooManyLabels, MAX_DISTINCT_LABELS } = require('../send/build.js');

// 装用者に関する項目(設計書 7 章)。加工には使わない。
const PII_LABELS = new Set([
  'CLIENT', 'CLIENTF', 'CLINIT', 'CLAGE', 'CLHT', 'CLLIFE', 'CLLNAM', 'CLNVB', 'CLDEYE', 'CLHLAT', 'CLFRNT', 'ACCN',
]);

// 行の頭のラベル。個人情報項目の除去では、読み取り(vca-parser.js)がその項目として読む行を全て除けるよう、
// ラベルの前後の空白・制御文字・8 ビットの文字を全て読み飛ばす(読み取りが読まない頭の文字が付いた行も除く)
// PROCBLK のブロックの中の行(1!CLIENT= など。5.17.2)も、番号を読み飛ばして同じく除く
const LINE_LABEL = /^[\s\x00-\x20\x7f-\xff]*\*?(?:\d+!)?\*?([A-Za-z_][A-Za-z0-9_]*)[\s\x00-\x20\x7f-\xff]*=/;

/** ファイル名に使えない文字と、フォルダをさかのぼる指定を取り除く。 */
function safeName(s) {
  const t = String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\.{2,}/g, '').trim().slice(0, 40);
  // 装置の名前(NUL. など)で始まるファイルは、ほかのソフトで開けず、手で消しにくいので、前に _ を付ける
  return (isWindowsDevice(t) ? '_' + t : t) || 'nojob';
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

// JOB の型 limited の上限(5.1.8。vca-guide の docs/conformance.md)
const JOB_MAX = 12;
// 保存期間をこの日数より多く過ぎた受信データは、自動では消さない(purge を参照)
const HOLD_AFTER_DAYS = 30;
// Windows の装置の名前。拡張子を付けても装置を指す
const WINDOWS_DEVICE_STEM = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)$/i;
/** Windows が装置として扱う名前か。最初の . より前を、末尾の空白と . を除いて比べる(Windows 10 は "CON .A" も CON とみなす) */
const isWindowsDevice = n => WINDOWS_DEVICE_STEM.test(String(n).split('.')[0].replace(/[ .]+$/, ''));

const sendingError = () => Object.assign(new Error('加工機へ渡している途中です。渡し終えてから操作してください'), { code: 'sending' });

// 索引の形(id と本文のファイルの場所がある記録の並び)。読むときと、1 つ前の索引に写すときに確かめる
let validIndex = () => true;

// 送信済みを書けなかったものを押さえる印(どの接続のものでもない)
const SENT_HOLDER = Object.freeze({ peer: '送信済みを書けなかったもの' });

class Store {
  /** @param {{dir: string, removePII?: boolean}} opts */
  constructor({ dir, removePII = true }) {
    this.dir = dir;
    this.removePII = removePII;
    this.indexFile = path.join(dir, 'index.json');
    fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    // 索引が壊れていたら(電源断などで書きかけになった)、1 つ前の索引(.bak)から読む。どちらも読めなければ起動しない
    this.recovered = null;
    // 要素の形も確かめる(id と本文のファイルの場所が無い記録があると、受け取るたびに失敗するため。形が違えば .bak から読む)
    validIndex = v => Array.isArray(v) && v.every(e => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.file === 'string');
    this.index = readJsonWithBackup(this.indexFile, { empty: () => [], valid: validIndex, onRecovered: e => { this.recovered = e.message; } });
    // 古い版の記録で欠けている欄を補う(送った記録の一覧が無いと、送信済みにするときに失敗するため)
    for (const e of this.index) if (!Array.isArray(e.sent)) e.sent = [];
    // 拡張(設計書 13 章)へ知らせる関数。app.js が入れる
    //   saved(entry, body): 受信データを保存した / removed(id): 消した / check(entry, readBody): 拡張の検査 / queued(entry): 送信待ちにした
    //   deleteFailed(file, err): 消せないファイルがあった(ほかのソフトが開いているなど。あとで消し直す)
    //   busy(id): 送り先へ送っている途中か(途中のものは消さない)
    this.hooks = { saved: null, removed: null, check: null, queued: null, deleteFailed: null, busy: null };
    // 索引から外したが、まだ消せていないファイル(消し直す)。起動し直しても消し直せるよう、データのフォルダに残す
    this.pendingFile = path.join(dir, 'pending-delete.json');
    this.pendingDelete = new Set();
    try { for (const p of JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'))) if (this._inside(String(p))) this.pendingDelete.add(String(p)); } catch { /* 無ければよい */ }
    // 加工機へ送っている途中の送信待ちのデータ(id → 送っている接続)。送り終えるまで、ほかの接続に渡さない。
    // 索引には残さない(送っている途中で止まったら、起動し直したときは送信待ちに戻る)
    this.sending = new Map();
    // ACK を受けたのに送信済みを書けなかったもの(id → 送った相手)。retrySent で書き直す
    this.unrecordedSent = new Map();
    // 加工機に渡せなかった最後の理由(id → { at, peer, device, message })。画面に出すため。索引には残さない
    this.refusals = new Map();
    // 前に止まったときの書きかけの一時ファイル(索引を書く途中で止まった)。中身は使わない
    try { fs.unlinkSync(this.indexFile + '.tmp'); } catch { /* 無ければよい */ }
    // 1 つ前の索引から読んだときは、最後の変更が抜けているので、ファイルと突き合わせて直す
    this.recoveryReport = this.recovered ? this._reconcile() : null;
    // 索引の変更の通し番号(管理画面の一覧が変わったかを、索引を JSON にせずに見分けるため)
    this.version = 0;
  }

  /**
   * 1 つ前の索引から読んだあとに、索引と受信データのファイルを突き合わせる(設計書 6 章)。
   * - 本文のファイルが無い記録は、索引から外す(抜けた変更が削除だった)
   * - 索引に無い受信データは、受け取ったときに一緒に書いた情報のファイル(.json)から登録し直す(抜けた変更が受信だった。
   *   機器にはもう STATUS=0 を返したかもしれないので、黙って消さない)。状態は受け取ったときのもの(名前なし)に戻す
   * - 送信待ちのものは、送信待ちから外す(抜けた変更が送信済みだったかもしれず、2 度渡さないため。人が確かめ直して戻す)
   * @returns {{dropped: string[], readded: string[], unqueued: string[]}} それぞれ id の一覧
   */
  _reconcile() {
    const report = { dropped: [], readded: [], unqueued: [] };
    const exists = rel => fs.existsSync(path.join(this.dir, rel));
    const kept = [];
    for (const e of this.index) {
      if (!e || typeof e.file !== 'string' || !exists(e.file) || this._pendingFor(e.file)) { report.dropped.push(e && e.id); continue; }
      if (e.status === 'queued') { e.status = 'received'; e.queuedAt = null; e.unqueuedAt = new Date().toISOString(); e.unqueuedByRecovery = true; report.unqueued.push(e.id); }
      kept.push(e);
    }
    const ids = new Set(kept.map(e => e.id)), files = new Set(kept.map(e => e.file));
    const inbox = path.join(this.dir, 'inbox');
    let days = [];
    try { days = fs.readdirSync(inbox); } catch { /* 無ければよい */ }
    for (const d of days) {
      let names = [];
      try { names = fs.readdirSync(path.join(inbox, d)); } catch { continue; }
      for (const n of names) {
        if (!/\.json$/i.test(n)) continue;
        const rel = ['inbox', d, n.replace(/\.json$/i, '.vca')].join('/');
        if (files.has(rel) || !exists(rel) || this._pendingFor(rel)) continue;
        let info;
        try { info = JSON.parse(fs.readFileSync(path.join(inbox, d, n), 'utf8')); } catch { continue; }
        if (!info || typeof info.id !== 'string' || info.file !== rel || ids.has(info.id)) continue;
        kept.push({ ...info, name: null, status: 'received', queuedAt: null, sent: [], recovered: true });
        ids.add(info.id); files.add(rel);
        report.readded.push(info.id);
      }
    }
    // 索引に残っていたものは、索引の並び(受け取った順)のまま。登録し直したもの(抜けた最後の受信)は、その後ろに受け取った時刻の順で足す。
    // 全体を時刻で並べ替えると、時計が遅れていた間に受け取った記録が先頭に来て、前のものの時刻から数える守り(purge)が外れるため
    const readded = kept.slice(kept.length - report.readded.length).sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
    this.index = kept.slice(0, kept.length - report.readded.length).concat(readded);
    // 形の違う索引を 1 つ前の索引(.bak)に写さない(正しい .bak を壊れたもので上書きしないため)
    writeJsonAtomic(this.indexFile, this.index, { valid: validIndex });
    return report;
  }

  /**
   * 索引を変更して保存する。保存に失敗したらメモリ上も変更前に戻し、
   * 画面に出る状態とファイルの内容が食い違わないようにする。
   */
  _commit(mutate) {
    // 戻す先は、前に書いた索引の文字列(this.written)。変更ごとに索引を JSON にするのを 1 回にする(索引が大きいときに止まる時間を減らす)
    if (this.written === undefined) this.written = JSON.stringify(this.index);
    let result, text;
    // 変更の途中で例外になったときも戻す(メモリだけが変わり、ファイルと食い違わないように)
    try {
      result = mutate();
      text = JSON.stringify(this.index);
      writeJsonAtomic(this.indexFile, null, { text, valid: validIndex });
    } catch (e) { this.index = JSON.parse(this.written); this.version++; throw e; }
    this.written = text;
    this.version++;
    return result;
  }

  /** 個人情報項目の行を除く。除いたラベルの一覧も返す。 */
  stripPII(body) {
    const removed = new Set();
    // 行と改行の組に分ける(CR LF を 1 つの改行として扱い、除いた行の改行も一緒に除く)
    const parts = String(body).split(/(\r\n|\r|\n)/);
    let out = '';
    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i], eol = parts[i + 1] || '';
      const m = line.match(LINE_LABEL);
      let label = m ? m[1].toUpperCase() : null;
      // PROC は 1 つ目の欄が、機器に渡すときのラベルになる(5.17.1)。PROC=CLIENT;EDG;;;氏名 も除く
      // 1 つ目の欄も、行の頭と同じ読み方(前後の空白・制御文字・*・= より後を除く)でラベルを取り出す
      // (PROC=*CLIENT;… や PROC=CLIENT=x;… も、機器に渡ると CLIENT として読まれるため)
      if (label === 'PROC') {
        const first = String(line.slice(line.indexOf('=') + 1).split(';')[0] || '').trim().replace(/^"(.*)"$/, '$1');
        const fm = (first + '=').match(LINE_LABEL);
        label = fm ? fm[1].toUpperCase() : first.trim().toUpperCase();
      }
      if (label && PII_LABELS.has(label)) { removed.add(label); continue; }
      out += line + eol;
    }
    return { body: out, removed: [...removed] };
  }

  /**
   * 受信した本文を保存する。
   * @param {{body: string, type: string, job?: string, peer: string, crcOk: boolean|null, source?: string}} rec source は取り込んだ元のファイル
   */
  saveReceived({ body, type, job, peer, crcOk, source }) {
    const now = new Date();
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    // 違うラベルが多すぎる本文は読まずに断る(読むと vca-hub が長く止まる。TCP の機器には STATUS=8 が返る)
    if (tooManyLabels(body)) throw Object.assign(new Error(`違うラベルが ${MAX_DISTINCT_LABELS} を超えます`), { code: 'too-many-labels' });
    let removed = [];
    // ファイルには latin1(1 文字 1 バイト)で書くので、先に同じ形にそろえる(U+0100 以上の文字は下位の 1 バイトになり、
    // 除いた後で改行や別のラベルができないように。TCP・取り込みの本文はもともと latin1)
    body = Buffer.from(String(body), 'latin1').toString('latin1');
    if (this.removePII) ({ body, removed } = this.stripPII(body));
    const dayDir = path.join(this.dir, 'inbox', day);
    fs.mkdirSync(dayDir, { recursive: true });
    // 受信元の「IP:ポート」は、: がファイル名に使えないため - に置き換える(127.0.0.1-54435)
    const from = safeName(String(peer ?? '').replace(/:/g, '-'));
    let base = `${safeName(job)}_${hms}_${from}`, i = 1;
    while (fs.existsSync(path.join(dayDir, base + '.vca'))) base = `${safeName(job)}_${hms}_${from}_${++i}`;
    const rel = path.join('inbox', day, base + '.vca');
    // 機器には保存できてから STATUS=0 を返すので、本文と情報はディスクへ書き切ってから索引に載せる(電源断で中身だけが失われないように)
    writeSynced(path.join(this.dir, rel), Buffer.from(body, 'latin1'));

    const parsed = VCA.parse(body);
    const eyes = parsed.traces.map(t => t.eye);
    const tr = parsed.traces[0];
    const box = tr && tr.radii.length >= 3 && tr.radii.every(Number.isFinite) ? VCA.boxOf(VCA.tracePoints(tr)) : null;
    const entry = {
      id: `${day.replace(/-/g, '')}-${hms}-${Math.random().toString(36).slice(2, 7)}`,
      // ジョブ番号は値の長さの上限(255 文字。附属書 D)までにする(送り手が長い値を送っても、索引が膨らまないように)
      job: String(job ?? '').slice(0, 255), type, peer, receivedAt: now.toISOString(), file: rel.replace(/\\/g, '/'),
      crcOk, eyes, traceFormat: tr ? tr.fmt : null, hbox: box ? +box.hbox.toFixed(2) : null,
      vbox: box ? +box.vbox.toFixed(2) : null, piiRemoved: removed, check: checkBody(body, parsed),
      name: null, status: 'received', queuedAt: null, sent: [],
    };
    // 取り込んだ元のファイル(取り込みのフォルダの中の場所)。起動し直したときに、同じファイルを 2 度取り込まないため
    if (source) entry.source = String(source);
    const infoFile = path.join(this.dir, rel.replace(/\.vca$/, '.json'));
    writeSynced(infoFile, JSON.stringify(entry, null, 1));
    try {
      this._commit(() => this.index.push(entry));
    } catch (e) {
      // 索引に載らないファイルを残さない。相手には STATUS=0 を返さないので、機器側で再送される
      for (const f of [path.join(this.dir, rel), infoFile]) try { fs.unlinkSync(f); } catch { /* 無視 */ }
      throw e;
    }
    if (this.hooks.saved) this.hooks.saved(this.get(entry.id), body);
    return this.get(entry.id);
  }

  list() { return this.index.slice().reverse(); }
  get(id) { return this.index.find(e => e.id === id) || null; }
  readBody(entry) { return fs.readFileSync(path.join(this.dir, entry.file)).toString('latin1'); }

  /** 送り出せない理由(玉型の点数の不一致など)があれば code='blocked' の例外を投げる。索引の記録ではなく、保存した本文で毎回確かめる */
  assertSendable(entry) {
    const { blockers } = this.checkOf(entry);
    if (blockers.length) throw Object.assign(new Error('送り出せません'), { code: 'blocked', blockers });
  }

  /** 送り出す前の検査: 保存した本文の検査に、拡張の検査を足したもの */
  checkOf(entry, body = this.readBody(entry)) {
    const own = checkBody(body);
    if (!this.hooks.check) return own;
    const ext = this.hooks.check(entry, () => body);
    return { blockers: own.blockers.concat(ext.blockers), notices: own.notices.concat(ext.notices) };
  }

  /**
   * 人が付けた名前を確かめる(設計書 6 章)。送信先へのジョブ番号(JOB)と、書き出しのファイル名になるので、次のものは断る(code='bad-name')。
   * - 空、ファイル名に使えない文字、フォルダをさかのぼる指定
   * - JOB の型 limited に合わないもの: 12 文字を超える、文字の範囲(32-127)の外(5.1.8。vca-hub は文字コードを ASCII で取り決める)
   * - 値の区切りの ;(JOB の値が ; の前で切れる)
   * - Windows の装置の名前(CON・NUL・COM1 など。書き出した CON.vca を、ほかのソフトがファイルとして開けない)
   */
  static checkName(name) {
    const n = String(name ?? '').trim();
    if (!n || n !== safeName(n) || n.length > JOB_MAX || !/^[\x20-\x7f]+$/.test(n) || n.includes(';') || isWindowsDevice(n)) {
      throw Object.assign(new Error('使えない名前です'), { code: 'bad-name' });
    }
    return n;
  }

  /** 名前を付ける(どこへも渡さずに付けるだけ。送信待ちにするのは queue)。 */
  setName(id, name) {
    const e = this.get(id);
    if (!e) return null;
    const n = Store.checkName(name);
    if (e.name === n) return e;
    // 送信待ちのものの名前は変えない(加工機は名前で求める。変えると、同じ名前が 2 つ送信待ちになったり、求めた名前で見つからなくなる。設計書 6 章)
    if (e.status === 'queued') {
      throw Object.assign(new Error(`送信待ちのデータの名前(${e.name})は変えられません。名前を変えるときは、送信待ちから外してください`), { code: 'queued-rename' });
    }
    this._commit(() => { this.get(id).name = n; });
    return this.get(id);
  }

  /**
   * 名前を付けて、加工機向けの送信待ちにする(設計書 6 章)。
   * 送信待ちの別のデータに同じ名前があれば、replace が無ければ code='name-taken' の例外を投げ、
   * replace なら前のものを送信待ちから外す(加工機は名前で求めるので、同じ名前を 2 つ送信待ちにしない)。
   */
  queue(id, name, { replace = false } = {}) {
    const entry = this.get(id);
    if (!entry) return null;
    const n = Store.checkName(name);
    this.assertSendable(entry);
    const others = this.index.filter(o => o.status === 'queued' && o.name === n && o.id !== id);
    if (others.length && !replace) throw Object.assign(new Error('同じ名前のデータが送信待ちです'), { code: 'name-taken', others: others.map(o => o.id) });
    // 加工機へ渡している途中(ACK を待っている)のものは、名前を変えることも、ほかのデータで置き換えることもしない
    // (同じ名前で中身の違うものが 2 台に渡ったり、渡したものと違う名前が送信済みになるため)
    if (this.sending.has(id) && entry.name !== n) throw sendingError();
    // 送信待ちのものの名前は、送信待ちにし直すことでも変えない(setName と同じ。先に送信待ちから外す)
    if (entry.status === 'queued' && entry.name !== n) {
      throw Object.assign(new Error(`送信待ちのデータの名前(${entry.name})は変えられません。名前を変えるときは、送信待ちから外してください`), { code: 'queued-rename' });
    }
    if (others.some(o => this.sending.has(o.id))) throw sendingError();
    this._commit(() => {
      for (const o of others) { o.status = 'received'; o.unqueuedAt = new Date().toISOString(); }
      const e = this.get(id);
      e.name = n;
      e.status = 'queued';
      e.queuedAt = new Date().toISOString();
      // 人が確かめ直して送信待ちにしたので、索引を戻したときの印は外す
      delete e.recovered;
      delete e.unqueuedByRecovery;
      delete e.unqueuedByCheck;
      this.refusals.delete(id);
    });
    if (this.hooks.queued) this.hooks.queued(this.get(id));
    return this.get(id);
  }

  /**
   * 送信待ちから外す。加工機へ渡している途中のものは外さない(渡したものが送信済みになり、取り消したのに渡ったことになるため)。
   * evenIfSending は、渡す直前の検査で送り出せない理由が見つかったとき(渡さないことが決まっている)に使う
   */
  unqueue(id, { evenIfSending = false, blocked = false } = {}) {
    const e = this.get(id);
    if (e && e.status === 'queued' && this.sending.has(id) && !evenIfSending) throw sendingError();
    // 外した時を残す(保存期間は、外した時から数え直す。人が確かめ直す前に消さないため)。
    // 渡す直前の検査で vca-hub が外したときは、その印も残す(画面で分かるように)
    if (e && e.status === 'queued') {
      this._commit(() => {
        const x = this.get(id);
        x.status = 'received'; x.unqueuedAt = new Date().toISOString();
        if (blocked) x.unqueuedByCheck = true;
      });
    }
    return this.get(id);
  }

  /** 元のファイル(取り込み)から登録したものがあるか */
  hasSource(source) { return this.index.some(e => e.source === source); }

  /** 送信待ちの中から、加工機が求めたジョブ番号と同じ名前のものを探す(名前の無いものは渡さない)。 */
  _queuedByName(job) {
    const want = String(job ?? '').trim();
    return this.index.find(e => e.status === 'queued' && e.name && e.name === want) || null;
  }

  /** 送信待ちの中から、加工機が求めたジョブ番号と同じ名前のものを探す。ほかの接続へ送っている途中のものは返さない。 */
  findQueued(job) {
    const e = this._queuedByName(job);
    return e && !this.sending.has(e.id) ? e : null;
  }

  /**
   * 送信待ちのデータを探し、送る接続のために押さえる(探すことと押さえることを 1 度に行い、2 つの接続に同じデータを渡さない)。
   * 押さえたものは、送信済みにする(markSent)か、release・releaseAll で放すまで、ほかの接続には渡さない。
   * @param {string} job 加工機が求めたジョブ番号
   * @param {object} holder 送る接続を表すもの(放すときに同じものを渡す)
   * @returns {{entry: object}|{busy: true}|null} 無ければ null。ほかの接続へ送っている途中なら busy
   */
  reserve(job, holder) {
    const e = this._queuedByName(job);
    if (!e) return null;
    const by = this.sending.get(e.id);
    if (by !== undefined && by !== holder) return { busy: true };
    if (by === undefined) this.version++;
    this.sending.set(e.id, holder);
    return { entry: e };
  }

  /** 押さえたデータを放す(送り終えられなかったとき)。押さえたのと違う接続からは放さない。放したら true */
  release(id, holder) {
    if (this.sending.get(id) !== holder) return false;
    this.sending.delete(id);
    this.version++;
    return true;
  }

  /** 接続が押さえているデータを全て放す(接続が切れたとき)。放した id の一覧を返す。 */
  releaseAll(holder) {
    // 送信済みを書けなかったもの(holdSent)は、接続が切れても放さない
    const ids = [...this.sending].filter(([id, h]) => h === holder && !this.unrecordedSent.has(id)).map(([id]) => id);
    for (const id of ids) this.sending.delete(id);
    if (ids.length) this.version++;
    return ids;
  }

  /**
   * 保存期間を過ぎたデータを消す(設計書 7 章)。送信待ちのものは、加工機がまだ取りに来ていないので消さない。
   * 送信待ちから外したもの(人が外した、渡す直前の検査や索引を戻したときに vca-hub が外した)は、外した時から数える
   * (外した直後に消すと、人が確かめ直して送信待ちに戻す前に無くなるため)
   * @returns {object[]} 消した索引の記録
   */
  purge(days, now = new Date()) {
    this.purgeHeld = 0;
    if (!(days > 0)) return [];
    const limit = now.getTime() - days * 86400000;
    // 受け取った時が読めないものは、いつのものか分からないので消さない
    // 索引は受け取った順に並ぶ。前に受け取ったものより古い時刻のもの(時計が遅れていた間に受け取った)は、前のものの時刻から数える
    // (時計を直した直後に、遅れた時刻の付いたデータを、まだ人が見ていないうちに消さないため)
    // 「今」より先の時刻のもの(時計が進んでいた間に受け取った)は、その前に受け取ったものの時刻から数え、後のものの基準にもしない
    // (未来の時刻の記録が 1 件あるために、それ自身も後に受け取ったものも、いつまでも消えなくならないように)。前に何も無ければ記録の時刻のまま
    const nowMs = now.getTime();
    let latest = -Infinity;
    const effective = new Map();
    for (const e of this.index) {
      const r = Date.parse(e.receivedAt);
      if (Number.isNaN(r)) { effective.set(e, Infinity); continue; }
      const u = Date.parse(e.unqueuedAt) || 0;
      if (r > nowMs) { effective.set(e, Math.max(latest > -Infinity ? latest : r, Math.min(u, nowMs))); continue; }
      latest = Math.max(latest, r);
      effective.set(e, Math.max(latest, Math.min(u, nowMs)));
    }
    // 保存期間を大きく(30 日より多く)過ぎたものは、消さずに残して知らせる(this.purgeHeld)。
    // 1 時間ごとに消しに行くので、ふつうは期間を過ぎた直後に消える。大きく過ぎたものは、時計が遅れていた間に受け取った
    // (前に受け取ったものが無く、守りが効かない)か、長く止めていたかで、どちらか見分けられない。STATUS=0 を返したものを黙って消さないため
    const held = nowMs - (days + HOLD_AFTER_DAYS) * 86400000;
    const old = [];
    for (const e of this.index) {
      if (e.status === 'queued' || !(effective.get(e) < limit)) continue;
      if (effective.get(e) < held) { this.purgeHeld++; continue; }
      old.push(e);
    }
    // まとめて索引から外す(索引を書くのは 1 回。件数ごとに書き直すと、その間 vca-hub が止まる)。
    // 索引を書けなければ例外(何も消さない。次の回にもう一度試す)
    return this.removeMany(old.map(e => e.id));
  }

  /** 本文か情報のファイルが、消し直しを待っているか(消したものを、索引を戻したときに登録し直さないため) */
  _pendingFor(rel) {
    const abs = path.resolve(this.dir, rel);
    return this.pendingDelete.has(abs) || this.pendingDelete.has(abs.replace(/\.vca$/, '.json'));
  }

  /** p がデータのフォルダの中か(消し直しの一覧で、フォルダの外のファイルを消さないため) */
  _inside(p) {
    const rel = path.relative(this.dir, path.resolve(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /** 索引から外したのに消せなかったファイルを、もう一度消す。消せたファイルを返す */
  retryDeletes() {
    const done = [];
    for (const p of [...this.pendingDelete]) if (this._unlink(p)) { this.pendingDelete.delete(p); done.push(p); }
    if (done.length) this._savePending();
    return done;
  }

  /** 消し直しの一覧を残す(残せなくても、保存期間で索引に無いファイルとして消す) */
  _savePending() {
    try { fs.writeFileSync(this.pendingFile, JSON.stringify([...this.pendingDelete])); } catch { /* 無視 */ }
  }

  /**
   * 索引に無いまま残った受信データのファイル(異常終了・前の索引から読み直したときなど)のうち、
   * 保存期間(日)を過ぎたものを消す。期間の中のものは、索引から外れた理由が分からないので残す。消したファイルを返す
   */
  sweepOrphans(days, now = new Date()) {
    if (!(days > 0)) return [];
    const limit = now.getTime() - days * 86400000;
    const known = new Set();
    for (const e of this.index) { known.add(e.file); known.add(e.file.replace(/\.vca$/, '.json')); }
    const done = [];
    const inbox = path.join(this.dir, 'inbox');
    let days_ = [];
    try { days_ = fs.readdirSync(inbox); } catch { return done; }
    for (const d of days_) {
      let names = [];
      try { names = fs.readdirSync(path.join(inbox, d)); } catch { continue; }
      for (const n of names) {
        const rel = ['inbox', d, n].join('/');
        if (known.has(rel) || !/\.(vca|json)$/i.test(n)) continue;
        const p = path.join(inbox, d, n);
        try {
          const st = fs.statSync(p);
          if (st.isFile() && st.mtimeMs < limit && this._unlink(p)) done.push(rel);
        } catch { /* 次の回にもう一度試す */ }
      }
    }
    return done;
  }

  /** ファイルを消す。無ければ消せたことにする。消せなければ false(記録に残すため hooks.deleteFailed を呼ぶ) */
  _unlink(p) {
    try { fs.unlinkSync(p); return true; } catch (e) {
      if (e.code === 'ENOENT') return true;
      if (this.hooks.deleteFailed) this.hooks.deleteFailed(path.relative(this.dir, p), e);
      return false;
    }
  }

  /** 加工機に渡せなかった理由を覚える(画面の一覧と詳細に出す) */
  noteRefusal(id, r) {
    if (this.refusals.size >= 1000 && !this.refusals.has(id)) this.refusals.delete(this.refusals.keys().next().value);
    this.refusals.set(id, { at: new Date().toISOString(), ...r });
    this.version++;
  }

  /**
   * 加工機が受け取った(ACK を受けた)のに、送信済みを索引に書けなかったもの(ディスク不足など)を覚える。
   * どの接続にも渡さないよう押さえたままにし、retrySent で書き直す(接続が切れても放さない。放すと、同じジョブをもう一度渡すため)
   */
  holdSent(id, to) {
    this.version++;
    this.sending.set(id, SENT_HOLDER);
    this.unrecordedSent.set(id, to);
  }

  /** 送信済みを書けなかったものを、もう一度書く。書けたものの id を返す */
  retrySent() {
    const done = [];
    for (const [id, to] of [...this.unrecordedSent]) {
      if (!this.get(id)) { this.unrecordedSent.delete(id); this.sending.delete(id); continue; }
      try { this.markSent(id, to); this.unrecordedSent.delete(id); done.push(id); } catch { /* 次の回にもう一度 */ }
    }
    return done;
  }

  /** 加工機が受け取った: 送信待ちから送信済みにする。 */
  markSent(id, to) {
    if (!this.get(id)) return;
    this._commit(() => {
      const e = this.get(id);
      e.status = 'sent';
      e.sent.push({ to, at: new Date().toISOString() });
    });
    this.sending.delete(id);
  }

  /** 別の PC への送信・共有フォルダへの書き出しを記録する。加工機向けの送信待ちなら、送信待ちのまま残す。 */
  recordSent(id, to) {
    if (!this.get(id)) return;
    this._commit(() => {
      const e = this.get(id);
      if (e.status !== 'queued') e.status = 'sent';
      e.sent.push({ to, at: new Date().toISOString() });
    });
  }

  /** 人の操作で消す。加工機へ渡している途中のものは消さない(渡したのに、索引にもファイルにも残らなくなるため) */
  remove(id) {
    if (this.sending.has(id)) throw sendingError();
    // 送り先へ送っている途中のものも消さない(届いたのに、送った記録が残らなくなるため)
    if (this.hooks.busy && this.hooks.busy(id)) throw Object.assign(new Error('送り先へ送っている途中です'), { code: 'uploading' });
    return this.removeMany([id]).length === 1;
  }

  /**
   * 受信データを消す。先に索引から外し、保存できたらファイルを消す(索引にあるのにファイルがない状態を作らない)。
   * ほかのソフトが開いていて消せなければ、覚えておいて消し直す(例外にしない。索引からはもう外れている)。
   * @returns {object[]} 消した索引の記録
   */
  removeMany(ids) {
    const want = new Set(ids.filter(id => !(this.hooks.busy && this.hooks.busy(id))));
    const gone = this.index.filter(e => want.has(e.id));
    if (!gone.length) return [];
    this._commit(() => { this.index = this.index.filter(x => !want.has(x.id)); });
    // 1 つ前の索引(.bak)にも、消した記録(ジョブ番号・名前)を残さない
    try { refreshBackup(this.indexFile); } catch (err) { if (this.hooks.deleteFailed) this.hooks.deleteFailed(path.basename(this.indexFile) + '.bak', err); }
    for (const e of gone) {
      this.sending.delete(e.id);
      for (const f of [e.file, e.file.replace(/\.vca$/, '.json')]) {
        const p = path.join(this.dir, f);
        if (!this._unlink(p)) this.pendingDelete.add(p);
      }
      if (this.hooks.removed) this.hooks.removed(e.id);
    }
    if (this.pendingDelete.size) this._savePending();
    return gone;
  }
}

module.exports = { Store, PII_LABELS, safeName };
