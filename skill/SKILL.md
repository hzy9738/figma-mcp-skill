---
name: figma-cli
description: Use the Figma MCP server to fetch design context, screenshots, variables, and assets from Figma, and to translate Figma nodes into production code. Trigger when a task involves Figma URLs, node IDs, design-to-code implementation, or Figma MCP setup and troubleshooting.
---

# Figma

通过 shell-first 的 `figma` CLI 调用 Figma MCP server，获取设计上下文、截图、变量和资源。

## 快速开始

```bash
figma-cli status                          # 连接状态与缓存
figma-cli self-check                      # 环境诊断
figma-cli get-design <url>                # 设计上下文（节点树、样式）
figma-cli get-screenshot <node-id>       # 节点截图
figma-cli get-metadata <url>             # 文件/页面元数据
figma-cli get-variable-defs <url>        # 设计变量/令牌
figma-cli search <query>                 # 搜索组件/样式
figma-cli refresh                        # 清除缓存
```

## 工作流

### 1. 设计审查

```bash
# 获取设计稿完整上下文
figma-cli get-design "https://www.figma.com/design/ABC123/MyApp?node-id=1-2"

# 截取特定组件截图查看
figma-cli get-screenshot "1:2" --file-key ABC123

# 查看设计令牌/变量
figma-cli get-variable-defs "https://www.figma.com/design/ABC123/MyApp"
```

### 2. 设计到代码

```bash
# 获取针对目标技术栈的设计上下文
figma-cli get-design "https://www.figma.com/design/ABC123/MyApp?node-id=1-2" \
  --client-languages typescript \
  --client-frameworks react
```

### 3. 检查环境

```bash
figma-cli self-check
```

## 后端选择

优先级: 本机 Figma Desktop MCP → npx → 远程云

| 后端 | 配置 | 说明 |
|---|---|---|
| 本机 MCP | 默认，Figma 桌面端已开启 | 免费账户可用，无需 API key |
| npx Desktop | `FIGMA_BACKEND=desktop` | 通过 npx figma-developer-mcp |
| 远程云 | `FIGMA_MCP_URL=https://mcp.figma.com/mcp` + `FIGMA_API_KEY` | 有 Figma API key |

```bash
# 默认：自动检测本机 Figma Desktop MCP (http://127.0.0.1:3845/mcp)
figma-cli self-check

# 远程云 MCP
export FIGMA_MCP_URL=https://mcp.figma.com/mcp
export FIGMA_API_KEY=figd_xxxxx
figma-cli status
```

## 缓存

- 设计数据缓存在 `<project>/.figma/<file-key>/` 下
- 重复请求同一文件自动使用缓存
- `figma-cli refresh` 强制清除缓存

## 环境变量

| 变量 | 说明 |
|---|---|
| `FIGMA_API_KEY` | Figma Personal Access Token |
| `FIGMA_OAUTH_TOKEN` | Figma OAuth Bearer Token |
| `FIGMA_BACKEND` | 后端选择: auto, desktop, remote |
| `FIGMA_MCP_URL` | 自定义 MCP HTTP 端点 (默认 http://127.0.0.1:3845/mcp) |
| `FIGMA_MCP_BIN` | 自定义 Figma MCP server 路径 |
| `FIGMA_IMAGE_DIR` | 图片下载输出目录 |

## 安装

要求 Node.js ≥ 19（零外部依赖）。

```bash
# curl 一行安装
curl -fsSL https://raw.githubusercontent.com/hzy9738/figma-mcp-skill/main/scripts/install.sh | bash

# 或 git clone + npm link
git clone https://github.com/hzy9738/figma-mcp-skill.git ~/.agents/skills/figma-cli
npm install -g ~/.agents/skills/figma-cli
```

迁移到另一台机器：

```bash
bash ~/.agents/skills/figma-cli/scripts/install.sh
```

## 常见问题

### 「MCP server 连接断开」

- 检查 Node.js 版本 ≥ 19: `node --version`
- 检查 figma-developer-mcp 是否可用: `npx figma-developer-mcp --version`
- 如果使用 remote 后端，检查 FIGMA_API_KEY 是否设置
- 添加 `--debug` 查看详细的 HTTP 请求/响应信息

### 「无法解析 URL」

支持三种输入格式：
- 完整 URL: `https://www.figma.com/design/ABC123/MyFile?node-id=1-2`
- file_key: `ABC123`（需同时指定 --node-id）
- node_id: `1:2`（需同时指定 --file-key）

### 缓存位置

缓存目录 `.figma/` 建议添加到 `.gitignore`：

```bash
echo '.figma/' >> .gitignore
```
