@echo off
rem vca-hub を起動する。止めるときは、この窓を閉じるか Ctrl+C を押す。
rem 同じフォルダの node\node.exe を使う。無ければ、この PC に入っている Node.js(20 以上)を使う。
cd /d "%~dp0"
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" (
    where node >nul 2>nul || (
        echo Node.js が見つかりません。node フォルダに node.exe を置くか、Node.js を入れてください。
        pause
        exit /b 1
    )
    set "NODE=node"
)
"%NODE%" src\main.js
pause
