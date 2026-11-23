'use strict';
// 初期化(INI)で割り当てた要求 ID と、機器が求めたレコード・玉型の形式を保存する(DCS 7.2)。
// 要求 ID は再起動をまたいでも繰り返さないよう、通し番号をファイルに残す(7.2.3.3)。

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, readJsonWithBackup } = require('../lib/atomic.js');

// 残す要求 ID の数(機器の台数より十分に多く)
const MAX_REQUESTS = 500;

// 要求 ID の記録の形(読むときと、1 つ前の記録に写すときに確かめる)
const VALID = v => v && typeof v === 'object' && Number.isInteger(v.nextId) && v.requests && typeof v.requests === 'object';

class Registry {
  constructor({ file }) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.unlinkSync(file + '.tmp'); } catch { /* 前に書く途中で止まったときの残り。無ければよい */ }
    // 読めなければ 1 つ前のもの(.bak)を読む(要求 ID の通し番号を戻さないため、どちらも読めなければ起動しない)
    this.recovered = null;
    this.data = readJsonWithBackup(file, {
      // 記録が無いとき(初めて・入れ直し・dataDir を変えた)は、時刻(秒)から始める。前に割り当てた番号と重ならないように(7.2.3.3)
      empty: () => ({ nextId: 1000 + (Math.floor(Date.now() / 1000) % 100000000), requests: {} }),
      valid: VALID,
      onRecovered: e => { this.recovered = e.message; },
    });
    // 1 つ前のものは、最後に割り当てた要求 ID を知らないことがある。通し番号を進め、同じ番号を 2 度割り当てない(7.2.3.3)
    if (this.recovered) this.data.nextId += 100;
  }

  /** 変更して保存する。保存に失敗したらメモリ上も変更前に戻す。 */
  _commit(mutate) {
    // 戻すための写しは文字列で持つ(記録が大きいときに、写しを作る時間を短くする)
    const before = JSON.stringify(this.data);
    const result = mutate();
    try { writeJsonAtomic(this.file, this.data, { valid: VALID }); } catch (e) { this.data = JSON.parse(before); throw e; }
    return result;
  }

  /** 次の要求 ID(vca-session.js の createHost の nextRequestId に渡す)。 */
  nextId() {
    return this._commit(() => String(this.data.nextId++));
  }

  /**
   * 初期化で割り当てた要求 ID と機器の希望を残す。
   * 同じ機器が初期化し直しても、前の要求 ID は消さない。名乗り(VEN・MODEL・SN)だけでは機器を見分けられず
   * (製造番号を名乗らない同じ機種が何台もある、1 つのアドレスの向こうに何台もある)、ほかの機器が使っている要求 ID を
   * 消してしまうため。増えすぎないよう、数の上限で古いものから消す。
   * @param {string} id
   * @param {{tag: string, labels: string[], device: object, trcfmt: object|null, kind: string, drill: string|null, peer: string}} def
   */
  save(id, def) {
    this._commit(() => {
      this.data.requests[id] = { ...def, createdAt: new Date().toISOString() };
      // 残す数を限る(名乗りを変えて初期化を繰り返されても、記録と 1 回ごとの処理が増え続けないように)。古いものから消す。
      // 消された要求 ID を使った機器には、知らない要求 ID として STATUS=5 を返すので、機器が初期化し直す
      const all = Object.entries(this.data.requests);
      if (all.length > MAX_REQUESTS) {
        // 古さは割り当てた順(要求 ID は増え続ける通し番号)で決める。作った時刻で決めると、時計が戻ったときに、
        // 割り当てたばかりの要求 ID をいちばん古いとみなして消してしまうため
        all.sort((a, b) => Number(a[0]) - Number(b[0]));
        for (const [old] of all.slice(0, all.length - MAX_REQUESTS)) delete this.data.requests[old];
      }
    });
  }

  get(id) { return this.data.requests[String(id)] || null; }
  list() { return Object.entries(this.data.requests).map(([id, r]) => ({ id, ...r })); }
}

module.exports = { Registry };
