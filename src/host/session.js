'use strict';
// ホスト役のセッション処理(DCS 7 章、設計書 5 章)。
// パケットの送受信とセッションの手順は vca-guide の vca-session.js(createHost)が行い、
// ここでは createHost に渡す応答の関数(初期化・要求・アップロードのデータ・通知・完了)を作る。

const VCA = require('../lib/vca-parser.js');
const { buildDownload, traceWant } = require('../send/build.js');
const { FORMATS } = require('../lib/trace.js');

// ダウンロードの要求種別(7.4.3)。どれも、送信待ちのデータをその種類のプリセットの項目一式で返す
const DOWNLOAD_TYPES = ['PTG', 'EDG', 'FBK', 'SBK', 'GEN', 'AGN', 'COA', 'FSG', 'LMD', 'DNL'];
// 対応する要求種別(設計書 5 章)。これ以外の、規格にある種別(CMD・LNF など)には STATUS=16 を返す(createHost の unsupportedRequest)
const REQUEST_TYPES = ['TRC', 'UPL', 'INS', ...DOWNLOAD_TYPES, 'TIM', 'INF', 'MNT'];
// 初期化の形式の取り決め(5.4.17)。サグは中継しない(ZFMT=0 で答える)。文字コードは ASCII だけ
// 穴あけの基準は 3 つとも受ける。保存した DRILLE の基準と合わなければ、渡すときに断る(STATUS=4。5.5.3)
// 角度のモード C は、アップロードする機器(トレーサーなど)のために受ける。加工機向けには chooseTrace が E・U だけを選ぶ
const SUPPORTS = { trace: { formats: FORMATS, modes: ['E', 'U', 'C'] }, sag: false, encodings: ['ASCII'], drill: ['C', 'E', 'B'] };
const HOST_INFO = [['HVEN', 'vca-hub'], ['HMODEL', 'vca-hub'], ['HVER', '0.2.0']];
// createHost と同じ決め方: アップロードする機器(DEV)の要求 ID はアップロードのセッションにする
const UPLOAD_DEVICES = new Set(['TRC', 'INS', 'UPL', 'CMD']);
// ほかの機器へ送っている途中のジョブを求められたときの STATUS(表 A.24 の 11: 受け手が忙しく、いまは要求に応えられない)
const BUSY = 11;
// 初期化のラベル一覧に置けるラベルの数(規格のラベルは約 500)
const MAX_INIT_LABELS = 1000;
// 玉型の点数として受ける範囲。規格に上限は無いが、作り直す点数に上限が無いと、1 つの応答が際限なく大きくなるため。
// 上限は 360 度を 0.1 度刻みで表せる 3600 点とする(規格の例は 400 点)
const MIN_TRACE_POINTS = 3, MAX_TRACE_POINTS = 3600;
// 1 つの欄の値の長さの上限(附属書 D: 3.13 で 80 文字から 255 文字に広げた)
const MAX_VALUE = 255;
// 加工機に渡せなかった理由(記録に書く。理由の文には値が入るので、値を含まない説明だけを書く)
const REFUSAL_TEXT = {
  'drill-reference': '穴あけの基準がこの加工機と合わない(DRILLE・DRILL・DRLFMT)',
  'trace-unconvertible': '玉型(角度のモード C など)をこの加工機の形式に作り直せない',
  'dataset-format': 'シェルフ・切り抜き・厚みのデータセットの形式が、取り決めと違う',
  'device-specific-unsupported': '機器ごとの値(LDPATH・LDCRYPT)が、加工機へ渡せない形',
  'device-specific-invalid': '機器ごとの値(PROC・PROCBLK・LDPATH)の形が正しくない',
  'device-specific-unknown': '機器の名乗りが足りず、機器ごとの値が合うか決められない',
  'device-specific-ambiguous': '機器ごとの値が同じ合い方で 2 つ以上あり、どれを渡すか決められない',
  'device-specific-case': '機器ごとの値の名乗りが、大文字・小文字だけ違う',
  'device-specific-dataset': '機器ごとのブロックに、渡せない玉型・データセットがある',
};
// 加工機に向けて作り直せないとき(build.js が投げる)。表 A.24 の 4(データはあるが、求めた機器には合わない)を返す
const NOT_FOR_DEVICE = new Set(['drill-reference', 'trace-unconvertible', 'dataset-format', 'device-specific-unsupported', 'device-specific-invalid', 'device-specific-unknown',
  'device-specific-ambiguous', 'device-specific-case', 'device-specific-dataset']);

