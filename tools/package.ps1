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
    Write-Warning 'Node.js の LICENSE が見つかりません。配る前に node フォルダへ入れてください(-NodeZip に公式の zip を渡すと入ります)'
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
    remote = @{ enabled = $true; port = 33512 }
    local = @(@{ name = '加工機 1'; host = '192.168.0.50'; port = 50000 })
    autoconnect = @{ enabled = $false; port = 33511 }
    destinations = @(@{ name = 'ラボ'; host = '192.168.0.10'; port = 33512; type = 'UPL' })
    exportDir = '\\server\share\vca-out'
    importDir = '\\server\share\vca-in'
    allow = @('127.0.0.1/32', '192.168.0.0/16')
    removePII = $true
    retentionDays = $null
    web = @{ port = 8765 }
}
$cfg | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stage 'config.example.json') -Encoding utf8

$crlf = "`r`n"
# 起動用のファイルは、元のフォルダと同じもの(同梱の node\node.exe を先に使う)
Copy-Item (Join-Path $root 'start.bat') $stage

Set-Content (Join-Path $stage 'firewall.bat') -Encoding oem -Value (@(
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
    '止める: start.bat の窓を閉じるか、Ctrl+C を押します。'
    '設定: config.example.json を config.json という名前で写し、書き換えてから起動し直します。'
    '      書かなかった項目は既定のままです(リモート接続 33512 で待ち受け、管理画面 8765)。'
    'ファイアウォール: 機器から vca-hub へつなぐ形(リモート接続)やオートコネクトを使うときは、'
    '      firewall.bat を管理者として 1 回だけ実行します。vca-hub から機器へつなぐ形(ローカル接続)なら要りません。'
    '自動で起動する: start.bat のショートカットを、スタートアップのフォルダ(Win+R で shell:startup)に置きます。'
    ''
    '受け取ったデータは、管理画面で名前を付けるまで、加工機にも別の PC にも共有フォルダにも渡しません。'
    '名前は、送り先へのジョブ番号になります。'
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
