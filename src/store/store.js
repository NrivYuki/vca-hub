'use strict';
// 受信データの保存と索引(設計書 6 章・7 章)。
// 受信した本文はそのまま保存する。個人情報項目の除去が有効なら、その行だけ除いて保存する。

const fs = require('node:fs');
const path = require('node:path');
const VCA = require('../lib/vca-parser.js');
const { writeJsonAtomic } = require('../lib/atomic.js');
const { checkBody } = require('../send/check.js');

// 装用者に関する項目(設計書 7 章)。加工には使わない。
const PII_LABELS = new Set([
  'CLIENT', 'CLIENTF', 'CLINIT', 'CLAGE', 'CLHT', 'CLLIFE', 'CLLNAM', 'CLNVB', 'CLDEYE', 'CLHLAT', 'CLFRNT', 'ACCN',
]);

// 行の頭のラベル。個人情報項目の除去では、読み取り(vca-parser.js)がその項目として読む行を全て除けるよう、
// ラベルの前後の空白・制御文字・8 ビットの文字を全て読み飛ばす(読み取りが読まない頭の文字が付いた行も除く)
const LINE_LABEL = /^[\s\x00-\x20\x7f-\xff]*\*?([A-Za-z_][A-Za-z0-9_]*)[\s\x00-\x20\x7f-\xff]*=/;

/** ファイル名に使えない文字と、フォルダをさかのぼる指定を取り除く。 */
function safeName(s) {
  const t = String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\.{2,}/g, '').trim();
  return t.slice(0, 40) || 'nojob';
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

// JOB の型 limited の上限(5.1.8。vca-guide の docs/conformance.md)
const JOB_MAX = 12;
// Windows の装置の名前。拡張子を付けても装置を指す
const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9]|CONIN\$|CONOUT\$|CLOCK\$)(\..*)?$/i;

