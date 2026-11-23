'use strict';
// 送受信の記録(設計書 6 章・7 章)。レコードの中身(氏名・度数など)は書かない。

const fs = require('node:fs');
const path = require('node:path');

// 1 つの記録の値の長さ(文字)。detail は理由の一覧などを含むので長めにする
const MAX_FIELD = 300, MAX_DETAIL = 2000;
function clip(v, n) {
  if (typeof v !== 'string' || v.length <= n) return v;
  return `${v.slice(0, n)}…(${v.length} 文字)`;
}

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
    // 値は長さを切って書く。ジョブ番号や機器の名乗りは相手から届いたままなので、長い値を繰り返されると、
    // ログのファイルと画面に返す一覧(recent)が際限なく大きくなるため
    const entry = { at: at.toISOString(), level };
    for (const [k, v] of Object.entries(fields)) entry[k] = clip(v, k === 'detail' ? MAX_DETAIL : MAX_FIELD);
    const day = at.toISOString().slice(0, 10);
    try {
      fs.appendFileSync(path.join(this.dir, `${day}.log`), JSON.stringify(entry) + '\n');
    } catch (e) {
      // 記録に失敗しても通信は止めない(ディスク不足やフォルダ削除など)
      if (this.echo) console.error(`ログを書けませんでした: ${e.message}`);
    }
    this.recent.push(entry);
    if (this.recent.length > 500) this.recent.shift();
    if (this.echo) console.log(`[${level}] ${entry.event} ${entry.peer || ''} ${entry.job || ''} ${entry.result || ''} ${entry.detail || ''}`.trim());
    return entry;
  }

  list(limit = 200) { return this.recent.slice(-limit).reverse(); }

  /**
   * 保存期間(日)を過ぎた日のログのファイルを消す(ジョブ番号や名前が残るため。設計書 7 章)。消したファイル名を返す。
   * 日付は UTC(ファイル名と同じ)で比べ、期限の日を含む日のファイルは残す。
   */
  purge(days, now = new Date()) {
    if (!(days > 0)) return [];
    const keepFrom = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
    // 画面に出す直近の記録(メモリ)からも、消す日の記録を除く
    this.recent = this.recent.filter(e => String(e.at).slice(0, 10) >= keepFrom);
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const old = names.filter(n => /^\d{4}-\d{2}-\d{2}\.log$/.test(n) && n.slice(0, 10) < keepFrom);
    return old.filter(n => { try { fs.unlinkSync(path.join(this.dir, n)); return true; } catch { return false; } });
  }
}

module.exports = { Log };
