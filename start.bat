@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"
title 共享新闻池

echo.
echo ========================================
echo    共享新闻池 - 一键安装并启动
echo ========================================
echo.

call :ensure_node
if errorlevel 1 (
  echo.
  echo   安装 Node.js 后，请重新双击本文件。
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo   首次运行：正在安装依赖（只需一次，请稍候）...
  call npm install
  if errorlevel 1 (
    echo.
    echo   [X] 依赖安装失败。请检查网络后重试；若反复失败，
    echo       可先运行：npm config set registry https://registry.npmmirror.com
    echo.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=3210
echo.
echo   正在启动... 浏览器会自动打开 http://localhost:%PORT%
echo   （关掉这个黑窗口即可停止服务）
echo.
start "" http://localhost:%PORT%
node src\server.js
echo.
echo   服务已停止。
pause
exit /b 0

:: ---------------------------------------------------------------
:: 确保有 Node.js：没有就用 winget 一键装；装不了就给出指引
:: ---------------------------------------------------------------
:ensure_node
where node >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%v in ('node -v') do echo   已检测到 Node.js %%v
  exit /b 0
)

echo   [ ! ] 没有检测到 Node.js（这个程序需要它才能运行）。
echo.
where winget >nul 2>nul
if errorlevel 1 (
  echo   你的系统没有 winget，无法自动安装。请手动安装：
  echo       1^) 打开  https://nodejs.org/
  echo       2^) 下载 Windows 安装包（LTS 版本），一路“下一步”
  echo       3^) 装完重新双击本文件
  exit /b 1
)

echo   可以尝试用 winget 自动安装 Node.js LTS（会弹出系统安装，约 1 分钟）。
set /p ANS=  现在就装吗？[Y/N] 
if /I not "%ANS%"=="Y" (
  echo   已取消。请手动到 https://nodejs.org/ 安装后重试。
  exit /b 1
)

winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
echo.
echo   安装命令执行完毕。注意：新装的 Node 需要“新开窗口”才生效。
echo   请关掉本窗口，然后重新双击本文件。
exit /b 1
