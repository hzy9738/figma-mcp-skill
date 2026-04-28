#!/usr/bin/env bash
set -euo pipefail
# Figma CLI 安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh | bash

REPO_URL="https://github.com/hzy9738/figma-mcp-skill.git"
SKILL_DST_DIR="${HOME}/.agents/skills/figma-cli"
LOCAL_BIN_DIR="${HOME}/.local/bin"
WRAPPER_PATH="${LOCAL_BIN_DIR}/figma-cli"
UNAME_S="$(uname -s)"

case "${UNAME_S}" in
  Darwin|Linux) ;;
  *)
    echo "不支持的平台: ${UNAME_S}。需要 macOS 或 Linux。" >&2
    exit 1
    ;;
esac

# 探测 python3 命令（兼容只有 python 的系统）
PYTHON_BIN=""
for candidate in python3 python; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    PYTHON_BIN="${candidate}"
    break
  fi
done
if [[ -z "${PYTHON_BIN}" ]]; then
  echo "错误: 未找到 python3 或 python，请先安装 Python ≥3.10" >&2
  exit 1
fi

for required_cmd in bash git; do
  if ! command -v "${required_cmd}" >/dev/null 2>&1; then
    echo "缺少必需命令: ${required_cmd}" >&2
    exit 1
  fi
done

# 判断是管道执行还是本地脚本执行
if [[ -n "${BASH_SOURCE[0]:-}" ]] && [[ "${BASH_SOURCE[0]}" != "bash" ]] && [[ -f "${BASH_SOURCE[0]}" ]]; then
  _script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SKILL_SRC_DIR="$(cd "${_script_dir}/.." && pwd)"
  echo "从本地源安装: ${SKILL_SRC_DIR}"

  mkdir -p "$(dirname "${SKILL_DST_DIR}")"
  rm -rf "${SKILL_DST_DIR}"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${SKILL_SRC_DIR}/" "${SKILL_DST_DIR}/"
  else
    cp -a "${SKILL_SRC_DIR}/." "${SKILL_DST_DIR}/"
  fi
else
  echo "从 GitHub 克隆: ${REPO_URL}"
  mkdir -p "$(dirname "${SKILL_DST_DIR}")"
  rm -rf "${SKILL_DST_DIR}"
  git clone --depth 1 "${REPO_URL}" "${SKILL_DST_DIR}"
fi

# 创建 wrapper 脚本
echo "安装 figma-cli ..."
mkdir -p "${LOCAL_BIN_DIR}"
cat > "${WRAPPER_PATH}" <<WRAPPER_EOF
#!/usr/bin/env bash
exec "${PYTHON_BIN}" "${SKILL_DST_DIR}/src/figma_cli/cli.py" "\$@"
WRAPPER_EOF
chmod +x "${WRAPPER_PATH}"

# 安装 httpx（remote/local MCP 需要）
echo "安装依赖 httpx ..."
PIP_BIN=""
for candidate in pip3 pip; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    PIP_BIN="${candidate}"
    break
  fi
done
if [[ -n "${PIP_BIN}" ]]; then
  "${PIP_BIN}" install httpx --quiet 2>/dev/null || \
  "${PYTHON_BIN}" -m pip install httpx --quiet 2>/dev/null || \
  "${PIP_BIN}" install httpx --break-system-packages --quiet 2>/dev/null || \
  echo "  ⚠ httpx 安装失败（不影响 stdio 模式，remote 模式需手动安装: ${PIP_BIN} install httpx）"
else
  echo "  ⚠ 未找到 pip，httpx 需手动安装"
fi

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
echo "  figma-cli --help"
echo "  figma-cli self-check"

# 询问是否安装 skill（/dev/tty 可用时交互，否则静默装到默认目录）
echo
if (true < /dev/tty) 2>/dev/null; then
  read -r -p "是否安装 Skill 到 Agent 目录? [Y/n]: " install_skill < /dev/tty
  install_skill="${install_skill:-y}"
else
  echo "非交互模式，自动安装 Skill ..."
  install_skill="y"
fi

if [[ "${install_skill}" =~ ^[Yy]$ ]]; then
  echo
  if (true < /dev/tty) 2>/dev/null; then
    bash "${SKILL_DST_DIR}/scripts/install-skill.sh" < /dev/tty
  else
    TARGET="${HOME}/.agents/skills/figma-cli"
    mkdir -p "${TARGET}"
    cp "${SKILL_DST_DIR}/skill/SKILL.md" "${TARGET}/SKILL.md"
    echo "  ✓ Skill 已安装到: ${TARGET}"
  fi
fi
