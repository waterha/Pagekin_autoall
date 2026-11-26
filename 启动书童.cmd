@echo off
setlocal
chcp 65001 >nul
title 书童 - 当前项目启动
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
echo 正在从当前项目启动书童：%CD%
echo 此窗口会显示启动日志，请勿关闭。退出时按 Ctrl+C。
echo.
where pnpm >nul 2>nul
if errorlevel 1 (
  echo 未找到 pnpm，请先安装 Node.js 和项目要求的 pnpm。
  pause
  exit /b 1
)
if not exist "node_modules\vite\bin\vite.js" (
  echo 缺少项目依赖，请先在当前目录运行 pnpm install。
  pause
  exit /b 1
)
call pnpm run dev
set "result=%errorlevel%"
echo.
echo 启动服务已结束，返回码：%result%
echo 若未出现书童窗口，请把上方日志截图发来。
pause
exit /b %result%