class Store {
  /** @param {{dir: string, removePII?: boolean}} opts */
  constructor({ dir, removePII = true }) {
    this.dir = dir;
    this.removePII = removePII;
    this.indexFile = path.join(dir, 'index.json');
    fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
    this.index = fs.existsSync(this.indexFile) ? JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) : [];
    // 拡張(設計書 13 章)へ知らせる関数。app.js が入れる
    //   saved(entry, body): 受信データを保存した / removed(id): 消した / check(entry, readBody): 拡張の検査 / queued(entry): 送信待ちにした
    this.hooks = { saved: null, removed: null, check: null, queued: null };
    // 加工機へ送っている途中の送信待ちのデータ(id → 送っている接続)。送り終えるまで、ほかの接続に渡さない。
    // 索引には残さない(送っている途中で止まったら、起動し直したときは送信待ちに戻る)
    this.sending = new Map();
  }

  /**
   * 索引を変更して保存する。保存に失敗したらメモリ上も変更前に戻し、
   * 画面に出る状態とファイルの内容が食い違わないようにする。
   */
  _commit(mutate) {
    const before = JSON.parse(JSON.stringify(this.index));
    const result = mutate();
    try { writeJsonAtomic(this.indexFile, this.index); } catch (e) { this.index = before; throw e; }
    return result;
  }

  /** 個人情報項目の行を除く。除いたラベルの一覧も返す。 */
  stripPII(body) {
    const removed = new Set();
    const lines = body.split(/(?<=\r\n|\n|\r)/).filter(line => {
      const m = line.match(LINE_LABEL);
      if (m && PII_LABELS.has(m[1].toUpperCase())) { removed.add(m[1].toUpperCase()); return false; }
      return true;
    });
    return { body: lines.join(''), removed: [...removed] };
  }

  /**
   * 受信した本文を保存する。
   * @param {{body: string, type: string, job?: string, peer: string, crcOk: boolean|null}} rec
   */
  saveReceived({ body, type, job, peer, crcOk }) {
    const now = new Date();
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    let removed = [];
    if (this.removePII) ({ body, removed } = this.stripPII(body));
    const dayDir = path.join(this.dir, 'inbox', day);
    fs.mkdirSync(dayDir, { recursive: true });
    // 受信元の「IP:ポート」は、: がファイル名に使えないため - に置き換える(127.0.0.1-54435)
    const from = safeName(String(peer ?? '').replace(/:/g, '-'));
    let base = `${safeName(job)}_${hms}_${from}`, i = 1;
    while (fs.existsSync(path.join(dayDir, base + '.vca'))) base = `${safeName(job)}_${hms}_${from}_${++i}`;
    const rel = path.join('inbox', day, base + '.vca');
    fs.writeFileSync(path.join(this.dir, rel), Buffer.from(body, 'latin1'));

    const parsed = VCA.parse(body);
    const eyes = parsed.traces.map(t => t.eye);
    const tr = parsed.traces[0];
    const box = tr && tr.radii.length >= 3 && tr.radii.every(Number.isFinite) ? VCA.boxOf(VCA.tracePoints(tr)) : null;
    const entry = {
      id: `${day.replace(/-/g, '')}-${hms}-${Math.random().toString(36).slice(2, 7)}`,
      job: job ?? '', type, peer, receivedAt: now.toISOString(), file: rel.replace(/\\/g, '/'),
      crcOk, eyes, traceFormat: tr ? tr.fmt : null, hbox: box ? +box.hbox.toFixed(2) : null,
      vbox: box ? +box.vbox.toFixed(2) : null, piiRemoved: removed, check: checkBody(body),
      name: null, status: 'received', queuedAt: null, sent: [],
    };
    const infoFile = path.join(this.dir, rel.replace(/\.vca$/, '.json'));
    fs.writeFileSync(infoFile, JSON.stringify(entry, null, 1));
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
    if (!n || n !== safeName(n) || n.length > JOB_MAX || !/^[\x20-\x7f]+$/.test(n) || n.includes(';') || WINDOWS_DEVICE.test(n)) {
      throw Object.assign(new Error('使えない名前です'), { code: 'bad-name' });
    }
    return n;
  }

  /** 名前を付ける(どこへも渡さずに付けるだけ。送信待ちにするのは queue)。 */
  setName(id, name) {
    if (!this.get(id)) return null;
    const n = Store.checkName(name);
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
    this._commit(() => {
      for (const o of others) o.status = 'received';
      const e = this.get(id);
      e.name = n;
      e.status = 'queued';
      e.queuedAt = new Date().toISOString();
    });
    if (this.hooks.queued) this.hooks.queued(this.get(id));
    return this.get(id);
  }

  unqueue(id) {
    const e = this.get(id);
    if (e && e.status === 'queued') this._commit(() => { this.get(id).status = 'received'; });
    return this.get(id);
  }

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
    this.sending.set(e.id, holder);
    return { entry: e };
  }

  /** 押さえたデータを放す(送り終えられなかったとき)。押さえたのと違う接続からは放さない。放したら true */
  release(id, holder) {
    if (this.sending.get(id) !== holder) return false;
    this.sending.delete(id);
    return true;
  }

  /** 接続が押さえているデータを全て放す(接続が切れたとき)。放した id の一覧を返す。 */
  releaseAll(holder) {
    const ids = [...this.sending].filter(([, h]) => h === holder).map(([id]) => id);
    for (const id of ids) this.sending.delete(id);
    return ids;
  }

  /**
   * 保存期間を過ぎたデータを消す(設計書 7 章)。送信待ちのものは、加工機がまだ取りに来ていないので消さない。
   * @returns {object[]} 消した索引の記録
   */
  purge(days, now = new Date()) {
    if (!(days > 0)) return [];
    const limit = now.getTime() - days * 86400000;
    const old = this.index.filter(e => e.status !== 'queued' && Date.parse(e.receivedAt) < limit);
    for (const e of old) this.remove(e.id);
    return old;
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

  remove(id) {
    const e = this.get(id);
    if (!e) return false;
    // 先に索引から外し、保存できたらファイルを消す(索引にあるのにファイルがない状態を作らない)
    this._commit(() => { this.index = this.index.filter(x => x.id !== id); });
    for (const f of [e.file, e.file.replace(/\.vca$/, '.json')]) {
      const p = path.join(this.dir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    if (this.hooks.removed) this.hooks.removed(id);
    return true;
  }
}

module.exports = { Store, PII_LABELS, safeName };
