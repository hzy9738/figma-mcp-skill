import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

import {
  APP_NAME, VERSION, DEFAULT_MCP_URL, REMOTE_MCP_URL,
  ENV_FIGMA_API_KEY, ENV_FIGMA_OAUTH_TOKEN, ENV_FIGMA_MCP_URL,
  ENV_FIGMA_MCP_BIN, ENV_FIGMA_IMAGE_DIR,
  DEFAULT_FIGMA_MCP_PACKAGE,
  ToolError, findNpxBin,
} from './utils.js';

// ---------------------------------------------------------------------------
// 基础传输类
// ---------------------------------------------------------------------------

export class MCPTransport {
  constructor(backend, { debug = false } = {}) {
    this.backend = backend;
    this.debug = debug;
    this._requestId = 0;
  }

  nextId() { return ++this._requestId; }

  async sendRequest(_method, _params) { throw new Error('not implemented'); }

  /** 尝试多种协议版本的 initialize 握手 */
  async initialize() {
    const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
    let lastError = null;

    for (const pv of versions) {
      try {
        if (this.debug) console.error(`[debug] 尝试 initialize (protocolVersion=${pv}) ...`);
        const result = await this.sendRequest('initialize', {
          protocolVersion: pv,
          capabilities: {},
          clientInfo: { name: APP_NAME, version: VERSION },
        });
        if (this.debug) console.error(`[debug] initialize 成功 (protocolVersion=${pv})`);
        await this._sendNotification('notifications/initialized', {});
        return result;
      } catch (exc) {
        lastError = exc;
        if (this.debug) console.error(`[debug] initialize 失败 (${pv}): ${exc.message}`);
        if (exc.message?.includes('Invalid request body') || exc.message?.toLowerCase().includes('initialize')) {
          continue;
        }
        throw exc;
      }
    }

    throw lastError || new ToolError('initialize 失败: 所有协议版本均被拒绝');
  }

  /** 获取服务器工具列表 */
  async listTools() {
    const result = await this.sendRequest('tools/list', {});
    return result.tools || [];
  }

  /** 调用 MCP 工具 */
  async callTool(name, args) {
    return this.sendRequest('tools/call', { name, arguments: args });
  }

  async _sendNotification(_method, _params) {
    // 默认空实现
  }

  close() { /* 默认空实现 */ }
}

// ---------------------------------------------------------------------------
// HTTP 传输（Figma Desktop MCP / Remote MCP）
// ---------------------------------------------------------------------------

