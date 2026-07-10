#!/usr/bin/env bash
# OpenKitty 一键安装器
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/neuralj/openkitty/main/install.sh | bash
#
# 该脚本下载最新 GitHub Release 打包产物 (openkitty.tar.gz)，解压后调用其中
# 内置的 scripts/install.sh 完成插件 / 技能 / 模板的拷贝与 opencode.jsonc 合并。
# 所有传给本脚本的参数都会透传给内置安装器，例如:
#   bash install.sh --prefix ~/.openkitty --project ~/my-project

set -euo pipefail

REPO="neuralj/openkitty"
VERSION="${OPENKITTY_VERSION:-latest}"

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "==> 解析 OpenKitty 发布版本: ${VERSION}"

if [ "$VERSION" = "latest" ]; then
  URL="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -o 'https://github.com/[^"]*/openkitty.tar.gz' | head -1)"
  [ -z "$URL" ] && { echo "error: 未找到最新 release 的 openkitty.tar.gz" >&2; exit 1; }
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/openkitty.tar.gz"
fi

echo "==> 下载 ${URL}"
curl -fsSL "$URL" -o "$TMP/openkitty.tar.gz"

echo "==> 解压到临时目录"
tar -xzf "$TMP/openkitty.tar.gz" -C "$TMP"

echo "==> 运行内置安装器"
exec bash "$TMP/openkitty/scripts/install.sh" "$@"
