import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

import {
  APP_NAME, VERSION,
  ENV_FIGMA_API_KEY, ENV_FIGMA_OAUTH_TOKEN, ENV_FIGMA_MCP_URL, ENV_FIGMA_MCP_BIN,
  ENV_FIGMA_IMAGE_DIR, DEFAULT_MCP_URL,
  ToolError, formatJson, printOrJson, extractTextContent, saveImagesFromResult,
  checkLocalMcp, resolveBackend, backendDisplayName,
  parseGlobalArgs, parseCmdArgs, resolveFileAndNode,
} from './utils.js';
import { CacheManager, findCacheRoot } from './cache.js';
import { createTransport } from './transport.js';

// ---------------------------------------------------------------------------
// 获取 transport 并完成 MCP 握手
// ---------------------------------------------------------------------------

async function getTransport(backend, { debug = false } = {}) {
  const transport = createTransport(backend, { debug });

  try {
    await transport.initialize();
  } catch (exc) {
    transport.close();
    if (backend === 'desktop') {
      throw new ToolError(
        `Figma Desktop MCP 启动失败: ${exc.message}\n` +
          '请确保 Node.js 已安装且设置了 FIGMA_API_KEY 或 FIGMA_OAUTH_TOKEN。',
      );
    }
    throw new ToolError(
      `Figma MCP 连接失败: ${exc.message}\n` +
        '如果使用远程云 MCP，请检查 FIGMA_API_KEY 或 FIGMA_OAUTH_TOKEN 环境变量。\n' +
        '如果使用本机 Figma Desktop MCP，请确保 Figma 桌面端已开启。',
    );
  }

  try {
    await transport.listTools();
  } catch (exc) {
    transport.close();
    throw new ToolError(
      `MCP 连接验证失败: ${exc.message}\n` +
        '请检查 FIGMA_API_KEY 或 FIGMA_OAUTH_TOKEN 环境变量。',
    );
  }

  return transport;
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

async function commandStatus(opts, _positional, { debug, backend, localMcpAvailable }) {
  const cache = new CacheManager(findCacheRoot());
  const displayBackend = backendDisplayName(backend, localMcpAvailable);

  const payload = {
    tool: APP_NAME,
    version: VERSION,
    node_version: process.version,
    backend: displayBackend,
    backend_raw: backend,
    mcp_url: process.env[ENV_FIGMA_MCP_URL] || DEFAULT_MCP_URL,
    figma_api_key_set: !!process.env[ENV_FIGMA_API_KEY],
    figma_oauth_token_set: !!process.env[ENV_FIGMA_OAUTH_TOKEN],
    npx_available: (() => { try { execSync('which npx'); return true; } catch { return false; } })(),
    httpx_available: false, // JS 版本，httpx 不适用
    figma_mcp_bin: process.env[ENV_FIGMA_MCP_BIN] || 'default',
    image_dir: process.env[ENV_FIGMA_IMAGE_DIR] || process.cwd(),
    cache: cache.cacheInfo(),
  };

  // 尝试连接后端
  try {
    const transport = createTransport(backend, { debug });
    await transport.initialize();
    const tools = await transport.listTools();
    payload.connected = true;
    payload.available_tools = tools.map(t => t.name);
    transport.close();
  } catch (exc) {
    payload.connected = false;
    payload.connection_error = exc.message;
  }

  if (opts.json) {
    console.log(formatJson(payload));
  } else {
    console.log(`Figma CLI v${VERSION}`);
    console.log(`后端: ${displayBackend} (${payload.connected ? '已连接' : '未连接'})`);
    console.log(`npx: ${payload.npx_available ? '可用' : '不可用'}`);
    console.log(`FIGMA_API_KEY: ${payload.figma_api_key_set ? '已设置' : '未设置'}`);
    if (!payload.connected) {
      console.log(`连接错误: ${payload.connection_error || '未知'}`);
    }
    if (payload.available_tools) {
      console.log(`可用工具: ${payload.available_tools.join(', ')}`);
    }
    const cacheFiles = payload.cache?.files || {};
    const cacheCount = Object.values(cacheFiles).reduce((s, v) => s + v.length, 0);
    if (cacheCount > 0) {
      console.log(`缓存文件数: ${cacheCount}`);
    } else {
      console.log('缓存: 无');
    }
  }

  return 0;
}

async function commandSelfCheck(opts, _positional, { debug, backend, localMcpAvailable }) {
  const cache = new CacheManager(findCacheRoot());
  const displayBackend = backendDisplayName(backend, localMcpAvailable);

  const payload = {
    tool: APP_NAME,
    version: VERSION,
    node_version: process.version,
    node_executable: process.execPath,
    backend: displayBackend,
    backend_raw: backend,
    mcp_url: process.env[ENV_FIGMA_MCP_URL] || DEFAULT_MCP_URL,
    npx_path: (() => { try { return execSync('which npx', { encoding: 'utf-8' }).trim(); } catch { return null; } })(),
    npx_available: (() => { try { execSync('which npx'); return true; } catch { return false; } })(),
    figma_api_key_set: !!process.env[ENV_FIGMA_API_KEY],
    figma_oauth_token_set: !!process.env[ENV_FIGMA_OAUTH_TOKEN],
    figma_mcp_bin: process.env[ENV_FIGMA_MCP_BIN] || 'default',
    image_dir: process.env[ENV_FIGMA_IMAGE_DIR] || process.cwd(),
    cache_root: String(cache.cacheRoot),
  };

  // 检查本地 Figma Desktop MCP 端点
  payload.desktop_mcp_local = localMcpAvailable;
  if (localMcpAvailable) payload.desktop_mcp_url = DEFAULT_MCP_URL;

  // 检查 Node.js 版本信息
  payload.node_version_full = process.version;

  // 测试连接
  try {
    const transport = createTransport(backend, { debug });
    await transport.initialize();
    const tools = await transport.listTools();
    payload.connection_ok = true;
    payload.available_tools = tools.map(t => t.name);
    transport.close();
  } catch (exc) {
    payload.connection_ok = false;
    payload.connection_error = exc.message;
  }

  if (opts.json) {
    console.log(formatJson(payload));
  } else {
    for (const [key, value] of Object.entries(payload)) {
      console.log(`${key}: ${value}`);
    }
  }

  return 0;
}

async function commandGetDesign(opts, positional, { debug, backend }) {
  const { fileKey, nodeId } = resolveFileAndNode(opts, positional);
  const transport = await getTransport(backend, { debug });

  const args = { fileKey };
  if (nodeId) args.nodeId = nodeId;
  if (opts.clientLanguages) args.clientLanguages = opts.clientLanguages.join(',');
  if (opts.clientFrameworks) args.clientFrameworks = opts.clientFrameworks.join(',');

  const result = await transport.callTool('get_design_context', args);
  transport.close();

  if (opts.json) {
    console.log(formatJson(result));
  } else {
    console.log(extractTextContent(result));
  }

  if (!opts.noCache) {
    const cache = new CacheManager(findCacheRoot());
    cache.write(fileKey, 'get_design_context', result, nodeId);
  }

  return 0;
}

async function commandGetScreenshot(opts, positional, { debug, backend }) {
  const { fileKey, nodeId } = resolveFileAndNode(opts, positional);

  if (!nodeId) {
    throw new ToolError('get-screenshot 需要指定 node_id，或通过 Figma URL 中的 node-id 参数提供');
  }

  const transport = await getTransport(backend, { debug });

  const args = { nodeId };
  if (opts.clientLanguages) args.clientLanguages = opts.clientLanguages.join(',');
  if (opts.clientFrameworks) args.clientFrameworks = opts.clientFrameworks.join(',');

  const result = await transport.callTool('get_screenshot', args);
  transport.close();

  // 自动解码 base64 图片到缓存目录
  const cacheRoot = findCacheRoot();
  const cacheDir = resolve(cacheRoot, fileKey);
  const savedFiles = saveImagesFromResult(result, cacheDir, nodeId);

  // --output 指定导出路径
  let outputPath = null;
  if (opts.output) {
    outputPath = resolve(opts.output);
    if (savedFiles.length > 0) {
      const { mkdirSync, copyFileSync } = await import('node:fs');
      mkdirSync(resolve(outputPath, '..'), { recursive: true });
      copyFileSync(savedFiles[0], outputPath);
    } else if (!opts.json) {
      console.error('警告: 未在结果中找到图片数据');
    }
  }

  if (opts.json) {
    const payload = { ...result };
    if (savedFiles.length) payload._saved_files = savedFiles;
    if (outputPath) payload._output = outputPath;
    console.log(formatJson(payload));
  } else {
    if (savedFiles.length > 0) {
      for (const f of savedFiles) {
        const sizeKb = (statSync(f).size / 1024).toFixed(1);
        console.log(`截图已保存: ${f} (${sizeKb} KB)`);
      }
    }
    if (outputPath && outputPath !== savedFiles[0]) {
      const sizeKb = (statSync(outputPath).size / 1024).toFixed(1);
      console.log(`截图已导出: ${outputPath} (${sizeKb} KB)`);
    }
    if (savedFiles.length === 0) {
      const text = extractTextContent(result);
      if (text) {
        console.log(text);
      } else {
        console.error('截图已获取（未找到可解码的图片数据）');
      }
    }
  }

  // 轻量缓存（不含 base64）
  if (!opts.noCache) {
    const cache = new CacheManager(cacheRoot);
    const lightResult = { ...result };
    if (lightResult.content) {
      lightResult.content = lightResult.content.map(item =>
        item && typeof item === 'object' ? Object.fromEntries(
          Object.entries(item).filter(([k]) => k !== 'data')
        ) : item
      );
    }
    cache.write(fileKey, 'get_screenshot', lightResult, nodeId);
  }

  return 0;
}

async function commandGetMetadata(opts, positional, { debug, backend }) {
  const { fileKey, nodeId } = resolveFileAndNode(opts, positional);
  const transport = await getTransport(backend, { debug });

  const args = { fileKey };
  if (nodeId) args.nodeId = nodeId;
  if (opts.clientLanguages) args.clientLanguages = opts.clientLanguages.join(',');
  if (opts.clientFrameworks) args.clientFrameworks = opts.clientFrameworks.join(',');

  const result = await transport.callTool('get_metadata', args);
  transport.close();

  printOrJson(result, opts.json);
  if (!opts.noCache) {
    const cache = new CacheManager(findCacheRoot());
    cache.write(fileKey, 'get_metadata', result, nodeId);
  }

  return 0;
}

async function commandGetVariableDefs(opts, positional, { debug, backend }) {
  const { fileKey, nodeId } = resolveFileAndNode(opts, positional);
  const transport = await getTransport(backend, { debug });

  const args = { fileKey };
  if (nodeId) args.nodeId = nodeId;
  if (opts.clientLanguages) args.clientLanguages = opts.clientLanguages.join(',');
  if (opts.clientFrameworks) args.clientFrameworks = opts.clientFrameworks.join(',');

  const result = await transport.callTool('get_variable_defs', args);
  transport.close();

  printOrJson(result, opts.json);
  if (!opts.noCache) {
    const cache = new CacheManager(findCacheRoot());
    cache.write(fileKey, 'get_variable_defs', result, nodeId);
  }

  return 0;
}

async function commandSearch(opts, positional, { debug, backend }) {
  const query = positional[0];
  if (!query) throw new ToolError('search 需要提供查询关键词。示例: figma-cli search button');

  const transport = await getTransport(backend, { debug });
  const result = await transport.callTool('search', { query });
  transport.close();

  printOrJson(result, opts.json);
  return 0;
}

async function commandRefresh(opts, _positional) {
  const cache = new CacheManager(findCacheRoot());
  const count = cache.clear(opts.fileKey || null);

  if (opts.json) {
    console.log(formatJson({ status: 'cleared', entries_removed: count }));
  } else {
    const target = opts.fileKey || '全部文件';
    console.log(`已清除 ${target} 的缓存 (${count} 条记录)`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// 帮助信息
// ---------------------------------------------------------------------------

const HELP_TEXT = `
Figma MCP CLI — shell-first Figma 设计稿到代码的桥梁

用法: ${APP_NAME} [全局选项] <命令> [命令选项] [参数]

全局选项:
  --backend <auto|desktop|remote>  后端模式 (默认: auto)
  --debug                           输出调试信息
  --version, -V                     显示版本
  --help, -h                        显示帮助

命令:
  status [--json]                              连接状态与缓存
  self-check [--json]                          环境诊断
  get-design [opts] [url]                      获取设计上下文
  get-screenshot [opts] [url]                  截取节点
  get-metadata [opts] [url]                    文件/页面元数据
  get-variable-defs [opts] [url]              设计变量/令牌
  search [--json] <query>                      搜索组件/样式
  refresh [--file-key KEY] [--json]            清除缓存

get-* 命令共用选项:
  --node-id ID               指定节点 ID (如 1:2)
  --file-key KEY             指定文件 key
  --client-languages LANG... 目标语言 (如 typescript css)
  --client-frameworks FW...  目标框架 (如 react vue)
  --json                     JSON 格式输出
  --no-cache                 跳过本地缓存

get-screenshot 额外选项:
  -o, --output PATH          截图输出路径

后端优先级: 本机 Figma Desktop MCP → npx → 远程云

环境变量:
  FIGMA_API_KEY              Figma Personal Access Token
  FIGMA_OAUTH_TOKEN          Figma OAuth Bearer Token
  FIGMA_BACKEND              auto, desktop, remote
  FIGMA_MCP_URL              自定义 MCP HTTP 端点
  FIGMA_MCP_BIN              自定义 MCP server 路径
  FIGMA_IMAGE_DIR            图片下载目录
`.trim();

// ---------------------------------------------------------------------------
// 命令路由表
// ---------------------------------------------------------------------------

const COMMANDS = {
  'status': {
    spec: { '--json': 'boolean' },
    handler: commandStatus,
  },
  'self-check': {
    spec: { '--json': 'boolean' },
    handler: commandSelfCheck,
  },
  'get-design': {
    spec: {
      '--node-id': 'string', '--file-key': 'string',
      '--client-languages': 'array', '--client-frameworks': 'array',
      '--json': 'boolean', '--no-cache': 'boolean',
    },
    handler: commandGetDesign,
  },
  'get-screenshot': {
    spec: {
      '--node-id': 'string', '--file-key': 'string',
      '--client-languages': 'array', '--client-frameworks': 'array',
      '--json': 'boolean', '--no-cache': 'boolean',
      '-o': 'string', '--output': 'string',
    },
    handler: commandGetScreenshot,
  },
  'get-metadata': {
    spec: {
      '--node-id': 'string', '--file-key': 'string',
      '--client-languages': 'array', '--client-frameworks': 'array',
      '--json': 'boolean', '--no-cache': 'boolean',
    },
    handler: commandGetMetadata,
  },
  'get-variable-defs': {
    spec: {
      '--node-id': 'string', '--file-key': 'string',
      '--client-languages': 'array', '--client-frameworks': 'array',
      '--json': 'boolean', '--no-cache': 'boolean',
    },
    handler: commandGetVariableDefs,
  },
  'search': {
    spec: { '--json': 'boolean' },
    handler: commandSearch,
  },
  'refresh': {
    spec: { '--file-key': 'string', '--json': 'boolean' },
    handler: commandRefresh,
  },
};

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  // 解析全局参数
  const global = parseGlobalArgs(argv);

  if (global.version) {
    console.log(`${APP_NAME} v${VERSION}`);
    return 0;
  }

  if (global.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  const cmdDef = COMMANDS[global.command];
  if (!cmdDef) {
    console.error(`${APP_NAME}: 未知命令 '${global.command}'，使用 --help 查看帮助`);
    return 1;
  }

  // 解析命令级参数
  const { opts, positional } = parseCmdArgs(global.cmdArgs, cmdDef.spec);

  try {
    // 检查本地 MCP 可用性
    const localMcpAvailable = await checkLocalMcp();
    const backend = resolveBackend(global.backend, localMcpAvailable);

    return await cmdDef.handler(opts, positional, {
      debug: global.debug,
      backend,
      localMcpAvailable,
    });
  } catch (exc) {
    let msg = `${APP_NAME}: ${exc.message}`;
    if (exc instanceof ToolError && !global.debug) {
      msg += '\n提示: 添加 --debug 参数可查看详细的 HTTP 请求/响应信息';
    }
    console.error(msg);
    return 1;
  }
}
