'use strict';
// 拡張の例: 相手の機器(初期化や要求で名乗った DEV・VEN・MODEL)ごとに、送る項目を足したり外したりする。
// メーカー独自の項目(DCS 5.1.6 の _ で始まるラベルなど)を求める加工機や、ある項目を受け付けない機器に合わせるため。
//
// 使い方: このフォルダを vca-hub の extensions フォルダへ写し、config.json に書く。
//   "extensions": {
//     "vendor-records": {
//       "rules": [
//         { "ven": "ACME", "model": "E-100", "add": [["_ACMEMODE", "2"]], "remove": ["POLISH"] },
//         { "dev": "EDG", "ven": "ACME", "add": [["_ACMESPEED", "1"]] }
//       ]
//     }
//   }
// rules の dev・ven・model は、書いたものだけを比べる(大文字・小文字は区別しない)。合うものはすべて、上から順に当てる。
// 加工機(device)へ送るときだけ当てる。共有フォルダ・送り先では相手の機器が分からないため。

const up = v => String(v ?? '').toUpperCase();

function matches(rule, device) {
  if (!device) return false;
  return ['dev', 'ven', 'model'].every(k => rule[k] === undefined || up(rule[k]) === up(device[k]));
}

module.exports = {
  title: 'メーカー別の項目',
  version: '0.1.0',
  setup(hub) {
    const rules = Array.isArray(hub.settings.rules) ? hub.settings.rules : [];
    for (const [i, r] of rules.entries()) {
      for (const rec of r.add || []) {
        if (!Array.isArray(rec) || !/^[A-Za-z_][A-Za-z0-9_]{0,15}$/.test(String(rec[0]))) throw new Error(`rules[${i}].add のラベル ${rec && rec[0]} は使えません(16 文字まで、DCS 5.1.6)`);
      }
    }

    hub.on('send', ({ records, to }) => {
      if (to.kind !== 'device') return undefined;
      let out = records;
      for (const r of rules) {
        if (!matches(r, to.device)) continue;
        const drop = new Set((r.remove || []).map(up));
        out = out.filter(x => !drop.has(up(x[0])));
        for (const rec of r.add || []) out = hub.vca.setRecord(out, ...rec);
      }
      return out;
    });

    hub.on('describe', () => (rules.length ? [`機器ごとの決まり ${rules.length} 件(加工機へ送るとき、名乗った機器に合わせて項目を足し外しする)`] : []));
  },
  matches,
};