// TRCFMT と同じに取り決めるデータセット(5.8.1・5.10.5・5.11.3)。作り直さないので、保存した形と合わなければ渡さない
const NEGOTIATED_DATASETS = ['SHLFFMT', 'CRIBFMT', 'STHKFMT'];
/** 申し出たデータセットの形式から、見出しごとに 1 つ選ぶ(形式 1-4 の最初のもの)。{ 見出し: 欄 } */
function chooseDatasets(proposals) {
  const out = {};
  for (const h of NEGOTIATED_DATASETS) {
    const f = (proposals || []).filter(x => x.label === h).map(x => (x.fields || []).map(v => String(v).trim())).find(x => /^\d+$/.test(x[0]) && FORMATS.includes(+x[0]));
    if (f) out[h] = f;
  }
  return out;
}

/**
 * 機器が申し出た TRCFMT(7.2.8)から、扱えるものを機器が書いた順に 1 つ選ぶ。
 * 形式は 1-4、点数は MIN_TRACE_POINTS から MAX_TRACE_POINTS(書かなければ受け取ったまま)、角度のモードは E・U、眼は R・L・B。
 * 1 つも扱えなければ STATUS=17 に、表 A.25 の修飾子(256: 形式、512: 点数、1024: 角度のモード)を足して返す
 * @returns {{offered: boolean, want?: object, fields?: string[], status?: number}}
 */
function chooseTrace(proposals, { upload = false } = {}) {
  const offered = (proposals || []).filter(x => x.label === 'TRCFMT').map(x => (x.fields || []).map(v => String(v).trim()));
  if (!offered.length) return { offered: false };
  const okFmt = f => /^\d+$/.test(f[0]) && FORMATS.includes(+f[0]);
  // アップロードは受け取ったまま保存する(作り直さない)ので、点数の上限は設けず、角度のモード C(5.4.3.1)も受ける
  const okPts = f => !f[1] || (/^\d+$/.test(f[1]) && +f[1] >= MIN_TRACE_POINTS && (upload || +f[1] <= MAX_TRACE_POINTS));
  const okMode = f => (upload ? ['E', 'U', 'C'] : ['E', 'U']).includes((f[2] || 'E').toUpperCase());
  const okEye = f => ['R', 'L', 'B'].includes((f[3] || 'R').toUpperCase());
  const f = offered.find(x => okFmt(x) && okPts(x) && okMode(x) && okEye(x));
  if (f) return { offered: true, want: traceWant(f), fields: f };
  let status = 17;
  if (!offered.some(okFmt)) status += 256;
  if (!offered.some(okPts)) status += 512;
  if (!offered.some(okMode)) status += 1024;
  return { offered: true, status };
}

/** 機器へ返す説明文: 例外のコード(英数字)だけにする。日本語の文は latin1 にできず、改行などに化けるため */
function asciiCode(e) {
  const c = String((e && e.code) || '').replace(/[^\x20-\x7e]/g, '').replace(/[;\r\n]/g, '').slice(0, 40);
  return c || 'host error';
}

function utcStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** パケットの原文(FS から GS まで)から、CRC の前までの本文を取り出す(受け取ったバイト列のまま保存するため)。 */
function bodyOf(raw) {
  const s = raw.indexOf(VCA.CH.FS), e = raw.lastIndexOf(VCA.CH.GS);
  const inner = raw.slice(s + 1, e < 0 ? raw.length : e);
  const r = inner.lastIndexOf(VCA.CH.RS);
  return r >= 0 ? inner.slice(0, r) : inner;
}

/** 要求 ID の記録を、createHost の requestIds の形にする(接続のたびに、前に割り当てた要求 ID を読み込む)。 */
function requestIdEntries(registry) {
  const out = {};
  for (const r of registry.list()) out[r.id] = { kind: r.kind, dev: r.device.dev, tag: r.tag, drill: r.drill || null };
  return out;
}

/**
 * createHost に渡す応答の関数を作る。
 * @param {{store: object, registry: object, log: object, peer: string, recordsFor?: Function}} ctx
 *   recordsFor(entry, to): 送るレコードを作る(拡張の send を通す。app.js)。無ければ buildDownload だけ
 */
