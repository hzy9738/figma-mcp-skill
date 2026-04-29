import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const APP_NAME = 'figma-cli';
export const VERSION = '0.2.0';

export const CACHE_DIRNAME = '.figma';
export const DEFAULT_FIGMA_MCP_PACKAGE = 'figma-developer-mcp';
export const REMOTE_MCP_URL = 'https://mcp.figma.com/mcp';
export const DEFAULT_MCP_URL = 'http://127.0.0.1:3845/mcp';

export const ENV_FIGMA_API_KEY = 'FIGMA_API_KEY';
export const ENV_FIGMA_OAUTH_TOKEN = 'FIGMA_OAUTH_TOKEN';
export const ENV_FIGMA_BACKEND = 'FIGMA_BACKEND';
export const ENV_FIGMA_MCP_URL = 'FIGMA_MCP_URL';
export const ENV_FIGMA_MCP_BIN = 'FIGMA_MCP_BIN';
export const ENV_FIGMA_IMAGE_DIR = 'FIGMA_IMAGE_DIR';

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

const FIGMA_URL_RE = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9]+)\//;

/** 从 Figma URL 中提取 fileKey 和可选的 nodeId */
export function parseFigmaUrl(url) {
  url = (url || '').trim();

  if (/^[a-zA-Z0-9]+$/.test(url)) return { fileKey: url, nodeId: null };
  if (/^\d+[:-]\d+$/.test(url)) return { fileKey: url, nodeId: null };

  const match = FIGMA_URL_RE.exec(url);
  if (!match) throw new ToolError(`无法从 URL 解析 file_key: ${url}`);

  const fileKey = match[1];
  let nodeId = null;

  try {
    const parsed = new URL(url);
    const raw = parsed.searchParams.get('node-id');
    if (raw) nodeId = raw.replace(/-/g, ':');
  } catch { /* URL 解析失败，忽略 node-id */ }

  return { fileKey, nodeId };
}

/** 检查本地 Figma Desktop MCP 端点是否可达 */
export async function checkLocalMcp() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(DEFAULT_MCP_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok || resp.status < 500;
  } catch {
    return false;
  }
}

/** 解析 Figma MCP 后端模式 */
export function resolveBackend(preferred, localMcpAvailable) {
  const backend = preferred || process.env[ENV_FIGMA_BACKEND] || 'auto';

  if (backend === 'auto') {
    const hasCredentials = !!(process.env[ENV_FIGMA_API_KEY] || process.env[ENV_FIGMA_OAUTH_TOKEN]);

    // 1. 本机 Figma Desktop MCP
    if (localMcpAvailable) return 'remote';

    // 2. npx figma-developer-mcp
    try {
      if (hasCredentials) {
        const r = spawnSync('npx', [DEFAULT_FIGMA_MCP_PACKAGE, '--version'], { timeout: 30000 });
        if (r.status === 0) return 'desktop';
      }
    } catch { /* npx not found */ }

    // 3. 远程云 MCP
    if (hasCredentials) return 'remote';

    // 4. 兜底
    return 'desktop';
  }

  if (backend === 'desktop' || backend === 'remote') return backend;
  throw new ToolError(`未知的 FIGMA_BACKEND 值: ${backend}，可选: auto, desktop, remote`);
}

/** 返回用户友好的后端显示名称 */
export function backendDisplayName(backend, localMcpAvailable) {
  const mcpUrl = process.env[ENV_FIGMA_MCP_URL] || DEFAULT_MCP_URL;
  if (backend === 'remote' && mcpUrl === DEFAULT_MCP_URL && localMcpAvailable) {
    return 'desktop (本机 Figma Desktop MCP)';
  }
  if (backend === 'remote' && mcpUrl === DEFAULT_MCP_URL) {
    return 'remote (本机 HTTP)';
  }
  if (backend === 'remote') return `remote (${mcpUrl})`;
  return backend;
}

