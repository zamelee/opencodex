"""HTTP 服务：协议注册表 + 下游鉴权 + 预提交缓冲 + 流式透传 + 故障转移。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from typing import Callable

import aiohttp
from aiohttp import web

from .failover import UpstreamSelector, classify_exception, classify_status
from .metrics import Metrics
from .models import Phase, Rule
from .session import session_key as make_session_key

HOP_BY_HOP = {
    "host",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
}

# endpoint registry：精确路径 -> 上游等价路径
REGISTRY: dict[str, dict[str, str]] = {
    "openai-responses": {
        "POST /v1/responses": "POST /v1/responses",
        "GET /v1/responses/{id}": "GET /v1/responses/{id}",
        "DELETE /v1/responses/{id}": "DELETE /v1/responses/{id}",
        "POST /v1/responses/compact": "POST /v1/responses/compact",
    },
    "openai-chat": {
        "POST /v1/chat/completions": "POST /v1/chat/completions",
        "GET /v1/models": "GET /v1/models",
    },
    "anthropic": {
        "POST /v1/messages": "POST /v1/messages",
        "POST /v1/messages/count_tokens": "POST /v1/messages/count_tokens",
        "POST /v1/messages/batches": "POST /v1/messages/batches",
        "GET /v1/messages/batches/{id}": "GET /v1/messages/batches/{id}",
    },
}


def resolve_endpoint(protocol: str, method: str, path: str) -> str | None:
    """按注册表精确匹配，返回上游等价路径描述。找不到返回 None。"""
    table = REGISTRY.get(protocol, {})
    key = f"{method} {path}"
    if key in table:
        return table[key]
    # 只有 {id} 这类单段占位符才允许模板匹配
    for tmpl, up in table.items():
        tmpl_method, tmpl_path = tmpl.split(" ", 1)
        if tmpl_method != method:
            continue
        tparts = tmpl_path.strip("/").split("/")
        pparts = path.strip("/").split("/")
        if len(tparts) != len(pparts):
            continue
        ok = True
        for t, p in zip(tparts, pparts):
            if t.startswith("{") and t.endswith("}"):
                if not p:
                    ok = False
                    break
            elif t != p:
                ok = False
                break
        if ok:
            return up
    return None


def _normalize_error(status: int, body: bytes, code: str) -> web.Response:
    """把上游错误归一化成下游可见的错误体。"""
    message = body.decode("utf-8", "replace")[:2000]
    try:
        parsed = json.loads(message)
        if isinstance(parsed, dict):
            err = parsed.get("error")
            if isinstance(err, dict) and err.get("message"):
                message = str(err["message"])[:2000]
            elif isinstance(err, str):
                message = err[:2000]
    except (ValueError, TypeError):
        pass
    return web.json_response(
        {"error": {"type": "upstream_error", "message": message, "code": code}},
        status=status,
    )


def _host_of(base_url: str) -> str:
    from urllib.parse import urlsplit

    try:
        p = urlsplit(base_url)
        if p.port:
            return f"{p.hostname}:{p.port}"
        return p.hostname or ""
    except ValueError:
        return ""


_RESP_ID_RE = re.compile(rb'"id"\s*:\s*"((?:resp|chatcmpl|msg)_[A-Za-z0-9_\-]{6,})"')


def _extract_response_id(chunk: bytes) -> str:
    """从首个数据块里捞出上游的 response/chat id（尽力而为，失败就跳过）。"""
    if not chunk or len(chunk) > 512 * 1024:
        return ""
    m = _RESP_ID_RE.search(chunk)
    return m.group(1).decode("ascii", "ignore") if m else ""


class Gateway:
    def __init__(
        self,
        storage,
        settings,
        health,
        session_router,
        log: Callable[[str, str, str], None] | None = None,
        on_route: Callable[[str], None] | None = None,
    ) -> None:
        self.storage = storage
        self.settings = settings
        self.health = health
        self.session_router = session_router
        self.log = log or (lambda level, kind, msg: None)
        self.on_route = on_route or (lambda upstream_id: None)
        self.selector = UpstreamSelector(settings, health, session_router)
        self.client: aiohttp.ClientSession | None = None
        self._client_loop: asyncio.AbstractEventLoop | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.metrics = Metrics()
        self.active = 0
        self.last_error = ""

    async def close(self) -> None:
        if self.client is not None:
            await self.client.close()
            self.client = None

    async def ensure_client(self) -> aiohttp.ClientSession:
        """连接池必须与当前事件循环同属一个线程，否则请求会挂死。"""
        loop = asyncio.get_running_loop()
        self._loop = loop
        if self.client is None or self._client_loop is not loop:
            if self.client is not None:
                try:
                    await self.client.close()
                except Exception:
                    pass
            self.client = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(
                    total=None,
                    sock_connect=self.settings.upstream_connect_timeout_s,
                    sock_read=self.settings.upstream_read_timeout_s,
                )
            )
            self._client_loop = loop
        return self.client

    def authorize(self, request: web.Request) -> bool:
        auth = request.headers.get("authorization", "")
        raw = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not raw:
            return False
        h = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        return h in self.storage.client_key_hashes()

    def client_key_id(self, request: web.Request) -> str:
        """下游 key 的 id（会话键材料之一）。取不到就退回 key 前缀的哈希。"""
        auth = request.headers.get("authorization", "")
        raw = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        if not raw:
            return ""
        h = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        return self.storage.client_key_id_by_hash(h) or h[:12]

    def build_headers(self, request: web.Request, upstream) -> dict[str, str]:
        headers = {}
        for k, v in request.headers.items():
            if k.lower() in HOP_BY_HOP or k.lower() == "authorization":
                continue
            headers[k] = v
        headers["authorization"] = f"Bearer {upstream.api_key}"
        headers["host"] = _host_of(upstream.base_url)
        return headers

    async def handle(self, request: web.Request) -> web.StreamResponse:
        if not self.authorize(request):
            return web.json_response(
                {"error": {"type": "invalid_api_key", "message": "invalid downstream key"}},
                status=401,
            )

        self.metrics.downstream_start()
        path = request.path
        upstream_desc = resolve_endpoint(self.settings.protocol, request.method, path)
        if upstream_desc is None:
            self.metrics.downstream_end()
            return web.json_response(
                {
                    "error": {
                        "type": "not_found",
                        "message": f"no route for {request.method} {path}",
                    }
                },
                status=404,
            )

        body = await request.read()
        skey = make_session_key(
            self.settings.protocol,
            dict(request.headers),
            self.client_key_id(request),
            request.headers.get("authorization", ""),
        )
        upstreams = self.storage.list_upstreams()
        if not upstreams:
            self.metrics.downstream_end()
            return _normalize_error(502, b"no upstream configured", "no_upstream")

        plan = self.selector.plan(upstreams, skey)
        last_body = b""
        last_code = "upstream_unavailable"

        while True:
            upstream = plan.next_upstream()
            if upstream is None:
                self.metrics.downstream_end()
                return _normalize_error(502, last_body or b"all upstreams failed", last_code)

            phase = Phase.NOT_SENT
            attempt_started = time.monotonic()
            try:
                client = await self.ensure_client()
                self.metrics.upstream_start(upstream.id)
                resp = await client.request(
                    request.method,
                    upstream.base_url.rstrip("/") + upstream_desc.split(" ", 1)[1],
                    headers=self.build_headers(request, upstream),
                    data=body if body else None,
                    allow_redirects=False,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.metrics.upstream_end(
                    upstream.id, (time.monotonic() - attempt_started) * 1000, ok=False
                )
                rule = classify_exception(exc)
                self.health.record_failure(upstream.id, str(exc))
                self.selector.mark_failure(upstream.id)
                self.log("warn", "upstream", f"{upstream.name} 连接失败: {exc}")
                if self.selector.should_switch(plan, rule, phase):
                    plan.mark_failed(upstream.id)
                    self.selector.note_switch(plan)
                    self.log("info", "switch", f"切换到下一个上游（原 {upstream.name}）")
                    continue
                self.metrics.downstream_end()
                return _normalize_error(502, str(exc).encode("utf-8"), "connect_failed")

            status = resp.status
            if 200 <= status < 300:
                # 预提交缓冲：在预算内等首块；超首块预算视为该上游响应过慢，可换人
                try:
                    first = await asyncio.wait_for(
                        resp.content.read(65536),
                        timeout=self.settings.precommit_budget_s,
                    )
                except asyncio.TimeoutError:
                    resp.close()
                    self.metrics.upstream_end(
                        upstream.id, (time.monotonic() - attempt_started) * 1000, ok=False
                    )
                    self.health.record_failure(upstream.id, "precommit budget exceeded")
                    self.log(
                        "warn",
                        "upstream",
                        f"{upstream.name} 预提交等待超过 "
                        f"{self.settings.precommit_budget_s}s，判定过慢",
                    )
                    if self.selector.should_switch(plan, Rule.CONNECT_FAIL, phase):
                        plan.mark_failed(upstream.id)
                        self.selector.note_switch(plan)
                        continue
                    self.metrics.downstream_end()
                    return _normalize_error(
                        504,
                        b"upstream did not send first chunk in time",
                        "precommit_timeout",
                    )
                phase = Phase.UPSTREAM_RESPONSE_STARTED
                ttfb_ms = (time.monotonic() - attempt_started) * 1000
                self.metrics.upstream_end(upstream.id, ttfb_ms)
                self.health.record_success(upstream.id)
                self.session_router.bind(skey, upstream.id)
                self.on_route(upstream.id)
                self.log("info", "route", f"{upstream.name} 命中 {status}")
                return await self._commit_stream(request, resp, first, upstream.id)

            body_bytes = await resp.read()
            await resp.release()
            self.metrics.upstream_end(
                upstream.id, (time.monotonic() - attempt_started) * 1000, ok=False
            )
            rule = classify_status(status)
            self.health.record_failure(upstream.id, f"HTTP {status}")
            self.selector.mark_failure(upstream.id)
            self.log("warn", "upstream", f"{upstream.name} 返回 {status}")
            last_body = body_bytes
            last_code = {
                Rule.UPSTREAM_429: "upstream_429",
                Rule.UPSTREAM_5XX: "upstream_5xx",
                Rule.UPSTREAM_4XX: "upstream_4xx",
            }.get(rule, "upstream_error")
            if self.selector.should_switch(plan, rule, phase):
                plan.mark_failed(upstream.id)
                self.selector.note_switch(plan)
                continue
            self.metrics.downstream_end()
            return _normalize_error(502, last_body, last_code)

    async def _commit_stream(
        self, request: web.Request, resp, first: bytes, upstream_id: str = ""
    ) -> web.StreamResponse:
        """把上游响应提交给下游并透传剩余数据。"""
        ctype = resp.headers.get("Content-Type", "application/json")
        encoding = resp.headers.get("Content-Encoding")
        headers = {"Content-Type": ctype, "Cache-Control": "no-cache"}
        if encoding:
            headers["Content-Encoding"] = encoding
        stream = web.StreamResponse(status=resp.status, headers=headers)
        await stream.prepare(request)
        ttfb_ms = None
        try:
            if first:
                ttfb_ms = 0.0
                resp_id = _extract_response_id(first)
                if resp_id:
                    self.session_router.bind_response(resp_id, upstream_id)
                await stream.write(first)
            async for chunk in resp.content.iter_any():
                if chunk:
                    await stream.write(chunk)
            await stream.write_eof()
        except (ConnectionResetError, asyncio.CancelledError):
            raise
        except Exception:
            pass
        finally:
            resp.close()
            self.metrics.downstream_end(ttfb_ms)
        return stream

    async def manual_probe(self, upstream, model: str = "gpt-4o-mini") -> dict:
        """手动探测：发一个最小请求。可能计费，UI 需明示。"""
        client = await self.ensure_client()
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
        }
        path = {
            "openai-responses": "/v1/responses",
            "openai-chat": "/v1/chat/completions",
            "anthropic": "/v1/messages",
        }.get(self.settings.protocol, "/v1/responses")
        started = time.monotonic()
        try:
            resp = await client.post(
                upstream.base_url.rstrip("/") + path,
                headers={
                    "authorization": f"Bearer {upstream.api_key}",
                    "content-type": "application/json",
                },
                json=payload,
            )
            body = await resp.text()
            return {
                "ok": resp.status < 400,
                "status": resp.status,
                "ms": int((time.monotonic() - started) * 1000),
                "body": body[:400],
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "status": None,
                "ms": int((time.monotonic() - started) * 1000),
                "body": str(exc)[:400],
            }

    async def tcp_probe(self, upstream) -> bool:
        """主动探活：只测 TCP 可达性，不发请求、不计费。"""
        from urllib.parse import urlsplit

        p = urlsplit(upstream.base_url)
        host = p.hostname
        port = p.port or (443 if p.scheme == "https" else 80)
        if not host:
            return False
        try:
            conn = asyncio.open_connection(host, port)
            reader, writer = await asyncio.wait_for(conn, timeout=self.settings.probe_timeout_s)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return True
        except Exception:
            return False


def build_app(gateway: Gateway) -> web.Application:
    app = web.Application(client_max_size=512 * 1024 * 1024)
    app.router.add_route("*", "/{tail:.*}", gateway.handle)
    return app
