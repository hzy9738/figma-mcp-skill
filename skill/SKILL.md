---
name: figma
description: Use the Figma MCP server to fetch design context, screenshots, variables, and assets from Figma, and to translate Figma nodes into production code. Trigger when a task involves Figma URLs, node IDs, design-to-code implementation, or Figma MCP setup and troubleshooting.
---

# Figma

通过 shell-first 的 `figma` CLI 调用 Figma MCP server，获取设计上下文、截图、变量和资源。

## 快速开始

```bash
figma status                          # 连接状态与缓存
figma self-check                      # 环境诊断
figma get-design <url>                # 设计上下文（节点树、样式）
figma get-screenshot <node-id>       # 节点截图
figma get-metadata <url>             # 文件/页面元数据
figma get-variable-defs <url>        # 设计变量/令牌
figma search <query>                 # 搜索组件/样式
figma refresh                        # 清除缓存
```

## 工作流

### 1. 设计审查

```bash
# 获取设计稿完整上下文
figma get-design "https://www.figma.com/design/ABC123/MyApp?node-id=1-2"

# 截取特定组件截图查看
figma get-screenshot "1:2" --file-key ABC123

# 查看设计令牌/变量
figma get-variable-defs "https://www.figma.com/design/ABC123/MyApp"
```

### 2. 设计到代码

```bash
# 获取针对目标技术栈的设计上下文
figma get-design "https://www.figma.com/design/ABC123/MyApp?node-id=1-2" \
  --client-languages typescript \
  --client-frameworks react
```

### 3. 检查环境

```bash
figma self-check
```

## 后端选择

| 后端 | 配置方式 | 适用场景 |
|---|---|---|
| Desktop MCP | 默认，需要 Figma 桌面端 | 本地开发，免费账户可用 |
| Remote MCP | `FIGMA_BACKEND=remote` + `FIGMA_API_KEY` | 有 Figma API key，操作线上文件 |

```bash
# 使用远程 MCP
export FIGMA_BACKEND=remote
export FIGMA_API_KEY=figd_xxxxx
figma status
```

CLI 默认自动检测可用后端（`FIGMA_BACKEND=auto`）。

## 缓存

- 设计数据缓存在 `<project>/.figma/<file-key>/` 下
- 重复请求同一文件自动使用缓存
- `figma refresh` 强制清除缓存

## 环境变量

| 变量 | 说明 |
|---|---|
| `FIGMA_API_KEY` | Figma Personal Access Token |
| `FIGMA_OAUTH_TOKEN` | Figma OAuth Bearer Token |
| `FIGMA_BACKEND` | 后端选择: auto, desktop, remote |
| `FIGMA_MCP_BIN` | 自定义 Figma MCP server 路径 |
| `FIGMA_IMAGE_DIR` | 图片下载输出目录 |

## 安装

```bash
# curl 一行安装
curl -fsSL https://raw.githubusercontent.com/... | bash

# 或手动安装
pip install figma-cli
```

迁移到另一台机器：

```bash
bash ~/.cc-switch/skills/figma/scripts/install.sh
```

## 常见问题

### 「MCP server 连接断开」

- 检查 Node.js 是否安装: `node --version`
- 检查 figma-developer-mcp 是否可用: `npx figma-developer-mcp --version`
- 如果使用 remote 后端，检查 FIGMA_API_KEY 是否设置

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
