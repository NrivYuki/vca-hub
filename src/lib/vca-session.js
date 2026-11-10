/*
 * vca-session.js — VCA(DCS)の通信の制御。確認応答・タイムアウト・再送(6.1.3)とセッションの手順(7 章)
 *
 * 接続方式(シリアル・TCP)には依存しない。送るバイト列は opts.send(文字列)で渡され、
 * 届いたバイト列は receive(文字列)で渡す。文字列は 1 文字 = 1 バイト。
 * 時計は opts.clock({ setTimeout, clearTimeout })で差し替えられる(テストでは偽の時計を使う)。
 *
 * ブラウザでは vca-records.js・vca-parser.js・vca-session.js の順に読み込むと window.VCA_SESSION として使える。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vca-parser.js'));
  else root.VCA_SESSION = factory(root.VCA);
})(typeof self !== 'undefined' ? self : this, function (VCA) {
  'use strict';

  const { FS, GS, ACK, NAK } = VCA.CH;

  // 既定のタイムアウト(秒)。ホストが初期化で TIMEOUT レコードを送ると変わる(6.1.3.5、2-255 秒)
  const TIMEOUTS = { ack: 6, packet: 12, char: 5 };
  const MAX_SENDS = 4;          // NAK のあとの送り直しは 3 回まで(合計 4 回、6.1.3.1)
  const CONNECT_DELAY = 3;      // TCP で接続してから最初のセッションまでデバイスが待つ秒数(7.8.2.7.4)
  // 受信中のパケットの長さの上限(文字数)。規格に上限は無いが、終わりの GS が届かないときにメモリを使い続けないための
  // 安全上限。面形状の表(141 × 141 の値など)でも数百 KB なので 1 MiB とする。opts.maxPacket で変えられる
  const MAX_PACKET = 1024 * 1024;

  // セッションの種類(7.2-7.4)。数字の要求 ID は初期化で決まる
  const UPLOAD = { TRC: 1, INS: 1, UPL: 1, CMD: 1 };   // 要求 → 応答 → データ → 応答
  const NOTIFY = { INF: 1, MNT: 1 };                   // 要求だけ(ホストは確認応答だけ返す)
  const NO_JOB = { INI: 1, TIM: 1, MNT: 1, CON: 1, LNF: 1 };

  const realClock = {
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: id => clearTimeout(id),
  };

  /**
   * 通信の失敗。code は次のどれか
   *   ack-timeout・packet-timeout・char-timeout(6.1.3)、nak(NAK が 4 回続いた)、too-large(パケットが長すぎる)、
   *   bad-confirmation(確認応答が ACK でも NAK でもない)、out-of-sync(同期ずれ。表 A.24 の 12)、
   *   job(JOB が違う)、busy(セッションの途中)、closed(接続が閉じた)
   */
  class SessionError extends Error {
    constructor(code, message) { super(message); this.name = 'SessionError'; this.code = code; }
  }

  // ---- パケットの送受信(6.1.3) -------------------------------------------------
  /**
   * 確認応答・タイムアウト・再送を受け持つ。デバイスとホストの両方が使う。
   * opts: { send, clock, crc, timeouts, maxPacket }
   *   crc: 送るパケットに CRC を付ける。付けなくても、直前に受け取ったパケットに CRC があれば応答に付ける(6.1.2.1)
   *
   * 規格に書かれていない 2 つの場面は、次のように扱う。
   *   同じパケットがもう一度届いた: こちらの ACK が相手に届かず(ノイズで NAK に化けるなど)、相手が送り直したもの。
   *     相手からまだ確認応答を受け取っていない間に、直前に受け入れたパケットとバイト単位で同じものが届いたら、
   *     ACK を返して捨てる(2 回処理しない)。相手から ACK・NAK を受け取ったら、相手は先へ進んだとみなして忘れる。
   *   確認応答を待つ間に、相手の新しいパケットが届いた: そのパケットには確認応答を返して取り置く。
   *     あとで ACK が来れば、相手はこちらのパケットを受け取ってから送ってきた(ACK が化けて届かなかった)と考え、
   *     取り置いたパケットを次のパケットとして渡す(種類が合うかは呼び出し側が確かめる)。
   *     NAK が来るか確認応答が来ないままなら、順序が崩れているので、表 A.24 の 12(Out of sync)に従い
   *     送信を out-of-sync で失敗させる。呼び出し側は STATUS=12 を送って中止する。
   */
  function createLink(opts) {
    const clock = opts.clock || realClock;
    const timeouts = Object.assign({}, TIMEOUTS, opts.timeouts);
    const maxPacket = opts.maxPacket || MAX_PACKET;
    let buf = null, charTimer = null, closed = false;
    let discarding = false;        // 長すぎるパケットを読み捨てている間
    const packets = [];            // 受け取ったが、まだ誰も待っていないパケット
    let packetWaiter = null;       // { resolve, reject, onStart }
    let confirmWaiter = null;      // 確認応答を待っている送信 { onConfirm(ch), onPacket(data), onBadChar(ch), quiet }
    let lastAccepted = null;       // 直前に受け入れたパケット(送り直しの見分けに使う)
    let peerCrc = false;           // 直前に受け入れたパケットに CRC があったか(あれば応答にも付ける、6.1.2.1)
    const warnings = [];

    function finishPacket(raw) {
      let data;
      try { data = VCA.parsePacket(raw); } catch (e) { data = null; }
      // CRC が合わない、またはレコードが 1 つも読めないパケットは NAK(6.1.3.1)
      if (!data || data.crcOk === false || !data.records.length) { opts.send(NAK); return; }
      opts.send(ACK);
      // 同じパケットの送り直し: ACK だけ返して捨てる
      if (raw === lastAccepted) { warnings.push('同じパケットがもう一度届いたので捨てました(こちらの ACK が届かなかったと考えられます)'); return; }
      lastAccepted = raw;
      peerCrc = data.crcOk === true;
      data.raw = raw;
      // 確認応答を待つ間に届いた新しいパケットは、同期ずれ
      if (confirmWaiter) { confirmWaiter.onPacket(data); return; }
      if (packetWaiter) { const w = packetWaiter; packetWaiter = null; w.resolve(data); } else packets.push(data);
    }

    function abort(err) {
      if (packetWaiter) { const w = packetWaiter; packetWaiter = null; w.reject(err); } else if (opts.onError) opts.onError(err);
    }

    /**
     * 届いたバイト列を渡す。
     * パケットが maxPacket を超えたら読み捨て(呼び出し側には too-large で知らせる)、終わりの GS が来たら NAK を返す。
     * GS で終わらないまま次の FS が来たら、前のパケットは捨てて新しいパケットとして読み直す(再同期)。
     */
    function receive(chunk) {
      if (closed) return;
      for (const c of String(chunk)) {
        if (discarding) {
          clock.clearTimeout(charTimer); charTimer = null;
          if (c === GS) { discarding = false; opts.send(NAK); continue; }
          if (c !== FS) { charTimer = clock.setTimeout(charTimeout, timeouts.char * 1000); continue; }
          discarding = false;   // 次のパケットが始まった
        }
        if (buf !== null && c === FS) {
          warnings.push('パケットが GS で終わらないまま次のパケットが始まったので、前のパケットを捨てました');
          buf = null;
        }
        if (buf !== null) {
          buf += c;
          clock.clearTimeout(charTimer);
          if (c === GS) { const raw = buf; buf = null; charTimer = null; finishPacket(raw); }
          else if (buf.length > maxPacket) {
            buf = null; discarding = true;
            warnings.push(`パケットが ${maxPacket} 文字を超えたので読み捨てます`);
            charTimer = clock.setTimeout(charTimeout, timeouts.char * 1000);
            abort(new SessionError('too-large', `パケットが ${maxPacket} 文字を超えました`));
          }
          else charTimer = clock.setTimeout(charTimeout, timeouts.char * 1000);
        } else if (c === FS) {
          buf = c;
          if (packetWaiter && packetWaiter.onStart) packetWaiter.onStart();
          charTimer = clock.setTimeout(charTimeout, timeouts.char * 1000);
        } else if (c === ACK || c === NAK) {
          lastAccepted = null;   // 相手は先へ進んだので、次に同じパケットが来ても送り直しではない
          if (confirmWaiter) confirmWaiter.onConfirm(c);
        } else if (c !== '\r' && c !== '\n') {
          warnings.push(`パケットの外で予期しない文字 0x${c.charCodeAt(0).toString(16)} を受け取りました`);
          if (confirmWaiter) confirmWaiter.onBadChar(c);
        }
      }
    }

    function charTimeout() {
      const wasDiscarding = discarding;
      buf = null; charTimer = null; discarding = false;
      if (wasDiscarding) return;   // 読み捨てていたパケットは too-large で知らせ済みなので、二度は知らせない
      abort(new SessionError('char-timeout', `パケットの受信が ${timeouts.char} 秒以上止まりました(6.1.3.4)`));
    }

    /**
     * パケットを送り、確認応答を待つ。NAK なら 3 回まで送り直す。
     * sendOpts.quiet: 確認応答を待つ間に届いたパケットを同期ずれにせず、確認応答だけ返して捨てる
     *   (STATUS=12 を送って中止するとき、相手も同時に STATUS=12 を送ってきても繰り返さないため)
     */
    async function sendPacket(records, sendOpts) {
      const quiet = !!(sendOpts && sendOpts.quiet);
      const pkt = VCA.buildPacket(records, { crc: !!opts.crc || peerCrc });
      for (let n = 1; n <= MAX_SENDS; n++) {
        if (closed) throw new SessionError('closed', '接続が閉じられました');
        let overlap = null;
        const reply = await new Promise((resolve, reject) => {
          const finish = f => v => { clock.clearTimeout(t); confirmWaiter = null; f(v); };
          const ok = finish(resolve), ng = finish(reject);
          const t = clock.setTimeout(() => ng(overlap
            ? outOfSync(overlap)
            : new SessionError('ack-timeout', `確認応答が ${timeouts.ack} 秒以内に来ません(6.1.3.2)`)), timeouts.ack * 1000);
          confirmWaiter = {
            onConfirm: c => {
              if (!overlap) return ok(c);
              if (c === NAK) return ng(outOfSync(overlap));
              packets.unshift(overlap);   // 取り置いたパケットを次のパケットとして渡す
              ok(c);
            },
            onPacket: data => { if (!quiet && !overlap) overlap = data; },
            // ACK・NAK 以外の確認応答(6.1.3.1 の注記の「Unrecognized confirmation」)
            onBadChar: c => ng(new SessionError('bad-confirmation',
              `確認応答が ACK でも NAK でもありません(0x${c.charCodeAt(0).toString(16)})。通信の設定を確かめてください`)),
            onClose: err => ng(err),   // 切断されたら、タイムアウトを待たずに失敗させる
          };
          opts.send(pkt);
        });
        if (reply === ACK) return n;
      }
      throw new SessionError('nak', `NAK が ${MAX_SENDS} 回続いたため中止しました(6.1.3.1)`);
    }

    function outOfSync(data) {
      const e = new SessionError('out-of-sync', '確認応答の代わりに相手のパケットが届きました(同期ずれ、表 A.24 の 12)');
      e.packet = data;
      return e;
    }

    /**
     * 相手のパケットを待つ。wait 秒以内に届き始めなければ失敗(null なら待ち続ける)。
     * 自分のパケットに ACK を受け取ったあとは、相手のパケットを 12 秒待つ(6.1.3.3)。
     */
    function receivePacket(wait) {
      if (packets.length) return Promise.resolve(packets.shift());
      if (closed) return Promise.reject(new SessionError('closed', '接続が閉じられました'));
      return new Promise((resolve, reject) => {
        let t = null;
        const done = f => v => { if (t) clock.clearTimeout(t); f(v); };
        packetWaiter = { resolve: done(resolve), reject: done(reject), onStart: () => { if (t) clock.clearTimeout(t); t = null; } };
        if (buf !== null) packetWaiter.onStart();
        else if (wait !== null && wait !== undefined) {
          t = clock.setTimeout(() => {
            packetWaiter = null;
            reject(new SessionError('packet-timeout', `相手のパケットが ${wait} 秒以内に届き始めません(6.1.3.3)`));
          }, wait * 1000);
        }
      });
    }

    /** 接続が閉じたときに呼ぶ。待っている受信と、確認応答を待っている送信をすぐ closed で失敗させる */
    function close() {
      if (closed) return;
      closed = true;
      clock.clearTimeout(charTimer); charTimer = null; buf = null; discarding = false;
      const err = new SessionError('closed', '接続が閉じられました');
      if (packetWaiter) { const w = packetWaiter; packetWaiter = null; w.reject(err); }
      if (confirmWaiter) confirmWaiter.onClose(err);
    }

    return { receive, sendPacket, receivePacket, close, timeouts, warnings };
  }

  // 値の取り出し
  const status = d => { const v = VCA.number(d, 'STATUS'); return v === undefined ? 0 : v; };
  // STATUS の 2 番目の欄の説明文(同じ番号でも理由が違うことがあるので、結果に一緒に入れる)
  const statusText = d => { const f = d.rec.STATUS; return f && f[1] !== undefined && f[1] !== '' ? f[1] : undefined; };
  const jobOf = d => VCA.value(d, 'JOB');
  // データのパケット(ダウンロードの応答・アップロードのデータ)で、中身の無い TRCFMT・ZFMT を警告に足す。
  // パーサーは中身の無い見出しを対応形式の候補(proposals)とみなすが、データのパケットでは R・Z を見出しの直後に置き
  // (5.4.5・5.4.6)、玉型・サグが無ければ TRCFMT=0・ZFMT=0 を送る(5.4.1)
  function checkEmptyDatasets(d) {
    d.proposals.filter(p => p.label === 'TRCFMT' || p.label === 'ZFMT').forEach(p => {
      d.warnings.push(`${p.label}=${p.fields.join(';')} のあとに${p.label === 'TRCFMT' ? '玉型' : 'サグ'}のデータがありません。` +
        `無ければ ${p.label}=0 にします(5.4.1・${p.label === 'TRCFMT' ? '5.4.5' : '5.4.6'})`);
    });
  }

  const answerType = d => (d.records[0] && d.records[0].label === 'ANS' ? String(d.records[0].fields[0] || '').toUpperCase() : null);
  const OUT_OF_SYNC = 12;   // 表 A.24 の 12(Out of sync)

  /**
   * 同期ずれ(表 A.24 の 12)で中止する。STATUS=12 のパケットを送り(相手も同時に送ってきても繰り返さないよう quiet)、
   * err を投げる。送れなくても(相手が先に中止して応答しないなど)中止は変わらない。
   */
  async function abortOutOfSync(link, type, job, err) {
    const r = [['ANS', type]];
    if (job !== undefined) r.push(['JOB', String(job)]);
    r.push(['STATUS', String(OUT_OF_SYNC), 'out of sync']);
    try { await link.sendPacket(r, { quiet: true }); } catch (e) { /* 中止は変わらない */ }
    throw err;
  }
  const syncError = msg => new SessionError('out-of-sync', msg + '(同期ずれ、表 A.24 の 12)');

  // TIMEOUT レコード(確認応答;パケット;文字間)を受け入れる(2-255 秒の範囲だけ)
  function applyTimeouts(link, d) {
    const f = VCA.fieldsOf(d, 'TIMEOUT');
    if (!f) return;
    ['ack', 'packet', 'char'].forEach(k => {
      const v = Number(f[k]);
      if (Number.isInteger(v) && v >= 2 && v <= 255) link.timeouts[k] = v;
    });
  }

  // ---- デバイス側 ------------------------------------------------------------------
  /**
   * デバイス(トレーサー・加工機など)側。セッションは必ずデバイスから始める(7.1.2)。
   * opts: {
   *   send, clock, crc, timeouts,
   *   kind: 数字の要求 ID を使うときのセッションの種類('upload' / 'download'。既定 'download')
   * }
   * 返り値のメソッドは Promise を返し、失敗は SessionError で拒否する。
   */
  function createDevice(opts) {
    const clock = opts.clock || realClock;
    const link = createLink(opts);
    let busy = false, readyAt = null;

    function wait(sec) { return new Promise(r => clock.setTimeout(r, sec * 1000)); }

    /** TCP で接続した直後に呼ぶ。最初のセッションを delay 秒(既定 3 秒)待たせる(7.8.2.7.4) */
    function connected(delay) {
      const d = delay === undefined ? CONNECT_DELAY : delay;
      readyAt = wait(d);
    }

    async function run(fn) {
      if (busy) throw new SessionError('busy', 'セッションの途中です。セッションは 1 つずつ完結させます(7.1.3)');
      busy = true;
      try {
        if (readyAt) { await readyAt; readyAt = null; }
        return await fn();
      } finally { busy = false; }
    }

    const recv = () => link.receivePacket(link.timeouts.packet);
    // 応答の種類(ANS)が要求と同じか。違えば同期ずれ
    async function expect(type, job) {
      const d = await recv();
      if (answerType(d) !== type) throw syncError(`${type} の応答を待っていたところ、${d.records[0].label}=${d.records[0].fields[0]} が届きました`);
      return d;
    }
    // 同期ずれなら STATUS=12 を送ってから失敗させる
    async function guarded(type, job, fn) {
      try { return await fn(); } catch (e) {
        if (e.code === 'out-of-sync') return abortOutOfSync(link, type, job, e);
        throw e;
      }
    }
    // 応答の JOB を確かめる(7.1.6)。違えば失敗。
    // ただし JOB の無い応答でも、STATUS が 0 以外なら断りの応答として受け取る(相手が伝えた理由を失わないため)。
    // DCS Host Simulator は、知らない要求種別に JOB を付けずに STATUS=18 を返す。このとき true を返す
    function checkJob(job, d) {
      if (job === undefined) return false;
      if (jobOf(d) === undefined && status(d) !== 0) return true;
      if (jobOf(d) !== String(job)) {
        throw new SessionError('job', `応答の JOB ${jobOf(d)} が要求の ${job} と違います(7.1.6)`);
      }
      return false;
    }
    // 初期化で送るデータの推奨との食い違い(送ることは止めない)
    //   7.2.5.2 データに DEV・VEN・MODEL を入れる
    //   7.2.4.2 定義のラベル一覧に R・A・Z・ZA を入れない(TRCFMT・ZFMT で決まる)
    //   7.2.4.5 定義のラベル一覧にインターフェイスレコード(表 A.2 の DO・JOB・TRCFMT など)を入れない
    function initWarnings(records, definition, st) {
      const w = [], sent = new Set((records || []).map(r => String(r[0]).toUpperCase()));
      const lack = ['DEV', 'VEN', 'MODEL'].filter(l => !sent.has(l));
      if (lack.length) w.push(`初期化のデータに ${lack.join('・')} がありません(7.2.5.2)`);
      if (definition && st === 0) {
        const labels = definition.labels.map(l => String(l).replace(/^\*/, '').toUpperCase());
        const data = labels.filter(l => ['R', 'A', 'Z', 'ZA'].includes(l));
        if (data.length) w.push(`ラベル一覧に ${data.join('・')} があります。玉型のレコードは TRCFMT・ZFMT で決まります(7.2.4.2)`);
        const iface = labels.filter(l => !data.includes(l) && (VCA.recordDef(l) || {}).tb === 'A.2');
        if (iface.length) w.push(`ラベル一覧にインターフェイスレコード ${iface.join('・')} があります(7.2.4.5)`);
      }
      return w;
    }

    // 自動フォーマット初期化の D レコード(1 レコードの値は 80 文字まで、7.2.4.1)
    function labelLists(labels) {
      const out = [];
      let cur = [];
      labels.forEach(l => {
        if (cur.length && (cur.concat(l).join(';')).length > 80) { out.push(['D'].concat(cur)); cur = []; }
        cur.push(l);
      });
      if (cur.length) out.push(['D'].concat(cur));
      return out;
    }

    /**
     * 初期化(7.2)。records は装置の情報(DEV・VEN・MODEL・TRCFMT など)。
     * definition: { tag, labels: ['HBOX', '*CIRC', ...] } を渡すと自動フォーマット初期化、無ければプリセット初期化。
     * 返り値: { status, hostStatus, statusText, requestId, trace, sag, drill, actions, warnings, response, host }
     *   status     ホストの最初の応答の STATUS(0 / 14 プリセットのみ / 15 初期化に非対応)
     *   hostStatus ホストのデータパケットの STATUS(形式が合わなければ 17 + 修飾ビット)
     *   trace・sag・drill ホストが選んだ玉型・サグ・穴あけの形式(sag が ['0'] ならサグは使えない)
     *   actions    ホストが ACT で返した、CMD でできる操作
     *   warnings   規格の推奨・手順との食い違い(initWarnings と、ACT を送ったのに返らない 7.6.3)
     */
    function initialize(records, definition) {
      return run(() => guarded('INI', undefined, async () => {
        await link.sendPacket([['REQ', 'INI']]);
        const response = await expect('INI');
        const st = status(response);
        if (st !== 0 && st !== 14) return { status: st, statusText: statusText(response), response };
        const data = [['ANS', 'INI']].concat(records || []);
        if (definition && st === 0) {
          data.push(['DEF', definition.tag]);
          labelLists(definition.labels).forEach(d => data.push(d));
          data.push(['ENDDEF', definition.tag]);
        }
        await link.sendPacket(data);
        const host = await expect('INI');
        applyTimeouts(link, host);
        const def = (host.all.DEF || [])[0];
        const chosen = label => { const p = host.proposals.find(x => x.label === label); return p ? p.fields : undefined; };
        // ACT を送ったなら、ホストはできる操作を ACT で返す(7.6.3)
        const sentAct = (records || []).some(r => String(r[0]).toUpperCase() === 'ACT');
        const warnings = initWarnings(records, definition, st);
        if (sentAct && !host.all.ACT && status(host) === 0) warnings.push('ホストが ACT を返しませんでした(7.6.3)');
        return {
          status: st, hostStatus: status(host), statusText: statusText(host), requestId: def ? def[1] : undefined,
          trace: chosen('TRCFMT'), sag: chosen('ZFMT') || (host.rec.ZFMT && host.rec.ZFMT[0] === '0' ? ['0'] : undefined),
          drill: VCA.value(host, 'DRLFMT'), actions: host.all.ACT ? host.all.ACT[0] : undefined, warnings, response, host,
        };
      }));
    }

    /**
     * 要求の種類に合わせてセッションを進める。type は要求種別(TRC・EDG・INF など)か要求 ID。
     * request: { job, records: 要求パケットに足すレコード, data: アップロードで送るデータのレコード, kind }
     * 返り値: { kind, status, statusText, response, final, jobMissing }
     *   status は 0 以外なら失敗で、番号によらず同じに扱えばよい(5 なら初期化をやり直す)。statusText は説明文
     *   jobMissing: 断りの応答(STATUS が 0 以外)に JOB が無かった(7.1.6 には合わないが、理由を伝えるため受け取る)
     *   アップロード(7.3): response は最初の応答、final は最後の応答
     *   ダウンロード(7.4): response がホストのデータパケット
     *   通知(INF・MNT、7.3.5・7.3.6): 確認応答だけで終わる
     */
    function request(type, req) {
      const r = req || {}, t = String(type).toUpperCase();
      const kind = r.kind || (UPLOAD[t] ? 'upload' : NOTIFY[t] ? 'notify' : /^\d+$/.test(t) ? (opts.kind || 'download') : 'download');
      const job = NO_JOB[t] ? undefined : r.job;
      return run(() => guarded(t, job, async () => {
        const head = [['REQ', t]];
        if (r.job !== undefined && !NO_JOB[t]) head.push(['JOB', String(r.job)]);
        await link.sendPacket(head.concat(r.records || []));
        if (kind === 'notify') return { kind, status: 0 };
        const response = await expect(t);
        const jobMissing = checkJob(job, response);
        if (kind === 'download' && status(response) === 0) checkEmptyDatasets(response);
        if (kind === 'download' || status(response) !== 0) {
          const res = { kind, status: status(response), statusText: statusText(response), response };
          if (jobMissing) res.jobMissing = true;   // JOB の無い断りの応答だった
          return res;
        }
        // アップロード: データパケットを送り、最後の応答を待つ
        const dataHead = [['ANS', t]];
        if (r.job !== undefined) dataHead.push(['JOB', String(r.job)]);
        await link.sendPacket(dataHead.concat(r.data || []));
        const final = await expect(t);
        checkJob(r.job, final);
        return { kind, status: status(final), statusText: statusText(final), response, final };
      }));
    }

    return { receive: link.receive, initialize, request, connected, close: link.close, link };
  }

  // ---- ホスト側 --------------------------------------------------------------------
  /**
   * ホストが要求を断るときの状態コード。起きたことの種類 → 番号(表 A.24)。
   * createHost({ statusCodes: { unsupportedRequest: 8 } }) のように番号だけ差し替えられる。
   *
   * 規格書の本文と表 A.24 が食い違う箇所があり、このライブラリは番号の意味を定めた表 A.24 に合わせている。
   *   unsupportedRequest: 本文 7.6.2(CMD)・7.7.2(LNF)は、対応しない要求種別に STATUS=8 を返すと書き、
   *     その説明を「unrecognized request type」「Invalid Request Type」としている。ところが表 A.24 では
   *     8 は「ホストの内部エラー」で、「Invalid request(ホストが要求の種類を特定できない)」は 16。
   *     表の番号は 3.02 から変わっておらず、CMD・LNF の節は 3.08-3.09 で加わったので、本文の 8 は 16 の
   *     誤記と考えて 16 を返す(規格書に理由の記載は無く、推測)。本文どおりにするには 8 に差し替える。
   *   unknownRequest: 表 A.3 にも 7.5.1 にも無い要求種別。本文に指定は無く、表 A.24 の 16 の定義に合わせた。
   *     なお DCS Host Simulator(The Vision Council)は 18 を返す。
   * 詳しくは docs/conformance.md の「規格書の中の食い違い」。
   */
  const STATUS_CODES = {
    noRequest: 18,           // REQ の無いパケット(7.1.5)
    unknownRequest: 16,      // 知らない要求種別(表 A.24 の 16。本文に指定なし)
    unsupportedRequest: 16,  // 知っているが対応していない要求種別(表 A.24 の 16。本文 7.6.2・7.7.2 は 8)
    unknownRequestId: 5,     // 知らない要求 ID(7.2.1、初期化が必要)
    invalidInit: 13,         // 初期化パケットが不正(表 A.24 の 13。プリセット初期化なのに DEF がある、7.2.5.3)
    hostError: 8,            // ホストの内部エラー(表 A.24 の 8。onInit・onRequest・onData が例外を投げたとき)
  };

  /**
   * ホスト(LMS・PC)側。デバイスの要求を待ち、手順に従って応答する。
   * opts: {
   *   send, clock, crc, timeouts,
   *   initStatus: 初期化の要求への最初の応答(0 / 14 プリセットのみ / 15 初期化に非対応。既定 0)
   *   supports:   形式の取り決めで使える形式(VCA.negotiate の host と同じ形)
   *   requestTypes: ['EDG', 'TRC', ...] このホストが対応する要求種別(省略するとすべて。INI は常に受け付ける)
   *   statusCodes: STATUS_CODES の番号の上書き
   *   timeoutsForDevice: 初期化でデバイスに送るタイムアウト { ack, packet, char }
   *   nextRequestId(): 要求 ID を作る。既定は、ホストを作った時刻(2020 年からの秒数)から始まる連番。
   *                    再起動しても、前に振った番号を長い期間繰り返さない(7.2.3.3)。1 秒に何件も振るときは自分で用意する
   *   firstRequestId:  既定の連番の始まりを決める(テスト用)
   *   actions: ['NEW', 'MERGE', 'DELETE'] CMD でできる操作。初期化に ACT が来たら、ACT で返す(7.6.3)
   *   onInit(data, reply):    初期化のデータパケットを受け取ったとき。reply にレコードを足せる
   *   onRequest(req, info):   要求を受け取ったとき。{ status, text, records } を返す
   *                           ダウンロードなら records がデータ、アップロードなら最初の応答に足すレコード。
   *                           status に 'unsupportedRequest' など STATUS_CODES の名前を書いてもよい
   *   onData(req, data, info): アップロードのデータを受け取ったとき。{ status, text, records } を返す
   *   onNotify(req):          INF・MNT を受け取ったとき
   *   onComplete(req, info, result): 要求のセッション(アップロード・ダウンロード)を終えたとき。ホストの最後のパケット
   *                           (ダウンロードならデータ、アップロードなら最後の応答)にデバイスが ACK を返したあとに呼ぶ。
   *                           result.status はそのパケットで返した STATUS。送れなかったときは呼ばない(失敗は onError へ)
   *   onError(err):           セッションの失敗と、応答の関数が投げた例外
   * }
   * 応答の関数は Promise を返してもよい。例外を投げると STATUS=8(ホストの内部エラー)と例外の文を返す。
   * CMD は onData が無ければ対応していないものとして扱う。
   */
  function createHost(opts) {
    const link = createLink(Object.assign({}, opts, { onError: e => opts.onError && opts.onError(e) }));
    const codes = Object.assign({}, STATUS_CODES, opts.statusCodes);
    const supported = opts.requestTypes ? opts.requestTypes.map(t => String(t).toUpperCase()) : null;
    const requestIds = {};   // 要求 ID → { kind, dev, tag }
    // 要求 ID の既定の連番は、作った時刻から始める(再起動で同じ番号に戻らないように、7.2.3.3)
    let counter = (opts.firstRequestId !== undefined ? opts.firstRequestId : Math.floor((Date.now() - Date.UTC(2020, 0, 1)) / 1000)) - 1;
    let stopped = false;
    const nextId = opts.nextRequestId || (() => String(++counter));

    const recv = () => link.receivePacket(link.timeouts.packet);
    // STATUS は「番号;説明文」(説明文は省略できる)
    const answer = (type, job, st, records, text) => {
      const r = [['ANS', type]];
      if (job !== undefined) r.push(['JOB', job]);
      if (st !== null) r.push(text ? ['STATUS', String(st), text] : ['STATUS', String(st)]);
      return r.concat(records || []);
    };
    const codeOf = st => (typeof st === 'string' && codes[st] !== undefined ? codes[st] : st);

    // 応答の関数を呼ぶ。例外は STATUS=8(ホストの内部エラー)にする
    async function call(fn, args) {
      if (!fn) return {};
      try { return (await fn.apply(null, args)) || {}; } catch (e) {
        if (opts.onError) opts.onError(e);
        return { status: 'hostError', text: String(e && e.message || e) };
      }
    }

    /**
     * デバイスのデータパケット(ANS=type)を待つ。種類が違えば同期ずれ。
     * デバイスが STATUS=12 を送ってきたら、デバイスはもう中止しているので、こちらからは送り返さない
     */
    async function expectData(type) {
      const d = await recv();
      if (answerType(d) === type && status(d) === OUT_OF_SYNC) {
        const e = syncError('デバイスがセッションを中止しました');
        e.noReply = true;
        throw e;
      }
      if (answerType(d) !== type) throw syncError(`${type} のデータを待っていたところ、${d.records[0].label}=${d.records[0].fields[0]} が届きました`);
      return d;
    }

    async function initSession() {
      const st = opts.initStatus === undefined ? 0 : opts.initStatus;
      await link.sendPacket(answer('INI', undefined, st));
      if (st !== 0 && st !== 14) return;
      const data = await expectData('INI');
      const neg = VCA.negotiate(data, opts.supports || {});
      const reply = [];
      const def = (data.all.DEF || [])[0];
      // プリセット初期化だけを受け付けると答えたのに DEF(自動フォーマットの定義)が来たら、初期化パケットが不正(7.2.5.3)
      if (st === 14 && def) {
        await link.sendPacket(answer('INI', undefined, codes.invalidInit, [], 'DEF is not allowed in preset initialization'));
        return;
      }
      const dev = VCA.value(data, 'DEV');
      let id = null;
      if (neg.status === 0) {
        id = nextId();
        requestIds[id] = { kind: dev && UPLOAD[String(dev).toUpperCase()] ? 'upload' : 'download', dev, tag: def ? def[0] : '', drill: neg.drill };
        reply.push(['DEF', def ? def[0] : '', id]);
      }
      neg.records.forEach(r => reply.push(r));
      // 初期化に ACT があれば、できる操作を ACT で返す(7.6.3)
      if (data.all.ACT && opts.actions) reply.push(['ACT'].concat(opts.actions));
      if (opts.timeoutsForDevice) {
        const t = opts.timeoutsForDevice;
        reply.push(['TIMEOUT', String(t.ack), String(t.packet), String(t.char)]);
      }
      const res = await call(opts.onInit, [data, reply, { requestId: id }]);
      if (res.status !== undefined) {
        if (id) delete requestIds[id];
        await link.sendPacket(answer('INI', undefined, codeOf(res.status), [], res.text));
        return;
      }
      await link.sendPacket(answer('INI', undefined, neg.status, reply));
    }

    // 同期ずれなら STATUS=12 を送ってから失敗させる(デバイスが先に中止していれば送らない)
    async function handle(req) {
      const first = req.records[0];
      const type = first && first.label === 'REQ' ? String(first.fields[0] || '').toUpperCase() : 'ERR';
      try { return await session(req); } catch (e) {
        if (e.code === 'out-of-sync' && !e.noReply) return abortOutOfSync(link, type, NO_JOB[type] ? undefined : jobOf(req), e);
        throw e;
      }
    }

    async function session(req) {
      const first = req.records[0];
      // 中止の知らせ(STATUS=12)は、確認応答だけ返して何もしない
      if (first && first.label === 'ANS' && status(req) === OUT_OF_SYNC) return;
      // REQ の無いパケットには ANS=ERR と STATUS=18(7.1.5)
      if (!first || first.label !== 'REQ') { await link.sendPacket(answer('ERR', undefined, codes.noRequest)); return; }
      const type = String(first.fields[0] || '').toUpperCase();
      const job = NO_JOB[type] ? undefined : jobOf(req);
      if (type === 'INI') return initSession();
      const numeric = /^\d+$/.test(type);
      // 知らない要求種別(表 A.3 にも 7.5.1 にも無い)
      if (!numeric && !VCA.REQUEST_TYPES[type]) {
        await link.sendPacket(answer(type, job, codes.unknownRequest)); return;
      }
      if (NOTIFY[type]) { if (opts.onNotify && (!supported || supported.indexOf(type) >= 0)) await call(opts.onNotify, [req]); return; }
      let kind = UPLOAD[type] ? 'upload' : 'download';
      if (numeric) {
        // 知らない要求 ID には STATUS=5(初期化が必要、7.2.1)
        if (!requestIds[type]) { await link.sendPacket(answer(type, job, codes.unknownRequestId)); return; }
        kind = requestIds[type].kind;
      } else if ((supported && supported.indexOf(type) < 0) || (type === 'CMD' && !opts.onData)) {
        // 知っているが対応していない要求種別。本文 7.6.2・7.7.2 は 8 だが、表 A.24 に合わせて 16(STATUS_CODES を参照)
        await link.sendPacket(answer(type, job, codes.unsupportedRequest)); return;
      }
      const info = { type, kind, job, requestId: requestIds[type] };
      const res = await call(opts.onRequest, [req, info]);
      const st = res.status !== undefined ? codeOf(res.status) : 0;
      // DRLFMT を取り決めた要求 ID には、廃止された DRILL を送らない(ラベル一覧にあっても無視する、5.5.1.5)
      const records = numeric && requestIds[type].drill && res.records ? res.records.filter(r => String(r[0]).toUpperCase() !== 'DRILL') : res.records;
      await link.sendPacket(answer(type, job, st, records, res.text));
      if (kind !== 'upload' || st !== 0) return complete(req, info, st);
      const data = await expectData(type);
      checkEmptyDatasets(data);
      const fin = await call(opts.onData, [req, data, info]);
      const fst = fin.status !== undefined ? codeOf(fin.status) : 0;
      await link.sendPacket(answer(type, job, fst, fin.records, fin.text));
      return complete(req, info, fst);
    }

    // 最後のパケットに ACK を受け取った(sendPacket が終わった)あとに呼ぶ
    async function complete(req, info, st) { await call(opts.onComplete, [req, info, { status: st }]); }

    // 要求を待ち続ける(待つあいだはタイムアウトなし)
    (async () => {
      while (!stopped) {
        let req;
        try { req = await link.receivePacket(null); } catch (e) {
          if (e.code === 'closed') return;
          if (opts.onError) opts.onError(e);
          continue;
        }
        try { await handle(req); } catch (e) {
          if (e.code === 'closed') return;
          if (opts.onError) opts.onError(e);
        }
      }
    })();

    return {
      receive: link.receive,
      close() { stopped = true; link.close(); },
      requestIds,
      link,
    };
  }

  /** オートコネクトのパケット(7.8.2.7.1)。info: { ip, port, dev, ven, model, mname, sn } */
  function autoconnectPacket(info) {
    const r = [['REQ', 'CON'], ['IP', info.ip], ['PORT', String(info.port || 50000)],
      ['DEV', info.dev], ['VEN', info.ven], ['MODEL', info.model]];
    if (info.mname) r.push(['MNAME', info.mname]);
    if (info.sn) r.push(['SN', info.sn]);
    return VCA.buildPacket(r);
  }

  return {
    TIMEOUTS, MAX_SENDS, CONNECT_DELAY, MAX_PACKET, STATUS_CODES, SessionError,
    createLink, createDevice, createHost, autoconnectPacket,
  };
});
