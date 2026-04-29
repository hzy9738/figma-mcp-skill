# Figma MCP Skill

Shell-first 的 Figma 设计稿到代码桥梁。通过 `figma` CLI 命令调用 Figma MCP server，
无需配置 MCP 协议，Agent 直接通过 shell 调用。**零外部依赖，仅需 Node.js ≥ 19。**

## 安装

**macOS / Linux（推荐）：**

```bash
curl -fsSL https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh | bash
```

**macOS / Linux / Git Bash：**

```bash
git clone https://github.com/hzy9738/figma-mcp-skill.git ~/.agents/skills/figma-cli
npm install -g ~/.agents/skills/figma-cli
```

**Windows (PowerShell)：**

```powershell
git clone https://github.com/hzy9738/figma-mcp-skill.git $env:USERPROFILE\.agents\skills\figma-cli
npm install -g $env:USERPROFILE\.agents\skills\figma-cli
```

## 使用

```bash
# 查看状态
figma-cli status

# 环境诊断
figma-cli self-check

# 获取设计上下文
figma-cli get-design "https://www.figma.com/design/ABC123/MyApp?node-id=1-2"

# 截取节点截图（自动保存为 PNG）
figma-cli get-screenshot "1:2" --file-key ABC123

# 截图导出到指定路径
figma-cli get-screenshot "1:2" --file-key ABC123 -o ./screenshot.png

# 获取设计变量
figma-cli get-variable-defs "https://www.figma.com/design/ABC123/MyApp"

# 搜索组件
figma-cli search "button"

# 清除缓存
figma-cli refresh
```

## 后端

优先级: 本机 Figma Desktop MCP → npx → 远程云

| 后端 | 配置 | 说明 |
|---|---|---|
| 本机 MCP | 默认 (http://127.0.0.1:3845/mcp) | 免费账户可用，无需 API key |
| 远程云 | `FIGMA_MCP_URL=https://mcp.figma.com/mcp` + `FIGMA_API_KEY` | 有 Figma API key |

```bash
# 远程云 MCP
export FIGMA_MCP_URL=https://mcp.figma.com/mcp
export FIGMA_API_KEY=figd_xxxxx
```

## 环境变量

- `FIGMA_API_KEY` — Figma Personal Access Token
- `FIGMA_OAUTH_TOKEN` — Figma OAuth Bearer Token
- `FIGMA_BACKEND` — 后端选择: auto (默认), desktop, remote
- `FIGMA_MCP_URL` — 自定义 MCP HTTP 端点
- `FIGMA_MCP_BIN` — 自定义 MCP server 路径
- `FIGMA_IMAGE_DIR` — 图片下载目录

## 开发

```bash
# 直接运行
node bin/figma-cli.js --help

# 运行测试
node --test tests/test.js
```

## 要求

- Node.js ≥ 19（零外部 npm 依赖，仅使用内置模块）
