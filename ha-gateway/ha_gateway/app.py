"""应用装配：存储 + 设置 + 健康 + 网关 + 事件循环。"""

from __future__ import annotations

import asyncio
import sys
import threading
import time
from collections import deque
from typing import Callable

from . import crypto
from .health import HealthMonitor
from .server import Gateway, build_app
from .session import SessionRouter
from .storage import Storage


class EventBus:
    """事件中心：内存环形缓冲 + 订阅回调。"""

    def __init__(self, capacity: int = 2000) -> None:
        self.capacity = capacity
        self._items: deque = deque(maxlen=capacity)
        self._subs: list[Callable[[dict], None]] = []
        self._lock = threading.Lock()

    def publish(self, level: str, kind: str, message: str, detail: str = "") -> dict:
        ev = {
            "ts": time.time(),
            "level": level,
            "kind": kind,
            "message": message,
            "detail": detail,
        }
        with self._lock:
            self._items.append(ev)
            subs = list(self._subs)
        for cb in subs:
            try:
                cb(ev)
            except Exception:
                pass
        return ev

    def subscribe(self, cb: Callable[[dict], None]) -> None:
        with self._lock:
            self._subs.append(cb)

    def recent(self, limit: int = 500) -> list[dict]:
        with self._lock:
            items = list(self._items)
        return items[-limit:]


class HaApp:
    def __init__(self, db_path: str | None = None) -> None:
        self.storage = Storage(db_path)
        self.settings = self.storage.load_settings()
        self.events = EventBus()
        self.health = HealthMonitor(self.settings, on_change=self._on_health_change)
        self.session_router = SessionRouter(self.storage, self.settings.sticky_ttl_s)
        self.gateway = Gateway(
            self.storage,
            self.settings,
            self.health,
            self.session_router,
            log=self._log,
            on_route=self._route_hit,
        )
        self._loop: asyncio.AbstractEventLoop | None = None
        self._runner: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._started = threading.Event()
        self._stop_event: asyncio.Event | None = None
        self._probe_stop: asyncio.Event | None = None
        self._probe_tasks: dict[str, asyncio.Task] = {}
        self._probe_supervisor: asyncio.Task | None = None

    # ---------- 日志 ----------

    def _log(self, level: str, kind: str, message: str) -> None:
        self.events.publish(level, kind, message)
        try:
            self.storage.add_event(level, kind, message)
        except Exception:
            pass

    def _route_hit(self, upstream_id: str) -> None:
        self.events.publish("info", "route_active", f"命中上游 {upstream_id}", upstream_id)

    def _on_health_change(self, state) -> None:
        self._log(
            "warn" if state.health.value == "down" else "info",
            "health",
            f"上游 {state.upstream_id} 状态 -> {state.health.value}"
            + (f" ({state.last_error})" if state.last_error else ""),
        )

    # ---------- 生命周期 ----------

    async def _serve(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stop_event = asyncio.Event()
        app = build_app(self.gateway)
        runner = web_runner(app, self.settings)
        self._runner = runner
        await runner.setup()
        from aiohttp import web

        site = web.TCPSite(
            runner,
            self.settings.listen_host,
            self.settings.listen_port,
            reuse_address=True,
        )
        await site.start()
        self._started.set()
        self._probe_stop = asyncio.Event()
        self._probe_tasks: dict[str, asyncio.Task] = {}
        self._probe_supervisor = asyncio.create_task(self._supervise_probes())
        self._log(
            "info",
            "listen",
            f"网关监听 {self.settings.listen_host}:{self.settings.listen_port} "
            f"协议 {self.settings.protocol}",
        )
        try:
            # 阻塞直到 stop() 触发
            await self._stop_event.wait()
        finally:
            self._probe_stop.set()
            for t in list(self._probe_tasks.values()):
                t.cancel()
            self._probe_tasks.clear()
            await self.gateway.close()

    async def _supervise_probes(self) -> None:
        """按上游列表启停主动探活任务。"""
        while True:
            try:
                await asyncio.sleep(5)
                ups = {u.id: u for u in self.storage.list_upstreams() if u.enabled}
                for uid, task in list(self._probe_tasks.items()):
                    if uid not in ups:
                        task.cancel()
                        self._probe_tasks.pop(uid, None)
                for uid, u in ups.items():
                    if uid not in self._probe_tasks:
                        self._probe_tasks[uid] = asyncio.create_task(
                            self.health.probe_loop(u, self.gateway.tcp_probe, self._probe_stop)
                        )
            except asyncio.CancelledError:
                return
            except Exception:
                continue

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run_loop, daemon=True, name="ha-gateway")
        self._thread.start()
        self._started.wait(timeout=10)

    def _run_loop(self) -> None:
        if sys.platform == "win32":
            # Windows 的 Proactor 事件循环在跨线程 socket 场景下不稳
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._serve())
        except Exception as exc:  # noqa: BLE001
            self._log("error", "serve", f"服务异常退出: {exc}")
        finally:
            try:
                loop.close()
            except Exception:
                pass

    def stop(self) -> None:
        if self._runner is not None and self._loop is not None:
            fut = asyncio.run_coroutine_threadsafe(self._runner.cleanup(), self._loop)
            try:
                fut.result(timeout=5)
            except Exception:
                pass
        if self._stop_event is not None and self._loop is not None:
            try:
                asyncio.run_coroutine_threadsafe(self._stop_event.set(), self._loop)
            except Exception:
                pass
        self._thread = None

    # ---------- 操作 ----------

    def reload_settings(self) -> None:
        self.settings = self.storage.load_settings()
        self.health.settings = self.settings
        self.session_router.ttl_s = self.settings.sticky_ttl_s

    def save_settings(self, s) -> None:
        self.storage.save_settings(s)
        self.settings = s
        self.health.settings = s
        self.session_router.ttl_s = s.sticky_ttl_s
        self._log("info", "settings", "设置已保存")

    def upstreams(self):
        return self.storage.list_upstreams()

    def new_client_key(self, label: str) -> str:
        import secrets

        raw = "sk_own_" + secrets.token_hex(8)
        self.storage.add_client_key(label, raw)
        self._log("info", "key", f"新增下游 key: {label}")
        return raw

    def probe_upstream(self, upstream_id: str, model: str = "gpt-4o-mini") -> dict:
        """手动探测单个上游（可能计费）。"""
        up = next((u for u in self.storage.list_upstreams() if u.id == upstream_id), None)
        if up is None:
            return {"ok": False, "status": None, "ms": 0, "body": "upstream not found"}
        loop = self.gateway._loop
        if loop is None:
            return {"ok": False, "status": None, "ms": 0, "body": "gateway not running"}
        fut = asyncio.run_coroutine_threadsafe(
            self.gateway.manual_probe(up, model), loop
        )
        try:
            res = fut.result(timeout=30)
        except Exception as exc:  # noqa: BLE001
            res = {"ok": False, "status": None, "ms": 0, "body": str(exc)}
        self._log(
            "info" if res.get("ok") else "warn",
            "probe",
            f"手动探测 {up.name}: HTTP {res.get('status')} {res.get('ms')}ms",
        )
        return res

    def data_dir(self) -> str:
        return crypto.data_dir()


def web_runner(app, settings):
    from aiohttp import web

    return web.AppRunner(app)
