# Figma MCP Skill

Shell-first 的 Figma 设计稿到代码桥梁。通过 `figma` CLI 命令调用 Figma MCP server，
无需配置 MCP 协议，Agent 直接通过 shell 调用。

## 安装

```bash
# 一行安装
curl -fsSL https://raw.githubusercontent.com/<repo>/main/scripts/install.sh | bash

# 或 pip 安装
pip install figma-cli
```

## 使用

```bash
# 查看状态
figma status

# 环境诊断
figma self-check

# 获取设计上下文
figma get-design "https://www.figma.com/design/ABC123/MyApp?node-id=1-2"

# 截取节点截图
figma get-screenshot "1:2" --file-key ABC123

# 获取设计变量
figma get-variable-defs "https://www.figma.com/design/ABC123/MyApp"

# 搜索组件
figma search "button"

# 清除缓存
figma refresh
```

## 后端

| 后端 | 配置 | 说明 |
|---|---|---|
| Desktop MCP | 默认 | 需要 Figma 桌面端，免费账户可用 |
| Remote MCP | `FIGMA_BACKEND=remote` + `FIGMA_API_KEY` | 有 Figma API key |

```bash
export FIGMA_BACKEND=remote
export FIGMA_API_KEY=figd_xxxxx
```

## 环境变量

- `FIGMA_API_KEY` — Figma Personal Access Token
- `FIGMA_OAUTH_TOKEN` — Figma OAuth Bearer Token
- `FIGMA_BACKEND` — 后端选择: auto (默认), desktop, remote
- `FIGMA_MCP_BIN` — 自定义 MCP server 路径
- `FIGMA_IMAGE_DIR` — 图片下载目录

## 开发

```bash
pip install -e ".[dev]"
python -m pytest tests/
```
