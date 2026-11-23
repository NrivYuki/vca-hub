#Requires -Version 7
<#
.SYNOPSIS
  vca-hub を、インストールなしで動く zip にする(設計書 1 章・12 章)。

.DESCRIPTION
  node.exe を同梱したフォルダを作り、zip にする。展開して start.bat を開くだけで動く(Node.js のインストールも、管理者の権限も要らない)。
    vca-hub-<版>/
      start.bat            起動する
      firewall.bat         ファイアウォールの許可を登録する(管理者で 1 回だけ。リモート接続・オートコネクトを使うときだけ)
      README.txt           使い方
      LICENSE              vca-hub のライセンス(MIT)
      config.example.json  設定の例(config.json にして使う)
      node/node.exe        Node.js(と、その LICENSE)
      src/                 vca-hub
      extensions/          使う拡張を置く(config.json の extensions に名前を書いたものだけを読む)
      examples/extensions/ 拡張の例
      data/                (初めて起動したときに作られる)

  node.exe は、-NodeZip に Node.js の公式の Windows 用 zip(node-v<版>-win-x64.zip)を渡すと、そこから node.exe と LICENSE を取り出す。
  渡さなければ、この PC に入っている node.exe を使う。その場合、Node.js の LICENSE が見つからなければ警告する
  (node.exe を配るときは、Node.js のライセンスの文書を一緒に入れる必要がある)。

.EXAMPLE
  pwsh -File tools/package.ps1
  pwsh -File tools/package.ps1 -NodeZip C:\Downloads\node-v24.20.0-win-x64.zip
#>
[CmdletBinding()]
param(
    [string]$NodeZip,
    [string]$OutDir = (Join-Path (Split-Path $PSScriptRoot) 'dist')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$name = "vca-hub-$version"
$stage = Join-Path $OutDir $name
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'node') | Out-Null

# ---- node.exe と、その LICENSE ----
$nodeDir = Join-Path $stage 'node'
$licenseFound = $false
if ($NodeZip) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("vcahub-node-" + [guid]::NewGuid())
    Expand-Archive -LiteralPath $NodeZip -DestinationPath $tmp
    $top = Get-ChildItem $tmp -Directory | Select-Object -First 1
    Copy-Item (Join-Path $top.FullName 'node.exe') $nodeDir
    if (Test-Path (Join-Path $top.FullName 'LICENSE')) { Copy-Item (Join-Path $top.FullName 'LICENSE') $nodeDir; $licenseFound = $true }
    Remove-Item $tmp -Recurse -Force
} else {
    $exe = (Get-Command node).Source
    Copy-Item $exe $nodeDir
    $lic = Join-Path (Split-Path $exe) 'LICENSE'
    if (Test-Path $lic) { Copy-Item $lic $nodeDir; $licenseFound = $true }
}
if (-not $licenseFound) {
    # 配る zip には Node.js のライセンスの文書が要る(README.txt が node\LICENSE を指す)。無いまま作らない
    throw 'Node.js の LICENSE が見つかりません。-NodeZip に Node.js の公式の zip を渡してください'
}
$nodeVersion = & (Join-Path $nodeDir 'node.exe') -v

# ---- vca-hub ----
Copy-Item (Join-Path $root 'src') (Join-Path $stage 'src') -Recurse
Copy-Item (Join-Path $root 'package.json') $stage
Copy-Item (Join-Path $root 'LICENSE') $stage
# 拡張(設計書 13 章): 使う拡張を置くフォルダ(空)と、例の拡張
New-Item -ItemType Directory -Force (Join-Path $stage 'extensions') | Out-Null
Copy-Item (Join-Path $root 'examples') (Join-Path $stage 'examples') -Recurse

$cfg = [ordered]@{
    remote = [ordered]@{ enabled = $true; port = 33512 }
    local = @([ordered]@{ name = '加工機 1'; host = '192.168.0.50'; port = 50000 })
    autoconnect = [ordered]@{ enabled = $false; port = 33511 }
    destinations = @([ordered]@{ name = 'ラボ'; host = '192.168.0.10'; port = 33512; type = 'UPL' })
    exportDir = '\\server\share\vca-out'
    importDir = '\\server\share\vca-in'
    allow = @('127.0.0.1/32', '192.168.0.0/16')
    removePII = $true
    retentionDays = 90
    web = [ordered]@{ port = 8765 }
}
$cfg | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stage 'config.example.json') -Encoding utf8

$crlf = "`r`n"
# 起動用のファイルは、元のフォルダと同じもの(同梱の node\node.exe を先に使う)
Copy-Item (Join-Path $root 'start.bat') $stage

