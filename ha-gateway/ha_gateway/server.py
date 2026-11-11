"""HTTP 服务：协议注册表 + 下游鉴权 + 预提交缓冲 + 流式透传 + 故障转移。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from typing import Callable

import aiohttp
from aiohttp import web

from .failover import UpstreamSelector, classify_exception, classify_status
from .labels import upstream_label
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
_REQ_ID_RE = re.compile(
    rb'"(?:request_id|requestId|request-id|x-request-id)"\s*:\s*"([^"]{4,200})"'
)
_REQ_ID_TEXT_RE = re.compile(rb"request[ _-]?id[:=]\s*([A-Za-z0-9_\-]{6,200})", re.I)
_USAGE_RE = re.compile(rb'"usage"\s*:\s*(\{[^{}]{0,600}\})')


def _extract_response_id(chunk: bytes) -> str:
    """从首个数据块里捞出上游的 response/chat id（尽力而为，失败就跳过）。"""
    if not chunk or len(chunk) > 512 * 1024:
        return ""
    m = _RESP_ID_RE.search(chunk)
    return m.group(1).decode("ascii", "ignore") if m else ""


def _extract_request_id(body: bytes) -> str:
    """从上游错误体里捞出 request id（没有就返回空串）。"""
    if not body or len(body) > 256 * 1024:
        return ""
    m = _REQ_ID_RE.search(body)
    if not m:
        m = _REQ_ID_TEXT_RE.search(body)
    return m.group(1).decode("utf-8", "ignore") if m else ""


def _extract_model(body: bytes) -> str:
    """从请求体里取 model 名（只取元信息，绝不记录对话内容）。"""
    if not body or len(body) > 4 * 1024 * 1024:
        return ""
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return ""
    if isinstance(data, dict):
        model = data.get("model")
        if isinstance(model, str):
            return model[:80]
    return ""


def _extract_usage(chunk: bytes) -> dict | None:
    """从流式数据块里捞 usage（token 计数）。

    三种协议都带 usage，字段名不一样：
      openai-responses: response.completed 事件 -> response.usage
      openai-chat:     最后一个 chunk -> usage
      anthropic:       message_start (input_tokens) / message_delta (output_tokens)
    这里只认「顶层 usage 对象」，取到就合并；取不到就返回 None。
    """
    if not chunk or len(chunk) > 1024 * 1024:
        return None
    matches = list(_USAGE_RE.finditer(chunk))
    if not matches:
        return None
    # 取最后一个：同一个块里若出现多次 usage，最后一个才是最新的计数
    m = matches[-1]
    try:
        obj = json.loads(m.group(1))
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    out = {
        "in": obj.get("input_tokens") or obj.get("prompt_tokens"),
        "out": obj.get("output_tokens") or obj.get("completion_tokens"),
        "total": obj.get("total_tokens"),
    }
    out = {k: v for k, v in out.items() if isinstance(v, int)}
    return out or None


def _merge_usage(acc: dict | None, part: dict | None) -> dict | None:
    """把多段 usage 合并成一份（后到的字段覆盖，缺失的保留）。"""
    if not part:
        return acc
    if acc is None:
        acc = {}
    for k, v in part.items():
        if v is not None:
            acc[k] = v
    return acc


def _probe_payload(protocol: str, model: str) -> dict:
    """按协议拼一个最小的探测请求体。

    之前三种协议都用 chat 的 messages 格式，openai-responses 那边认不出来，
    会报"找不到 provider"这种看起来像通道坏了的错。
    """
    if protocol == "anthropic":
        return {
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
    if protocol == "openai-chat":
        return {
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
    # openai-responses：用 input
    return {
        "model": model,
        "max_output_tokens": 16,
        "input": "ping",
    }


def _parse_models(body: str) -> list[str]:
    """从 /v1/models 的响应里抽出模型名列表。"""
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, dict):
        return []
    items = data.get("data")
    if not isinstance(items, list):
        items = data.get("models")
    if not isinstance(items, list):
        return []
    out: list[str] = []
    for it in items:
        if isinstance(it, str):
            name = it
        elif isinstance(it, dict):
            name = str(it.get("id") or it.get("name") or "")
        else:
            continue
        name = name.strip()
        if name and name not in out:
            out.append(name)
    return out


class UsageCollector:
    """跨块收集 usage。

    usage 往往出现在流的最后一块（openai-responses 的 response.completed、
    anthropic 的 message_delta），而 SSE 的分块边界经常把 "usage" 这个词切成
    两半，单块正则匹配不到。这里留一个尾巴缓冲，跨块再匹配一次。
    """

    def __init__(self, keep: int = 8192) -> None:
        self.keep = keep
        self.tail = b""
        self.usage: dict = {}

    def feed(self, chunk: bytes) -> None:
        if not chunk:
            return
        buf = self.tail + chunk
        _merge_usage(self.usage, _extract_usage(buf))
        self.tail = buf[-self.keep :]

    def snapshot(self) -> dict:
        return dict(self.usage)


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

    def _record_usage(
        self,
        *,
        rid: str,
        upstream_id: str,
        upstream_name: str,
        model: str,
        status: int,
        usage: dict | None,
        ttfb_ms: float | None,
    ) -> None:
        """把一次请求的用量写进 SQLite（用于历史统计）。写库失败不影响主流程。"""
        try:
            self.storage.add_usage_record(
                rid=rid,
                upstream_id=upstream_id,
                upstream_name=upstream_name,
                model=model,
                status=status,
                input_tokens=(usage or {}).get("in"),
                output_tokens=(usage or {}).get("out"),
                total_tokens=(usage or {}).get("total"),
                ttfb_ms=ttfb_ms,
            )
        except Exception:
            pass

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
        # 下游（Codex 等）拉模型列表：按路由转发到这次该走的那条上游，
        # 拿它真实的清单；上游不支持时用本地缓存兜底。
        if request.method == "GET" and path.rstrip("/") == "/v1/models":
            return await self._handle_models(request)
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

        # 一次下游请求一个短 rid，把这次请求牵出的所有日志行串起来。
        # resp_id 只有成功响应才有；失败行靠 rid + request_id 对账。
        rid = os.urandom(4).hex()
        labels = {u.id: upstream_label(upstreams, u.id) for u in upstreams}
        model_name = _extract_model(body)
        self.log(
            "info",
            "request",
            f"请求 ｜ rid={rid} ｜ {request.method} {path} ｜ "
            f"model={model_name or '-'} ｜ body={len(body)}B",
        )

        plan = self.selector.plan(upstreams, skey)
        cand = [labels.get(u.id, u.name) for u in plan.candidates]
        sticky = labels.get(plan.sticky_id, "") if plan.sticky_id else ""
        self.log(
            "info",
            "plan",
            f"候选 ｜ 顺序 {'→'.join(cand) if cand else '无'} ｜ 粘性={sticky or '无'}",
        )
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
                self.log(
                    "warn",
                    "upstream",
                    f"✗ {labels.get(upstream.id, upstream.name)} ｜ rid={rid} ｜ "
                    f"连接失败 ｜ rule=connect_fail ｜ {exc}",
                )
                if self.selector.should_switch(plan, rule, phase):
                    plan.mark_failed(upstream.id)
                    self.selector.note_switch(plan)
                    nxt = plan.next_upstream()
                    self.log(
                        "info",
                        "switch",
                        f"切换 ｜ rid={rid} ｜ {labels.get(upstream.id, upstream.name)}"
                        + (f" → {labels.get(nxt.id, nxt.name)}" if nxt else " → 无候选"),
                    )
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
                        f"✗ {labels.get(upstream.id, upstream.name)} ｜ rid={rid} ｜ "
                        f"预提交等待超过 {self.settings.precommit_budget_s}s ｜ "
                        f"判定过慢 ｜ rule=connect_fail",
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
                resp_id = _extract_response_id(first)
                usage_box: dict = {}
                stream = await self._commit_stream(
                    request, resp, first, upstream.id, resp_id, usage_box
                )
                total_ms = (time.monotonic() - attempt_started) * 1000
                usage_txt = ""
                if usage_box:
                    usage_txt = (
                        f" usage=入{usage_box.get('in', '-')}"
                        f"/出{usage_box.get('out', '-')}"
                        f"/总{usage_box.get('total', '-')}"
                    )
                self._record_usage(
                    rid=rid,
                    upstream_id=upstream.id,
                    upstream_name=labels.get(upstream.id, upstream.name),
                    model=model_name,
                    status=status,
                    usage=usage_box,
                    ttfb_ms=ttfb_ms,
                )
                self.log(
                    "info",
                    "route",
                    f"✓ {labels.get(upstream.id, upstream.name)} ｜ rid={rid} ｜ {status} ｜ "
                    f"ttfb={ttfb_ms:.0f}ms ｜ 总={total_ms:.0f}ms ｜ "
                    f"resp_id={resp_id or '-'}{usage_txt}",
                )
                return stream

            body_bytes = await resp.read()
            await resp.release()
            self.metrics.upstream_end(
                upstream.id, (time.monotonic() - attempt_started) * 1000, ok=False
            )
            rule = classify_status(status)
            self.health.record_failure(upstream.id, f"HTTP {status}")
            self.selector.mark_failure(upstream.id)
            last_body = body_bytes
            last_code = {
                Rule.UPSTREAM_429: "upstream_429",
                Rule.UPSTREAM_5XX: "upstream_5xx",
                Rule.UPSTREAM_4XX: "upstream_4xx",
            }.get(rule, "upstream_error")
            req_id = _extract_request_id(body_bytes)
            # 提示词过长这类错误，日志里点出来，省得再去翻原始报文
            low = body_bytes[:4000].lower()
            too_long = (
                b"prompt_too_long" in low
                or b"too many tokens" in low
                or b"maximum context length" in low
                or b"context_length_exceeded" in low
            )
            will_switch = self.selector.should_switch(plan, rule, phase)
            nxt = None
            if will_switch:
                plan.mark_failed(upstream.id)
                nxt = plan.next_upstream()
            self._record_usage(
                rid=rid,
                upstream_id=upstream.id,
                upstream_name=labels.get(upstream.id, upstream.name),
                model=model_name,
                status=status,
                usage=None,
                ttfb_ms=(time.monotonic() - attempt_started) * 1000,
            )
            self.log(
                "warn",
                "upstream",
                f"✗ {labels.get(upstream.id, upstream.name)} ｜ rid={rid} ｜ {status} ｜ "
                f"规则={last_code} ｜ request_id={req_id or '-'}"
                + (" ｜ 提示=疑似提示词超长" if too_long else "")
                + (f" ｜ → {labels.get(nxt.id, nxt.name)}" if nxt else ""),
            )
            if will_switch:
                self.selector.note_switch(plan)
                continue
            self.metrics.downstream_end()
            return _normalize_error(502, last_body, last_code)

    async def _commit_stream(
        self,
        request: web.Request,
        resp,
        first: bytes,
        upstream_id: str = "",
        resp_id: str = "",
        usage_box: dict | None = None,
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
        collector = UsageCollector()
        try:
            if first:
                ttfb_ms = 0.0
                if resp_id:
                    self.session_router.bind_response(resp_id, upstream_id)
                if usage_box is not None:
                    collector.feed(first)
                    usage_box.update(collector.snapshot())
                await stream.write(first)
            async for chunk in resp.content.iter_any():
                if chunk:
                    if usage_box is not None:
                        collector.feed(chunk)
                        usage_box.update(collector.snapshot())
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

    async def _handle_models(self, request: web.Request) -> web.StreamResponse:
        """下游的 GET /v1/models。

        语义要跟真实请求一致：这次会走哪条上游，就给哪条上游的模型清单。
        （各上游清单可能不同，给并集反而会让下游选到别的通道才有的模型。）
        """
        skey = make_session_key(
            self.settings.protocol,
            dict(request.headers),
            self.client_key_id(request),
            request.headers.get("authorization", ""),
        )
        upstreams = self.storage.list_upstreams()
        plan = self.selector.plan(upstreams, skey)
        client = await self.ensure_client()
        while True:
            upstream = plan.next_upstream()
            if upstream is None:
                break
            for path in ("/v1/models", "/models"):
                try:
                    resp = await client.get(
                        upstream.base_url.rstrip("/") + path,
                        headers={
                            "authorization": f"Bearer {upstream.api_key}",
                            "accept": "application/json",
                        },
                    )
                    body = await resp.read()
                    await resp.release()
                except Exception as exc:  # noqa: BLE001
                    # 读操作失败只记日志，不计入通道健康度（上游可能只是没这个端点）
                    self.log(
                        "warn",
                        "models",
                        f"下游 /v1/models ｜ {self._up_label(upstream.id, upstream.name)} ｜ {path} 失败 ｜ {str(exc)[:120]}",
                    )
                    continue
                if 200 <= resp.status < 300:
                    self.metrics.upstream_end(upstream.id, 0.0, ok=True)
                    self.health.record_success(upstream.id)
                    self.log(
                        "info",
                        "models",
                        f"下游 /v1/models ｜ {self._up_label(upstream.id, upstream.name)} ｜ 转发成功 ｜ {path}",
                    )
                    return web.Response(
                        body=body,
                        status=200,
                        content_type="application/json",
                        headers={"Cache-Control": "no-cache"},
                    )
                self.log(
                    "warn",
                    "models",
                    f"下游 /v1/models ｜ {self._up_label(upstream.id, upstream.name)} ｜ {path} HTTP {resp.status}",
                )
            # 这条上游不支持清单端点：本次请求跳过它，但不计入健康度
            plan.mark_failed(upstream.id)

        # 兜底：网关本地缓存的模型清单（用户手动拉取时记下的）
        known: list[str] = []
        try:
            known = self.storage.known_models()
        except Exception:
            known = []
        if known:
            self.log("info", "models", f"下游 /v1/models ｜ 本地缓存兜底 ｜ {len(known)} 个")
            return web.json_response(
                {
                    "object": "list",
                    "data": [{"id": m, "object": "model"} for m in known],
                }
            )
        return web.json_response(
            {
                "error": {
                    "type": "upstream_error",
                    "message": "no upstream can serve /v1/models",
                    "code": "models_unavailable",
                }
            },
            status=502,
        )

    def _up_label(self, upstream_id: str, fallback: str = "") -> str:
        """「槽位 通道名」，取不到就退回原名。"""
        try:
            ups = self.storage.list_upstreams()
        except Exception:
            ups = []
        return upstream_label(ups, upstream_id) or fallback

    async def manual_probe(self, upstream, model: str = "gpt-4o-mini") -> dict:
        """手动探测：发一个最小请求。可能计费，UI 需明示。"""
        client = await self.ensure_client()
        model = (model or upstream.model or "").strip()
        if not model:
            return {
                "ok": False,
                "status": None,
                "ms": 0,
                "body": "先从上游拉取模型列表并选择一个模型，再探测",
            }
        payload = _probe_payload(self.settings.protocol, model)
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

    async def list_models(self, upstream) -> dict:
        """从上游拉模型清单。只读、不计费。

        路径容错：先试标准的 /v1/models，再试 /models
        （部分中转把清单挂在后者）。任一路径 2xx 即停。
        """
        client = await self.ensure_client()
        started = time.monotonic()
        last: dict = {
            "ok": False,
            "status": None,
            "ms": 0,
            "models": [],
            "body": "",
            "path": None,
        }
        for path in ("/v1/models", "/models"):
            url = upstream.base_url.rstrip("/") + path
            try:
                resp = await client.get(
                    url,
                    headers={
                        "authorization": f"Bearer {upstream.api_key}",
                        "accept": "application/json",
                    },
                )
                body = await resp.text()
            except Exception as exc:  # noqa: BLE001
                last = {
                    "ok": False,
                    "status": None,
                    "ms": int((time.monotonic() - started) * 1000),
                    "models": [],
                    "body": str(exc)[:400],
                    "path": path,
                }
                continue
            ms = int((time.monotonic() - started) * 1000)
            if resp.status >= 400:
                last = {
                    "ok": False,
                    "status": resp.status,
                    "ms": ms,
                    "models": [],
                    "body": body[:400],
                    "path": path,
                }
                continue
            models = _parse_models(body)
            return {
                "ok": True,
                "status": resp.status,
                "ms": ms,
                "models": models,
                "body": body[:200] if not models else "",
                "path": path,
            }
        last["ms"] = int((time.monotonic() - started) * 1000)
        return last

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
