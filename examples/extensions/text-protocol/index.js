'use strict';
// 拡張の例: DCS ではない通信方式を足す(規格から外れたメーカーの通信に合わせるときの形の見本)。
// ここでは、行で区切った簡単なテキストの通信方式「text-line」を作る。本物のメーカーの通信では、
// この拡張のように、相手の形と VCA のレコードとの間を変換し、保存・名前で探す・送信済みにする、は vca-hub(io)にまかせる。
//
// text-line の決まり(この例のためのもの。どの規格でもない):
//   受け取る: 相手が「PUT <ジョブ>」の行、VCA の行(ラベル=値)、「END」の行を送る → 保存して「OK」、だめなら「NG <理由>」
//   渡す:     相手が「GET <名前>」の行を送る → 送信待ちなら VCA の行と「END」、無ければ「NG notfound」
//             相手が「ACK」の行を返したら、送信済みにする
//   送る(送り先): vca-hub が相手へつなぎ、「PUT <名前>」・VCA の行・「END」を送り、「OK」を待つ
//
// 使い方: このフォルダを vca-hub の extensions フォルダへ写し、config.json に書く。
//   "extensions": { "text-protocol": true },
//   "listeners": [{ "name": "メーカー A の加工機", "port": 40001, "protocol": "text-line" }],
//   "destinations": [{ "name": "メーカー A のソフト", "host": "192.168.0.20", "port": 40002, "protocol": "text-line" }]

const net = require('node:net');

/** ソケットから 1 行ずつ読む(CR LF・LF 区切り。文字は latin1) */
function lines(socket, onLine) {
  let buf = '';
  socket.setEncoding('latin1');
  socket.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      onLine(line);
    }
    if (buf.length > 1e6) socket.destroy();   // 区切りの無い大きなデータは受けない
  });
}

const toLines = records => records.map(r => `${r[0]}=${r.slice(1).join(';')}\r\n`).join('');

module.exports = {
  title: 'テキストの通信方式(例)',
  version: '0.1.0',
  setup(hub) {
    hub.protocol('text-line', {
      title: 'text-line(例)',

      /** 待ち受ける: 相手からの PUT(受け取る)と GET(渡す) */
      listen({ name, port }, io) {
        const server = net.createServer(socket => {
          const peer = `${socket.remoteAddress}:${socket.remotePort}`.replace(/^::ffff:/, '');
          if (!io.allowed(socket.remoteAddress)) { io.log('warn', { event: 'rejected', detail: `${peer} は許可範囲の外` }); socket.destroy(); return; }
          let putting = null, giving = null;
          lines(socket, line => {
            if (putting) {
              if (line !== 'END') { putting.body += line + '\r\n'; return; }
              try {
                const e = io.receive({ body: putting.body, job: putting.job, peer: `${name} ${peer}` });
                socket.write(`OK ${e.id}\r\n`);
              } catch (err) { socket.write(`NG ${err.message}\r\n`); }
              putting = null;
              return;
            }
            const [cmd, ...rest] = line.split(' ');
            const arg = rest.join(' ');
            if (cmd === 'PUT') putting = { job: arg, body: '' };
            else if (cmd === 'GET') {
              const entry = io.queued(arg);
              if (!entry) { socket.write('NG notfound\r\n'); return; }
              let recs;
              try { recs = io.records(entry); } catch (err) { socket.write(`NG ${err.message}\r\n`); return; }
              giving = entry;
              socket.write(`JOB=${entry.name}\r\n` + toLines(recs) + 'END\r\n');
            } else if (cmd === 'ACK' && giving) {
              io.markSent(giving.id, `${name} ${peer}`);
              giving = null;
            } else socket.write('NG unknown\r\n');
          });
          socket.on('error', () => {});
        });
        return new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, () => resolve({ port: server.address().port, close: () => new Promise(r => server.close(r)) }));
        });
      },

      /** 送り先へ送る: PUT・VCA の行・END を送り、OK なら status 0 */
      upload({ dest, name, records }, io) {
        return new Promise((resolve, reject) => {
          const socket = net.connect(dest.port, dest.host);
          const timer = setTimeout(() => { socket.destroy(); reject(new Error('応答がありません')); }, (io.timeouts.packet || 12) * 1000);
          socket.on('error', e => { clearTimeout(timer); reject(e); });
          socket.on('connect', () => socket.write(`PUT ${name}\r\n` + toLines(records) + 'END\r\n'));
          lines(socket, line => {
            clearTimeout(timer);
            socket.end();
            resolve(line.startsWith('OK') ? { status: 0 } : { status: 8, statusText: line });
          });
        });
      },
    });
  },
};
