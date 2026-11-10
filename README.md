# vca-hub

眼鏡店・ラボの機器と PC の間で、VCA(DCS v3.14)のデータを受け取り、保存し、加工機・別の PC・共有フォルダへ中継する常駐プログラムである。

- 受け取ったデータの中身は変えない。足りない項目を補ったり、推測で埋めたりしない。
- 受け取ったデータは、管理画面で人が名前を付けるまで、どこへも渡さない。名前は、送り先へのジョブ番号になる。
- 加工条件の追加や、メーカー独自の項目・通信方式への対応は、拡張で行う。

設計の詳しい内容は [docs/design.md](docs/design.md) にある。

## 必要なもの

- Windows(主な対象)
- Node.js 20 以上。配る zip には node.exe を同梱するので、zip から使うときは要らない。

外部のパッケージは使わない。

## 起動

`start.bat` を開く。または、次のコマンドで起動する。

```
npm start
```

管理画面は、この PC のブラウザで http://localhost:8765 を開く。管理画面は、この PC からだけ開ける。止めるときは、窓を閉じるか Ctrl+C を押す。

## 設定

設定は `config.json` に書く。書かなかった項目は既定値のままになる。主な項目は次のとおりである。

| 項目 | 中身 | 既定値 |
|---|---|---|
| `remote` | 機器から接続してくる形(リモート接続)の待ち受け | 有効、ポート 33512 |
| `local` | vca-hub から機器へ接続する形(ローカル接続)の相手: `[{ name, host, port }]` | なし |
| `autoconnect` | 機器が UDP で知らせてくる形(オートコネクト) | 無効、ポート 33511 |
| `destinations` | 別の PC やソフトへの送り先: `[{ name, host, port, type: 'UPL' か 'TRC', protocol }]` | なし |
| `listeners` | 追加の待ち受け: `[{ name, port, protocol, settings }]` | なし |
| `allow` | 接続を受け付ける IP アドレスの範囲 | この PC とプライベートアドレス |
| `exportDir`・`importDir` | 共有フォルダへの書き出し先と、取り込むフォルダ | なし |
| `removePII` | 受け取ったときに、装用者の氏名・年齢などの項目を除いて保存する | 有効 |
| `retentionDays` | 保存期間(日)。過ぎたデータは、送信待ちのものを除いて自動で消す | なし(手動で消す) |
| `web` | 管理画面のポート | 8765 |
| `dataDir` | データの保存先 | `data/` |
| `extensions`・`extensionsDir` | 使う拡張と、拡張を置くフォルダ | なし、`extensions/` |

例:

```json
{
  "remote": { "enabled": true, "port": 33512 },
  "local": [{ "name": "加工機 1", "host": "192.168.0.50", "port": 50000 }],
  "destinations": [{ "name": "ラボ", "host": "192.168.0.10", "port": 33512, "type": "UPL" }],
  "allow": ["127.0.0.1/32", "192.168.0.0/16"],
  "exportDir": "\\\\server\\share\\vca-out"
}
```

ほかの機器から vca-hub へ接続する形(リモート接続・オートコネクト)を使うときは、Windows のファイアウォールで node.exe の受信を許可する必要がある。配る zip には、許可を登録する `firewall.bat`(管理者として 1 回だけ実行する)を入れている。

## データと個人情報

受け取ったデータは `data/` に保存する。受け取った原文は、手を加えずにそのまま残す(個人情報の項目を除く設定のときは、除いたものを残す)。送受信の記録には、ジョブ番号・相手・結果だけを書き、レコードの中身は書かない。

VCA の注文データには、装用者の氏名や処方度数などの個人情報が含まれることがある。データの保存先のフォルダは、vca-hub を使う Windows のアカウントだけが読み書きできるようにすることを勧める。共有フォルダへ書き出すときは、書き出し先を誰が読めるかを利用者が管理する。

## 拡張

拡張は `extensions/<名前>/index.js` に置き、`config.json` の `extensions` に名前を書く。書いたものだけを読み込む。拡張は vca-hub と同じ権限で動くので、中身を確かめたものだけを入れる。

例を `examples/extensions/` に置いている。

| 例 | 中身 |
|---|---|
| `processing-conditions` | 加工条件を付けるまで送れないようにし、加工機への応答に条件を入れる |
| `vendor-records` | 機器ごとに項目を足したり外したりする |
| `text-protocol` | DCS ではない、テキストの通信方式で受け取り、送る |

拡張の仕組み(フック・通信方式・管理画面のページ)は、設計書の 13 章にある。拡張で通信方式を足した例として、マイコン向けの通信規格 OLDP の機器をつなぐ拡張を [vca-hub-extension](https://github.com/NrivYuki/vca-hub-extension) に置いている。

## テスト

```
npm test
```

模擬機器(`tools/mock-tracer.js`・`tools/mock-edger.js`)で、受信から加工機への送信までを手で試せる。

## 配る zip を作る

```
pwsh -File tools/package.ps1 -NodeZip <Node.js の公式の Windows 用 zip>
```

`dist/` に、node.exe を同梱した zip ができる。展開して `start.bat` を開くだけで動き、インストールも管理者の権限も要らない。

## ライブラリ

`src/lib/` の `vca-parser.js`・`vca-records.js`・`vca-session.js`・`vca-tcp.js` は、[vca-guide](https://github.com/NrivYuki/vca-guide) の `src` から写したものである。vca-guide と同じものに保ち、vca-hub の中では書き換えない。vca-guide が隣のフォルダ(`../vca-guide`)にあれば、テスト `tests/e2e.test.js` が同じであることを確かめる(なければ、この確認だけを飛ばす)。

## 注意

- 実機(トレーサー・加工機)では確かめていない。確かめた範囲は、設計書の 10 章にある。
- DCS v3.14 に従って作っているが、規格への準拠は保証しない。
- vca-hub は加工用のデータを中継するだけで、診断や処方の決定は行わない。

## ライセンス

MIT(`LICENSE`)。無保証であり、データの誤りによる加工の失敗などに責任を負わない。
