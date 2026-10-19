#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
if [[ -x .venv/bin/python ]]; then
  .venv/bin/python -m backend.launcher --stop
else
  echo "书间尚未安装。"
fi
