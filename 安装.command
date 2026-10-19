#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"
trap 'echo "安装未完成，请查看上方错误后重试。"; read -r -p "按 Enter 关闭…" _answer' ERR
mkdir -p .local
echo "书间 · 首次安装（需要网络，之后可离线使用）"

# Respect explicit runtime choices; fall back to Python already installed on this Mac.
PYTHON_EXEC="${FILESEARCH_PYTHON:-$(command -v python3 || true)}"
if [[ -z "$PYTHON_EXEC" ]] || ! "$PYTHON_EXEC" -c 'import sys; assert sys.version_info >= (3,10)' 2>/dev/null; then
  echo "需要 Python 3.10 或以上版本。请从 https://www.python.org/downloads/macos/ 安装后重试。"
  exit 1
fi
if [[ ! -x .venv/bin/python ]]; then
  "$PYTHON_EXEC" -m venv .venv
fi
.venv/bin/python -m ensurepip --upgrade
.venv/bin/python -m pip install --requirement requirements.txt
.venv/bin/python -c "import sqlite3; c=sqlite3.connect(':memory:'); c.execute(\"CREATE VIRTUAL TABLE t USING fts5(text,tokenize='trigram')\"); print('SQLite FTS5 检查通过')"

# Node is needed only for this one-time frontend build; download a project-local
# official runtime if no suitable Node exists. It is never used by 启动.command.
NODE_EXEC="${FILESEARCH_NODE:-$(command -v node || true)}"
if [[ -z "$NODE_EXEC" && -x "$PROJECT_DIR/.local/node/bin/node" ]]; then
  NODE_EXEC="$PROJECT_DIR/.local/node/bin/node"
fi
if [[ -z "$NODE_EXEC" ]] || ! "$NODE_EXEC" -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<13))process.exit(1)' 2>/dev/null; then
  NODE_VERSION="22.16.0"
  ARCH="$(uname -m)"
  [[ "$ARCH" == "arm64" ]] || ARCH="x64"
  NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
  echo "下载项目专用 Node.js ${NODE_VERSION}…"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" -o ".local/${NODE_ARCHIVE}"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o .local/node-shasums.txt
  (cd .local && /usr/bin/grep " ${NODE_ARCHIVE}\$" node-shasums.txt | shasum -a 256 -c -)
  mkdir -p .local/node
  tar -xzf ".local/${NODE_ARCHIVE}" -C .local/node --strip-components=1
  NODE_EXEC="$PROJECT_DIR/.local/node/bin/node"
fi
export PATH="$(dirname "$NODE_EXEC"):$PATH"
NPM_CLI="$(dirname "$NODE_EXEC")/../lib/node_modules/npm/bin/npm-cli.js"
if [[ -f "$NPM_CLI" ]]; then
  "$NODE_EXEC" "$NPM_CLI" install --prefix "$PROJECT_DIR/.local/build-tools" --cache "$PROJECT_DIR/.local/npm-cache" --no-audit --no-fund pnpm@11.25.0
else
  npm install --prefix "$PROJECT_DIR/.local/build-tools" --cache "$PROJECT_DIR/.local/npm-cache" --no-audit --no-fund pnpm@11.25.0
fi
PNPM_CLI="$PROJECT_DIR/.local/build-tools/node_modules/pnpm/bin/pnpm.cjs"
cd frontend
CI=true "$NODE_EXEC" "$PNPM_CLI" install --frozen-lockfile --store-dir "$PROJECT_DIR/.local/pnpm-store"
"$NODE_EXEC" node_modules/typescript/bin/tsc -b
"$NODE_EXEC" scripts/pdf-assets.mjs
"$NODE_EXEC" node_modules/vite/bin/vite.js build
cd "$PROJECT_DIR"
chmod +x 启动.command 停止.command
echo ""
echo "安装完成。双击「启动.command」，选择资料库目录后即可开始。"
read -r -p "按 Enter 关闭…" _answer
