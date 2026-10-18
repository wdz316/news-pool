#!/usr/bin/env bash
# 共享新闻池 - 一键启动（macOS / Linux）
set -e
cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "   共享新闻池 - 一键启动"
echo "========================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  [X] 没有检测到 Node.js。"
  echo "      请先安装 Node.js 18+ ： https://nodejs.org/"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  首次运行：正在安装依赖（只需一次）..."
  npm install
fi

PORT="${PORT:-3210}"
URL="http://localhost:${PORT}"
echo ""
echo "  正在启动... 浏览器会自动打开 ${URL}"
echo "  （按 Ctrl+C 停止服务）"
echo ""

( sleep 1; { command -v open >/dev/null 2>&1 && open "$URL"; } || { command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL"; } || true ) >/dev/null 2>&1 &

exec node src/server.js
