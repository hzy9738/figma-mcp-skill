#!/usr/bin/env bash
set -euo pipefail
# Figma CLI 安装脚本 (Node.js)
# 用法: curl -fsSL https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh | bash
#
# 中国大陆可通过代理加速:
#   curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh | bash
# 代理下载脚本后，git clone 也需要走代理，通过 FIGMA_REPO_URL 指定:
#   export FIGMA_REPO_URL=https://gh-proxy.org/https://github.com/hzy9738/figma-mcp-skill.git
#   curl -fsSL https://gh-proxy.org/... | bash
# 或一行:
#   FIGMA_REPO_URL=https://gh-proxy.org/https://github.com/hzy9738/figma-mcp-skill.git bash -c "$(curl -fsSL https://gh-proxy.org/https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh)"

REPO_URL="${FIGMA_REPO_URL:-https://github.com/hzy9738/figma-mcp-skill.git}"
SKILL_DST_DIR="${HOME}/.agents/skills/figma-cli"
LOCAL_BIN_DIR="${HOME}/.local/bin"
WRAPPER_PATH="${LOCAL_BIN_DIR}/figma-cli"
UNAME_S="$(uname -s)"

case "${UNAME_S}" in
  Darwin|Linux|MINGW*|MSYS*|CYGWIN*) ;;
  *)
    echo "不支持的平台: ${UNAME_S}。需要 macOS / Linux / Windows Git Bash。" >&2
    exit 1
    ;;
esac

# 检查 Node.js >= 19
NODE_BIN=""
for candidate in node; do
  if command -v "${candidate}" >/dev/null 2>&1; then
    NODE_BIN="${candidate}"
    break
  fi
done
if [[ -z "${NODE_BIN}" ]]; then
  echo "错误: 未找到 Node.js，请先安装 Node.js ≥19" >&2
  exit 1
fi

NODE_VERSION="$("${NODE_BIN}" --version | sed 's/^v//')"
NODE_MAJOR="$(echo "${NODE_VERSION}" | cut -d. -f1)"
if [[ "${NODE_MAJOR}" -lt 19 ]]; then
  echo "错误: Node.js ≥19 必须，当前版本 ${NODE_VERSION}" >&2
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

  # git clone 主逻辑：失败时依次尝试备用代理
  _clone_or_extract() {
    local url="$1"
    local dst="$2"
    mkdir -p "$(dirname "${dst}")"
    rm -rf "${dst}"

    # 1) 尝试 git clone
    if git clone --depth 1 "${url}" "${dst}" 2>/dev/null; then
      return 0
    fi
    echo "  git clone 失败，尝试 curl 下载 ..."

    # 2) 从代理 URL 还原原始 GitHub URL，构造 tarball 地址
    local gh_url="${url}"
    # 匹配 https://<proxy>/https://github.com/... 提取原始 URL
    if [[ "${url}" =~ https?://[^/]+/https?://github\.com/(.+)\.git$ ]]; then
      gh_url="https://github.com/${BASH_REMATCH[1]}"
    fi
    # 匹配 https://gitclone.com/github.com/... 提取原始 URL
    if [[ "${url}" =~ https?://gitclone\.com/github\.com/(.+)\.git$ ]]; then
      gh_url="https://github.com/${BASH_REMATCH[1]}"
    fi

    local tarball_url="${gh_url%.git}/archive/refs/heads/main.tar.gz"
    echo "  尝试 tarball: ${tarball_url}"

    if curl -fsSL --max-time 60 "${tarball_url}" | tar xz -C "$(dirname "${dst}")" 2>/dev/null; then
      # 解压后目录名是 <repo>-main，重命名为目标名
      local extracted="$(dirname "${dst}")/$(basename "${gh_url%.git}")-main"
      if [[ -d "${extracted}" ]] && [[ "${extracted}" != "${dst}" ]]; then
        mv "${extracted}" "${dst}"
      fi
      return 0
    fi

    # 3) 最后尝试通过 gitclone.com 兜底
    local basename="${gh_url#https://github.com/}"
    basename="${basename%.git}"
    echo "  尝试 gitclone.com 兜底: gitclone.com/github.com/${basename}.git"
    if git clone --depth 1 "https://gitclone.com/github.com/${basename}.git" "${dst}" 2>/dev/null; then
      return 0
    fi

    return 1
  }

  if ! _clone_or_extract "${REPO_URL}" "${SKILL_DST_DIR}"; then
    echo "错误: 无法下载仓库，请检查网络连接或尝试其他代理。" >&2
    echo "备选方案: 手动下载 https://github.com/hzy9738/figma-mcp-skill/archive/refs/heads/main.zip" >&2
    echo "  解压到 ${SKILL_DST_DIR} 后重新运行本脚本。" >&2
    exit 1
  fi
fi

# 创建 wrapper 脚本（零外部依赖，直接 node 运行）
echo "安装 figma-cli ..."
mkdir -p "${LOCAL_BIN_DIR}"
cat > "${WRAPPER_PATH}" <<WRAPPER_EOF
#!/usr/bin/env bash
exec "${NODE_BIN}" "${SKILL_DST_DIR}/bin/figma-cli.js" "\$@"
WRAPPER_EOF
chmod +x "${WRAPPER_PATH}"

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
