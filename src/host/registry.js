'use strict';
// 初期化(INI)で割り当てた要求 ID と、機器が求めたレコード・玉型の形式を保存する(DCS 7.2)。
// 要求 ID は再起動をまたいでも繰り返さないよう、通し番号をファイルに残す(7.2.3.3)。

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('../lib/atomic.js');

class Registry {
  constructor({ file }) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { nextId: 1000, requests: {} };
  }

  /** 変更して保存する。保存に失敗したらメモリ上も変更前に戻す。 */
  _commit(mutate) {
    const before = JSON.parse(JSON.stringify(this.data));
    const result = mutate();
    try { writeJsonAtomic(this.file, this.data); } catch (e) { this.data = before; throw e; }
    return result;
  }

  /** 次の要求 ID(vca-session.js の createHost の nextRequestId に渡す)。 */
  nextId() {
    return this._commit(() => String(this.data.nextId++));
  }

  /**
   * 初期化で割り当てた要求 ID と機器の希望を残す。同じ機器・同じタグの前の要求 ID は消す
   * (機器は初期化のたびに新しい要求 ID を使うため)。
   * @param {string} id
   * @param {{tag: string, labels: string[], device: object, trcfmt: object|null, kind: string, drill: string|null, peer: string}} def
   */
  save(id, def) {
    const key = [def.device.ven, def.device.model, def.device.sn || def.device.mid || '', def.tag].join('|');
    this._commit(() => {
      for (const [old, r] of Object.entries(this.data.requests)) if (r.key === key) delete this.data.requests[old];
      this.data.requests[id] = { key, ...def, createdAt: new Date().toISOString() };
    });
  }

  get(id) { return this.data.requests[String(id)] || null; }
  list() { return Object.entries(this.data.requests).map(([id, r]) => ({ id, ...r })); }
}

module.exports = { Registry };
