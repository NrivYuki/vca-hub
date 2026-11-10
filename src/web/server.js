'use strict';
// 管理画面(設計書 8 章)。127.0.0.1 だけで待ち受け、この PC からのみ開ける。
// 他のサイトから操作を仕掛けられないよう、Host ヘッダーと独自ヘッダーを確認する。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const VCA = require('../lib/vca-parser.js');
const { checkBody } = require('../send/check.js');

const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

/** 詳細表示用に、保存した本文を画面向けの形にする。 */
function detail(store, entry, ext) {
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
  return {
    ...entry, records: parsed.records, traces, text, errors: parsed.errors, warnings: parsed.warnings,
    check: store.checkOf(entry, body), extensions: ext ? ext.describe(entry) : [],
  };
}

/**
 * @param {{host: string, port: number, store: object, registry: object, log: object, cfg: object}} ctx
 */
// 断る理由ごとの HTTP の状態コード
const REFUSAL = {
  'bad-name': 400, 'blocked': 409, 'name-taken': 409, 'no-export-dir': 409, 'no-destination': 409, 'upload-failed': 502, 'not-found': 404,
  'ext-send': 409, 'no-protocol': 409, 'bad-request': 400,
};
// 拡張のページと一緒に配るファイルの種類
const EXT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** 拡張のフォルダの中のファイルだけを返す(.. などでフォルダの外を指したら null) */
function extFile(dir, rel) {
  const p = path.resolve(dir, rel);
  if (!p.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return p;
}

function startWeb({ host, port, store, registry, log, cfg, hub, ext }) {
  const server = http.createServer(async (req, res) => {
    // 断った理由を返す(知らない例外は 500 にする)
    const refuse = e => {
      if (!REFUSAL[e.code]) throw e;
      return send(res, REFUSAL[e.code], { error: e.code, message: e.message, blockers: e.blockers, others: e.others });
    };
    try {
      // DNS リバインディング対策: localhost 以外の Host 名は拒否する
      const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostName)) return send(res, 403, { error: 'forbidden host' });

      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), type);
      }
      // 拡張のページ(/ext/<名前>/ はページ、/ext/<名前>/<ファイル> は拡張のフォルダの中のファイル)
      const pm = req.method === 'GET' && url.pathname.match(/^\/ext\/([\w-]+)\/(.*)$/);
      if (pm) {
        const e = ext && ext.get(pm[1]);
        const rel = pm[2] ? decodeURIComponent(pm[2]) : e && e.page && e.page.file;
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
          return send(res, 200, out === undefined ? { ok: true } : out);
        } catch (err) {
          log.write('warn', { event: 'ext-error', detail: `[${e.name}] ${req.method} ${am[2]}: ${err.message}` });
          return send(res, REFUSAL[err.code] || 400, { error: err.code || 'ext-error', message: err.message });
        }
      }
      // 共有フォルダへ書き出す前に、同じ名前のファイルがあるか(上書きになることを確認の画面で知らせる)
      if (req.method === 'GET' && url.pathname === '/api/export-check') {
        try { return send(res, 200, { exists: hub.exportCheck(url.searchParams.get('name')).exists }); } catch (e) { return refuse(e); }
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') {
        // 一覧の印には、拡張の検査も入れる(加工条件が未設定なら送れない、など。拡張の検査はその時点の状態で行う)
        if (!store.hooks.check) return send(res, 200, store.list());
        return send(res, 200, store.list().map(e => {
          const x = store.hooks.check(e, () => store.readBody(e));
          return x.blockers.length || x.notices.length
            ? { ...e, check: { blockers: e.check.blockers.concat(x.blockers), notices: e.check.notices.concat(x.notices) } } : e;
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/log') return send(res, 200, log.list());
      if (req.method === 'GET' && url.pathname === '/api/devices') return send(res, 200, registry.list());
      if (m) {
        const entry = store.get(m[1]);
        if (!entry) return send(res, 404, { error: 'not found' });
        if (req.method === 'GET' && !m[2]) return send(res, 200, detail(store, entry, ext));
        // 送り出す操作は、どれも送信前の確認(設計書 6 章)を経て、人が名前を付けたものだけを受け付ける
        if (req.method === 'POST' && ['queue', 'export', 'send'].includes(m[2])) {
          const b = await readJson(req);
          if (b.confirmed !== true || typeof b.name !== 'string') return send(res, 400, { error: 'confirmation required' });
          try {
            if (m[2] === 'queue') {
              const e = store.queue(entry.id, b.name, { replace: b.replace === true });
              log.write('info', { event: 'queued', job: e.name, detail: entry.id });
              return send(res, 200, e);
            }
            if (m[2] === 'export') return send(res, 200, { ...store.get(entry.id), export: hub.exportJob(entry.id, b.name) });
            const r = await hub.sendTo(entry.id, b.name, b.to);
            return send(res, r.status === 0 ? 200 : 502, { ...store.get(entry.id), upload: r });
          } catch (e) {
            if (e.code === 'blocked') log.write('warn', { event: 'send-blocked', job: entry.job, detail: entry.id });
            return refuse(e);
          }
        }
        if (req.method === 'POST' && m[2] === 'unqueue') {
          store.unqueue(entry.id);
          log.write('info', { event: 'unqueued', job: entry.job, detail: entry.id });
          return send(res, 200, store.get(entry.id));
        }
        if (req.method === 'DELETE' && !m[2]) {
          store.remove(entry.id);
          log.write('info', { event: 'deleted', job: entry.job, detail: entry.id });
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log.write('error', { event: 'web', detail: e.message });
      return send(res, 500, { error: 'internal error' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { startWeb };
