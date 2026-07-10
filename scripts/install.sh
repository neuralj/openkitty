#!/usr/bin/env bash
# OpenKitty installer
#
# 将插件(plugins)、技能(skills) 拷贝到 PREFIX 目录，并把 MCP / plugin / skills
# 引用合并进 opencode.jsonc。无需 OCX，单脚本即可完成分发。
#
# 用法见: bash install.sh --help

set -euo pipefail

# 仓库根目录 = 本脚本上一级目录
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 确保 node 可用
if ! command -v node >/dev/null 2>&1; then
  echo "error: 需要 node 来合并配置，请先安装 node。" >&2
  exit 1
fi

# 若 dist 缺失则尝试构建
if [ ! -d "$REPO_ROOT/dist/plugins" ] || [ -z "$(ls -A "$REPO_ROOT/dist/plugins" 2>/dev/null)" ]; then
  echo "==> 未检测到 dist/plugins，尝试构建..."
  (cd "$REPO_ROOT" && npm run build)
fi

exec node "$REPO_ROOT/scripts/merge-config.mjs" "$@"
