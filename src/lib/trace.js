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
  // 角度のモード C(角度が増えも減りもする。鍵穴のような形)は、等角度にも、増えていく角度(U)にも作り直せない(5.4.3.1)。
  // 受け取った順のまま送る。E・U を取り決めた機器には送れない(呼んだ側が、この機器には合わないと答える)
  if (String(trace.mode || '').toUpperCase() === 'C') {
    const wantMode = want.mode === 'E' || want.mode === 'U' ? want.mode : null;
    if (wantMode) throw Object.assign(new Error(`角度のモード C の玉型は、${wantMode} に作り直せません(5.4.3.1)`), { code: 'trace-unconvertible' });
    if (want.n > 0 && want.n !== trace.radii.length) throw Object.assign(new Error('角度のモード C の玉型は、点数を変えられません(5.4.3.1)'), { code: 'trace-unconvertible' });
    const fmt = FORMATS.includes(want.fmt) ? want.fmt : (FORMATS.includes(trace.fmt) ? trace.fmt : 1);
    const pts = VCA.tracePoints(trace, eye);
    return VCA.datasetRecords({
      fmt, eye, object: trace.kind || 'F', mode: 'C',
      values: pts.map(p => Math.round(p.r * 100)), angles: pts.map(p => Math.round(p.a * 100) % 36000),
    });
  }
  const fmt = FORMATS.includes(want.fmt) ? want.fmt : (FORMATS.includes(trace.fmt) ? trace.fmt : 1);
  const object = trace.kind || 'F';
  // 取り決めた点数・角度のモードがあれば、それに合わせる(ホストが返した TRCFMT は、実際に使うもの。7.2.8)
  const wantMode = want.mode === 'E' || want.mode === 'U' ? want.mode : null;
  const sameCount = !(want.n > 0) || want.n === trace.radii.length;
  if (wantMode === 'U' && (trace.equi || !sameCount)) {
    // 角度つき(U)を求められ、元が等角度か点数が違う: 等角度に並べ直し、角度を付けて送る(元が角度つきで点数も同じなら、下でそのまま送る)
    const n = want.n > 0 ? want.n : trace.radii.length;
    const values = VCA.resampleTrace(trace, n, eye);
    return VCA.datasetRecords({ fmt, eye, object, mode: 'U', values, angles: values.map((_, i) => Math.round(i * 36000 / n) % 36000) });
  }
  // 等角度(E)で送るのは、元が等角度か、送信先が等角度を求めたとき。点数は求めがなければ元のまま
  if ((trace.equi && wantMode !== 'U') || wantMode === 'E') {
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