# firewall.bat は CP932 で書く(zip を作る PC の言語によらず、cmd.exe で日本語の rem が読めるように)
[System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
Set-Content (Join-Path $stage 'firewall.bat') -Encoding ([System.Text.Encoding]::GetEncoding(932)) -Value (@(
    '@echo off'
    'rem vca-hub の node.exe が、ほかの機器からの接続(リモート接続 TCP 33512、オートコネクト UDP 33511)を受けられるようにする。'
    'rem 管理者として 1 回だけ実行する。config.json でポートを変えたときは、下の番号も変える。'
    'cd /d "%~dp0"'
    'netsh advfirewall firewall add rule name="vca-hub VCA" dir=in action=allow program="%~dp0node\node.exe" protocol=TCP localport=33512 profile=private,domain'
    'netsh advfirewall firewall add rule name="vca-hub autoconnect" dir=in action=allow program="%~dp0node\node.exe" protocol=UDP localport=33511 profile=private,domain'
    'pause'
) -join $crlf)

Set-Content (Join-Path $stage 'README.txt') -Encoding utf8 -Value (@(
    "vca-hub $version(Node.js $nodeVersion を同梱)"
    ''
    '眼鏡店・ラボの機器と PC の間で VCA(DCS v3.14)のデータを受け取り、このフォルダの data に保存し、'
    '加工機・別の PC・共有フォルダへ中継します。インストールは要りません。'
    ''
    '起動: start.bat を開きます。管理画面は、この PC のブラウザで http://localhost:8765 を開きます。'
    '止める: start.bat の窓を閉じるか、Ctrl+C を押します。Ctrl+C のあとに「バッチ ジョブを終了しますか (Y/N)?」と聞かれたら Y を、'
    '      「続行するには何かキーを押してください」と出たら何かキーを押します(vca-hub はもう止まっています)。'
    '設定: config.example.json を config.json という名前で写し、書き換えてから起動し直します。'
    '      書かなかった項目は既定のままです(リモート接続 33512 で待ち受け、管理画面 8765)。'
    '      機器からの接続は、config.json の allow に書いたアドレスからだけ受けます(既定はこの PC だけ)。'
    '      受け取ったデータと送受信の記録は、既定では 90 日で消します(retentionDays。null で無期限)。'
    '      ただし、90 日を 30 日より多く過ぎたもの(PC の時計が遅れていた間に受け取ったかもしれないもの)は、消さずに記録で知らせます。'
    '      config.json の書き方に誤り(知らない項目の名前も含む)があると、項目の名前を出して起動しません。'
    '機器の側: トレーサー・加工機に、この PC の IP アドレスと 33512 を設定します。IP アドレスは、コマンドプロンプトで'
    '      ipconfig を実行し、「IPv4 アドレス」を見ます。機器が待ち受ける形(vca-hub からつなぐ)のときだけ local に書きます。'
    'ファイアウォール: 機器から vca-hub へつなぐ形(リモート接続)やオートコネクトを使うときは、'
    '      firewall.bat を管理者として 1 回だけ、vca-hub を初めて起動する前に実行します。vca-hub から機器へつなぐ形(ローカル接続)なら要りません。'
    '      先に start.bat を開いて Windows の警告を「キャンセル」すると、遮断の規則ができて許可が効きません。'
    '      許可するのはプライベートとドメインのネットワークだけです。Windows がネットワークをパブリックに'
    '      分類していると効かないので、そのときはネットワークの種類をプライベートに変えます。'
    '自動で起動する: start.bat のショートカットを、スタートアップのフォルダ(Win+R で shell:startup)に置きます。'
    ''
    'config.example.json から書き換えるところ:'
    '  allow          機器のアドレスの範囲を書き足す(書かないと、ほかの機器からの接続を断ります)'
    '  local          vca-hub から機器へつなぐときだけ。使わなければ消す'
    '  destinations   別の PC やラボへ送るときだけ。使わなければ消す'
    '  exportDir・importDir  共有フォルダを使うときだけ。使わなければ消す'
    '  config.json の中では、パスの \ を 2 つ重ねて書きます(例: "\\\\server\\share\\vca-out")。'
    ''
    '加工機にジョブが出ないとき: 1) 受信の一覧で、名前と状態が「送信待ち」かを見る 2) 記録の「要求に応えられず」の行の理由を見る'
    '  3) 記録に「接続を断った」があれば allow を見る 4) 状態に「加工機に渡せなかった」とあれば、詳細の理由を見る'
    '送受信の記録は窓には出しません。管理画面の「記録」と data\log で見ます。'
    '共有フォルダは \\server\share の形で書きます(割り当てたドライブ Z: などでは、共有フォルダの PC が止まったとき vca-hub が止まることがあります)。'
    ''
    '受け取ったデータは、管理画面で名前を付けるまで、加工機にも別の PC にも共有フォルダにも渡しません。'
    '名前は、送り先へのジョブ番号になります。'
    'ジョブ番号(JOB)は、保存するファイルの名前と送受信の記録に入ります。装用者の名前をジョブ番号にしないでください。'
    ''
    '拡張: vca-hub は中継に徹し、受け取った中身は変えません。加工条件を足す、メーカー独自の項目や通信方式に合わせる、'
    '      といったことは拡張で行います。拡張のフォルダを extensions に置き、config.json の extensions に名前を書きます。'
    '      例が examples\extensions にあります(加工条件・メーカー別の項目・テキストの通信方式)。'
    '      拡張は vca-hub と同じ権限で動くので、中身を確かめたものだけを入れてください。'
    ''
    'vca-hub のライセンスは MIT で、LICENSE にあります。無保証です(データの誤りによる加工の失敗などに責任を負いません)。'
    'node フォルダの node.exe は Node.js(https://nodejs.org)のもので、そのライセンスは node\LICENSE にあります。'
) -join $crlf)

# ---- zip ----
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path $stage -DestinationPath $zip
Write-Host ("作りました: {0}({1:N1} MB)" -f $zip, ((Get-Item $zip).Length / 1MB))
