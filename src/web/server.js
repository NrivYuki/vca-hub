'use strict';
// 管理画面(設計書 8 章)。この PC のアドレス(127.0.0.1・::1・localhost)だけで待ち受け、この PC からのみ開ける。
// 他のサイトから操作を仕掛けられないよう、Host ヘッダーと独自ヘッダーを確認する。

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const VCA = require('../lib/vca-parser.js');
const { normalizeIp } = require('../net/tcp.js');
const { reachable } = require('../send/folder.js');
// 書き出し先の共有フォルダに届かないときの断り(vca-hub を止めずに断る)
const unreachable = () => Object.assign(new Error('書き出し先の共有フォルダに届きません'), { code: 'export-failed' });

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
};

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  // 先に本文を作る(JSON にできない値なら、見出しを書く前に例外にする。書いた後だと、呼んだ側が応答を返せなくなる)
  const text = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  // ほかのサイトの枠(iframe)に入れさせない(押し間違いを誘う画面を作らせないため)。拡張のページは同じオリジンの枠なので通す
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'", ...extra,
  });
  res.end(text);
}

// 要求の本文の上限(画面から送るのは名前などの小さな JSON だけ)
const MAX_BODY = 1e5;
const badRequest = message => Object.assign(new Error(message), { code: 'bad-request' });

/** 本文の JSON を読む。大きすぎる(code='too-large')、JSON でない・オブジェクトでない(code='bad-request')ときは断る */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '', over = false;
    req.on('data', c => { if (over) return; s += c; if (s.length > MAX_BODY) { over = true; s = ''; } });
    req.on('error', reject);
    req.on('end', () => {
      if (over) return reject(Object.assign(new Error('本文が大きすぎます'), { code: 'too-large' }));
      let v;
      try { v = s ? JSON.parse(s) : {}; } catch { return reject(badRequest('本文が JSON ではありません')); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(badRequest('本文が JSON のオブジェクトではありません'));
      resolve(v);
    });
  });
}

/**
 * 送る前の確認で人が確かめる中身(本文・送り出せない理由と知らせ・拡張の説明)から作る値。
 * 確認の画面はこの値を添えて送り、vca-hub は送る直前に作り直して比べる(確かめた後に拡張の条件などが変わっていたら送らない)
 */
function confirmKey(body, check, extensions) {
  return crypto.createHash('sha256').update(JSON.stringify([body, check, extensions])).digest('hex').slice(0, 32);
}

/** 詳細表示用に、保存した本文を画面向けの形にする。 */
function detail(store, entry, ext, hub) {
  const body = store.readBody(entry);
  const parsed = VCA.parse(body);
  const traces = parsed.traces.map(t => {
    const ok = t.radii.length >= 3 && t.radii.every(Number.isFinite);
    const pts = ok ? VCA.tracePoints(t) : [];
    const box = ok ? VCA.boxOf(pts) : null;
    return {
      eye: t.eye, fmt: t.fmt, n: t.radii.length, mode: t.mode, kind: t.kind,
      points: pts.map(p => [+p.x.toFixed(2), +p.y.toFixed(2)]),
      hbox: box ? +box.hbox.toFixed(2) : null, vbox: box ? +box.vbox.toFixed(2) : null,
      circ: ok ? +VCA.circumference(pts).toFixed(2) : null,
    };
  });
  // 画面に出す原文: 制御文字や 8 ビット文字は記号に置き換える
  const text = body.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\xff]/g, '·');
  const check = store.checkOf(entry, body), extensions = ext ? ext.describe(entry) : [];
  return {
    ...entry, ...flags(store, entry, hub), records: parsed.records, traces, text, errors: parsed.errors, warnings: parsed.warnings,
    check, extensions, confirmKey: confirmKey(body, check, extensions),
  };
}

/**
 * 一覧と詳細に添える、いまの状態の印。
 * sending: 加工機へ渡している途中、sentUnrecorded: 加工機は受け取ったが送信済みを書けず押さえている、uploading: 送り先へ送っている途中
 */
