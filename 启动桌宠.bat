@echo off
chcp 65001 >nul
title DS鲸鱼娘 桌宠
cd /d "%~dp0app"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 没找到 Electron，请先在 app 目录执行： npm install
  pause
  exit /b 1
)
echo 正在启动 DS鲸鱼娘 桌宠...
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
