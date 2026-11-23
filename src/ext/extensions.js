'use strict';
// 拡張(設計書 13 章)。vca-hub は中継に徹し、加工条件の設定やメーカーごとの項目のように、
// 中身を足したり変えたりする処理は、利用者が作って入れる拡張にまかせる。
//
// 拡張は vca-hub のフォルダの extensions/<名前>/index.js に置き、config.json の extensions に名前を書いたものだけを読む。
// 拡張のコードは vca-hub と同じ権限で動くので、勝手には読まない。読めなければ vca-hub を起動しない
// (たとえば加工条件の拡張が欠けたまま、条件なしで加工機へ渡さないため)。
//
// 拡張の形:
//   module.exports = { title: '画面に出す名前', setup(hub) { hub.on('send', ...); ... } }
// setup に渡す hub(拡張から使えるもの)は makeContext を参照。

const fs = require('node:fs');
const path = require('node:path');
const VCA = require('../lib/vca-parser.js');

const HOOKS = ['received', 'check', 'send', 'describe', 'queued'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * 拡張に渡す索引の記録の写し。拡張が書き換えても、索引(状態・名前など)は変わらない。
 * 状態を変えるのは io の関数(markSent など)と、人の操作(送信前の確認)だけにするため
 */
const view = e => (e && typeof e === 'object' ? structuredClone(e) : e);

/**
 * レコード([ラベル, 値...])の並びのうち、同じラベルのものを置き換える。無ければ玉型(TRCFMT)の前に入れる。
 * 拡張が加工条件などを足すときに使う。
 */
function setRecord(records, label, ...fields) {
  const L = String(label).toUpperCase();
  const rec = [L, ...fields.map(String)];
  const out = records.filter(r => String(r[0]).toUpperCase() !== L);
  const at = records.findIndex(r => String(r[0]).toUpperCase() === L);
  if (at >= 0) { out.splice(Math.min(at, out.length), 0, rec); return out; }
  const trc = out.findIndex(r => String(r[0]).toUpperCase() === 'TRCFMT');
  out.splice(trc < 0 ? out.length : trc, 0, rec);
  return out;
}

const { DATASET_SERIES } = require('../send/build.js');
// 送るレコードのうち、セッションの見出しとして vca-hub(createHost・uploadTo)が付けるもの。拡張の send からは足さない・変えない
const SESSION_LABELS = new Set(['REQ', 'ANS', 'STATUS', 'JOB']);
// ラベルの形: ブロックの番号(n!)と省略の印(*)を前に付けてよい。英字か _ で始まり、英数字・_・.(メーカーの名前空間)が続く
// 受け取った行の読み方(build.js の LINE_LABEL)とそろえる(拡張を入れたかどうかで、送れるデータが変わらないように)
const RECORD_LABEL = /^\*?(?:\d+!)?\*?[A-Za-z_][A-Za-z0-9_.:\-]*$/;

/**
 * 拡張が返したレコードの形を確かめる。ラベルの形と、値に制御文字(CR・LF・FS・GS・RS など)が無いこと。
 * 値に改行があると、書き出しのファイルや送り先へ、別のレコードが紛れ込むため
 * @returns {string|null} 正しくなければ理由
 */
function badRecord(records) {
  for (const r of records) {
    if (!RECORD_LABEL.test(String(r[0]).trim())) return `ラベル ${JSON.stringify(r[0].slice(0, 20))}`;
    // データセットの系列(R・A など)は、バイナリの形式(2-4)で制御文字を含むのが正しい(5.1.7.3)ので確かめない
    if (DATASET_SERIES.has(String(r[0]).replace(/^\*?(?:\d+!)?\*?/, '').toUpperCase())) {
      const v = r.slice(1).join(';');
      if (/[\x06\x0a\x0d\x11\x13\x15\x1a\x1c-\x1e]/.test(v) || /\x1b(?![\x80-\xff])/.test(v)) return `${r[0]} の値に、逃がしていない予約文字があります(5.1.7.3)`;
      continue;
    }
    const f = r.slice(1).find(v => /[\x00-\x1f\x7f]/.test(v));
    if (f !== undefined) return `${r[0]} の値に制御文字(改行など)があります`;
  }
  return null;
}

/** レコードの並びを VCA のテキスト(CR LF 区切り)にする */
function toText(records) {
  return records.map(r => `${String(r[0]).toUpperCase()}=${r.slice(1).join(';')}\r\n`).join('');
}

/** 2 つのレコードの並びを比べ、足した・変えた・除いたラベルを返す(記録に残すため)。 */
function diffRecords(before, after) {
  const key = rs => {
    const m = new Map();
    for (const r of rs) { const l = String(r[0]).toUpperCase(); m.set(l, (m.get(l) || []).concat(r.slice(1).join(';'))); }
    return m;
  };
  const a = key(before), b = key(after);
  const added = [], changed = [], removed = [];
  for (const [l, v] of b) {
    if (!a.has(l)) added.push(l);
    else if (a.get(l).join('\n') !== v.join('\n')) changed.push(l);
  }
  for (const l of a.keys()) if (!b.has(l)) removed.push(l);
  return { added, changed, removed };
}

class Extensions {
  /**
   * @param {{dir: string, enabled: object, dataDir: string, store: object, log: object}} opts
   *   enabled: config.json の extensions({ 名前: 設定 | true | false })
   */
  constructor({ dir, enabled, dataDir, store, log }) {
    this.dir = dir;
    this.dataDir = path.join(dataDir, 'ext');
    this.store = store;
    this.log = log;
    this.list = [];                 // 読んだ拡張: { name, title, version, dir, hooks, routes, page }
    this.protocols = new Map();     // 拡張が足した通信方式: id → { ext, impl, title }
    this.gen = 0;                   // 拡張の情報(hub.data)を変えた回数。管理画面の一覧が変わったかを見分けるため
    this.dataGen = new Map();       // 受信データごとの、拡張の情報を変えた回数
    this.app = null;                // 送るレコードを作る関数(app.js が入れる)
    for (const [name, settings] of Object.entries(enabled || {})) {
      if (settings === false) continue;
      this.load(name, settings === true ? {} : settings);
    }
  }

  load(name, settings) {
    if (!NAME.test(name)) throw fail('ext-load', `拡張の名前 ${name} は使えません(英数字・_・- で 40 文字まで)`);
    const dir = path.join(this.dir, name);
    let mod;
    try { mod = require(path.join(dir, 'index.js')); } catch (e) {
      throw fail('ext-load', `拡張 ${name} を読めません(${path.join(dir, 'index.js')}): ${e.message}`);
    }
    if (!mod || typeof mod.setup !== 'function') throw fail('ext-load', `拡張 ${name} に setup がありません`);
    const ext = { name, title: String(mod.title || name), version: String(mod.version || ''), dir, hooks: {}, routes: [], page: null };
    for (const h of HOOKS) ext.hooks[h] = [];
    try { mod.setup(this.makeContext(ext, settings)); } catch (e) {
      throw fail('ext-load', `拡張 ${name} の setup で失敗しました: ${e.message}`);
    }
    this.list.push(ext);
  }

  /** 拡張の setup に渡すもの。拡張はこれだけを通して vca-hub とやりとりする。 */
  makeContext(ext, settings) {
    const self = this;
    const dataDir = path.join(this.dataDir, ext.name);
    const dataFile = id => {
      if (!/^[\w-]+$/.test(String(id))) throw fail('bad-id', 'id が正しくありません');
      return path.join(dataDir, id + '.json');
    };
    return {
      name: ext.name,
      // 設定は写しを渡す(拡張が書き換えても、config.json から読んだものは変わらない)
      settings: structuredClone(settings || {}),
      dir: ext.dir,
      /** 拡張が自分のファイル(鍵・組み合わせた相手など)を置くフォルダ(data/ext/<名前>。無ければ作る) */
      get dataDir() { fs.mkdirSync(dataDir, { recursive: true }); return dataDir; },
      vca: { parse: VCA.parse, value: VCA.value, setRecord },
      /** 記録に残す(画面の「記録」に、拡張の名前を付けて出る) */
      log: (level, fields = {}) => self.log.write(level, { event: 'ext', ...fields, detail: `[${ext.name}] ${fields.detail || ''}`.trim() }),
      /** 受信データごとに、拡張の情報を残す(data/ext/<名前>/<id>.json。受信データを消すと一緒に消える) */
      data: {
        get(id) { try { return JSON.parse(fs.readFileSync(dataFile(id), 'utf8')); } catch { return null; } },
        set(id, value) {
          if (!self.store.get(id)) throw fail('not-found', 'データがありません');
          fs.mkdirSync(dataDir, { recursive: true });
          const f = dataFile(id), tmp = f + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
          fs.renameSync(tmp, f);
          self.touched(id);
        },
        remove(id) { try { fs.unlinkSync(dataFile(id)); } catch { /* 無ければよい */ } self.touched(id); },
      },
      /** 保存した受信データを読む(変えることはできない) */
      store: {
        get: id => view(self.store.get(id)),
        list: () => self.store.list().map(view),
        body: id => { const e = self.store.get(id); return e ? self.store.readBody(e) : null; },
      },
      /** フックに関数をつなぐ(received・check・send・describe・queued) */
      on(hook, fn) {
        if (!HOOKS.includes(hook)) throw new Error(`フック ${hook} はありません(${HOOKS.join('・')})`);
        ext.hooks[hook].push(fn);
      },
      /** 管理画面から呼べる API(/api/ext/<名前>/<path>)。handler({ method, path, query, body }) は JSON にできるものを返す */
      route(method, sub, handler) { ext.routes.push({ method: String(method).toUpperCase(), path: String(sub).replace(/^\/+/, ''), handler }); },
      /** 管理画面の右の面に出すページ(拡張のフォルダの中の HTML)。選んだ受信データの id を ?id= で渡す */
      page(file, title) { ext.page = { file: String(file), title: String(title || ext.title) }; },
      /**
       * 通信方式を足す(規格から外れたメーカーの通信など)。config.json の待ち受け(remote・listeners)・
       * ローカル接続(local)・送り先(destinations)の protocol にこの id を書くと、その口はこの通信方式になる。
       * impl: {
       *   title: 画面に出す名前,
       *   listen({ name, port, settings }, io): 待ち受ける。{ port, close() } を返す(Promise でもよい)
       *   connect({ name, host, port, settings }, io): 機器へつなぐ。止める関数を返す(つなぎ直しも拡張が行う)
       *   upload({ dest, name, entry, records }, io): 送り先へ送る。{ status, statusText } を返す(0 が成功)
       * }
       * io は vca-hub の保管と名前の仕組み(protocolIo を参照)。保存の形は、どの通信方式でも VCA のテキストにそろえる。
       */
      protocol(id, impl) {
        const key = String(id);
        if (!NAME.test(key) || key.toLowerCase() === 'vca') throw new Error(`通信方式の名前 ${key} は使えません`);
        if (self.protocols.has(key)) throw new Error(`通信方式 ${key} は、ほかの拡張がすでに足しています`);
        if (!impl || !['listen', 'connect', 'upload'].some(k => typeof impl[k] === 'function')) throw new Error(`通信方式 ${key} に listen・connect・upload のどれもありません`);
        self.protocols.set(key, { ext, impl, title: String(impl.title || key) });
      },
    };
  }

  /** 拡張が足した通信方式(無ければ null) */
  protocol(id) { return this.protocols.get(String(id)) || null; }

  /**
   * 通信方式の拡張に渡すもの(口ごと)。拡張はメーカーの通信と VCA のレコードとの間を変換し、
   * 保存・名前で探す・送信済みにする、は vca-hub が行う。
   * @param {{name: string, protocol: string, allowed: Function, timeouts: object}} where
   */
  protocolIo({ name, protocol, allowed, timeouts }) {
    const self = this;
    const p = this.protocols.get(protocol);
    const note = (level, fields = {}) => self.log.write(level, { event: 'ext', peer: name, ...fields, detail: `[${p.ext.name}] ${fields.detail || ''}`.trim() });
    // この口が io.reserve で押さえたもの(id → holder)。markSent で、ほかの相手が押さえているものと見分けるため
    const reservedHere = new Map();
    return {
      // 時間切れの設定は写しを渡す(拡張が書き換えても、DCS のセッションの時間切れは変わらない)
      name, protocol, timeouts: structuredClone(timeouts),
      vca: { parse: VCA.parse, value: VCA.value, setRecord, toText },
      log: note,
      /** 相手の IP が許可範囲(config.json の allow)の中か */
      allowed: ip => allowed(ip),
      /**
       * 受け取ったデータを保存する(名前なしで一覧に載る)。body(VCA のテキスト)か records([ラベル, 値...] の並び)を渡す
       * @returns {object} 保存した記録(id など)
       */
      receive({ body, records, job, peer, type }) {
        const text = body !== undefined ? String(body) : toText(records || []);
        const entry = self.store.saveReceived({ body: text, type: type || protocol, job, peer: peer || name, crcOk: null });
        note('info', { event: 'received', job, detail: entry.id });
        return view(entry);
      },
      /** 送信待ちのデータを、人が付けた名前で探す(無ければ null。ほかの相手へ渡している途中のものも null) */
      queued: job => view(self.store.findQueued(job)),
      /**
       * 送信待ちのデータを探し、渡す相手のために押さえる(2 つの相手に同じデータを渡さない)。
       * 押さえたものは、markSent で送信済みにするか、release・releaseAll で放すまで、ほかの相手(VCA の加工機を含む)には渡さない。
       * holder は相手(接続)ごとに 1 つのオブジェクト。同じ holder がもう一度求めたら渡す
       * @returns {{entry: object}|{busy: true}|null} 無ければ null。ほかの相手へ渡している途中なら busy
       */
      reserve: (job, holder) => {
        const r = self.store.reserve(job, holder);
        if (r && r.entry) reservedHere.set(r.entry.id, holder);
        return r && r.entry ? { entry: view(r.entry) } : r;
      },
      /** 押さえたデータを放す(渡し終えられなかったとき)。押さえたのと違う holder からは放さない。放したら true */
      release: (id, holder) => {
        const done = self.store.release(id, holder);
        if (done) reservedHere.delete(id);
        return done;
      },
      /** holder が押さえているデータを全て放す(接続が切れたとき)。放した id の一覧を返す */
      releaseAll: holder => {
        const ids = self.store.releaseAll(holder);
        for (const id of ids) reservedHere.delete(id);
        return ids;
      },
      /** 送るレコード(VCA の [ラベル, 値...])。ほかの拡張の send も通す。profile を渡せば、その項目と玉型の形式に合わせる */
      // 拡張が渡した記録は写しなので、id で索引の記録を引き直す(ファイルの場所などを拡張が書き換えても、索引のものを読む)
      records: (entry, { device, profile } = {}) => {
        const real = entry && self.store.get(entry.id);
        if (!real) throw Object.assign(new Error('データがありません'), { code: 'not-found' });
        // 見つけた後で、送信待ちから外された・名前が変わったものは渡さない(人が取り消した・置き換えたデータを渡さないため)
        if (real.status !== 'queued' || real.name !== entry.name) {
          throw Object.assign(new Error('送信待ちではありません(取り消されたか、名前が変わりました)'), { code: 'not-queued' });
        }
        // 渡す直前にも、送り出せない理由ができていないかを確かめる(VCA の加工機への応答と同じ。送信待ちから外して確かめ直してもらう)
        const { blockers } = self.store.checkOf(real);
        if (blockers.length) {
          // 押さえを放してから送信待ちから外す(加工機への応答と同じ。放さないと、人が消すことも送信待ちに戻すこともできない)
          const by = self.store.sending.get(real.id);
          if (by !== undefined) self.store.release(real.id, by);
          reservedHere.delete(real.id);
          self.store.unqueue(real.id, { blocked: true });
          note('warn', { event: 'send-blocked', job: real.name, detail: `${real.id} 送信待ちから外した(理由 ${blockers.length} 件。理由の文には値が入るので、画面の詳細で確かめる)` });
          throw Object.assign(new Error('送り出せません'), { code: 'blocked', blockers });
        }
        return self.app.recordsFor(real, { kind: 'device', protocol, device: device || null, profile: profile || null, peer: name });
      },
      /**
       * 渡し終えた(相手が受け取った)ら、送信済みにする。
       * name を渡せば、送信待ちのものの名前と照らす(io.queued で探して渡したときに、渡した後で人が名前を変えたものを送信済みにしない)
       */
      markSent: (id, to, { name: sentName } = {}) => {
        // 送信待ちでないもの(取り消された・ほかへ渡し終えた)を、送信済みにしない
        const cur = self.store.get(id);
        if (!cur || cur.status !== 'queued') throw Object.assign(new Error('送信待ちではありません'), { code: 'not-queued' });
        if (sentName !== undefined && cur.name !== sentName) throw Object.assign(new Error('送信待ちのものの名前が変わりました'), { code: 'not-queued' });
        // ほかの相手(VCA の加工機、ほかの口)が押さえているものは、送信済みにしない(その相手へ渡している途中のため)
        const by = self.store.sending.get(id);
        if (by !== undefined && reservedHere.get(id) !== by) throw Object.assign(new Error('ほかの相手へ渡している途中です'), { code: 'sending' });
        const sentTo = `${to || name} (${p.title})`;
        try { self.store.markSent(id, sentTo); } catch (err) {
          // 相手はもう受け取っている。送信済みとして押さえたままにし(ほかの相手に渡さない)、保存期間の処理で書き直す
          self.store.holdSent(id, sentTo);
          reservedHere.delete(id);
          note('error', { event: 'sent-not-recorded', detail: `${id} ${err.code || err.message}。送信済みとして押さえ、書き直す` });
          throw err;
        }
        reservedHere.delete(id);
        const e = self.store.get(id);
        note('info', { event: 'sent', job: e && e.name, detail: id });
      },
    };
  }

  /**
   * フックが Promise を返したら、失敗を捕まえて記録に残す(捕まえない失敗は vca-hub を止めるため)。
   * 結果を使うフック(check・send・describe)では、Promise は結果として扱わない(呼んだ側が失敗にする)。
   */
  settle(ext, hook, r) {
    if (r && typeof r.then === 'function') {
      Promise.resolve(r).catch(e => this.warn(ext, hook, e instanceof Error ? e : new Error(String(e))));
      return true;
    }
    return false;
  }

  /** 受信データを保存したとき。失敗しても受信は取り消さない(記録に残す) */
  received(entry, body) {
    for (const ext of this.list) for (const fn of ext.hooks.received) {
      try { this.settle(ext, 'received', fn({ entry: view(entry), body })); } catch (e) { this.warn(ext, 'received', e); }
    }
  }

  /** 送信待ちにしたとき(通信方式の拡張が機器へ知らせるため)。失敗しても送信待ちは取り消さない(記録に残す) */
  queued(entry) {
    for (const ext of this.list) for (const fn of ext.hooks.queued) {
      try { this.settle(ext, 'queued', fn({ entry: view(entry) })); } catch (e) { this.warn(ext, 'queued', e); }
    }
  }

  /**
   * 送り出す前の検査に、拡張の理由を足す。拡張の検査が失敗したら、送り出せない理由にする(安全な側に倒す)。
   * @returns {{blockers: string[], notices: string[]}}
   */
  check(entry, readBody) {
    const blockers = [], notices = [];
    let body;
    const lazy = () => (body === undefined ? (body = readBody()) : body);
    for (const ext of this.list) for (const fn of ext.hooks.check) {
      try {
        const r = fn({ entry: view(entry), get body() { return lazy(); } }) || {};
        // 検査は同期で答える決まり。Promise は答えを待てないので、送り出せない理由にする(安全な側に倒す)
        if (this.settle(ext, 'check', r)) throw new Error('検査が Promise を返しました(同期で答えてください)');
        for (const s of r.blockers || []) blockers.push(`${ext.title}: ${s}`);
        for (const s of r.notices || []) notices.push(`${ext.title}: ${s}`);
      } catch (e) {
        blockers.push(`${ext.title}: 検査で失敗しました(${e.message})`);
        this.warn(ext, 'check', e);
      }
    }
    return { blockers, notices };
  }

  /**
   * 送るレコードを拡張に通す(拡張の順に)。拡張が失敗したら送らない(例外をそのまま投げる)。
   * 足した・変えた・除いたラベルは記録に残す。
   * @param {object} to { kind: 'device' | 'file' | 'destination', device?, profile?, type?, dest?, dir? }
   */
  send(entry, body, records, to) {
    let out = records;
    for (const ext of this.list) for (const fn of ext.hooks.send) {
      const before = out;
      let r;
      try { r = fn({ entry: view(entry), body, records: out.map(x => x.slice()), to: view(to) }); } catch (e) {
        this.warn(ext, 'send', e);
        throw fail('ext-send', `拡張「${ext.title}」で送るデータを作れませんでした: ${e.message}`);
      }
      if (r === undefined) continue;
      if (this.settle(ext, 'send', r)) throw fail('ext-send', `拡張「${ext.title}」の send が Promise を返しました(同期でレコードを返してください)`);
      if (!Array.isArray(r) || !r.every(x => Array.isArray(x) && x.length >= 1)) {
        throw fail('ext-send', `拡張「${ext.title}」の send がレコードの並びを返しませんでした`);
      }
      out = r.map(x => x.map(String));
      const bad = badRecord(out);
      if (bad) throw fail('ext-send', `拡張「${ext.title}」の send が正しくないレコードを返しました(${bad})`);
      const d = diffRecords(before, out);
      const head = d.added.concat(d.changed).find(l => SESSION_LABELS.has(l.replace(/^\*?(?:\d+!)?\*?/, '')));
      if (head) throw fail('ext-send', `拡張「${ext.title}」の send が ${head} を足すか変えました(セッションの見出しのレコードは vca-hub が付けます)`);
      if (d.added.length || d.changed.length || d.removed.length) {
        this.log.write('info', {
          event: 'ext-send', job: entry.name || entry.job,
          detail: `[${ext.name}] ${to.kind}${d.added.length ? ` 足した ${d.added.join(',')}` : ''}${d.changed.length ? ` 変えた ${d.changed.join(',')}` : ''}${d.removed.length ? ` 除いた ${d.removed.join(',')}` : ''} ${entry.id}`,
        });
      }
    }
    return out;
  }

  /** 拡張の情報を変えたことを覚える(覚えた検査の結果を使わないように) */
  touched(id) {
    this.gen++;
    // 全体で増え続ける番号を使う(一覧を空にしても、前の番号に戻らない)
    this.dataGen.set(String(id), this.gen);
    if (this.dataGen.size > 100000) this.dataGen.clear();
  }

  /** 画面の詳細と送る前の確認に出す、拡張からの説明([{ name, title, lines }]) */
  describe(entry) {
    const out = [];
    // 失敗したら、説明を作れなかったことを出す(send は送るレコードを変えるかもしれず、人が確かめないまま送らないように)
    const failed = why => ({ name: ext.name, title: ext.title, lines: [`説明を作れませんでした(${why})。送るデータをこの拡張が変えることがあります`], failed: true });
    let ext;
    for (ext of this.list) for (const fn of ext.hooks.describe) {
      try {
        const r = fn({ entry: view(entry) });
        if (this.settle(ext, 'describe', r)) { out.push(failed('Promise を返しました')); continue; }
        const lines = [].concat(r || []).map(String).filter(Boolean);
        if (lines.length) out.push({ name: ext.name, title: ext.title, lines });
      } catch (e) { this.warn(ext, 'describe', e); out.push(failed(e.message)); }
    }
    return out;
  }

  /** 受信データを消したとき、拡張が残した情報も消す */
  removed(id) {
    for (const ext of this.list) {
      for (const f of [id + '.json', id + '.json.tmp']) { try { fs.unlinkSync(path.join(this.dataDir, ext.name, f)); } catch { /* 無ければよい */ } }
    }
  }

  /** 管理画面に出す拡張の一覧 */
  summary() {
    return this.list.map(e => ({
      name: e.name, title: e.title, version: e.version, page: e.page ? e.page.title : null,
      protocols: [...this.protocols].filter(([, p]) => p.ext === e).map(([id, p]) => ({ id, title: p.title })),
    }));
  }

  get(name) { return this.list.find(e => e.name === name) || null; }

  warn(ext, hook, e) { this.log.write('warn', { event: 'ext-error', detail: `[${ext.name}] ${hook}: ${e.message}` }); }
}

module.exports = { Extensions, setRecord, diffRecords, toText, HOOKS };
