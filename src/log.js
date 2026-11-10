'use strict';
// 送受信の記録(設計書 6 章・7 章)。レコードの中身(氏名・度数など)は書かない。

const fs = require('node:fs');
const path = require('node:path');

class Log {
  constructor({ dir, echo = false }) {
    this.dir = dir;
    this.echo = echo;
    this.recent = [];
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {{event: string, peer?: string, job?: string, type?: string, result?: string, detail?: string}} fields
   */
  write(level, fields) {
    const at = new Date();
    const entry = { at: at.toISOString(), level, ...fields };
    const day = at.toISOString().slice(0, 10);
    try {
      fs.appendFileSync(path.join(this.dir, `${day}.log`), JSON.stringify(entry) + '\n');
    } catch (e) {
      // 記録に失敗しても通信は止めない(ディスク不足やフォルダ削除など)
      if (this.echo) console.error(`ログを書けませんでした: ${e.message}`);
    }
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    if (this.echo) console.log(`[${level}] ${fields.event} ${fields.peer || ''} ${fields.job || ''} ${fields.result || ''} ${fields.detail || ''}`.trim());
    return entry;
  }

  list(limit = 200) { return this.recent.slice(-limit).reverse(); }
}

module.exports = { Log };