function flags(store, entry, hub) {
  const out = {};
  if (store.unrecordedSent && store.unrecordedSent.has(entry.id)) out.sentUnrecorded = true;
  else if (store.sending.has(entry.id)) out.sending = true;
  if (hub && hub.isUploading && hub.isUploading(entry.id)) out.uploading = true;
  if (store.refusals && store.refusals.has(entry.id)) out.refused = store.refusals.get(entry.id);
  return out;
}

// 断る理由ごとの HTTP の状態コード
const REFUSAL = {
  'bad-name': 400, 'blocked': 409, 'name-taken': 409, 'queued-rename': 409, 'queued-change': 409, 'sending': 409, 'uploading': 409, 'export-failed': 502, 'no-export-dir': 409, 'no-destination': 409, 'upload-failed': 502, 'upload-unconfirmed': 502, 'not-found': 404,
  'ext-send': 409, 'changed': 409, 'file-exists': 409, 'file-busy': 409, 'no-protocol': 409, 'bad-request': 400, 'too-large': 413,
};
// 拡張のページと一緒に配るファイルの種類
const EXT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** 拡張のフォルダの中のファイルだけを返す(.. などでフォルダの外を指したら null) */
function extFile(dir, rel) {
  const p = path.resolve(dir, rel);
  if (!p.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return p;
}

// 管理画面に接続してよい相手(この PC)
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * 管理画面を待ち受ける。
 * @param {{host: string, port: number, store: object, registry: object, log: object, cfg: object, hub: object, ext: object}} ctx
 */
function startWeb({ host, port, store, registry, log, cfg, hub, ext }) {
  // 一覧の拡張の検査の結果(id → { key, x })。状態・名前・拡張の情報が変わらなければ使い回す
  const checkCache = new Map();
  // 起動ごとの印(一覧の版の番号は起動のたびに 0 から数えるので、前の起動の版と取り違えないように)
  const boot = crypto.randomBytes(4).toString('hex');
  const server = http.createServer(async (req, res) => {
    // 断った理由を返す(知らない例外は 500 にする)
    const refuse = e => {
      if (!REFUSAL[e.code]) throw e;
      return send(res, REFUSAL[e.code], { error: e.code, message: e.message, blockers: e.blockers, others: e.others });
    };
    try {
      // 管理画面には認証が無いので、この PC から以外の接続は断る(Host は相手が自由に書けるので、相手のアドレスで確かめる)
      if (!LOOPBACK.has(normalizeIp(req.socket.remoteAddress))) return send(res, 403, { error: 'forbidden peer' });
      // DNS リバインディング対策: localhost 以外の Host 名は拒否する
      const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostName)) return send(res, 403, { error: 'forbidden host' });

      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { throw badRequest('パスを読めません'); }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), type);
      }
      // 拡張のページ(/ext/<名前>/ はページ、/ext/<名前>/<ファイル> は拡張のフォルダの中のファイル)
      const pm = req.method === 'GET' && url.pathname.match(/^\/ext\/([\w-]+)\/(.*)$/);
      if (pm) {
        const e = ext && ext.get(pm[1]);
        let rel;
        try { rel = pm[2] ? decodeURIComponent(pm[2]) : e && e.page && e.page.file; } catch { return send(res, 404, { error: 'not found' }); }
        const file = e && rel && extFile(e.dir, rel);
        const type = file && EXT_TYPES[path.extname(file).toLowerCase()];
        if (!type) return send(res, 404, { error: 'not found' });
        return send(res, 200, fs.readFileSync(file), type);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

      // 変更を伴う操作は、画面からの呼び出しであることを独自ヘッダーで確認する(CSRF 対策)
      if (req.method !== 'GET' && req.headers['x-vca-hub'] !== '1') return send(res, 403, { error: 'missing header' });

      const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)(?:\/(queue|unqueue|export|send))?$/);
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const proto = p => (p === undefined || p === null || String(p).toLowerCase() === 'vca' ? 'vca' : String(p));
        return send(res, 200, {
          remote: cfg.remote.enabled ? cfg.remote.port : null, remoteProtocol: proto(cfg.remote.protocol),
          listeners: cfg.listeners.map(l => ({ name: l.name, port: l.port, protocol: proto(l.protocol) })),
          local: cfg.local.map(d => d.name), localDevices: cfg.local.map(d => ({ name: d.name, host: d.host, port: d.port, protocol: proto(d.protocol) })),
          autoconnect: cfg.autoconnect.enabled ? cfg.autoconnect.port : null,
          destinations: cfg.destinations.map(d => d.name), destinationList: cfg.destinations.map(d => ({ name: d.name, host: d.host, port: d.port, protocol: proto(d.protocol) })),
          exportDir: cfg.exportDir, importDir: cfg.importDir,
          removePII: cfg.removePII, retentionDays: cfg.retentionDays, dataDir: cfg.dataDir,
          extensions: ext ? ext.summary() : [],
        });
      }
      // 拡張の API(/api/ext/<名前>/<path>)。変更を伴うものは、上の独自ヘッダーの確認を通ったものだけ
      const am = url.pathname.match(/^\/api\/ext\/([\w-]+)\/(.*)$/);
      if (am) {
        const e = ext && ext.get(am[1]);
        const r = e && e.routes.find(x => x.method === req.method && x.path === am[2]);
        if (!r) return send(res, 404, { error: 'not found' });
        const body = req.method === 'GET' ? {} : await readJson(req);
        try {
          const out = await r.handler({ method: req.method, path: am[2], query: Object.fromEntries(url.searchParams), body });
          let text;
          try { text = JSON.stringify(out === undefined ? { ok: true } : out); } catch (err) {
            throw Object.assign(new Error(`拡張の応答を JSON にできません(${err.message})`), { code: 'ext-error' });
          }
          return send(res, 200, text, 'application/json; charset=utf-8');
        } catch (err) {
          log.write('warn', { event: 'ext-error', detail: `[${e.name}] ${req.method} ${am[2]}: ${err.message}` });
          return send(res, REFUSAL[err.code] || 400, { error: err.code || 'ext-error', message: err.message });
        }
      }
      // 共有フォルダへ書き出す前に、同じ名前のファイルがあるか(上書きになることを確認の画面で知らせる)
      if (req.method === 'GET' && url.pathname === '/api/export-check') {
        if (cfg.exportDir && !(await reachable(cfg.exportDir))) return refuse(unreachable());
        try { return send(res, 200, { exists: hub.exportCheck(url.searchParams.get('name')).exists }); } catch (e) { return refuse(e); }
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        // 一覧の印には、拡張の検査も入れる(加工条件が未設定なら送れない、など。拡張の検査はその時点の状態で行う)
        // 加工機へ渡している途中かも付ける(取り消し・削除などを断る理由が、押す前に分かるように)
        // 一覧が変わっていなければ中身を送らない(索引が大きいとき、画面が 3 秒ごとに読み直すたびに全てを作り直さないため)。
        // 変わったかは、索引の変更・押さえ・送り先へ送っている途中・拡張の情報の変更の通し番号で見分ける
        const tag = `W/"${boot}-${store.version}-${hub && hub.uploadingIds ? hub.uploadingIds().join(',') : ''}-${ext ? ext.gen : 0}"`;
        if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' }); return res.end(); }
        const withSending = e => { const f = flags(store, e, hub); return Object.keys(f).length ? { ...e, ...f } : e; };
        if (!store.hooks.check) return send(res, 200, store.list().map(withSending), undefined, { ETag: tag });
        const seen = new Set();
        const out = store.list().map(e => {
          seen.add(e.id);
          // 送信済みのものは、もう送り出さないので拡張の検査をしない。ほかは結果を覚えておき、状態・名前・拡張の情報が変わったら検査し直す
          if (e.status === 'sent') return withSending(e);
          const key = `${e.status}|${e.name}|${ext ? ext.dataGen.get(e.id) || 0 : 0}`;
          let c = checkCache.get(e.id);
          if (!c || c.key !== key) { c = { key, x: store.hooks.check(e, () => store.readBody(e)) }; checkCache.set(e.id, c); }
          const x = c.x;
          return withSending(x.blockers.length || x.notices.length
            ? { ...e, check: { blockers: e.check.blockers.concat(x.blockers), notices: e.check.notices.concat(x.notices) } } : e);
        });
        for (const id of checkCache.keys()) if (!seen.has(id)) checkCache.delete(id);
        return send(res, 200, out, undefined, { ETag: tag });
      }
      if (req.method === 'GET' && url.pathname === '/api/log') return send(res, 200, log.list());
      if (req.method === 'GET' && url.pathname === '/api/devices') return send(res, 200, registry.list());
      if (m) {
        const entry = store.get(m[1]);
        if (!entry) return send(res, 404, { error: 'not found' });
        if (req.method === 'GET' && !m[2]) return send(res, 200, detail(store, entry, ext, hub));
        // 送り出す操作は、どれも送信前の確認(設計書 6 章)を経て、人が名前を付けたものだけを受け付ける
        if (req.method === 'POST' && ['queue', 'export', 'send'].includes(m[2])) {
          const b = await readJson(req);
          if (b.confirmed !== true || typeof b.name !== 'string') return send(res, 400, { error: 'confirmation required' });
          // 本文を読んでいる間に、消されたかもしれない(削除・保存期間)
          if (!store.get(entry.id)) return send(res, 404, { error: 'not found' });
          // 確かめた中身と、いまの中身を比べる(確かめた後に拡張の条件・知らせが変わっていたら送らない)
          const body = store.readBody(entry), check = store.checkOf(entry, body);
          if (b.key !== confirmKey(body, check, ext ? ext.describe(entry) : [])) {
            return send(res, 409, { error: 'changed', message: '確かめている間に、送る中身(拡張の条件や知らせ)が変わりました' });
          }
          try {
            if (m[2] === 'queue') {
              const e = store.queue(entry.id, b.name, { replace: b.replace === true });
              log.write('info', { event: 'queued', job: e.name, detail: entry.id });
              return send(res, 200, e);
            }
            if (m[2] === 'export' && cfg.exportDir && !(await reachable(cfg.exportDir))) throw unreachable();
            if (m[2] === 'export') { const x = hub.exportJob(entry.id, b.name, { overwrite: b.overwrite === true }); return send(res, 200, { ...store.get(entry.id), export: x }); }
            const r = await hub.sendTo(entry.id, b.name, b.to);
            return send(res, r.status === 0 ? 200 : 502, { ...store.get(entry.id), upload: r });
          } catch (e) {
            if (e.code === 'blocked') log.write('warn', { event: 'send-blocked', job: entry.name || entry.job, detail: entry.id });
            return refuse(e);
          }
        }
        if (req.method === 'POST' && m[2] === 'unqueue') {
          try { store.unqueue(entry.id); } catch (e) { return refuse(e); }
          log.write('info', { event: 'unqueued', job: entry.name || entry.job, detail: entry.id });
          return send(res, 200, store.get(entry.id));
        }
        if (req.method === 'DELETE' && !m[2]) {
          try { store.remove(entry.id); } catch (e) { return refuse(e); }
          log.write('info', { event: 'deleted', job: entry.name || entry.job, detail: entry.id });
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      // 要求の形の誤り(読めないパス・本文)は、利用者の側の誤りとして返す
      if (e.code === 'bad-request' || e.code === 'too-large') return send(res, REFUSAL[e.code], { error: e.code, message: e.message });
      log.write('error', { event: 'web', detail: e.message });
      return send(res, 500, { error: 'internal error' });
    }
  });
  if (!LOOPBACK.has(normalizeIp(host))) {
    return Promise.reject(Object.assign(new Error(`管理画面は、この PC のアドレス(127.0.0.1・::1)でだけ待ち受けます(web.host: ${host})`), { code: 'web-host' }));
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { startWeb };
