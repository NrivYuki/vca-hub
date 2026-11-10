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
      settings: settings || {},
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
        },
        remove(id) { try { fs.unlinkSync(dataFile(id)); } catch { /* 無ければよい */ } },
      },
      /** 保存した受信データを読む(変えることはできない) */
      store: {
        get: id => self.store.get(id),
        list: () => self.store.list(),
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
    return {
      name, protocol, timeouts,
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
        return entry;
      },
      /** 送信待ちのデータを、人が付けた名前で探す(無ければ null) */
      queued: job => self.store.findQueued(job),
      /** 送るレコード(VCA の [ラベル, 値...])。ほかの拡張の send も通す。profile を渡せば、その項目と玉型の形式に合わせる */
      records: (entry, { device, profile } = {}) => self.app.recordsFor(entry, { kind: 'device', protocol, device: device || null, profile: profile || null, peer: name }),
      /** 渡し終えた(相手が受け取った)ら、送信済みにする */
      markSent: (id, to) => {
        self.store.markSent(id, `${to || name} (${p.title})`);
        const e = self.store.get(id);
        note('info', { event: 'sent', job: e && e.name, detail: id });
      },
    };
  }

  /** 受信データを保存したとき。失敗しても受信は取り消さない(記録に残す) */
  received(entry, body) {
    for (const ext of this.list) for (const fn of ext.hooks.received) {
      try { fn({ entry, body }); } catch (e) { this.warn(ext, 'received', e); }
    }
  }

  /** 送信待ちにしたとき(通信方式の拡張が機器へ知らせるため)。失敗しても送信待ちは取り消さない(記録に残す) */
  queued(entry) {
    for (const ext of this.list) for (const fn of ext.hooks.queued) {
      try { fn({ entry }); } catch (e) { this.warn(ext, 'queued', e); }
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
        const r = fn({ entry, get body() { return lazy(); } }) || {};
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
      try { r = fn({ entry, body, records: out.map(x => x.slice()), to }); } catch (e) {
        this.warn(ext, 'send', e);
        throw fail('ext-send', `拡張「${ext.title}」で送るデータを作れませんでした: ${e.message}`);
      }
      if (r === undefined) continue;
      if (!Array.isArray(r) || !r.every(x => Array.isArray(x) && x.length >= 1)) {
        throw fail('ext-send', `拡張「${ext.title}」の send がレコードの並びを返しませんでした`);
      }
      out = r.map(x => x.map(String));
      const d = diffRecords(before, out);
      if (d.added.length || d.changed.length || d.removed.length) {
        this.log.write('info', {
          event: 'ext-send', job: entry.name || entry.job,
          detail: `[${ext.name}] ${to.kind}${d.added.length ? ` 足した ${d.added.join(',')}` : ''}${d.changed.length ? ` 変えた ${d.changed.join(',')}` : ''}${d.removed.length ? ` 除いた ${d.removed.join(',')}` : ''} ${entry.id}`,
        });
      }
    }
    return out;
  }

  /** 画面の詳細と送る前の確認に出す、拡張からの説明([{ name, title, lines }]) */
  describe(entry) {
    const out = [];
    for (const ext of this.list) for (const fn of ext.hooks.describe) {
      try {
        const r = fn({ entry });
        const lines = [].concat(r || []).map(String).filter(Boolean);
        if (lines.length) out.push({ name: ext.name, title: ext.title, lines });
      } catch (e) { this.warn(ext, 'describe', e); }
    }
    return out;
  }

  /** 受信データを消したとき、拡張が残した情報も消す */
  removed(id) {
    for (const ext of this.list) {
      try { fs.unlinkSync(path.join(this.dataDir, ext.name, id + '.json')); } catch { /* 無ければよい */ }
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
