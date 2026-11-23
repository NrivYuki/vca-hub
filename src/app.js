'use strict';
// 各部品を組み立てて起動・停止する。テストからも同じ入口を使う。
// 接続とセッションは vca-guide の vca-tcp.js・vca-session.js が行い、応答の中身は host/session.js が作る。

const path = require('node:path');
const fs = require('node:fs');
const T = require('./lib/vca-tcp.js');
const VCA = require('./lib/vca-parser.js');
const { hostOptions, requestIdEntries } = require('./host/session.js');
const { Registry } = require('./host/registry.js');
const { Store } = require('./store/store.js');
const { Log } = require('./log.js');
const { isAllowed, allowList, peerOf, normalizeIp } = require('./net/tcp.js');
const { exportFile, exportTarget, watchFolder, fileRecords, purgeImported, cleanExportTemps, folderOverlap, reachable, isNetworkPath } = require('./send/folder.js');
const { uploadTo, uploadRecords } = require('./device/upload.js');
const { buildDownload } = require('./send/build.js');
const { Extensions } = require('./ext/extensions.js');
const { checkConfig } = require('./config.js');

const LOCAL_RETRY_MS = 10000;          // ローカル接続が切れたあと、つなぎ直すまでの時間
const PURGE_INTERVAL_MS = 3600000;     // 保存期間を過ぎたデータを消しに行く間隔
const KEEPALIVE_MS = 60000;            // 何も届かない接続で、TCP の keepalive の確かめを始めるまでの時間
const REJECT_LOG_MS = 60000;           // 同じ相手・同じ理由で断った接続は、この間に 1 度だけ記録する
const LIMITED_KEYS = 1000;             // 記録を抑えるために覚えておく相手の数
// 拡張の通信方式が終わらないときの時間切れ。送り先への送信と、待ち受けの開始(拡張がつなぐ・待つのを、vca-hub は中から止められない)
const EXT_UPLOAD_MS = 120000, EXT_LISTEN_MS = 30000;
/** Promise が ms のうちに終わらなければ、code の例外にする(元の Promise は止まらない。後で終わったときは onLate に渡す) */
function within(promise, ms, code, onLate) {
  let timer, late = false;
  const p = Promise.resolve(promise);
  p.then(v => { if (late && onLate) onLate(null, v); }, e => { if (late && onLate) onLate(e); });
  return Promise.race([p, new Promise((_, reject) => {
    timer = setTimeout(() => { late = true; reject(Object.assign(new Error(`${ms / 1000} 秒で終わりませんでした`), { code })); }, ms);
    timer.unref();
  })]).finally(() => clearTimeout(timer));
}
const AUTOCONNECT_FORGET_MS = 60000;   // オートコネクトでつなげなかった相手の設定を忘れるまでの時間(つなぐ時間切れより長く)

const fail = (code, message) => Object.assign(new Error(message), { code });
// 許可範囲の外の相手を断ったときの記録
const NOT_ALLOWED = '許可範囲(allow)の外の相手です。この機器を使うなら、config.json の allow にこのアドレスを書き足して起動し直してください';
/** つなげない理由を、現場で読める言葉にする */
function netReason(e) {
  const c = e && e.code;
  const text = { ECONNREFUSED: '相手のソフトが待ち受けていません(動いているか、ポートが合っているかを確かめてください)', ETIMEDOUT: '相手から応答がありません(電源・ネットワーク・相手のファイアウォールを確かめてください)', EHOSTUNREACH: '相手まで届きません(ネットワークを確かめてください)', ENETUNREACH: 'ネットワークに届きません', ENOTFOUND: '相手の名前が見つかりません', ECONNRESET: '相手が接続を切りました' }[c];
  return text ? `${text}(${c})` : (c || (e && e.message) || '不明');
}

/**
 * そのプロセス番号で、vca-hub(node)が動いているか。0 を送って、あるかどうかを確かめたうえで、プログラムの名前も見る
 * (電源断の後などは、止まった vca-hub の番号を別のプロセスが使っていることがあり、それだけで起動を断らないため)。
 * 名前を確かめられないときは、動いているとみなす(同じデータのフォルダを 2 つで使うより安全な側)
 */
function alive(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try {
    const cp = require('node:child_process');
    const out = process.platform === 'win32'
      ? cp.execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      // comm は、Node.js 24 ではメインのスレッドの名前(MainThread)になることがあるので、コマンドの行を見る
      : cp.execFileSync('ps', ['-p', String(pid), '-o', 'comm=,args='], { encoding: 'utf8', timeout: 5000 });
    return /node/i.test(out);
  } catch { return true; }
}

/**
 * データのフォルダを、この vca-hub だけが使うようにする(vca-hub.lock にプロセスの番号を書く)。
 * 2 つの vca-hub が同じフォルダを使うと、互いに索引を上書きして、受け取った記録が消えるため。
 * 前に書いたプロセスがもう無ければ(異常終了など)、引き継ぐ。同じプロセスの中で作り直すとき(テスト)も引き継ぐ
 * @returns {{release: Function}}
 */
function takeLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'vca-hub.lock');
  const inUse = pid => fail('data-in-use', `別の vca-hub(プロセス ${pid})が同じデータのフォルダ(${dir})を使っています。止めてから起動してください`);
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 古いロックの引き継ぎは、引き継ぎの印(.takeover)を排他で作れた 1 つの vca-hub だけが行う
    // (ほぼ同時に 2 つ起動したとき、両方が「前のプロセスは動いていない」と読んで両方とも引き継がないように)
    const takeover = file + '.takeover';
    try { fs.writeFileSync(takeover, String(process.pid), { flag: 'wx' }); } catch (e2) {
      if (e2.code !== 'EEXIST') throw e2;
      // 引き継ぎの印が新しければ、ほかの vca-hub が引き継いでいる。古ければ(引き継ぐ途中で止まった)外してやり直す
      let age = 0;
      try { age = Date.now() - fs.statSync(takeover).mtimeMs; } catch { /* 消えていればやり直せる */ }
      if (age >= 0 && age < 30000) throw inUse('引き継ぎの途中');
      try { fs.unlinkSync(takeover); } catch { /* 無ければよい */ }
      fs.writeFileSync(takeover, String(process.pid), { flag: 'wx' });
    }
    try {
      // 引き継ぎの印を作ってから読み直す(先に引き継いだ vca-hub が書いた番号を見る)
      const pid = Number(String(fs.readFileSync(file, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) throw inUse(pid);
      fs.writeFileSync(file, String(process.pid));
    } finally { try { fs.unlinkSync(takeover); } catch { /* 無ければよい */ } }
  }
  return {
    release() {
      try { if (String(fs.readFileSync(file, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* 無ければよい */ }
    },
  };
}

/**
 * @param {object} cfg loadConfig() の結果
 * @param {{echoLog?: boolean, extUploadMs?: number, extListenMs?: number, localRetryMs?: number}} [opts] extUploadMs・extListenMs は拡張の通信方式の時間切れ(既定 120 秒・30 秒。確かめのために短くする)
 */
function createHub(cfg, opts = {}) {
  checkConfig(cfg);
  // 索引などを読む・書く前に、データのフォルダを押さえる(起動に失敗する 2 つ目の vca-hub が、取り込みなどで索引を書かないように)
  const lock = takeLock(cfg.dataDir);
  const log = new Log({ dir: path.join(cfg.dataDir, 'log'), echo: !!opts.echoLog });
  const store = new Store({ dir: cfg.dataDir, removePII: cfg.removePII });
  const registry = new Registry({ file: path.join(cfg.dataDir, 'devices.json') });
  // 消せなかったファイル(ほかのソフトが開いているなど)。あとで消し直す
  // ファイルの名前には、受け取った JOB や取り込んだファイルの名前が入るので、記録には理由だけを書く
  store.hooks.deleteFailed = (file, e) => log.write('warn', { event: 'delete-failed', detail: `ファイルを消せません(${e.code || e.message})。あとで消し直す` });
  // 拡張(設計書 13 章)。config.json の extensions に書いたものだけを読む。読めなければ例外(起動しない)
  const ext = new Extensions({ dir: cfg.extensionsDir, enabled: cfg.extensions, dataDir: cfg.dataDir, store, log });
  if (ext.list.length) {
    store.hooks.saved = (entry, body) => ext.received(entry, body);
    store.hooks.removed = id => ext.removed(id);
    store.hooks.check = (entry, readBody) => ext.check(entry, readBody);
    store.hooks.queued = entry => ext.queued(entry);
  }
  // 索引・要求 ID の記録が読めず、1 つ前のもの(.bak)から読んだ。最後の変更が抜けていることがある
  if (store.recovered) {
    const r = store.recoveryReport;
    log.write('error', { event: 'index-recovered', detail: `索引を 1 つ前のものから読み、ファイルと突き合わせた(${store.recovered})。ファイルの無い記録を外した ${r.dropped.length} 件、登録し直した ${r.readded.length} 件、送信待ちから外した ${r.unqueued.length} 件(確かめ直してから送信待ちに戻す)` });
    for (const id of r.unqueued) log.write('warn', { event: 'unqueued-by-recovery', detail: id });
    // 索引から外した記録の、拡張が残した情報も消す
    for (const id of r.dropped) if (id) ext.removed(id);
  }
  if (registry.recovered) log.write('error', { event: 'index-recovered', detail: `要求 ID の記録を 1 つ前のものから読んだ(${registry.recovered})` });

  /**
   * 送るレコードを作る: 送り先に合わせて組み立て(値は変えない)、拡張の send を通す。
   * @param {object} to { kind: 'device', profile, device } | { kind: 'file' } | { kind: 'destination', dest }
   */
  function recordsFor(entry, to) {
    const body = store.readBody(entry);
    const base = to.kind === 'device' ? buildDownload({ body, profile: to.profile || null, device: to.device || null })
      : to.kind === 'file' ? fileRecords(body) : uploadRecords(body);
    return ext.list.length ? ext.send(entry, body, base, to) : base;
  }
  ext.app = { recordsFor };

  // ---- 通信方式(設計書 13 章): 口ごとに、VCA(DCS)か拡張が足した通信方式かを選ぶ ----
  const isVca = p => p === undefined || p === null || String(p).toLowerCase() === 'vca';
  /** 口の通信方式を確かめる。VCA なら null、拡張の通信方式ならその定義。無い・使えないなら例外(起動しない) */
  function protocolFor(where, p, need) {
    if (isVca(p)) return null;
    const pr = ext.protocol(p);
    if (!pr) throw fail('no-protocol', `${where} の通信方式 ${p} がありません(足す拡張を config.json の extensions に入れてください)`);
    if (typeof pr.impl[need] !== 'function') throw fail('no-protocol', `${where} の通信方式 ${p} は、${need} に対応していません`);
    return pr;
  }
  const ioFor = (name, protocol) => ext.protocolIo({ name, protocol, allowed: ip => isAllowed(ip, cfg.allow), timeouts: cfg.timeouts });
  // 起動する前に、すべての口の通信方式を確かめる
  protocolFor('リモート接続(remote)', cfg.remote.protocol, 'listen');
  for (const l of cfg.listeners) protocolFor(`待ち受け ${l.name}(listeners)`, l.protocol, 'listen');
  for (const d of cfg.local) protocolFor(`ローカル接続 ${d.name}(local)`, d.protocol, 'connect');
  for (const d of cfg.destinations) protocolFor(`送り先 ${d.name}(destinations)`, d.protocol, 'upload');

  const hosts = new Set();       // つないでいる機器とのセッション(createHost)
  const closers = [];
  const ports = {};

  // 接続ごとのセッションの設定。初期化で割り当てた要求 ID は、つないでいるほかの接続にも知らせる
  // (createHost は要求 ID を接続ごとに持つため。機器がつなぎ直しても STATUS=5 にならないように)
  function sessionOpts(peer) {
    const o = hostOptions({ store, registry, log, peer, recordsFor });
    const onInit = o.onInit;
    o.onInit = (...args) => {
      // 初期化を断ったとき(ラベル一覧が正しくないなど)は、その STATUS を createHost へ返す
      const r = onInit(...args);
      if (r && r.status !== undefined) return r;
      const entries = requestIdEntries(registry);
      // 記録から消えた(数の上限で古いものから消した)要求 ID は、つないでいる接続からも外す
      for (const h of hosts) {
        for (const id of Object.keys(h.requestIds)) if (!entries[id]) delete h.requestIds[id];
        Object.assign(h.requestIds, entries);
      }
    };
    return { ...o, timeouts: cfg.timeouts };
  }
  // 接続が切れたら、その接続が送っている途中だったデータを放す(host/session.js の onClose。createHost は呼ばない)
  // あわせて TCP の keepalive を使う。相手の電源が落ちたときなど、閉じた知らせが届かない接続も、
  // 確かめの応答が無ければ OS が閉じる(close が来て、送っている途中のデータと接続の数を放す)。
  // 何も送らない接続を時間で閉じることはしない(4 章)。確かめは TCP の層で行い、DCS のセッションには影響しない
  const releaseOnClose = (socket, o) => {
    socket.setKeepAlive(true, KEEPALIVE_MS);
    socket.once('close', () => o.onClose());
  };

  function attached(host, peer) {
    Object.assign(host.requestIds, requestIdEntries(registry));
    hosts.add(host);
    log.write('info', { event: 'connected', peer });
    host.socket.once('close', () => { hosts.delete(host); log.write('info', { event: 'disconnected', peer }); });
  }

  /** ローカル接続: 機器が待ち受けているポートへ接続し、切れたら一定時間後につなぎ直す。 */
  function connectLocal(dev) {
    let stopped = false, timer = null, current = null;
    const peer = `${dev.name}(${dev.host}:${dev.port})`;
    const retry = () => { if (!stopped) timer = setTimeout(attempt, opts.localRetryMs ?? LOCAL_RETRY_MS); };
    async function attempt() {
      if (stopped) return;
      if (!isAllowed(dev.host, cfg.allow)) { log.write('warn', { event: 'rejected', peer, detail: NOT_ALLOWED }); return; }
      let host;
      const o = sessionOpts(peer);
      try { host = await T.connectHost(dev.host, dev.port, o); } catch (e) {
        logLimited(`local ${peer} ${e.code || e.message}`, n => log.write('warn', { event: 'local-connect', peer, detail: `つなげません: ${netReason(e)}。${(opts.localRetryMs ?? LOCAL_RETRY_MS) / 1000} 秒ごとにやり直す${skippedNote(n)}` }));
        retry();
        return;
      }
      releaseOnClose(host.socket, o);
      if (stopped) { host.socket.destroy(); return; }
      current = host.socket;
      attached(host, peer);
      host.socket.once('close', () => { current = null; retry(); });
    }
    attempt();
    return () => { stopped = true; clearTimeout(timer); if (current) current.destroy(); };
  }

  // ---- 送り出し(どれも、人が付けた名前で送る。設計書 6 章) ----
  /**
   * 送り出せるかを確かめ、使う名前を決める。名前は、送り出しに成功してから付ける(失敗したのに名前だけ変わらないように)。
   * 送信待ちのものは、名前を変えて送り出さない(加工機が求める名前と食い違うため。設計書 6 章)
   * @returns {{entry: object, name: string, named: object}} named は、送り出しに使う名前を付けた記録の写し
   */
  function sendable(id, name) {
    const entry = store.get(id);
    if (!entry) throw fail('not-found', 'データがありません');
    store.assertSendable(entry);
    const n = Store.checkName(name);
    if (entry.status === 'queued' && entry.name !== n) {
      throw fail('queued-rename', `送信待ちのデータの名前(${entry.name})は変えられません。名前を変えるときは、送信待ちから外してください`);
    }
    return { entry, name: n, named: { ...structuredClone(entry), name: n } };
  }

  /** 共有フォルダへ書き出す前に、同じ名前のファイルがあるか(あれば上書きになる)。 */
  function exportCheck(name) {
    if (!cfg.exportDir) throw fail('no-export-dir', '書き出し先(exportDir)が設定されていません');
    return exportTarget(cfg.exportDir, Store.checkName(name));
  }

  /** 共有フォルダへ書き出す。同じ名前のファイルは、確認の画面で上書きを確かめたとき(overwrite)だけ上書きし、ログに残す。 */
  function exportJob(id, name, { overwrite = false } = {}) {
    if (!cfg.exportDir) throw fail('no-export-dir', '書き出し先(exportDir)が設定されていません');
    const { entry, name: n, named } = sendable(id, name);
    const r = exportFile(cfg.exportDir, n, store.readBody(entry), recordsFor(named, { kind: 'file', dir: cfg.exportDir }), { overwrite });
    store.setName(id, n);
    store.recordSent(id, `フォルダ ${r.file}`);
    log.write(r.overwrote ? 'warn' : 'info', { event: 'exported', job: n, detail: `${entry.id}${r.overwrote ? ' 上書き' : ''}` });
    return r;
  }

  // 送り先へ送っている途中のデータ(同じデータを、送り終える前にもう一度送らない。画面のボタンを 2 度押したときなど)
  const uploading = new Set();

  /** 別の PC やソフト(送り先)へアップロードする(機器役。設計書 5 章)。 */
  async function sendTo(id, name, destName) {
    const dest = cfg.destinations.find(d => d.name === destName);
    if (!dest) throw fail('no-destination', `送り先 ${destName} が設定されていません`);
    if (uploading.has(id)) throw fail('uploading', 'このデータは、送り先へ送っている途中です');
    uploading.add(id);
    try { return await sendToOnce(id, name, dest); } finally { uploading.delete(id); }
  }

  async function sendToOnce(id, name, dest) {
    const { entry, name: n, named } = sendable(id, name);
    const to = `${dest.name}(${dest.host}:${dest.port})`;
    const pr = protocolFor(`送り先 ${dest.name}`, dest.protocol, 'upload');
    const records = recordsFor(named, {
      kind: 'destination', protocol: pr ? dest.protocol : 'vca',
      dest: { name: dest.name, host: dest.host, port: dest.port, type: dest.type || 'UPL' },
    });
    let r;
    try {
      r = pr
        // 拡張の通信方式: VCA のレコードを渡し、メーカーの形に直して送るのは拡張
        // 終わらなければ時間切れにする(送っている途中の印が外れず、そのデータを送れなくなるため)。時間切れの後に届いたと分かったら、送った記録を残す
        ? await within(pr.impl.upload({ dest: structuredClone(dest), name: n, entry: named, records }, ioFor(to, dest.protocol)), opts.extUploadMs ?? EXT_UPLOAD_MS, 'timeout', (err, late) => {
          if (err || !late || late.status !== 0) { log.write('warn', { event: 'upload', peer: to, job: n, detail: `時間切れの後に終わった: ${err ? err.code || err.message : `STATUS=${late && late.status}`}` }); return; }
          try { store.setName(id, n); } catch { /* 送信待ちで別の名前になっているときなどは、記録だけ */ }
          try { store.recordSent(id, `${to} ${n}`); } catch { /* 消されていれば記録だけ */ }
          log.write('warn', { event: 'uploaded', peer: to, job: n, result: 'STATUS=0', detail: `${id} 時間切れの後に届いた` });
        })
        : await uploadTo(dest, { body: store.readBody(entry), name: n, records, timeouts: cfg.timeouts, connectDelay: cfg.connectDelay });
      if (!r || !Number.isInteger(r.status)) throw new Error('送った結果(status)がありません');
    } catch (e) {
      // 届いたか分からない(データに ACK を受けた後で切れた・最後の応答に STATUS が無い、拡張の送信が時間切れ)。
      // 送れなかったときと分けて知らせる(送り直すと、送り先に同じジョブが 2 度届くことがあるため)。送信済みにはしない
      if (e.code === 'unconfirmed' || (pr && e.code === 'timeout')) {
        log.write('error', { event: 'upload-unconfirmed', peer: to, job: n, detail: `${entry.id} ${e.message}` });
        throw fail('upload-unconfirmed', `送り先に届いたか分かりません(${e.message})。送り直す前に、送り先で受け取ったかを確かめてください`);
      }
      log.write('warn', { event: 'upload', peer: to, job: n, detail: e.code || e.message });
      throw fail('upload-failed', `送り先 ${to} へ送れませんでした: ${e.code === 'no-request-id' ? e.message : netReason(e)}`);
    }
    for (const w of r.warnings || []) log.write('warn', { event: 'uploaded', peer: to, job: n, detail: `${entry.id} ${w}` });
    if (r.status === 0) {
      // 送り先には届いた。送っている間に別の名前で送信待ちにされていて名前を付けられなくても、送った記録は必ず残す
      try { store.setName(id, n); } catch (e) {
        log.write('warn', { event: 'uploaded', peer: to, job: n, detail: `${id} ${n} として送ったが、名前は付けられなかった(${e.code || e.message})` });
      }
      store.recordSent(id, `${to} ${n}`);
    }
    log.write(r.status === 0 ? 'info' : 'warn', { event: 'uploaded', peer: to, job: n, result: `STATUS=${r.status}`, detail: entry.id });
    return r;
  }

  /**
   * data/ext/<名前>/ の中の受信データごとの情報のうち、索引に無く、保存期間を過ぎたものを消す。
   * 名前が受信データの id の形(20261120-143005-abcde.json)のものだけを見る(拡張そのものの鍵などは消さない)
   */
  function sweepExtData(days, now = Date.now()) {
    const out = [];
    const base = path.join(cfg.dataDir, 'ext');
    const limit = now - days * 86400000;
    let names = [];
    try { names = fs.readdirSync(base); } catch { return out; }
    // 索引の id は一度だけ集める(ファイルごとに索引を探すと、件数とファイル数の積で長く止まるため)
    const ids = new Set(store.index.map(e => e.id));
    for (const name of names) {
      let files = [];
      try { files = fs.readdirSync(path.join(base, name)); } catch { continue; }
      for (const f of files) {
        // 書く途中で止まった一時ファイル(.json.tmp)も消す
        const m = f.match(/^(\d{8}-\d{6}-[a-z0-9]+)\.json(?:\.tmp)?$/);
        if (!m || ids.has(m[1])) continue;
        const p = path.join(base, name, f);
        try { if (fs.statSync(p).mtimeMs < limit) { fs.unlinkSync(p); out.push(path.join('ext', name, f)); } } catch { /* 次の回にもう一度試す */ }
      }
    }
    return out;
  }

  // 保存期間の「今」: 起動したときの時計に、動いている間の経過時間(単調な時計)を足す。
  // 動いている間に時計を変えられても(手で直す・年を打ち間違える)、その分を経過したとして一度に消さないため
  const clockBase = { wall: Date.now(), mono: performance.now() };
  // 時計を戻したとき(進んでいたのを直したとき)は、すぐに時計に従う(今日のログや受け取ったばかりのデータを消さないため)。
  // 進めたときは、起動し直すまで経過した時間だけを数える(年の打ち間違いなどで一度に消さないため)
  const retentionNow = () => Math.min(clockBase.wall + (performance.now() - clockBase.mono), Date.now());
  /**
   * 保存期間を過ぎたものを消し、前に消せなかったファイルを消し直す。
   * 1 つが失敗しても、ほかは続け、例外を外へ出さない(一定の間隔で呼ぶので、例外で vca-hub を止めない)
   */
  function purge() {
    const nowMs = retentionNow(), now = new Date(nowMs);
    const skew = Date.now() - nowMs;
    if (Math.abs(skew) > 3600000) {
      logLimited('clock-skew', n => log.write('warn', { event: 'clock-skew', detail: `PC の時計が、起動してから ${Math.round(skew / 60000)} 分ずれました。保存期間は、起動したときの時計から数えます。時計を直したときは、vca-hub を起動し直してください${skippedNote(n)}` }));
    }
    const step = (what, fn) => {
      try { fn(); } catch (e) { log.write('warn', { event: 'purge-failed', detail: `${what} ${e.code || e.message}` }); }
    };
    // 書き出しの途中で止まったときの一時ファイル(保存期間によらず消す)
    // 消したものは数だけを書く(ファイルの名前に、名前・JOB・取り込んだファイルの名前が入るため。設計書 7 章)
    const counted = (event, list) => { if (list.length) log.write('info', { event, detail: `${list.length} 件` }); };
    // 共有フォルダは届くかを確かめてから(届かない共有フォルダの読み取りで vca-hub を止めない)
    const whenReachable = (dir, fn) => { if (!isNetworkPath(dir)) fn(); else reachable(dir).then(ok => { if (ok) fn(); }); };
    if (cfg.exportDir) whenReachable(cfg.exportDir, () => step('書き出しの一時ファイル', () => counted('purged-temp', cleanExportTemps(cfg.exportDir))));
    step('送信済みの書き直し', () => { for (const id of store.retrySent()) log.write('info', { event: 'sent', detail: `${id} 送信済みを書き直した` }); });
    step('消し直し', () => counted('purged-retry', store.retryDeletes()));
    if (!(cfg.retentionDays > 0)) return;
    step('受信データ', () => {
      for (const e of store.purge(cfg.retentionDays, now)) log.write('info', { event: 'purged', detail: e.id });
      // 保存期間を大きく過ぎたものは消さずに残した(受け取ったときに時計が遅れていたかもしれない)。人が確かめて消す
      const held = store.purgeHeld;
      if (held) logLimited('purge-held', n => log.write('warn', { event: 'purge-held', detail: `保存期間を 30 日より多く過ぎた受信データが ${held} 件あり、消さずに残しました。受け取ったときに PC の時計が遅れていたかもしれません。管理画面で受け取った時刻と中身を確かめて、要らなければ消してください${skippedNote(n)}` }));
    });
    // 索引に無いまま残ったファイル(異常終了・1 つ前の索引から読んだときなど)
    step('索引に無いファイル', () => counted('purged-orphan', store.sweepOrphans(cfg.retentionDays, now)));
    // 拡張が受信データごとに残した情報(data/ext/<名前>/<id>.json)のうち、索引に無いもの(拡張を外したあとなど)
    step('拡張の情報', () => counted('purged-orphan', sweepExtData(cfg.retentionDays, nowMs)));
    // 受信データのほかに、ジョブ番号の残るログと、取り込んだ元のファイルも同じ期間で消す
    step('ログ', () => { const logs = log.purge(cfg.retentionDays, now); if (logs.length) log.write('info', { event: 'purged-log', detail: logs.join(' ') }); });
    // 取り込んだファイルの名前は装用者の名前のことがあるので、数だけを書く
    if (cfg.importDir) whenReachable(cfg.importDir, () => step('取り込んだファイル', () => { const n = purgeImported(cfg.importDir, cfg.retentionDays, now).length; if (n) log.write('info', { event: 'purged-import', detail: `${n} 件` }); }));
  }

  // 断った接続の記録。同じ相手・同じ理由は REJECT_LOG_MS に 1 度だけ書き、その間に断った数を次の記録に添える
  // (接続を繰り返す相手で、ログが膨らみ、画面の記録からほかの記録が押し出されないように)
  const limited = new Map();   // 記録の種類と相手 → { at, count }
  /**
   * 同じ key の記録を REJECT_LOG_MS に 1 度だけ書く。write には、前の記録から書かずに数えた回数を渡す。
   * 覚えておく key は LIMITED_KEYS までとし、超えたら(相手が多すぎる)1 つの key にまとめる
   */
  function logLimited(key, write) {
    const now = Date.now();
    if (!limited.has(key) && limited.size >= LIMITED_KEYS) {
      for (const [k, v] of limited) if (now - v.at >= REJECT_LOG_MS) limited.delete(k);
      if (limited.size >= LIMITED_KEYS) key = '(相手が多すぎるため、まとめた記録)';
    }
    const r = limited.get(key);
    // 時計が戻ったとき(今が前の記録の時刻より前)は、戻った分だけ記録が出なくならないよう、間引きをやめて書く
    if (r && now >= r.at && now - r.at < REJECT_LOG_MS) { r.count++; return; }
    limited.set(key, { at: now, count: 0 });
    write(r ? r.count : 0);
  }
  const skippedNote = n => (n ? ` (この前の記録から、ほかに ${n} 回)` : '');
  function logRejected(socket, reason) {
    const ip = normalizeIp(socket.remoteAddress);
    logLimited(`rejected ${ip} ${reason}`, n => log.write('warn', { event: 'rejected', peer: peerOf(socket), detail: reason + skippedNote(n) }));
  }

  // 待ち受け(VCA)で開いている接続。相手の IP ごとの数と全体の数を限る(設計書 4 章)
  const open = new Map();   // IP → 数
  let openTotal = 0;
  /** 上限を超えるなら断る理由を返す。受けるなら数に入れ、切れたら数から外す */
  function connectionLimit(socket) {
    const ip = normalizeIp(socket.remoteAddress);
    const lim = cfg.connections || {};
    if (lim.total > 0 && openTotal >= lim.total) return `同時に開いておける接続の数(全体 ${lim.total})を超えました(config.json の connections)`;
    if (lim.perAddress > 0 && (open.get(ip) || 0) >= lim.perAddress) return `この相手から同時に開いておける接続の数(${lim.perAddress})を超えました(config.json の connections)`;
    open.set(ip, (open.get(ip) || 0) + 1);
    openTotal++;
    socket.once('close', () => {
      openTotal--;
      const n = (open.get(ip) || 1) - 1;
      if (n) open.set(ip, n); else open.delete(ip);
    });
    return null;
  }

  /**
   * 待ち受ける。VCA なら DCS のリモート接続(機器がつないでくる)、拡張の通信方式なら拡張の listen。
   * @returns {Promise<number>} 待ち受けたポート
   */
  async function listen({ name, port, protocol, settings }) {
    const pr = protocolFor(`待ち受け ${name}`, protocol, 'listen');
    if (pr) {
      // 終わらなければ起動を止める(後の待ち受け・ローカル接続・管理画面が、起動しないまま残らないように)
      const l = await within(pr.impl.listen({ name, port, settings: structuredClone(settings || {}) }, ioFor(name, protocol)), opts.extListenMs ?? EXT_LISTEN_MS, 'ext-listen')
        .catch(e => { throw fail('ext-listen', `待ち受け ${name}(通信方式 ${protocol})を始められません(${e.code || e.message})`); });
      if (l && typeof l.close === 'function') closers.push(() => l.close());
      return l && l.port !== undefined ? l.port : port;
    }
    const server = await T.listenHost(port, socket => {
      if (!isAllowed(socket.remoteAddress, cfg.allow)) {
        logRejected(socket, NOT_ALLOWED);
        return null;
      }
      const full = connectionLimit(socket);
      if (full) {
        logRejected(socket, full);
        return null;
      }
      const o = sessionOpts(peerOf(socket));
      releaseOnClose(socket, o);
      return o;
    }, host => attached(host, peerOf(host.socket)));
    closers.push(() => new Promise(r => server.close(r)));
    return server.address().port;
  }

  async function start() {
    allowList(cfg.allow);   // 許可する範囲の書き損じがあれば、待ち受ける前に止める
    // ローカル接続の相手も、許可範囲の中に書く(外なら一度もつながないまま黙って止まるので、起動しない)
    const outside = cfg.local.filter(d => !isAllowed(d.host, cfg.allow));
    if (outside.length) throw fail('config', `ローカル接続の相手 ${outside.map(d => `${d.name}(${d.host})`).join('、')} が、許可範囲(allow)の外です。その加工機を使うなら allow に書き足し、使わないなら local から消してください(機器から接続してくるなら remote の待ち受けで受けるので、local は要りません)`);
    // 書き出したものを取り込み直さないよう、書き出し先と取り込むフォルダが重なれば起動しない
    const overlap = folderOverlap(cfg.exportDir, cfg.importDir);
    if (overlap) throw fail('folder-overlap', overlap);
    // 保存期間が無期限でも、消せなかったファイルの消し直しのために回す
    purge();
    const purgeTimer = setInterval(purge, PURGE_INTERVAL_MS);
    closers.push(() => clearInterval(purgeTimer));
    if (cfg.importDir) {
      const w = watchFolder({ dir: cfg.importDir, store, log });
      closers.push(() => w.stop());
    }
    if (cfg.autoconnect.enabled) {
      // 知らせてきた IP が送り主と同じで、許可範囲の中のときだけつなぐ(設計書 4 章)
      // つなぐ前に作った接続ごとの設定は、知らせ(con)と結び付けておき、つないだ後に接続(ソケット)と結び付ける
      // (listenAutoconnect は、connectOpts と onHost に同じ知らせを渡す。つなぐのに時間がかかっても、切れたときに放せるように)
      const optsOf = new WeakMap();
      // つなぎに行っている途中の数(IP ごと)。接続の数の上限(connections)に、つないだ接続と合わせて数える
      // (知らせの送り主は偽れるので、知らせを繰り返されても、つなぎに行く数が増え続けないように)。
      // つなげなかったときは結び付ける接続が来ないので、しばらくしたら数から外す
      const pending = new Map();
      const pendingOf = ip => pending.get(ip) || 0;
      const unpend = ip => { const n = pendingOf(ip) - 1; if (n > 0) pending.set(ip, n); else pending.delete(ip); };
      const udp = await T.listenAutoconnect(cfg.autoconnect.port, {
        allow: ({ ip, from }) => {
          if (ip !== from || !isAllowed(ip, cfg.allow)) return false;
          const lim = cfg.connections || {}, n = normalizeIp(ip);
          let total = 0;
          for (const v of pending.values()) total += v;
          if (lim.total > 0 && openTotal + total >= lim.total) return false;
          if (lim.perAddress > 0 && (open.get(n) || 0) + pendingOf(n) >= lim.perAddress) return false;
          return true;
        },
        // 知らせは許可範囲の外からも届くので、同じ相手・同じ理由の記録は 1 分に 1 度にする(ログが膨らまないように)
        onIgnore: (reason, info) => logLimited(`autoconnect-ignored ${info.from || info.ip} ${reason}`, n =>
          log.write('warn', { event: 'autoconnect-ignored', peer: `${info.ip}:${info.port}`, detail: reason + skippedNote(n) })),
        onError: e => logLimited(`autoconnect ${e.code || e.message}`, n => log.write('warn', { event: 'autoconnect', detail: (e.code || e.message) + skippedNote(n) })),
        connectOpts: ({ ip, port, con }) => {
          const n = normalizeIp(ip);
          const o = sessionOpts(`${ip}:${port}`);
          const slot = { ip: n, done: false };
          pending.set(n, pendingOf(n) + 1);
          setTimeout(() => { if (!slot.done) { slot.done = true; unpend(n); } }, AUTOCONNECT_FORGET_MS).unref();
          optsOf.set(con, { o, slot });
          return o;
        },
      }, (host, con) => {
        const got = optsOf.get(con);
        optsOf.delete(con);
        if (got && !got.slot.done) { got.slot.done = true; unpend(got.slot.ip); }
        if (got) releaseOnClose(host.socket, got.o);
        // つないだ接続を数に入れる(つなぎに行っている間に、ほかの接続で上限に届いていたら切る)
        const full = connectionLimit(host.socket);
        if (full) { logRejected(host.socket, full); host.socket.destroy(); return; }
        attached(host, peerOf(host.socket));
      });
      ports.autoconnect = udp.address().port;
      closers.push(() => new Promise(r => udp.close(r)));
    }
    if (cfg.remote.enabled) ports.remote = await listen({ name: 'リモート接続', port: cfg.remote.port, protocol: cfg.remote.protocol, settings: cfg.remote.settings });
    // 追加の待ち受け(VCA の口とメーカーの口を並べるときなど)
    ports.listeners = {};
    for (const l of cfg.listeners) ports.listeners[l.name] = await listen(l);
    for (const dev of cfg.local) {
      const pr = protocolFor(`ローカル接続 ${dev.name}`, dev.protocol, 'connect');
      if (!pr) { closers.push(connectLocal(dev)); continue; }
      const peer = `${dev.name}(${dev.host}:${dev.port})`;
      const r = pr.impl.connect({ name: dev.name, host: dev.host, port: dev.port, settings: structuredClone(dev.settings || {}) }, ioFor(peer, dev.protocol));
      // 止める関数を返す決まり。Promise を返したら、解決した止める関数を使う(失敗したら、その口が動いていないことを記録に残す)
      let stopIt = typeof r === 'function' ? r : null;
      if (r && typeof r.then === 'function') {
        r.then(fn => { if (typeof fn === 'function') stopIt = fn; },
          e => log.write('error', { event: 'ext', peer, detail: `ローカル接続を始められません: ${e && (e.code || e.message)}` }));
      }
      closers.push(async () => { if (stopIt) await stopIt(); });
    }
    if (cfg.web.enabled) {
      const { startWeb } = require('./web/server.js');
      const web = await startWeb({ host: cfg.web.host, port: cfg.web.port, store, registry, log, cfg, hub: api, ext });
      ports.web = web.address().port;
      // 送っている途中の要求(本文を送り切らない要求など)があっても閉じる(待つと、ほかの口を閉じる前に止まるため)
      closers.push(() => new Promise(r => { web.close(r); web.closeAllConnections(); }));
    }
    log.write('info', { event: 'started', detail: `リモート接続のポート ${ports.remote ?? 'なし'}、管理画面のポート ${ports.web ?? 'なし'}${ext.list.length ? `、拡張 ${ext.list.map(e => e.name).join('・')}` : ''}` });
    return ports;
  }

  async function stop() {
    for (const h of hosts) h.socket.destroy();
    for (const c of closers.splice(0).reverse()) await c();
    lock.release();
  }

  const isUploading = id => uploading.has(id);
  store.hooks.busy = isUploading;
  const uploadingIds = () => [...uploading].sort();
  const api = { start, stop, store, registry, log, ports, cfg, ext, exportCheck, exportJob, sendTo, isUploading, uploadingIds, purge, recordsFor };
  return api;
}

module.exports = { createHub };
