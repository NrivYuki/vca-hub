'use strict';
// 拡張の例: 加工条件(縁の加工・ヤゲンや溝の位置・磨き)を、受信データごとに管理画面で設定し、送るときに足す。
// 値の意味は DCS v3.14 の表 A.1 の ETYP・BEVP・BEVM・BEVC・POLISH。
//
// 使い方: このフォルダを vca-hub の extensions フォルダへ写し、config.json に書く。
//   "extensions": { "processing-conditions": { "required": true } }
// 設定:
//   required: true なら、加工条件を付けるまで送り出せない(送信待ち・書き出し・送り先への送信)
//   targets: 足す送り先の種類(既定 ["device", "file", "destination"])。device は加工機、file は共有フォルダ、destination は送り先

const ETYP = { '-1': '加工しない', 1: 'ヤゲン', 2: '平(縁なし)', 3: '溝', 4: 'ミニヤゲン', 5: 'T ヤゲン', 6: 'U ヤゲン' };
const BEVP = { 0: '手動', 1: '前面から(BEVM mm)', 2: '前面からの割合(BEVM %)', 3: 'フレームカーブに沿う(BEVC・BEVM)', 4: '50/50', 5: '後面から(BEVM mm)', 7: '加工機の設定に従う', 10: 'フリーフロート' };
const POLISH = { 0: '磨かない', 1: '縁と面取りを磨く', 2: '面取りだけ磨く', 3: '縁だけ磨く' };
// 位置の決め方を使う縁(ヤゲン・溝・ミニヤゲン・T ヤゲン・U ヤゲン)
const NEEDS_POSITION = new Set(['1', '3', '4', '5', '6']);
// BEVP ごとに要る値(表 A.1 の BEVP の説明)
const NEEDS_M = new Set(['1', '2', '3', '5']);
const NEEDS_C = new Set(['3']);

const bad = message => Object.assign(new Error(message), { code: 'bad-request' });

/** 画面から受け取った加工条件を確かめ、保存する形にする */
function normalize(c) {
  const out = {};
  const etyp = String(c.ETYP ?? '');
  if (!(etyp in ETYP)) throw bad('縁の加工(ETYP)を選んでください');
  out.ETYP = etyp;
  if (NEEDS_POSITION.has(etyp)) {
    const bevp = String(c.BEVP ?? '');
    if (!(bevp in BEVP)) throw bad('位置の決め方(BEVP)を選んでください');
    out.BEVP = bevp;
    for (const [label, need] of [['BEVM', NEEDS_M], ['BEVC', NEEDS_C]]) {
      if (!need.has(bevp)) continue;
      const v = String(c[label] ?? '').trim();
      if (!/^-?\d+(\.\d+)?$/.test(v)) throw bad(`BEVP=${bevp} では ${label} の数値が要ります`);
      out[label] = v;
    }
  }
  const polish = String(c.POLISH ?? '');
  if (polish !== '') {
    if (!(polish in POLISH)) throw bad('磨き(POLISH)の値が正しくありません');
    out.POLISH = polish;
  }
  return out;
}

/** 加工条件を、レコード([ラベル, 値...])にする。BEVP・BEVM・BEVC は左右に同じ値 */
function records(c) {
  const out = [['ETYP', c.ETYP]];
  if (c.BEVP !== undefined) out.push(['BEVP', c.BEVP, c.BEVP]);
  if (c.BEVM !== undefined) out.push(['BEVM', c.BEVM, c.BEVM]);
  if (c.BEVC !== undefined) out.push(['BEVC', c.BEVC, c.BEVC]);
  if (c.POLISH !== undefined) out.push(['POLISH', c.POLISH]);
  return out;
}

function describe(c) {
  const lines = [`縁の加工 ETYP=${c.ETYP}(${ETYP[c.ETYP]})`];
  if (c.BEVP !== undefined) {
    lines.push(`位置 BEVP=${c.BEVP}(${BEVP[c.BEVP]})${c.BEVM !== undefined ? ` BEVM=${c.BEVM}` : ''}${c.BEVC !== undefined ? ` BEVC=${c.BEVC}` : ''}`);
  }
  if (c.POLISH !== undefined) lines.push(`磨き POLISH=${c.POLISH}(${POLISH[c.POLISH]})`);
  return lines;
}

module.exports = {
  title: '加工条件',
  version: '0.1.0',
  setup(hub) {
    const required = hub.settings.required === true;
    const targets = new Set(hub.settings.targets || ['device', 'file', 'destination']);

    hub.page('page.html', '加工条件');

    hub.route('GET', 'conditions', ({ query }) => ({
      conditions: hub.data.get(query.id), required, options: { ETYP, BEVP, POLISH },
      needs: { position: [...NEEDS_POSITION], m: [...NEEDS_M], c: [...NEEDS_C] },
    }));
    hub.route('POST', 'conditions', ({ body }) => {
      if (!hub.store.get(body.id)) throw Object.assign(new Error('データがありません'), { code: 'not-found' });
      const c = normalize(body.conditions || {});
      hub.data.set(body.id, c);
      hub.log('info', { detail: `${body.id} に加工条件を付けた ${records(c).map(r => `${r[0]}=${r.slice(1).join(';')}`).join(' ')}` });
      return { conditions: c };
    });
    hub.route('POST', 'clear', ({ body }) => {
      hub.data.remove(body.id);
      hub.log('info', { detail: `${body.id} の加工条件を外した` });
      return { conditions: null };
    });

    hub.on('check', ({ entry }) => {
      if (required && !hub.data.get(entry.id)) return { blockers: ['加工条件が付いていません(右の面の「加工条件」で付けてください)'] };
      return {};
    });

    hub.on('send', ({ entry, records: recs, to }) => {
      const c = hub.data.get(entry.id);
      if (!c || !targets.has(to.kind)) return undefined;
      // 加工機が項目を指定していれば(初期化の一覧・プリセット)、その項目だけを置き換える。
      // 送るレコードにすでにある項目(BEVP に添えて送る BEVM・BEVC の ? など)も置き換える。求めていない項目は送らない
      const wanted = to.profile && to.profile.labels && to.profile.labels.length ? new Set(to.profile.labels.map(l => String(l).toUpperCase())) : null;
      const present = new Set(recs.map(r => String(r[0]).toUpperCase()));
      let out = recs;
      for (const r of records(c)) if (!wanted || wanted.has(r[0]) || present.has(r[0])) out = hub.vca.setRecord(out, ...r);
      return out;
    });

    hub.on('describe', ({ entry }) => {
      const c = hub.data.get(entry.id);
      return c ? describe(c) : [required ? '加工条件が付いていません(付けるまで送れません)' : '加工条件は付いていません(加工機の設定のまま)'];
    });
  },
  // テストから使う
  normalize, records,
};
