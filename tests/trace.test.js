'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const VCA = require('../src/lib/vca-parser.js');
const { traceRecords } = require('../src/lib/trace.js');

const sample = fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-right.vca'), 'latin1');
const trace = VCA.parse(sample).traces[0];
const text = records => records.map(r => r[0] + '=' + r.slice(1).join(';')).join('\r\n');
const back = records => VCA.parse(text(records)).traces[0];

test('同じ点数・同じ眼なら半径はそのまま', () => {
  const r = traceRecords(trace, { fmt: 1, n: 360, eye: 'R' });
  assert.deepEqual(r[0], ['TRCFMT', '1', '360', 'E', 'R', 'F']);
  assert.deepEqual(back(r).radii, trace.radii);
});

test('形式 1 の行は 80 文字以内(5.4.15.1)', () => {
  for (const l of text(traceRecords(trace, { fmt: 1, n: 512 })).split('\r\n')) assert.ok(l.length <= 80, l);
});

test('512 点への変換(5.4.17): 0°・90° の点は元の値と一致し、形の寸法も保たれる', () => {
  const t = back(traceRecords(trace, { fmt: 1, n: 512, eye: 'R' }));
  assert.equal(t.radii.length, 512);
  assert.equal(t.radii[0], trace.radii[0]);       // 0°
  assert.equal(t.radii[128], trace.radii[90]);    // 90°
  const b0 = VCA.boxOf(VCA.tracePoints(trace)), b1 = VCA.boxOf(VCA.tracePoints(t));
  assert.ok(Math.abs(b0.hbox - b1.hbox) < 0.05 && Math.abs(b0.vbox - b1.vbox) < 0.05);
});

test('左眼への反転(5.4.13): 右眼の 0° の半径が左眼の 180° に来る', () => {
  const t = back(traceRecords(trace, { fmt: 1, eye: 'L' }));
  assert.equal(t.eye, 'L');
  assert.equal(t.radii[180], trace.radii[0]);
});

test('形式 2・3・4 で書き出して読み戻すと同じ値', () => {
  for (const fmt of [2, 3, 4]) assert.deepEqual(back(traceRecords(trace, { fmt })).radii, trace.radii, `形式 ${fmt}`);
});

test('不等角度(U)は求めがなければ角度ごと送る', () => {
  const u = VCA.parse(fs.readFileSync(path.join(__dirname, '..', 'samples', 'frame-uneven.vca'), 'latin1')).traces[0];
  const t = back(traceRecords(u, {}));
  assert.equal(t.mode, 'U');
  assert.deepEqual(t.radii, u.radii);
  assert.deepEqual(t.angles, u.angles);
});
