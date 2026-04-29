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

### 无桌面端（仅远程 Figma）

没装 Figma 桌面端时，设置 API key 后自动通过 npx stdio 连接：

```bash
export FIGMA_API_KEY=figd_xxxxx
figma-cli status
```

也可用 OAuth token 走远程 HTTP 端点：

```bash
export FIGMA_OAUTH_TOKEN=figx_xxxxx
export FIGMA_MCP_URL=https://mcp.figma.com/mcp
figma-cli status
```

### 中国大陆安装

GitHub 访问受限时，安装脚本内置了备用代理链（git clone 失败自动换 curl tarball → gitclone.com 兜底），直接运行即可：

```bash
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh | bash
```

如果 `ghproxy.net` 也不可用，手动指定一个能通的 git 镜像：

```bash
# gitclone.com 镜像（测试可用）
export FIGMA_REPO_URL=https://gitclone.com/github.com/hzy9738/figma-mcp-skill.git
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh | bash

# 也可用其他镜像，格式一致
export FIGMA_REPO_URL=https://ghproxy.net/https://github.com/hzy9738/figma-mcp-skill.git
curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh | bash
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
