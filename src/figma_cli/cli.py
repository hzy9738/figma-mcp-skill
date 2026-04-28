#!/usr/bin/env python3
"""Figma MCP CLI — shell-first Figma 设计稿到代码的桥梁。

通过 MCP 协议（stdio 或 HTTP/SSE）调用 Figma MCP server，
对外暴露简洁的 shell 命令，供 Agent 直接调用。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import textwrap
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, parse_qs

# ---------------------------------------------------------------------------
# 第三方导入（可选）
# ---------------------------------------------------------------------------

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

APP_NAME = "figma-cli"
VERSION = "0.1.0"

CACHE_DIRNAME = ".figma"
DEFAULT_FIGMA_MCP_PACKAGE = "figma-developer-mcp"
REMOTE_MCP_URL = "https://mcp.figma.com/mcp"
DEFAULT_MCP_URL = "http://127.0.0.1:3845/mcp"   # Figma Desktop 本地 MCP 端点

# 环境变量
ENV_FIGMA_API_KEY = "FIGMA_API_KEY"
ENV_FIGMA_OAUTH_TOKEN = "FIGMA_OAUTH_TOKEN"
ENV_FIGMA_BACKEND = "FIGMA_BACKEND"          # remote | desktop | auto
ENV_FIGMA_MCP_URL = "FIGMA_MCP_URL"          # 自定义 MCP HTTP 端点（覆盖默认 URL）
ENV_FIGMA_MCP_BIN = "FIGMA_MCP_BIN"          # 自定义 server 路径
ENV_FIGMA_IMAGE_DIR = "FIGMA_IMAGE_DIR"      # 图片下载目录

# Figma URL 正则
FIGMA_URL_PATTERN = re.compile(
    r"https?://(?:www\.)?figma\.com/(?:design|file|proto)/([a-zA-Z0-9]+)/",
)

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------


class ToolError(RuntimeError):
    """CLI 统一异常类型。"""
    pass


def parse_figma_url(url: str) -> tuple[str, str | None]:
    """从 Figma URL 中提取 file_key 和可选的 node_id。

    Example:
        >>> parse_figma_url("https://www.figma.com/design/ABC123/MyFile?node-id=1-2")
        ("ABC123", "1:2")
    """
    url = url.strip()

    # 如果已经是纯 file_key
    if re.match(r"^[a-zA-Z0-9]+$", url):
        return url, None

    # 如果已经是 node_id 格式（如 1:2 或 1-2）
    if re.match(r"^\d+[:-]\d+$", url):
        return url, None  # 只有 node_id，没有 file_key

    match = FIGMA_URL_PATTERN.search(url)
    if not match:
        raise ToolError(f"无法从 URL 解析 file_key: {url}")

    file_key = match.group(1)
    node_id = None

    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    raw_node = params.get("node-id", [None])[0]
    if raw_node:
        node_id = raw_node.replace("-", ":")

    return file_key, node_id


def _check_local_mcp() -> bool:
    """检查本地 Figma Desktop MCP 端点是否可达（绕过系统代理）。"""
    if not HAS_HTTPX:
        return False
    try:
        with httpx.Client(trust_env=False) as client:
            client.get(DEFAULT_MCP_URL, timeout=2.0)
        return True
    except Exception:
        return False


def resolve_backend(preferred: str | None = None) -> str:
    """解析 Figma MCP 后端模式。auto 优先级: npx > 本地 Desktop HTTP > 远程云。"""
    backend = preferred or os.environ.get(ENV_FIGMA_BACKEND, "auto")

    if backend == "auto":
        # 1. 优先 npx figma-developer-mcp（最可靠的 Figma Desktop 通信方式）
        npx_available = shutil.which("npx") is not None
        if npx_available:
            try:
                proc = subprocess.run(
                    ["npx", DEFAULT_FIGMA_MCP_PACKAGE, "--version"],
                    capture_output=True, text=True, timeout=30,
                )
                if proc.returncode == 0:
                    return "desktop"
            except Exception:
                pass

        # 2. 其次尝试本机 Figma Desktop MCP 直接 HTTP
        if _check_local_mcp():
            return "remote"

        # 3. 远程云 MCP（需要 API key）
        if os.environ.get(ENV_FIGMA_API_KEY) or os.environ.get(ENV_FIGMA_OAUTH_TOKEN):
            return "remote"

        # 4. 最后尝试 desktop（可能失败但会给出明确错误提示）
        return "desktop"

    if backend in ("desktop", "remote"):
        return backend

    raise ToolError(f"未知的 FIGMA_BACKEND 值: {backend}，可选: auto, desktop, remote")


def find_npx_bin() -> str:
    """查找 npx 可执行文件路径。"""
    npx = shutil.which("npx")
    if not npx:
        raise ToolError("未找到 npx，请安装 Node.js (https://nodejs.org)")
    return npx


# ---------------------------------------------------------------------------
# MCP 传输层
# ---------------------------------------------------------------------------


@dataclass
class MCPTransport:
    """MCP 传输抽象基类。"""
    backend: str
    _request_id: int = field(default=0, init=False)

    def next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def send_request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        raise NotImplementedError

    def close(self) -> None:
        pass

    def initialize(self) -> dict[str, Any]:
        """MCP 握手: initialize → initialized notification。"""
        result = self.send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": APP_NAME, "version": VERSION},
        })
        # 发送 initialized 通知（无 id 的消息）
        self._send_notification("notifications/initialized", {})
        return result

    def list_tools(self) -> list[dict[str, Any]]:
        """获取服务器可用工具列表。"""
        result = self.send_request("tools/list", {})
        return result.get("tools", [])

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """调用 MCP 工具。"""
        return self.send_request("tools/call", {
            "name": name,
            "arguments": arguments,
        })

    def _send_notification(self, method: str, params: dict[str, Any]) -> None:
        """发送 JSON-RPC 通知（无 id，不需要响应）。"""
        raise NotImplementedError


@dataclass
class StdioTransport(MCPTransport):
    """基于子进程 stdin/stdout 的 MCP 传输。"""

    server_cmd: list[str] = field(default_factory=list)
    _process: subprocess.Popen | None = field(default=None, init=False)
    image_dir: str | None = None

    def _ensure_process(self) -> subprocess.Popen:
        if self._process is not None and self._process.poll() is not None:
            self._process = None  # 进程已结束

        if self._process is None:
            cmd = self._build_cmd()
            self._process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        return self._process

    def _build_cmd(self) -> list[str]:
        npx = find_npx_bin()
        cmd = [npx, DEFAULT_FIGMA_MCP_PACKAGE, "--stdio"]

        # 传入 API key 或 OAuth token
        api_key = os.environ.get(ENV_FIGMA_API_KEY)
        oauth_token = os.environ.get(ENV_FIGMA_OAUTH_TOKEN)
        if api_key:
            cmd.extend(["--figma-api-key", api_key])
        if oauth_token:
            cmd.extend(["--figma-oauth-token", oauth_token])

        # 图片下载目录
        img_dir = self.image_dir or os.environ.get(ENV_FIGMA_IMAGE_DIR) or os.getcwd()
        cmd.extend(["--image-dir", img_dir])

        # 自定义 MCP bin
        custom_bin = os.environ.get(ENV_FIGMA_MCP_BIN)
        if custom_bin:
            return shlex.split(custom_bin)

        return cmd

    def send_request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        proc = self._ensure_process()
        request_id = self.next_id()

        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or {},
        }
        payload = json.dumps(request, ensure_ascii=False) + "\n"

        try:
            assert proc.stdin is not None
            proc.stdin.write(payload)
            proc.stdin.flush()
        except BrokenPipeError:
            stderr_output = ""
            if proc.stderr:
                try:
                    stderr_output = proc.stderr.read()
                except Exception:
                    pass
            raise ToolError(
                f"MCP server 连接断开（进程已退出，code={proc.poll()}）。"
                f"{' stderr: ' + stderr_output if stderr_output else ''}"
            )

        # 读取响应
        assert proc.stdout is not None
        line = proc.stdout.readline()
        if not line:
            stderr_output = ""
            if proc.stderr:
                try:
                    stderr_output = proc.stderr.read()
                except Exception:
                    pass
            raise ToolError(
                f"MCP server 无响应（进程已退出，code={proc.poll()}）。"
                f"{' stderr: ' + stderr_output if stderr_output else ''}"
            )

        try:
            response = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ToolError(f"MCP server 返回非 JSON 响应: {line[:200]} ({exc})")

        if "error" in response:
            err = response["error"]
            raise ToolError(f"MCP 错误 [{err.get('code', '?')}]: {err.get('message', str(err))}")

        return response.get("result", {})

    def _send_notification(self, method: str, params: dict[str, Any]) -> None:
        proc = self._ensure_process()
        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        payload = json.dumps(notification, ensure_ascii=False) + "\n"
        try:
            assert proc.stdin is not None
            proc.stdin.write(payload)
            proc.stdin.flush()
        except BrokenPipeError:
            pass  # 通知丢失不致命

    def close(self) -> None:
        if self._process is not None:
            try:
                self._process.stdin.close()
            except Exception:
                pass
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait()
            self._process = None


@dataclass
class HttpTransport(MCPTransport):
    """MCP Streamable HTTP 传输（Figma Desktop / Remote MCP）。

    遵循 MCP Streamable HTTP 规范：
    1. GET 建立 SSE 会话，获取 Mcp-Session-Id
    2. POST JSON-RPC 请求（携带 session id）
    """

    _client: Any = field(default=None, init=False)
    _session_id: str | None = field(default=None, init=False)
    _endpoint_url: str | None = field(default=None, init=False)  # SSE endpoint 事件中的 POST URL
    debug: bool = field(default=False)

    @property
    def base_url(self) -> str:
        return os.environ.get(ENV_FIGMA_MCP_URL, DEFAULT_MCP_URL)

    @property
    def _post_url(self) -> str:
        """POST 请求的目标 URL。优先使用 SSE endpoint 事件中指定的 URL。"""
        return self._endpoint_url or self.base_url

    def _ensure_client(self) -> Any:
        if not HAS_HTTPX:
            raise ToolError("remote 后端需要 httpx 库: pip install httpx")
        if self._client is None:
            self._client = httpx.Client(timeout=httpx.Timeout(60.0), trust_env=False)
        return self._client

    def _ensure_session(self) -> str:
        """尝试多种方式建立 SSE 会话并获取 POST 端点。"""
        if self._session_id is not None:
            return self._session_id

        client = self._ensure_client()
        auth = self._auth_headers()

        # 尝试 GET 建立 SSE 会话（Streamable HTTP 规范）
        for sse_path in ["/sse", ""]:
            sse_url = f"{self.base_url.rstrip('/')}{sse_path}" if sse_path else self.base_url
            try:
                hdr = {"Accept": "text/event-stream", **auth}
                resp = client.get(sse_url, headers=hdr)
                if self.debug:
                    print(f"[debug] GET {sse_url} → {resp.status_code}", file=sys.stderr)
                    print(f"[debug]   响应头: {dict(resp.headers)}", file=sys.stderr)

                if resp.is_success:
                    sid = resp.headers.get("Mcp-Session-Id") or resp.headers.get("mcp-session-id")
                    if sid:
                        self._session_id = sid
                        if self.debug:
                            print(f"[debug]   获取到 Session ID: {sid}", file=sys.stderr)
                        return sid

                    # 读取 SSE 事件，查找 endpoint 和 session 信息
                    endpoint_url = self._parse_sse_endpoint(resp.text)
                    if endpoint_url:
                        self._endpoint_url = endpoint_url
                        if self.debug:
                            print(f"[debug]   SSE endpoint 事件: {endpoint_url}", file=sys.stderr)

                    # 也尝试从 SSE 事件中找 session id
                    if not sid:
                        sid = self._parse_sse_session_id(resp.text)
                        if sid:
                            self._session_id = sid
                            if self.debug:
                                print(f"[debug]   从 SSE 获取到 Session ID: {sid}", file=sys.stderr)
                            return sid
            except httpx.HTTPError as exc:
                if self.debug:
                    print(f"[debug] GET {sse_url} 失败: {exc}", file=sys.stderr)
                continue

        # 无会话模式：直接 POST，不携带 Mcp-Session-Id
        self._session_id = ""
        if self.debug:
            print("[debug] 未获取到 SSE 会话，使用无会话模式", file=sys.stderr)
        return ""

    def _parse_sse_endpoint(self, body: str) -> str | None:
        """从 SSE 响应中解析 endpoint 事件。"""
        event_type = None
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:") and event_type == "endpoint":
                data = line[5:].strip()
                if data:
                    return data
        return None

    def _parse_sse_session_id(self, body: str) -> str | None:
        """从 SSE 响应中解析 session ID。"""
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                data_str = line[5:].strip()
                if not data_str:
                    continue
                try:
                    data = json.loads(data_str)
                    sid = data.get("sessionId") or data.get("session_id")
                    if sid:
                        return sid
                except json.JSONDecodeError:
                    continue
        return None

    def _auth_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {}
        api_key = os.environ.get(ENV_FIGMA_API_KEY)
        oauth_token = os.environ.get(ENV_FIGMA_OAUTH_TOKEN)
        if api_key:
            headers["X-Figma-Token"] = api_key
        if oauth_token:
            headers["Authorization"] = f"Bearer {oauth_token}"
        return headers

    def _build_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:  # 非空才加
            headers["Mcp-Session-Id"] = self._session_id
        headers.update(self._auth_headers())
        return headers

    def send_request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._ensure_session()
        client = self._ensure_client()
        request_id = self.next_id()
        post_url = self._post_url

        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or {},
        }
        payload = json.dumps(request, ensure_ascii=False)
        headers = self._build_headers()

        if self.debug:
            print(f"[debug] POST {post_url}", file=sys.stderr)
            print(f"[debug]   请求头: {headers}", file=sys.stderr)
            print(f"[debug]   请求体: {payload[:500]}", file=sys.stderr)

        try:
            resp = client.post(post_url, content=payload, headers=headers)
            if self.debug:
                print(f"[debug]   响应状态: {resp.status_code}", file=sys.stderr)
                print(f"[debug]   响应头: {dict(resp.headers)}", file=sys.stderr)
                print(f"[debug]   响应体: {resp.text[:500]}", file=sys.stderr)
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise ToolError(
                f"MCP HTTP 请求失败 ({post_url}): {exc} "
                f"body={exc.response.text[:300]}"
            )
        except httpx.HTTPError as exc:
            raise ToolError(f"MCP HTTP 请求失败 ({post_url}): {exc}")

        # 解析响应
        ct = resp.headers.get("content-type", "")
        if "text/event-stream" in ct:
            return self._parse_sse_response(resp.text, request_id)

        try:
            data = resp.json()
        except json.JSONDecodeError:
            raise ToolError(f"MCP 返回非 JSON 响应: {resp.text[:200]}")

        if "error" in data:
            err = data["error"]
            raise ToolError(f"MCP 错误 [{err.get('code', '?')}]: {err.get('message', str(err))}")

        return data.get("result", {})

    def _parse_sse_response(self, body: str, request_id: int) -> dict[str, Any]:
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                data_str = line[5:].strip()
                if not data_str:
                    continue
                try:
                    data = json.loads(data_str)
                    if data.get("id") == request_id:
                        if "error" in data:
                            err = data["error"]
                            raise ToolError(
                                f"MCP 错误 [{err.get('code', '?')}]: "
                                f"{err.get('message', str(err))}"
                            )
                        return data.get("result", {})
                except json.JSONDecodeError:
                    continue
        raise ToolError("SSE 响应中未找到对应请求的 JSON-RPC 结果")

    def _send_notification(self, method: str, params: dict[str, Any]) -> None:
        self._ensure_session()
        client = self._ensure_client()
        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        payload = json.dumps(notification, ensure_ascii=False)
        try:
            client.post(self._post_url, content=payload, headers=self._build_headers())
        except httpx.HTTPError:
            pass

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None


def create_transport(backend: str, image_dir: str | None = None, debug: bool = False) -> MCPTransport:
    """创建 MCP 传输实例。"""
    if backend == "desktop":
        return StdioTransport(
            backend="desktop",
            image_dir=image_dir,
        )
    elif backend == "remote":
        return HttpTransport(backend="remote", debug=debug)
    else:
        raise ToolError(f"未知后端: {backend}")


# ---------------------------------------------------------------------------
# 缓存管理
# ---------------------------------------------------------------------------


@dataclass
class CacheManager:
    """管理 Figma 设计数据的本地缓存。"""

    cache_root: Path

    def file_cache_dir(self, file_key: str) -> Path:
        return self.cache_root / file_key

    def cache_path(self, file_key: str, tool_name: str, node_id: str | None = None) -> Path:
        d = self.file_cache_dir(file_key)
        d.mkdir(parents=True, exist_ok=True)
        if node_id:
            safe_node = node_id.replace(":", "_")
            return d / f"{tool_name}_{safe_node}.json"
        return d / f"{tool_name}.json"

    def read(self, file_key: str, tool_name: str, node_id: str | None = None) -> dict[str, Any] | None:
        path = self.cache_path(file_key, tool_name, node_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def write(self, file_key: str, tool_name: str, data: dict[str, Any],
              node_id: str | None = None) -> Path:
        path = self.cache_path(file_key, tool_name, node_id)
        payload = {
            "cached_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "file_key": file_key,
            "tool": tool_name,
            "node_id": node_id,
            "data": data,
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    def clear(self, file_key: str | None = None) -> int:
        count = 0
        if file_key:
            d = self.file_cache_dir(file_key)
            if d.exists():
                count = len(list(d.rglob("*.json")))
                shutil.rmtree(d)
        else:
            if self.cache_root.exists():
                count = len(list(self.cache_root.rglob("*.json")))
                shutil.rmtree(self.cache_root)
        return count

    def cache_info(self) -> dict[str, Any]:
        info: dict[str, Any] = {"root": str(self.cache_root), "files": {}}
        if not self.cache_root.exists():
            return info
        for file_dir in self.cache_root.iterdir():
            if file_dir.is_dir():
                entries = list(file_dir.glob("*.json"))
                if entries:
                    info["files"][file_dir.name] = [e.name for e in entries]
        return info


def find_cache_root() -> Path:
    """查找项目缓存根目录：<project>/.figma/。"""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True,
        )
        if proc.returncode == 0:
            return Path(proc.stdout.strip()) / CACHE_DIRNAME
    except Exception:
        pass
    return Path.cwd() / CACHE_DIRNAME


# ---------------------------------------------------------------------------
# 命令实现
# ---------------------------------------------------------------------------


def _get_transport(args: argparse.Namespace) -> MCPTransport:
    backend = resolve_backend(getattr(args, "backend", None))
    debug = getattr(args, "debug", False)
    transport = create_transport(backend, debug=debug)

    # 判断是否为本地 Figma Desktop MCP（直接 HTTP，不需要 initialize）
    is_local_desktop_http = (
        backend == "remote"
        and os.environ.get(ENV_FIGMA_MCP_URL, DEFAULT_MCP_URL) == DEFAULT_MCP_URL
        and _check_local_mcp()
    )

    if is_local_desktop_http:
        # 本地 Figma Desktop MCP：服务器已内部初始化，直接验证工具可用性
        if debug:
            print(f"[debug] 本地 Figma Desktop MCP，跳过 initialize，直接验证工具列表 ...", file=sys.stderr)
        try:
            transport.list_tools()
            if debug:
                print("[debug] 工具列表获取成功", file=sys.stderr)
        except ToolError as exc:
            transport.close()
            raise ToolError(
                f"Figma Desktop MCP 连接失败: {exc}\n"
                f"请确保 Figma Desktop 客户端已开启并登录。\n"
                f"或尝试: FIGMA_BACKEND=desktop 使用 npx 后端。"
            )
    else:
        # 标准 MCP 握手: initialize → initialized → tools/list
        try:
            transport.initialize()
        except ToolError as exc:
            transport.close()
            if backend == "desktop":
                raise ToolError(
                    f"Figma Desktop MCP 启动失败: {exc}\n"
                    f"请确保 Node.js 已安装，或设置 FIGMA_API_KEY 使用 remote 后端。"
                )
            else:
                raise ToolError(
                    f"Figma Remote MCP 连接失败: {exc}\n"
                    f"请检查 FIGMA_API_KEY 或 FIGMA_OAUTH_TOKEN 环境变量。"
                )

        try:
            transport.list_tools()
        except ToolError as exc:
            transport.close()
            raise ToolError(
                f"MCP 连接验证失败: {exc}\n"
                f"请检查 FIGMA_API_KEY 或 FIGMA_OAUTH_TOKEN 环境变量。"
            )

    return transport


def _get_tools(transport: MCPTransport) -> list[dict[str, Any]]:
    try:
        return transport.list_tools()
    except ToolError:
        return []


def _resolve_tool_arg(tool_name: str, tools: list[dict[str, Any]]) -> dict[str, Any] | None:
    for tool in tools:
        if tool.get("name") == tool_name:
            return tool
    return None


def _format_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def _print_or_json(data: Any, *, json_mode: bool) -> None:
    if json_mode:
        print(_format_json(data))
    else:
        if isinstance(data, dict):
            print(_format_json(data))
        else:
            print(data)


def _extract_text_content(result: dict[str, Any]) -> str:
    """从 MCP tools/call 结果中提取文本内容。"""
    content = result.get("content", [])
    texts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            texts.append(item.get("text", ""))
    return "\n".join(texts)


# --- status ---

def command_status(args: argparse.Namespace) -> int:
    backend = resolve_backend(getattr(args, "backend", None))
    cache = CacheManager(find_cache_root())

    payload: dict[str, Any] = {
        "tool": APP_NAME,
        "version": VERSION,
        "python_version": sys.version.split()[0],
        "backend": backend,
        "figma_api_key_set": bool(os.environ.get(ENV_FIGMA_API_KEY)),
        "figma_oauth_token_set": bool(os.environ.get(ENV_FIGMA_OAUTH_TOKEN)),
        "npx_available": shutil.which("npx") is not None,
        "httpx_available": HAS_HTTPX,
        "figma_mcp_bin": os.environ.get(ENV_FIGMA_MCP_BIN, "default"),
        "image_dir": os.environ.get(ENV_FIGMA_IMAGE_DIR, os.getcwd()),
        "cache": cache.cache_info(),
    }

    # 尝试连接后端
    try:
        debug = getattr(args, "debug", False)
        transport = create_transport(backend, debug=debug)
        transport.initialize()
        tools = transport.list_tools()
        payload["connected"] = True
        payload["available_tools"] = [t.get("name") for t in tools]
        transport.close()
    except ToolError as exc:
        payload["connected"] = False
        payload["connection_error"] = str(exc)

    json_mode = getattr(args, "json", False)
    if json_mode:
        print(_format_json(payload))
    else:
        print(f"Figma CLI v{VERSION}")
        print(f"后端: {backend} ({'已连接' if payload.get('connected') else '未连接'})")
        print(f"npx: {'可用' if payload['npx_available'] else '不可用'}")
        print(f"httpx: {'可用' if payload['httpx_available'] else '不可用'}")
        print(f"FIGMA_API_KEY: {'已设置' if payload['figma_api_key_set'] else '未设置'}")
        if not payload.get("connected"):
            print(f"连接错误: {payload.get('connection_error', '未知')}")
        if payload.get("available_tools"):
            print(f"可用工具: {', '.join(payload['available_tools'])}")
        cache_info = payload.get("cache", {}).get("files", {})
        if cache_info:
            print(f"缓存文件数: {sum(len(v) for v in cache_info.values())}")
        else:
            print("缓存: 无")
    return 0


# --- self-check ---

def command_self_check(args: argparse.Namespace) -> int:
    backend = resolve_backend(getattr(args, "backend", None))
    cache = CacheManager(find_cache_root())

    payload: dict[str, Any] = {
        "tool": APP_NAME,
        "version": VERSION,
        "python_version": sys.version.split()[0],
        "python_executable": sys.executable,
        "backend": backend,
        "mcp_url": os.environ.get(ENV_FIGMA_MCP_URL, DEFAULT_MCP_URL),
        "npx_path": shutil.which("npx"),
        "npx_available": shutil.which("npx") is not None,
        "httpx_available": HAS_HTTPX,
        "figma_api_key_set": bool(os.environ.get(ENV_FIGMA_API_KEY)),
        "figma_oauth_token_set": bool(os.environ.get(ENV_FIGMA_OAUTH_TOKEN)),
        "figma_mcp_bin": os.environ.get(ENV_FIGMA_MCP_BIN, "default"),
        "image_dir": os.environ.get(ENV_FIGMA_IMAGE_DIR, os.getcwd()),
        "cache_root": str(cache.cache_root),
    }

    # 检查本地 Figma Desktop MCP 端点
    if HAS_HTTPX:
        try:
            with httpx.Client(trust_env=False) as c:
                c.get(DEFAULT_MCP_URL, timeout=2.0)
            payload["desktop_mcp_local"] = True
            payload["desktop_mcp_url"] = DEFAULT_MCP_URL
        except Exception:
            payload["desktop_mcp_local"] = False

    # 检查 Node.js
    try:
        node_proc = subprocess.run(["node", "--version"], capture_output=True, text=True)
        payload["node_version"] = node_proc.stdout.strip() if node_proc.returncode == 0 else "unknown"
    except Exception:
        payload["node_version"] = "not found"

    # 检查 figma-developer-mcp
    try:
        import shlex
        npx = find_npx_bin()
        mcp_proc = subprocess.run(
            [npx, DEFAULT_FIGMA_MCP_PACKAGE, "--version"],
            capture_output=True, text=True, timeout=30,
        )
        payload["figma_mcp_version"] = (
            mcp_proc.stdout.strip() or mcp_proc.stderr.strip()
            if mcp_proc.returncode == 0 else "failed"
        )
    except Exception as exc:
        payload["figma_mcp_version"] = f"error: {exc}"

    # 测试连接
    try:
        debug = getattr(args, "debug", False)
        transport = create_transport(backend, debug=debug)
        transport.initialize()
        tools = transport.list_tools()
        payload["connection_ok"] = True
        payload["available_tools"] = [t.get("name") for t in tools]
        transport.close()
    except ToolError as exc:
        payload["connection_ok"] = False
        payload["connection_error"] = str(exc)

    json_mode = getattr(args, "json", False)
    if json_mode:
        print(_format_json(payload))
    else:
        for key, value in payload.items():
            print(f"{key}: {value}")
    return 0


# --- get-design ---

def command_get_design(args: argparse.Namespace) -> int:
    file_key, node_id = _resolve_file_and_node(args)
    transport = _get_transport(args)

    arguments: dict[str, Any] = {"fileKey": file_key}
    if node_id:
        arguments["nodeId"] = node_id
    if args.client_languages:
        arguments["clientLanguages"] = args.client_languages
    if args.client_frameworks:
        arguments["clientFrameworks"] = args.client_frameworks

    result = transport.call_tool("get_design_context", arguments)
    transport.close()

    if args.json:
        print(_format_json(result))
    else:
        text = _extract_text_content(result)
        print(text)

    # 缓存结果
    if not args.no_cache:
        cache = CacheManager(find_cache_root())
        cache.write(file_key, "get_design_context", result, node_id)

    return 0


# --- get-screenshot ---

def command_get_screenshot(args: argparse.Namespace) -> int:
    file_key, node_id = _resolve_file_and_node(args)

    if not node_id:
        raise ToolError("get-screenshot 需要指定 node_id，或通过 Figma URL 中的 node-id 参数提供")

    transport = _get_transport(args)

    arguments: dict[str, Any] = {
        "nodeId": node_id,
    }
    if args.client_languages:
        arguments["clientLanguages"] = args.client_languages
    if args.client_frameworks:
        arguments["clientFrameworks"] = args.client_frameworks

    result = transport.call_tool("get_screenshot", arguments)
    transport.close()

    if args.json:
        print(_format_json(result))
    else:
        text = _extract_text_content(result)
        print(text)

    if not args.no_cache:
        cache = CacheManager(find_cache_root())
        cache.write(file_key, "get_screenshot", result, node_id)

    return 0


# --- get-metadata ---

def command_get_metadata(args: argparse.Namespace) -> int:
    file_key, node_id = _resolve_file_and_node(args)

    transport = _get_transport(args)

    arguments: dict[str, Any] = {"fileKey": file_key}
    if node_id:
        arguments["nodeId"] = node_id
    if args.client_languages:
        arguments["clientLanguages"] = args.client_languages
    if args.client_frameworks:
        arguments["clientFrameworks"] = args.client_frameworks

    result = transport.call_tool("get_metadata", arguments)
    transport.close()

    _print_or_json(result, json_mode=args.json)
    if not args.no_cache:
        cache = CacheManager(find_cache_root())
        cache.write(file_key, "get_metadata", result, node_id)
    return 0


# --- get-variable-defs ---

def command_get_variable_defs(args: argparse.Namespace) -> int:
    file_key, node_id = _resolve_file_and_node(args)

    transport = _get_transport(args)

    arguments: dict[str, Any] = {"fileKey": file_key}
    if node_id:
        arguments["nodeId"] = node_id
    if args.client_languages:
        arguments["clientLanguages"] = args.client_languages
    if args.client_frameworks:
        arguments["clientFrameworks"] = args.client_frameworks

    result = transport.call_tool("get_variable_defs", arguments)
    transport.close()

    _print_or_json(result, json_mode=args.json)
    if not args.no_cache:
        cache = CacheManager(find_cache_root())
        cache.write(file_key, "get_variable_defs", result, node_id)
    return 0


# --- search ---

def command_search(args: argparse.Namespace) -> int:
    transport = _get_transport(args)
    result = transport.call_tool("search", {"query": args.query})
    transport.close()

    _print_or_json(result, json_mode=args.json)
    return 0


# --- refresh ---

def command_refresh(args: argparse.Namespace) -> int:
    cache = CacheManager(find_cache_root())
    count = cache.clear(args.file_key)
    if args.json:
        print(_format_json({"status": "cleared", "entries_removed": count}))
    else:
        target = args.file_key or "全部文件"
        print(f"已清除 {target} 的缓存 ({count} 条记录)")
    return 0


# --- 辅助函数 ---


def _resolve_file_and_node(args: argparse.Namespace) -> tuple[str, str | None]:
    """从命令行参数中解析 file_key 和 node_id。"""
    url_or_key = args.url
    node_id_override = getattr(args, "node_id", None)

    # 尝试从 URL 解析
    file_key, parsed_node = parse_figma_url(url_or_key)

    # 如果解析出的是 node_id（格式如 1:2），需要从 args 中获取 file_key
    if re.match(r"^\d+:\d+$", file_key) or re.match(r"^\d+-\d+$", file_key):
        # 这是 node_id，不是 file_key
        # 需要 URL 或 file-key 参数
        file_key_arg = getattr(args, "file_key", None)
        if file_key_arg:
            node_id = file_key.replace("-", ":")
            return file_key_arg, node_id
        raise ToolError(
            f"无法确定 file_key。请使用完整 Figma URL 或通过 --file-key 指定。"
            f"输入: {url_or_key}"
        )

    node_id = node_id_override or parsed_node
    if node_id:
        node_id = node_id.replace("-", ":")

    return file_key, node_id


# ---------------------------------------------------------------------------
# CLI 构建
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=APP_NAME,
        description="Figma MCP CLI — shell-first Figma 设计稿到代码的桥梁。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            命令:
              get-design <url>             获取设计上下文（节点树、样式）
              get-screenshot <node-id>     截取指定节点
              get-metadata <url>           获取文件/页面元数据
              get-variable-defs <url>      获取设计变量/令牌
              search <query>               搜索文件中的组件/样式
              refresh [--file-key KEY]     强制清除缓存
              status                       显示后端连接状态和缓存
              self-check                   诊断环境

            后端选择:
              FIGMA_BACKEND=remote         使用远程 Figma MCP（mcp.figma.com）
              FIGMA_BACKEND=desktop        使用本地 Figma Desktop MCP
              FIGMA_BACKEND=auto           自动检测（默认）

            环境变量:
              FIGMA_API_KEY                Figma Personal Access Token
              FIGMA_OAUTH_TOKEN            Figma OAuth Bearer Token
              FIGMA_MCP_BIN                自定义 MCP server 路径
              FIGMA_IMAGE_DIR              图片下载目录
        """),
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    parser.add_argument(
        "--backend",
        choices=["auto", "desktop", "remote"],
        help="后端模式 (默认: auto，通过 FIGMA_BACKEND 环境变量覆盖)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="输出调试信息（HTTP 请求/响应详情）",
    )
    subparsers = parser.add_subparsers(dest="command", required=False)

    # --- status ---
    status = subparsers.add_parser("status", help="显示后端连接状态和缓存")
    status.add_argument("--json", action="store_true", help="JSON 格式输出")
    status.set_defaults(func=command_status)

    # --- self-check ---
    self_check = subparsers.add_parser("self-check", help="诊断环境")
    self_check.add_argument("--json", action="store_true", help="JSON 格式输出")
    self_check.set_defaults(func=command_self_check)

    # --- get-design ---
    get_design = subparsers.add_parser("get-design", help="获取设计上下文（节点树、样式）")
    get_design.add_argument("url", help="Figma 文件 URL 或 file_key")
    get_design.add_argument("--node-id", help="指定节点 ID (如 1:2)，覆盖 URL 中的 node-id")
    get_design.add_argument("--file-key", help="直接指定 file_key（当 url 参数为 node_id 时使用）")
    get_design.add_argument("--client-languages", nargs="+", help="目标语言 (如 python typescript)")
    get_design.add_argument("--client-frameworks", nargs="+", help="目标框架 (如 react vue)")
    get_design.add_argument("--json", action="store_true", help="JSON 格式输出")
    get_design.add_argument("--no-cache", action="store_true", help="跳过本地缓存")
    get_design.set_defaults(func=command_get_design)

    # --- get-screenshot ---
    get_screenshot = subparsers.add_parser("get-screenshot", help="截取指定节点")
    get_screenshot.add_argument("url", help="Figma 文件 URL、file_key 或 node_id (如 1:2)")
    get_screenshot.add_argument("--node-id", help="指定节点 ID，覆盖 URL 中的 node-id")
    get_screenshot.add_argument("--file-key", help="直接指定 file_key")
    get_screenshot.add_argument("--client-languages", nargs="+", help="目标语言")
    get_screenshot.add_argument("--client-frameworks", nargs="+", help="目标框架")
    get_screenshot.add_argument("--json", action="store_true", help="JSON 格式输出")
    get_screenshot.add_argument("--no-cache", action="store_true", help="跳过本地缓存")
    get_screenshot.set_defaults(func=command_get_screenshot)

    # --- get-metadata ---
    get_metadata = subparsers.add_parser("get-metadata", help="获取文件/页面元数据")
    get_metadata.add_argument("url", help="Figma 文件 URL 或 file_key")
    get_metadata.add_argument("--node-id", help="指定节点 ID")
    get_metadata.add_argument("--file-key", help="直接指定 file_key")
    get_metadata.add_argument("--client-languages", nargs="+", help="目标语言")
    get_metadata.add_argument("--client-frameworks", nargs="+", help="目标框架")
    get_metadata.add_argument("--json", action="store_true", help="JSON 格式输出")
    get_metadata.add_argument("--no-cache", action="store_true", help="跳过本地缓存")
    get_metadata.set_defaults(func=command_get_metadata)

    # --- get-variable-defs ---
    get_variable_defs = subparsers.add_parser("get-variable-defs", help="获取设计变量/令牌")
    get_variable_defs.add_argument("url", help="Figma 文件 URL 或 file_key")
    get_variable_defs.add_argument("--node-id", help="指定节点 ID")
    get_variable_defs.add_argument("--file-key", help="直接指定 file_key")
    get_variable_defs.add_argument("--client-languages", nargs="+", help="目标语言")
    get_variable_defs.add_argument("--client-frameworks", nargs="+", help="目标框架")
    get_variable_defs.add_argument("--json", action="store_true", help="JSON 格式输出")
    get_variable_defs.add_argument("--no-cache", action="store_true", help="跳过本地缓存")
    get_variable_defs.set_defaults(func=command_get_variable_defs)

    # --- search ---
    search = subparsers.add_parser("search", help="搜索文件中的组件/样式")
    search.add_argument("query", help="搜索关键词")
    search.add_argument("--json", action="store_true", help="JSON 格式输出")
    search.set_defaults(func=command_search)

    # --- refresh ---
    refresh = subparsers.add_parser("refresh", help="强制清除缓存")
    refresh.add_argument("--file-key", help="指定文件 key（不指定则清除全部）")
    refresh.add_argument("--json", action="store_true", help="JSON 格式输出")
    refresh.set_defaults(func=command_refresh)

    # 默认命令（无子命令时显示 status）
    parser.set_defaults(func=command_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ToolError as exc:
        print(f"{APP_NAME}: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(f"{APP_NAME}: 中断", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
