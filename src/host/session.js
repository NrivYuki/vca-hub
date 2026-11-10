'use strict';
// ホスト役のセッション処理(DCS 7 章、設計書 5 章)。
// パケットの送受信とセッションの手順は vca-guide の vca-session.js(createHost)が行い、
// ここでは createHost に渡す応答の関数(初期化・要求・アップロードのデータ・通知・完了)を作る。

const VCA = require('../lib/vca-parser.js');
const { buildDownload, traceWant } = require('../send/build.js');
const { FORMATS } = require('../lib/trace.js');

// 対応する要求種別(設計書 5 章)。これ以外の、規格にある種別には STATUS=16 を返す(createHost の unsupportedRequest)
const REQUEST_TYPES = ['TRC', 'UPL', 'INS', 'EDG', 'DNL', 'TIM', 'INF', 'MNT'];
// 初期化の形式の取り決め(5.4.17)。サグは中継しない(ZFMT=0 で答える)。文字コードは ASCII だけ
const SUPPORTS = { trace: { formats: FORMATS, modes: ['E', 'U'] }, sag: false, encodings: ['ASCII'] };
const HOST_INFO = [['HVEN', 'vca-hub'], ['HMODEL', 'vca-hub'], ['HVER', '0.2.0']];
// createHost と同じ決め方: アップロードする機器(DEV)の要求 ID はアップロードのセッションにする
const UPLOAD_DEVICES = new Set(['TRC', 'INS', 'UPL', 'CMD']);

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
  const sending = new WeakMap();   // ダウンロードの要求 → 送る保存データ(ACK を受けてから送信済みにする)
  const note = (level, o) => log.write(level, { peer, ...o });

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
      const pick = label => reply.find(r => r[0] === label);
      const trcfmt = traceWant((pick('TRCFMT') || []).slice(1));
      reply.push(...HOST_INFO);
      if (requestId) {
        registry.save(requestId, {
          tag: def ? def.tag : '', labels: def ? def.labels.map(l => l.label) : [], device, trcfmt,
          zfmt: !!pick('ZFMT'), kind: UPLOAD_DEVICES.has(device.dev.toUpperCase()) ? 'upload' : 'download',
          drill: pick('DRLFMT') ? pick('DRLFMT')[1] : null, peer,
        });
      }
      note('info', { event: 'initialized', detail: `${device.ven} ${device.model} id=${requestId || '-'} trcfmt=${trcfmt ? trcfmt.fmt : '-'}` });
    },

    /** 要求(7.3・7.4): アップロードは受け付け、ダウンロードは送信待ちのデータで応答する。 */
    onRequest(req, info) {
      const { type, job, kind } = info;
      if (type === 'TIM') return { records: [['TIME', utcStamp()]] };
      if (kind === 'upload') {
        if (job === undefined) { note('warn', { event: 'upload', type, result: 'STATUS=6' }); return { status: 6 }; }
        return {};
      }
      let profile = null, device = null;
      if (/^\d+$/.test(type)) {
        const p = registry.get(type);
        if (p) { profile = { labels: p.labels, trcfmt: p.trcfmt, zfmt: p.zfmt }; device = p.device; }
      } else {
        // 初期化しない要求には DEV・VEN・MODEL が入っている(7.2.6.2)
        device = { dev: VCA.value(req, 'DEV') || '', ven: VCA.value(req, 'VEN') || '', model: VCA.value(req, 'MODEL') || '' };
        // 初期化しない機器は、プリセットの項目一式を期待する(7.2.6.2)
        const preset = VCA.presetRecords(type);
        if (preset) profile = { labels: preset.map(r => r.label), preset: true };
      }
      const entry = job === undefined ? null : store.findQueued(job);
      if (!entry) { note('warn', { event: 'download', type, job, result: 'STATUS=1' }); return { status: 1 }; }
      // 拡張の send が失敗したら、例外のまま返す(createHost が STATUS=8 を返し、送信待ちのまま残る)
      const records = recordsFor ? recordsFor(entry, { kind: 'device', type, device, profile, peer })
        : buildDownload({ body: store.readBody(entry), profile });
      sending.set(req, entry);
      return { records };
    },

    /** アップロードのデータ(7.3): 受け取った本文を保存する。保存できなければ例外になり、STATUS=8 を返す。 */
    onData(req, data, info) {
      const p = /^\d+$/.test(info.type) ? registry.get(info.type) : null;
      const type = p && p.device.dev ? p.device.dev.toUpperCase() : info.type;
      const entry = store.saveReceived({ body: bodyOf(data.raw), type, job: info.job, peer, crcOk: data.crcOk });
      note('info', { event: 'received', type: info.type, job: info.job, result: 'STATUS=0', detail: entry.id });
      return { status: 0 };
    },

    /** セッションを終えたとき(最後のパケットに ACK を受け取った): ダウンロードした保存データを送信済みにする。 */
    onComplete(req, info, { status }) {
      const entry = sending.get(req);
      if (!entry || status !== 0) return;
      const p = /^\d+$/.test(info.type) ? registry.get(info.type) : null;
      const to = p ? `${p.device.ven} ${p.device.model}`.trim() || peer : peer;
      try {
        store.markSent(entry.id, `${to} (${peer})`);
      } catch (e) {
        // 加工機はすでに受け取っている。送信待ちのまま残るので、二重加工しないよう記録に残す
        note('error', { event: 'sent-not-recorded', type: info.type, job: info.job, result: 'STATUS=0', detail: `${entry.id} ${e.code || e.message}` });
        return;
      }
      note('info', { event: 'sent', type: info.type, job: info.job, result: 'STATUS=0', detail: entry.id });
    },

    /** 作業完了の通知(INF)と機器の状態(MNT)は記録するだけ(7.3.5・7.3.6)。 */
    onNotify(req) {
      const type = VCA.value(req, 'REQ');
      const st = VCA.fieldsOf(req, 'STATUS');
      note('info', { event: type === 'INF' ? 'job-complete' : 'maintenance', job: VCA.value(req, 'JOB'), result: `STATUS=${st ? [].concat(st._fields || st)[0] : ''}` });
    },

    onError(e) { note(e.code === 'closed' ? 'info' : 'warn', { event: 'session', detail: e.code || e.message }); },
  };
}

module.exports = { hostOptions, requestIdEntries, bodyOf, REQUEST_TYPES, SUPPORTS };
