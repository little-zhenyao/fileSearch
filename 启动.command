#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
if [[ ! -x .venv/bin/python ]]; then
  echo "请先双击「安装.command」完成首次安装。"
  read -r -p "按 Enter 关闭…" _answer
  exit 1
fi
if ! .venv/bin/python -m backend.launcher; then
  echo "启动失败。请查看上方错误；可重新运行「安装.command」修复依赖。"
  read -r -p "按 Enter 关闭…" _answer
  exit 1
fi
