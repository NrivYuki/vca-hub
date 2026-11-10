'use strict';
// 玉型データ(トレース)の「入れ物」の変換。形状そのもの(半径の値)は変えず、
// 送信先が求める形式・点数・左右の向きに合わせるだけ。計算は vca-guide の vca-parser.js に任せる。

const VCA = require('./vca-parser.js');

const FORMATS = [1, 2, 3, 4];

/**
 * トレース 1 眼分を、送信用のレコードにする([label, field...] の配列。buildPacket に渡せる)。
 * @param {object} trace vca-parser の traces の要素
 * @param {{fmt?: number, n?: number, mode?: string, eye?: string}} want 送信先の希望(省略時は元のまま)
 * @returns {Array<string[]>} TRCFMT・R(・A)のレコード
 */
function traceRecords(trace, want = {}) {
  const eye = want.eye === 'R' || want.eye === 'L' ? want.eye : trace.eye;
  const fmt = FORMATS.includes(want.fmt) ? want.fmt : (FORMATS.includes(trace.fmt) ? trace.fmt : 1);
  const object = trace.kind || 'F';
  // 等角度(E)で送るのは、元が等角度か、送信先が等角度を求めたとき。点数は求めがなければ元のまま
  if (trace.equi || want.mode === 'E') {
    const n = want.n > 0 ? want.n : trace.radii.length;
    return VCA.datasetRecords({ fmt, eye, object, mode: 'E', values: VCA.resampleTrace(trace, n, eye) });
  }
  // 角度つき(U)のまま送る。反転した点列は 0° から並べ直す(tracePoints の注意書き)
  const pts = VCA.tracePoints(trace, eye).slice().sort((p, q) => p.a - q.a);
  return VCA.datasetRecords({
    fmt, eye, object, mode: trace.mode,
    values: pts.map(p => Math.round(p.r * 100)), angles: pts.map(p => Math.round(p.a * 100) % 36000),
  });
}

module.exports = { traceRecords, FORMATS };
