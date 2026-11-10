'use strict';
// JSON ファイルを一時ファイル経由で置き換える。
// Windows ではウイルス対策ソフトや検索インデックスが一瞬ファイルを開いているだけで
// rename が EPERM などで失敗するため、少し待って再試行する。

const fs = require('node:fs');

const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {string} file
 * @param {unknown} data
 * @param {{tries?: number, waitMs?: number}} [opts]
 */
function writeJsonAtomic(file, data, { tries = 10, waitMs = 20 } = {}) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (!RETRY_CODES.has(e.code) || i >= tries) {
        try { fs.unlinkSync(tmp); } catch { /* 消せなくても次回の書き込みで上書きされる */ }
        throw e;
      }
      sleepSync(waitMs * i);
    }
  }
}

module.exports = { writeJsonAtomic };
