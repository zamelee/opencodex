"""会话粘性：会话键推导 + 路由映射。"""

from __future__ import annotations

import hashlib
import json
import time

_TURN_META = "x-codex-turn-metadata"


def _meta_thread_id(raw: str) -> str | None:
    try:
        obj = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    for k in ("thread_id", "session_id", "turn_id"):
        v = obj.get(k)
        if isinstance(v, str) and v:
            return f"{k}:{v}"
    return None


def derive_session_material(headers: dict[str, str]) -> str | None:
    """按优先级推导会话标识材料。返回 None 表示无法推导。"""
    lower = {k.lower(): v for k, v in headers.items()}

    meta = lower.get(_TURN_META)
    if meta:
        tid = _meta_thread_id(meta)
        if tid:
            return tid

    for h in (
        "x-codex-parent-thread-id",
        "x-codex-turn-state",
        "x-codex-window-id",
        "x-codex-installation-id",
        "x-codex-routing-hint",
    ):
        v = lower.get(h)
        if v:
            return f"{h}:{v}"
    return None


def session_key(protocol: str, headers: dict[str, str], fallback: str = "") -> str:
    material = derive_session_material(headers) or f"key:{fallback}"
    return hashlib.sha256(f"{protocol}|{material}".encode("utf-8")).hexdigest()


class SessionRouter:
    """会话 -> 上游 的粘性映射，带 TTL 与失效清理。"""

    def __init__(self, storage, ttl_s: float = 24 * 3600) -> None:
        self.storage = storage
        self.ttl_s = ttl_s

    def lookup(self, key: str, alive: set[str]) -> str | None:
        up = self.storage.get_session_route(key)
        if not up:
            return None
        if up not in alive:
            self.storage.drop_session_route(key)
            return None
        return up

    def bind(self, key: str, upstream_id: str) -> None:
        self.storage.set_session_route(key, upstream_id)

    def bind_response(self, response_id: str, upstream_id: str) -> None:
        if response_id:
            self.storage.set_response_route(response_id, upstream_id)

    def response_upstream(self, response_id: str, alive: set[str]) -> str | None:
        up = self.storage.get_response_route(response_id)
        if up and up in alive:
            return up
        return None

    def sweep(self) -> int:
        """清理超 TTL 的会话绑定，返回清理条数。"""
        cutoff = time.time() - self.ttl_s
        conn = self.storage._conn
        with self.storage._lock:
            cur = conn.execute(
                "DELETE FROM session_routes WHERE updated_at < ?", (cutoff,)
            )
            n = cur.rowcount or 0
            self.storage._conn.commit()
        return n