/** SSE GET 请求：读取响应的前 maxBytes 字节，返回 { status, headers, body } */
async function sseGet(urlStr, headers = {}, { maxBytes = 131072, timeoutMs = 15000 } = {}) {
  const parsed = new URL(urlStr);
  const mod = parsed.protocol === 'https:' ? https : http;
  const ua = `${APP_NAME}/${VERSION}`;

  return new Promise((resolve, reject) => {
    let timer;
    const req = mod.get(
      urlStr,
      { headers: { 'User-Agent': ua, Accept: 'text/event-stream', ...headers }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let resolved = false;

        const finish = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          const body = Buffer.concat(chunks).toString('utf-8');
          // 规范化 header key（node http 保持原始大小写）
          const normHeaders = {};
          for (const [k, v] of Object.entries(res.headers)) {
            normHeaders[k.toLowerCase()] = v;
          }
          resolve({ status: res.statusCode, headers: normHeaders, body });
        };

        res.on('data', (chunk) => {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length > maxBytes) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (e) => {
          if (!resolved) { resolved = true; clearTimeout(timer); reject(e); }
        });
      },
    );

    timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE GET 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    req.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** POST JSON-RPC 请求，返回 { status, headers, body } */
async function postJsonRpc(urlStr, body, headers = {}, { timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(urlStr, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Origin: 'http://localhost',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const text = await resp.text();
    const respHeaders = {};
    resp.headers.forEach((v, k) => { respHeaders[k.toLowerCase()] = v; });

    return { status: resp.status, headers: respHeaders, body: text };
  } finally {
    clearTimeout(timer);
  }
}

export class HttpTransport extends MCPTransport {
  constructor({ debug = false } = {}) {
    super('remote', { debug });
    this._sessionId = null;
    this._endpointUrl = null;
  }

  get baseUrl() {
    return process.env[ENV_FIGMA_MCP_URL] || DEFAULT_MCP_URL;
  }

  get _postUrl() {
    return this._endpointUrl || this.baseUrl;
  }

  _authHeaders() {
    const h = {};
    const apiKey = process.env[ENV_FIGMA_API_KEY];
    const oauthToken = process.env[ENV_FIGMA_OAUTH_TOKEN];
    if (apiKey) h['X-Figma-Token'] = apiKey;
    if (oauthToken) h['Authorization'] = `Bearer ${oauthToken}`;
    return h;
  }

  _buildHeaders() {
    const h = this._authHeaders();
    if (this._sessionId) h['Mcp-Session-Id'] = this._sessionId;
    return h;
  }

  async _ensureSession() {
    if (this._sessionId !== null) return;

    const auth = this._authHeaders();
    const base = this.baseUrl.replace(/\/$/, '');

    for (const ssePath of ['/sse', '']) {
      const sseUrl = ssePath ? `${base}${ssePath}` : base;
      try {
        const { status, headers, body } = await sseGet(sseUrl, auth);
        if (this.debug) {
          console.error(`[debug] GET ${sseUrl} → ${status}`);
          console.error(`[debug]   响应头: ${JSON.stringify(headers)}`);
          console.error(`[debug]   SSE 前几行: ${body.substring(0, 800)}`);
        }

        if (status >= 400) continue;

        let sid = headers['mcp-session-id'];

        // 解析 SSE endpoint 事件 → POST 消息 URL
        const rawEndpoint = parseSseEndpoint(body);
        if (rawEndpoint) {
          this._endpointUrl = resolveUrl(rawEndpoint, this.baseUrl);
          if (this.debug) console.error(`[debug]   SSE endpoint → POST URL: ${this._endpointUrl}`);
          if (!sid) sid = extractSessionFromUrl(this._endpointUrl);
        }

        // 从 SSE 数据中查找 session ID
        if (!sid) sid = parseSseSessionId(body);

        if (sid) {
          this._sessionId = sid;
          if (this.debug) console.error(`[debug]   会话 ID: ${sid}`);
          return;
        }
      } catch (exc) {
        if (this.debug) console.error(`[debug] GET ${sseUrl} 失败: ${exc.message}`);
      }
    }

    // 无会话模式
    this._sessionId = '';
    if (this.debug) console.error('[debug] 未获取到 SSE 会话，使用无会话模式直接 POST');
  }

  async sendRequest(method, params = {}) {
    await this._ensureSession();

    const requestId = this.nextId();
    const requestBody = { jsonrpc: '2.0', id: requestId, method, params };
    const headers = this._buildHeaders();

    if (this.debug) {
      console.error(`[debug] POST ${this._postUrl}`);
      console.error(`[debug]   请求头: ${JSON.stringify(headers)}`);
      console.error(`[debug]   请求体: ${JSON.stringify(requestBody).substring(0, 500)}`);
    }

    let resp;
    try {
      resp = await postJsonRpc(this._postUrl, requestBody, headers);
    } catch (exc) {
      throw new ToolError(`MCP HTTP 请求失败 (${this._postUrl}): ${exc.message}`);
    }

    if (this.debug) {
      console.error(`[debug]   响应状态: ${resp.status}`);
      console.error(`[debug]   响应头: ${JSON.stringify(resp.headers)}`);
      console.error(`[debug]   响应体: ${resp.body.substring(0, 500)}`);
    }

    if (resp.status >= 400) {
      throw new ToolError(`MCP HTTP ${resp.status} (${this._postUrl}): ${resp.body.substring(0, 300)}`);
    }

    // 捕获响应中的 Session ID
    const sid = resp.headers['mcp-session-id'];
    if (sid && !this._sessionId) {
      this._sessionId = sid;
      if (this.debug) console.error(`[debug]   从 POST 响应获取到 Session ID: ${sid}`);
    }

    const ct = resp.headers['content-type'] || '';

    // SSE 响应
    if (ct.includes('text/event-stream')) {
      return parseSseResponse(resp.body, requestId);
    }

    // JSON 响应
    if (resp.body.trim()) {
      try {
        const data = JSON.parse(resp.body);
        if (data.error) {
          throw new ToolError(`MCP 错误 [${data.error.code || '?'}]: ${data.error.message || JSON.stringify(data.error)}`);
        }
        if ('result' in data) return data.result;
      } catch (exc) {
        if (exc instanceof ToolError) throw exc;
        // JSON 解析失败，继续 SSE 回退
      }
    }

    // POST 返回空或 202 → 从 SSE 流读取
    if (this._endpointUrl || this._sessionId) {
      const sseUrl = this.baseUrl;
      if (this.debug) console.error(`[debug] POST 响应为空/非 JSON，尝试从 SSE 读取 (${sseUrl})`);
      try {
        const { body } = await sseGet(sseUrl, this._buildHeaders());
        return parseSseResponse(body, requestId);
      } catch (exc) {
        if (exc instanceof ToolError) throw exc;
        throw new ToolError(`从 SSE 读取响应失败: ${exc.message}`);
      }
    }

    throw new ToolError(`MCP 返回非 JSON 响应: ${resp.body.substring(0, 200)}`);
  }

  async _sendNotification(method, params = {}) {
    try {
      await postJsonRpc(this._postUrl, { jsonrpc: '2.0', method, params }, this._buildHeaders());
    } catch { /* 通知丢失不致命 */ }
  }

  close() { /* fetch/http 请求自动关闭连接 */ }
}

// ---- SSE 解析辅助 ----

function parseSseEndpoint(body) {
  let eventType = null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('event:')) {
      eventType = trimmed.substring(6).trim();
    } else if (trimmed.startsWith('data:') && eventType === 'endpoint') {
      const data = trimmed.substring(5).trim();
      if (data) return data;
    }
  }
  return null;
}

function parseSseSessionId(body) {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.substring(5).trim();
    if (!dataStr) continue;
    try {
      const data = JSON.parse(dataStr);
      const sid = data.sessionId || data.session_id;
      if (sid) return sid;
    } catch { /* 非 JSON */ }
  }
  return null;
}

function extractSessionFromUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return parsed.searchParams.get('sessionId') || parsed.searchParams.get('session_id');
  } catch { return null; }
}

function resolveUrl(urlStr, baseUrl) {
  if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) return urlStr;
  return new URL(urlStr, baseUrl).href;
}

function parseSseResponse(body, requestId) {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.substring(5).trim();
    if (!dataStr) continue;
    try {
      const data = JSON.parse(dataStr);
      if (data.id === requestId) {
        if (data.error) {
          throw new ToolError(
            `MCP 错误 [${data.error.code || '?'}]: ${data.error.message || JSON.stringify(data.error)}`,
          );
        }
        return data.result || {};
      }
    } catch (exc) {
      if (exc instanceof ToolError) throw exc;
      // 非 JSON 行，继续
    }
  }
  throw new ToolError('SSE 响应中未找到对应请求的 JSON-RPC 结果');
}

// ---------------------------------------------------------------------------
// Stdio 传输（npx figma-developer-mcp）
// ---------------------------------------------------------------------------

export class StdioTransport extends MCPTransport {
  constructor({ debug = false, imageDir = null } = {}) {
    super('desktop', { debug });
    this.imageDir = imageDir;
    this._proc = null;
  }

  _buildCmd() {
    const npx = findNpxBin();
    const cmd = [npx, DEFAULT_FIGMA_MCP_PACKAGE, '--stdio'];

    const apiKey = process.env[ENV_FIGMA_API_KEY];
    const oauthToken = process.env[ENV_FIGMA_OAUTH_TOKEN];
    if (apiKey) cmd.push('--figma-api-key', apiKey);
    if (oauthToken) cmd.push('--figma-oauth-token', oauthToken);

    const imgDir = this.imageDir || process.env[ENV_FIGMA_IMAGE_DIR] || process.cwd();
    cmd.push('--image-dir', imgDir);

    // 自定义 MCP bin
    const customBin = process.env[ENV_FIGMA_MCP_BIN];
    if (customBin) return customBin.split(/\s+/);

    return cmd;
  }