function hostOptions({ store, registry, log, peer, recordsFor }) {
  const holder = { peer };   // この接続(Store で、送っている途中のデータを押さえる印)
  let holding = null;        // 送っている途中のダウンロード { id, job }。最後のパケットに ACK を受けたら送信済みにする
  const note = (level, o) => log.write(level, { peer, ...o });

  /**
   * 送り終えられなかったダウンロードを放し、送信待ちに戻す。
   * 加工機が受け取ったかどうかは分からない(ACK だけが届かなかったこともある)ので、記録に残す。
   */
  function letGo(reason) {
    if (!holding) return;
    const { id, job } = holding;
    holding = null;
    if (store.release(id, holder)) note('warn', { event: 'download-unconfirmed', job, detail: `${id} 送信待ちに戻した(${reason})` });
  }

  return {
    supports: SUPPORTS,
    requestTypes: REQUEST_TYPES,
    nextRequestId: () => registry.nextId(),

    /** 初期化(7.2): 割り当てた要求 ID と、機器が求めたレコード・玉型の形式を残す。 */
    onInit(data, reply, { requestId }) {
      const device = {
        dev: VCA.value(data, 'DEV') || '', ven: VCA.value(data, 'VEN') || '', model: VCA.value(data, 'MODEL') || '',
        sn: VCA.value(data, 'SN') || '', mid: VCA.value(data, 'MID') || '',
      };
      const def = VCA.autoFormatDefinitions(data)[0];
      // 名乗りと定義の名前の長さを確かめる。値は 255 文字まで(附属書 D の 3.13 の改訂)、定義の名前は limited(12 文字まで。表 A.2・5.1.8.3)。
      // 要求 ID の記録に残すので、長い値を繰り返されると記録が膨らみ、書くたびに止まるため
      const long = Object.entries(device).find(([, v]) => v.length > MAX_VALUE);
      if (long || (def && String(def.tag || '').length > 12)) {
        note('warn', { event: 'initialized', result: 'STATUS=13', detail: long ? `${long[0].toUpperCase()} が ${long[1].length} 文字で長すぎる` : 'DEF の名前が長すぎる' });
        return { status: 'invalidInit', text: long ? `${long[0].toUpperCase()} too long` : 'DEF name too long' };
      }
      // ラベル一覧の形と数を確かめる。ラベルは英字か _ で始まる 16 文字まで(5.1.6)。重なりは 1 つにする。
      // 数は規格のラベルの数より十分に多い上限まで(大きな一覧を繰り返されると、要求 ID の記録が膨らみ、書くたびに止まるため)
      if (def) {
        const labels = [...new Set(def.labels.map(l => String(l.label).toUpperCase()))];
        const bad = labels.find(l => !/^[A-Z_][A-Z0-9_.:\-]{0,15}$/.test(l));
        if (bad !== undefined || labels.length > MAX_INIT_LABELS) {
          note('warn', { event: 'initialized', result: 'STATUS=13', detail: bad !== undefined ? `ラベル一覧に正しくないラベル(${String(bad).slice(0, 20)})` : `ラベル一覧が ${labels.length} 個で多すぎる` });
          return { status: 'invalidInit', text: 'invalid record label list' };
        }
        def.labels = labels.map(label => ({ label }));
      }
      // 玉型の形式は、点数・眼も確かめて選び直す(VCA.negotiate は形式と角度のモードだけを見る)
      const tc = chooseTrace(data.proposals, { upload: UPLOAD_DEVICES.has(String(VCA.value(data, 'DEV') || '').toUpperCase()) });
      if (tc.offered && !tc.want) {
        note('warn', { event: 'initialized', result: `STATUS=${tc.status}`, detail: '扱える玉型の形式が無い' });
        return { status: tc.status };
      }
      const at = reply.findIndex(r => r[0] === 'TRCFMT');
      if (tc.want) reply.splice(at < 0 ? reply.length : at, at < 0 ? 0 : 1, ['TRCFMT', ...tc.fields]);
      const pick = label => reply.find(r => r[0] === label);
      const trcfmt = tc.want || null;
      // シェルフ・切り抜き・厚みのデータセットも、選んだ形式を返す(5.4.17: the host responds with its choice)
      const datasets = chooseDatasets(data.proposals);
      for (const [h, f] of Object.entries(datasets)) reply.push([h, ...f]);
      reply.push(...HOST_INFO);
      if (requestId) {
        // プリセット初期化(DEF が無い)の機器は、機器の種類のプリセットの項目一式を期待する(7.2.5.2・5.1.3)
        const preset = def ? null : VCA.presetRecords(device.dev.toUpperCase());
        registry.save(requestId, {
          tag: def ? def.tag : '', labels: def ? def.labels.map(l => l.label) : (preset ? preset.map(r => r.label) : []), preset: !def, device, trcfmt,
          zfmt: !!pick('ZFMT'), kind: UPLOAD_DEVICES.has(device.dev.toUpperCase()) ? 'upload' : 'download',
          drill: pick('DRLFMT') ? pick('DRLFMT')[1] : null, datasets, peer,
        });
      }
      note('info', { event: 'initialized', detail: `${device.dev || ''} ${device.ven} ${device.model} 要求 ID ${requestId || 'なし'}、玉型の形式 ${trcfmt ? trcfmt.fmt : 'なし'}`.trim() });
    },

    /** 要求(7.3・7.4): アップロードは受け付け、ダウンロードは送信待ちのデータで応答する。 */
    onRequest(req, info) {
      const { type, job, kind } = info;
      // 1 つの接続のセッションは 1 つずつなので、前のダウンロードを押さえたままなら、それは終わっていない
      letGo('前のセッションが終わらないまま、次の要求が来た');
      if (type === 'TIM') return { records: [['TIME', utcStamp()]] };
      // JOB の無い要求(7.1.6 は、初期化の外の全てのパケットに JOB を求める)。表 A.24 の 7(足りないレコードのラベルを説明に書く)
      if (job === undefined) {
        note('warn', { event: kind === 'upload' ? 'upload' : 'download', type, result: 'STATUS=7', detail: 'JOB が無い' });
        return { status: 7, text: 'JOB' };
      }
      // 機器が要求に書いた玉型・サグ・穴あけの基準(7.2.8・5.4.11.2・5.5.3)。初期化した機器も、要求に書けばそのセッションだけ
      // 初期化の取り決めに代わる(7.2.3.2)。玉型は、機器が書いた順に、扱える形式の最初のもの
      const proposals = (req && req.proposals) || [];
      const tc = chooseTrace(proposals, { upload: kind === 'upload' });
      const sagOffered = proposals.some(x => x.label === 'ZFMT');
      // 玉型の形式を書いたのに、扱える形式が 1 つも無い(表 A.24 の 17、表 A.25 の修飾子。5.4.17)
      if (tc.offered && !tc.want) {
        note('warn', { event: kind === 'upload' ? 'upload' : 'download', type, job, result: `STATUS=${tc.status}`, detail: '扱える玉型の形式が無い' });
        return { status: tc.status };
      }
      if (kind === 'upload') {
        // 値の長さの上限(255 文字)を超えるジョブ番号は受けない(表 A.24 の 6)。索引と受信データの情報に残すため
        if (String(job).length > MAX_VALUE) { note('warn', { event: 'upload', type, job, result: 'STATUS=6', detail: 'JOB が長すぎる' }); return { status: 6, text: 'JOB' }; }
        // 申し出た玉型の形式のうち使うものを 1 つ返す。サグは受けないので ZFMT=0 で答える(7.2.8)
        const records = [];
        if (tc.want) records.push(['TRCFMT', ...tc.fields]);
        if (sagOffered) records.push(['ZFMT', '0']);
        return records.length ? { records } : {};
      }
      const drillOffers = ((req && req.all && req.all.DRLFMT) || []).map(f => String([].concat(f)[0] || '').trim()).filter(Boolean);
      let profile = null, device = null;
      if (/^\d+$/.test(type)) {
        const p = registry.get(type);
        // 記録に無い要求 ID(消された古いもの)は、何を送るか分からないので、知らない要求 ID として初期化し直してもらう(7.2.1)
        if (!p) { note('warn', { event: 'download', type, job, result: 'STATUS=5', detail: '記録に無い要求 ID' }); return { status: 5 }; }
        profile = { labels: p.labels, preset: !!p.preset, trcfmt: p.trcfmt, zfmt: p.zfmt, drill: p.drill || null, datasets: { ...(p.datasets || {}), ...chooseDatasets(proposals) } }; device = p.device;
        if (tc.want) profile.trcfmt = tc.want;
        if (sagOffered) profile.zfmt = true;
        if (drillOffers.length) { profile.drill = null; profile.drillOffers = drillOffers; }
      } else {
        // 初期化しない要求には DEV・VEN・MODEL が入っている(7.2.6.2)。DEV が無ければ、要求の種別が機器の種類(7.2.1)
        device = { dev: VCA.value(req, 'DEV') || type, ven: VCA.value(req, 'VEN') || '', model: VCA.value(req, 'MODEL') || '' };
        // 初期化しない機器は、プリセットの項目一式を期待する(7.2.6.2)
        const preset = VCA.presetRecords(type);
        profile = { labels: preset ? preset.map(r => r.label) : [], preset: true, trcfmt: tc.want || null, zfmt: sagOffered, drillOffers, datasets: chooseDatasets(proposals) };
      }
      // 探すことと押さえることを 1 度に行う(ACK を待つ間に、ほかの接続へ同じデータを渡さない)
      const got = store.reserve(job, holder);
      if (!got) {
        // 現場で多い「加工機に出てこない」の理由が、記録から分かるように
        note('warn', { event: 'download', type, job, result: 'STATUS=1', detail: 'この名前の送信待ちのデータがありません(名前が違う・送信待ちにしていない・送信済み)。受信の一覧で名前と状態を確かめてください' });
        return { status: 1 };
      }
      if (got.busy) {
        // ほかの機器へ送っている途中。表 A.24 の 11(受け手が忙しく、いまは要求に応えられない)
        note('warn', { event: 'download', type, job, result: `STATUS=${BUSY}`, detail: 'ほかの接続へ送っている途中' });
        return { status: BUSY };
      }
      const { entry } = got;
      // 送信待ちにした後で、送り出せない理由ができていないかを、渡す直前にもう一度確かめる
      // (拡張の加工条件を外した・変えたなど。人が確かめたのと違う中身を渡さない)。理由があれば送信待ちから外し、確かめ直してもらう
      const { blockers } = store.checkOf(entry);
      if (blockers.length) {
        store.release(entry.id, holder);
        store.unqueue(entry.id, { blocked: true });
        note('warn', { event: 'send-blocked', type, job, result: 'STATUS=8', detail: `${entry.id} 送信待ちから外した(理由 ${blockers.length} 件。理由の文には値が入るので、画面の詳細で確かめる)` });
        // 機器に合わないのではなく、vca-hub が人に確かめ直してもらうために止めた(表 A.24 の 8。説明は job held for review)
        return { status: 8, text: 'job held for review' };
      }
      holding = { id: entry.id, job };
      try {
        // 拡張の send が失敗したら、放してから STATUS=8 を返す(送信待ちのまま残る)
        const records = recordsFor ? recordsFor(entry, { kind: 'device', type, device, profile, peer })
          : buildDownload({ body: store.readBody(entry), profile, device });
        return { records };
      } catch (e) {
        holding = null;
        store.release(entry.id, holder);
        if (!(e && NOT_FOR_DEVICE.has(e.code))) {
          // 拡張の send の失敗など。理由は記録に残し、機器には ASCII の説明だけを返す(送信待ちのまま残す)
          note('warn', { event: 'download', type, job, result: 'STATUS=8', detail: `${entry.id} ${e && (e.code || e.message)}` });
          return { status: 8, text: asciiCode(e) };
        }
        // この機器に向けて作り直せない(穴あけの基準が違う、機器ごとの値を決められない など)。
        // データはあるが、求めた機器には合わない(表 A.24 の 4)。送信待ちのまま残す
        if (e && NOT_FOR_DEVICE.has(e.code)) {
          note('warn', { event: 'download', type, job, result: 'STATUS=4', detail: `${entry.id} この加工機には渡せません: ${REFUSAL_TEXT[e.code] || e.code}。送信待ちのまま残します` });
          // 詳しい理由(値を含む)は、画面の一覧と詳細に出すために覚える(記録のファイルには書かない)
          if (store.noteRefusal) store.noteRefusal(entry.id, { peer, device: [device && device.dev, device && device.ven, device && device.model].filter(Boolean).join(' '), message: e.message });
          return { status: 4, text: e.code };
        }
        throw e;
      }
    },

    /** アップロードのデータ(7.3): 受け取った本文を保存する。保存できなければ STATUS=8 を返す(説明は ASCII のコード)。 */
    onData(req, data, info) {
      const p = /^\d+$/.test(info.type) ? registry.get(info.type) : null;
      const type = p && p.device.dev ? p.device.dev.toUpperCase() : info.type;
      // データのパケットにも JOB が要る(7.1.6)。要求の JOB と違えば、別のジョブのデータなので受けない(表 A.24 の 7・6)
      const dataJob = VCA.value(data, 'JOB');
      if (dataJob === undefined) { note('warn', { event: 'upload', type: info.type, job: info.job, result: 'STATUS=7', detail: 'データのパケットに JOB が無い' }); return { status: 7, text: 'JOB' }; }
      if (String(dataJob).trim() !== String(info.job).trim()) {
        note('warn', { event: 'upload', type: info.type, job: info.job, result: 'STATUS=6', detail: 'データのパケットの JOB が要求と違う' });
        return { status: 6, text: 'JOB' };
      }
      let entry;
      try { entry = store.saveReceived({ body: bodyOf(data.raw), type, job: info.job, peer, crcOk: data.crcOk }); } catch (e) {
        // 保存できない(ディスク不足・違うラベルが多すぎる など)。STATUS=0 は返さない。説明は ASCII だけにする
        note('warn', { event: 'upload', type: info.type, job: info.job, result: 'STATUS=8', detail: e.code || e.message });
        return { status: 8, text: asciiCode(e) };
      }
      note('info', { event: 'received', type: info.type, job: info.job, result: 'STATUS=0', detail: entry.id });
      return { status: 0 };
    },

    /** セッションを終えたとき(最後のパケットに ACK を受け取った): ダウンロードした保存データを送信済みにする。 */
    onComplete(req, info, { status }) {
      const sent = holding;
      holding = null;
      if (!sent) return;
      if (status !== 0) { store.release(sent.id, holder); return; }
      const p = /^\d+$/.test(info.type) ? registry.get(info.type) : null;
      const to = p ? `${p.device.ven} ${p.device.model}`.trim() || peer : peer;
      try {
        store.markSent(sent.id, `${to} (${peer})`);
      } catch (e) {
        // 加工機はすでに受け取っている。送信済みを書けなかったことを記録に残す。
        // 押さえたままにし、あとで書き直す(接続が切れても、ほかの機器に同じジョブを渡さない)
        store.holdSent(sent.id, `${to} (${peer})`);
        note('error', { event: 'sent-not-recorded', type: info.type, job: info.job, result: 'STATUS=0', detail: `${sent.id} ${e.code || e.message}。送信済みとして押さえ、書き直す` });
        return;
      }
      note('info', { event: 'sent', type: info.type, job: info.job, result: 'STATUS=0', detail: sent.id });
    },

    /** 作業完了の通知(INF)と機器の状態(MNT)は記録するだけ(7.3.5・7.3.6)。 */
    onNotify(req) {
      const type = VCA.value(req, 'REQ');
      const st = VCA.fieldsOf(req, 'STATUS');
      note('info', { event: type === 'INF' ? 'job-complete' : 'maintenance', job: VCA.value(req, 'JOB'), result: `STATUS=${st ? [].concat(st._fields || st)[0] : ''}` });
    },

    /** セッションが失敗した(NAK が続いた、ACK が来ない、同期ずれなど)。送っている途中のダウンロードがあれば放す */
    onError(e) {
      letGo(e.code || e.message);
      note(e.code === 'closed' ? 'info' : 'warn', { event: 'session', detail: e.code || e.message });
    },

    /** 接続が切れた(createHost は呼ばない。app.js がソケットの close で呼ぶ)。押さえたデータを全て放す */
    onClose() {
      letGo('接続が切れた');
      // 残っているのは、この接続が押さえたまま letGo していないもの(送信済みを書けなかったものは、releaseAll が放さない)
      for (const id of store.releaseAll(holder)) note('warn', { event: 'download-released', detail: `${id} この接続が押さえていたものを、送信待ちに戻した(接続が切れた)` });
    },
  };
}

module.exports = { hostOptions, requestIdEntries, bodyOf, REQUEST_TYPES, SUPPORTS };
