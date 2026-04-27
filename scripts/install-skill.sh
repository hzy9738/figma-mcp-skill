#!/usr/bin/env bash
set -euo pipefail
# 交互式安装 figma skill 到 Claude Code / Codex 等 Agent 环境

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILL_FILE="${SKILL_SRC_DIR}/skill/SKILL.md"

echo "安装 Figma Skill ..."
echo ""

# 目标目录列表
SKILL_TARGETS=(
  "${HOME}/.claude/skills/figma"
  "${HOME}/.agent/skills/figma"
  "${HOME}/.agents/skills/figma"
  "${HOME}/.cc-switch/skills/figma"
)

for target in "${SKILL_TARGETS[@]}"; do
  if [[ -d "$(dirname "${target}")" ]]; then
    echo "安装到: ${target}"
    mkdir -p "${target}"
    cp "${SKILL_FILE}" "${target}/SKILL.md"
    echo "  ✓ 完成"
  fi
done

echo ""
echo "Figma Skill 安装完成。"
echo "请确保 figma CLI 已安装: figma --help"
echo "如果没有，请先运行: bash ${SKILL_SRC_DIR}/scripts/install.sh"