  _ensureProcess() {
    if (this._proc && this._proc.exitCode !== null) {
      this._proc = null;
    }

    if (!this._proc) {
      const cmd = this._buildCmd();
      if (this.debug) console.error(`[debug] 启动进程: ${cmd.join(' ')}`);
      this._proc = spawn(cmd[0], cmd.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._proc.on('error', (err) => {
        throw new ToolError(`无法启动 MCP server: ${err.message}`);
      });

      // 收集 stderr 以便报错
      let stderr = '';
      if (this._proc.stderr) {
        this._proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      }
      this._stderr = () => stderr;
    }

    return this._proc;
  }

  /** 读一行 JSON 响应 */
  _readLine(stream) {
    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        cleanup();
        resolve(chunk.toString().trim());
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        stream.removeListener('data', onData);
        stream.removeListener('error', onError);
      };
      stream.once('data', onData);
      stream.once('error', onError);
    });
  }

  async sendRequest(method, params = {}) {
    const proc = this._ensureProcess();
    const requestId = this.nextId();

    const request = { jsonrpc: '2.0', id: requestId, method, params };
    const payload = JSON.stringify(request) + '\n';

    if (!proc.stdin || !proc.stdout) {
      throw new ToolError(`MCP server 子进程异常: stdin=${!!proc.stdin}, stdout=${!!proc.stdout}`);
    }

    try {
      proc.stdin.write(payload);
    } catch (err) {
      const stderr = this._stderr ? this._stderr() : '';
      throw new ToolError(
        `MCP server 连接断开（进程已退出，code=${proc.exitCode}）。${stderr ? 'stderr: ' + stderr : ''}`,
      );
    }

    const line = await this._readLine(proc.stdout);
    if (!line) {
      const stderr = this._stderr ? this._stderr() : '';
      throw new ToolError(
        `MCP server 无响应（进程已退出，code=${proc.exitCode}）。${stderr ? 'stderr: ' + stderr : ''}`,
      );
    }

    let response;
    try {
      response = JSON.parse(line);
    } catch (exc) {
      throw new ToolError(`MCP server 返回非 JSON 响应: ${line.substring(0, 200)} (${exc.message})`);
    }

    if (response.error) {
      const err = response.error;
      throw new ToolError(`MCP 错误 [${err.code || '?'}]: ${err.message || JSON.stringify(err)}`);
    }

    return response.result || {};
  }

  async _sendNotification(method, params = {}) {
    const proc = this._ensureProcess();
    const notification = { jsonrpc: '2.0', method, params };
    try {
      if (proc.stdin) proc.stdin.write(JSON.stringify(notification) + '\n');
    } catch { /* 通知丢失不致命 */ }
  }

  close() {
    if (this._proc) {
      try { this._proc.stdin?.end(); } catch { /* ignore */ }
      setTimeout(() => {
        if (this._proc && this._proc.exitCode === null) {
          this._proc.kill();
        }
      }, 5000);
      this._proc = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export function createTransport(backend, { debug = false, imageDir = null } = {}) {
  if (backend === 'desktop') {
    return new StdioTransport({ debug, imageDir });
  } else if (backend === 'remote') {
    return new HttpTransport({ debug });
  }
  throw new ToolError(`未知后端: ${backend}`);
}
