'use strict';
// 個人情報項目の除去(設計書 7 章)を、行の形を乱数で変えて確かめる。除いた本文を読み取り(vca-parser.js)にかけても
// 個人情報の項目が出てこないこと、本文に値が残らないこと、ほかの項目は変わらないこと。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, PII_LABELS } = require('../src/store/store.js');
const VCA = require('../src/lib/vca-parser.js');

test('個人情報項目の除去: 大文字・小文字、行の頭の空白や制御文字、= の前の空白、行の区切りの違いによらず、除く', () => {
  const store = new Store({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'vcahub-pii-')) });
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  const pick = a => a[rnd(a.length)];
  const labels = [...PII_LABELS];
  const pre = ['', ' ', '\t', '*', '  *', '\x1c', '\x1e', '\x1d', '\x1a', '\x02', '\x0b', '\x0c', '\x00', '\xa0', '\x7f', '\xff'];
  const eq = ['=', ' =', '\t=', '  =', ' = ', '\x00=', '\xa0=', '\x85=', '\x0b=', ' \xa0 ='];
  const eol = ['\r\n', '\n', '\r', '\r\r\n', '\n\r'];
  for (let i = 0; i < 20000; i++) {
    const l = pick(labels);
    const label = rnd(2) ? l : l.toLowerCase();
    const body = `REQ=TRC\r\nJOB=A\r\nDBL=18${pick(eol)}${pick(pre)}${label}${pick(eq)}YAMADA;TARO${pick(eol)}HBOX=50${pick(eol)}*CLAMP=5\r\n`;
    const { body: kept } = store.stripPII(body);
    assert.ok(!/YAMADA/.test(kept), JSON.stringify(body));
    assert.ok(!VCA.parse(kept).records.some(r => PII_LABELS.has(String(r.label).toUpperCase())), JSON.stringify(body));
    const others = VCA.parse(body).records.filter(r => !PII_LABELS.has(r.label)).map(r => r.label);
    assert.deepEqual(VCA.parse(kept).records.map(r => r.label), others, JSON.stringify(body));
  }
});