/** 查找 npx 可执行文件 */
export function findNpxBin() {
  // 使用 which/where 查找 npx（Node.js 没有内置 which，用 spawnSync）
  const r = spawnSync('which', ['npx'], { encoding: 'utf-8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  // Windows fallback
  const r2 = spawnSync('where', ['npx'], { encoding: 'utf-8', shell: true });
  if (r2.status === 0 && r2.stdout.trim()) return r2.stdout.trim().split('\n')[0].trim();
  throw new ToolError('未找到 npx，请安装 Node.js (https://nodejs.org)');
}

/** 从 MCP 结果中提取文本内容 */
export function extractTextContent(result) {
  const content = result.content || [];
  return content
    .filter(item => item && item.type === 'text')
    .map(item => item.text || '')
    .join('\n');
}

/** 从 MCP 结果中提取 base64 图片并保存为 PNG。返回已保存的文件路径 */
export function saveImagesFromResult(result, outputDir, nodeId) {
  const saved = [];
  const content = result.content || [];
  mkdirSync(outputDir, { recursive: true });

  content.forEach((item, i) => {
    if (!item || item.type !== 'image' || !item.data) return;
    const safeNode = nodeId.replace(/:/g, '_');
    const suffix = i > 0 ? `_${i}` : '';
    const filePath = resolve(outputDir, `screenshot_${safeNode}${suffix}.png`);
    writeFileSync(filePath, Buffer.from(item.data, 'base64'));
    saved.push(filePath);
  });

  return saved;
}

/** JSON 格式化 */
export function formatJson(data) {
  return JSON.stringify(data, null, 2);
}

/** JSON 模式 / 普通模式输出 */
export function printOrJson(data, jsonMode) {
  if (jsonMode) {
    console.log(formatJson(data));
  } else if (typeof data === 'object') {
    console.log(formatJson(data));
  } else {
    console.log(data);
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/** 解析全局参数，返回 { backend, debug, version, help, command, cmdArgs } */
export function parseGlobalArgs(argv) {
  const global = { backend: undefined, debug: false, version: false, help: false };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--backend' || arg === '-b') {
      global.backend = argv[++i];
    } else if (arg === '--debug') {
      global.debug = true;
    } else if (arg === '--version' || arg === '-V') {
      global.version = true;
    } else if (arg === '--help' || arg === '-h') {
      global.help = true;
    } else {
      break;
    }
    i++;
  }

  const rest = argv.slice(i);
  const command = rest[0] || 'status';
  const cmdArgs = rest.slice(1);

  return { ...global, command, cmdArgs };
}

/**
 * 解析命令级参数。
 * spec: { '--json': 'boolean', '--node-id': 'string', '--client-languages': 'array' }
 * 返回 { opts, positional }
 */
export function parseCmdArgs(args, spec = {}) {
  const opts = {};
  const positional = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    const type = spec[arg];

    if (type === 'boolean') {
      opts[optKey(arg)] = true;
      i++;
    } else if (type === 'string') {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        opts[optKey(arg)] = args[i + 1];
        i += 2;
      } else {
        // 选项后没有值，跳过
        i++;
      }
    } else if (type === 'array') {
      const values = [];
      i++;
      while (i < args.length && !args[i].startsWith('--')) {
        values.push(args[i]);
        i++;
      }
      if (values.length) opts[optKey(arg)] = values;
    } else if (arg.startsWith('-') && !spec[arg]) {
      // 未知选项，跳过
      i++;
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { opts, positional };
}

/** 把 --some-option 转为 someOption */
function optKey(key) {
  return key.replace(/^--?/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// fileKey / nodeId 解析
// ---------------------------------------------------------------------------

/** 从命令行参数中解析 fileKey 和 nodeId */
export function resolveFileAndNode(opts, positional) {
  const urlOrKey = positional[0] || null;
  const nodeIdOverride = opts.nodeId || null;
  const fileKeyArg = opts.fileKey || null;

  // 未提供 url：从 --file-key / --node-id 获取
  if (!urlOrKey) {
    if (fileKeyArg) {
      return {
        fileKey: fileKeyArg,
        nodeId: nodeIdOverride ? nodeIdOverride.replace(/-/g, ':') : null,
      };
    }
    throw new ToolError(
      '请提供 Figma URL、file_key，或通过 --file-key 指定文件。\n' +
        `示例: ${APP_NAME} get-design https://www.figma.com/design/ABC123/...\n` +
        `      ${APP_NAME} get-design --file-key ABC123 --node-id 1:2`,
    );
  }

  // 尝试从 URL 解析
  const { fileKey, nodeId: parsedNode } = parseFigmaUrl(urlOrKey);

  // 如果解析出的是 node_id（如 1:2），需要用 --file-key 获取 fileKey
  if (/^\d+:\d+$/.test(fileKey) || /^\d+-\d+$/.test(fileKey)) {
    if (fileKeyArg) {
      return { fileKey: fileKeyArg, nodeId: fileKey.replace(/-/g, ':') };
    }
    throw new ToolError(
      `无法确定 file_key。请使用完整 Figma URL 或通过 --file-key 指定。输入: ${urlOrKey}`,
    );
  }

  const nodeId = (nodeIdOverride || parsedNode || '').replace(/-/g, ':') || null;
  return { fileKey, nodeId };
}
