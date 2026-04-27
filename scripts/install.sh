#!/usr/bin/env bash
set -euo pipefail
# Figma CLI 安装脚本
# 用法: curl -fsSL <url> | bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILL_DST_DIR="${HOME}/.cc-switch/skills/figma"
LOCAL_BIN_DIR="${HOME}/.local/bin"
WRAPPER_PATH="${LOCAL_BIN_DIR}/figma"
UNAME_S="$(uname -s)"

copy_tree() {
  local src_dir="$1"
  local dst_dir="$2"

  rm -rf "${dst_dir}"
  mkdir -p "${dst_dir}"

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${src_dir}/" "${dst_dir}/"
    return
  fi

  cp -a "${src_dir}/." "${dst_dir}/"
}

case "${UNAME_S}" in
  Darwin|Linux) ;;
  *)
    echo "不支持的平台: ${UNAME_S}。需要 macOS 或 Linux。" >&2
    exit 1
    ;;
esac

for required_cmd in bash python3; do
  if ! command -v "${required_cmd}" >/dev/null 2>&1; then
    echo "缺少必需命令: ${required_cmd}" >&2
    exit 1
  fi
done

mkdir -p "${HOME}/.cc-switch/skills"
copy_tree "${SKILL_SRC_DIR}" "${SKILL_DST_DIR}"

# pip 安装 CLI
echo "安装 figma CLI ..."
python3 -m pip install --user -e "${SKILL_DST_DIR}" 2>&1 || {
  echo "pip 安装失败，尝试使用 wrapper 模式 ..."
  mkdir -p "${LOCAL_BIN_DIR}"
  cat > "${WRAPPER_PATH}" <<'WRAPPER_EOF'
#!/usr/bin/env bash
exec python3 "${HOME}/.cc-switch/skills/figma/src/figma_cli/cli.py" "$@"
WRAPPER_EOF
  chmod +x "${WRAPPER_PATH}"
}

# 确保 PATH 中包含 ~/.local/bin
SHELL_NAME="$(basename "${SHELL:-bash}")"
RC_FILE="${HOME}/.bashrc"
if [[ "${SHELL_NAME}" == "zsh" ]]; then
  RC_FILE="${HOME}/.zshrc"
fi

case ":${PATH}:" in
  *":${LOCAL_BIN_DIR}:"*) ;;
  *)
    echo
    echo "将 ${LOCAL_BIN_DIR} 添加到 PATH:"
    echo "  echo 'export PATH=\"${LOCAL_BIN_DIR}:\$PATH\"' >> ${RC_FILE}"
    ;;
esac

echo
echo "Figma CLI 已安装到: ${SKILL_DST_DIR}"
echo "命令: ${WRAPPER_PATH}"
echo "试试:"
echo "  figma --help"
echo "  figma self-check"
