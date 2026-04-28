#!/usr/bin/env bash
set -euo pipefail
# 交互式安装 figma skill 到 Agent 环境

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SKILL_FILE="${SKILL_SRC_DIR}/skill/SKILL.md"

echo "安装 Figma Skill"
echo ""

echo "选择安装目录:"
echo "  1) ~/.agents/skills           (默认)"
echo "  2) ~/.claude/skills           (Claude Code)"
echo "  3) ~/.codex/skills            (Codex)"
echo "  4) ~/.opencode/skills         (OpenCode)"
echo "  5) ~/.cc-switch/skills        (cc-switch)"
echo "  6) 手动输入路径"
echo ""

read -r -p "请输入序号 [1]: " choice
choice="${choice:-1}"

case "${choice}" in
  1) TARGET="${HOME}/.agents/skills/figma-cli" ;;
  2) TARGET="${HOME}/.claude/skills/figma-cli" ;;
  3) TARGET="${HOME}/.codex/skills/figma-cli" ;;
  4) TARGET="${HOME}/.opencode/skills/figma-cli" ;;
  5) TARGET="${HOME}/.cc-switch/skills/figma-cli" ;;
  6)
    read -r -p "请输入安装路径: " TARGET
    if [[ -z "${TARGET}" ]]; then
      echo "路径不能为空" >&2
      exit 1
    fi
    ;;
  *)
    echo "无效选择: ${choice}" >&2
    exit 1
    ;;
esac

mkdir -p "${TARGET}"
cp "${SKILL_FILE}" "${TARGET}/SKILL.md"

echo ""
echo "✓ Figma Skill 已安装到: ${TARGET}"
echo ""
echo "请确保 figma-cli 命令已安装: figma-cli --help"
echo "如果没有，请运行: bash ${SKILL_SRC_DIR}/scripts/install.sh"
