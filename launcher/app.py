"""启动器的本地 web 服务（只监听本机，端口随机）。

内嵌窗口加载的就是这个页面；顺带也能用浏览器打开，方便远程排查。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import webbrowser
from pathlib import Path

from aiohttp import web

from . import status as status_mod
from .actions import build_actions
from .paths import config_dir, repo_root
from .runner import Runner

WEB_DIR = Path(__file__).resolve().parent / "web"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "opencodex-launcher"


def autostart_command() -> str:
    """开机自启要登记的命令行。"""
    if getattr(sys, "frozen", False):
        return f'"{Path(sys.executable).resolve()}"'
    root = repo_root()
    main_py = Path(__file__).resolve().parent / "main.py"
    return f'"{sys.executable}" "{main_py}"' + (f' --root "{root}"' if root else "")


def autostart_enabled() -> bool:
    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            value, _ = winreg.QueryValueEx(k, RUN_NAME)
        return bool(value)
    except Exception:
        return False


def set_autostart(enable: bool) -> bool:
    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE
        ) as k:
            if enable:
                winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, autostart_command())
            else:
                try:
                    winreg.DeleteValue(k, RUN_NAME)
                except FileNotFoundError:
                    pass
        return True
    except Exception:
        return False


class LauncherApp:
    """托盘与窗口共用的状态中枢。"""

    def __init__(self) -> None:
        self.runner = Runner()
        self.settings = status_mod.settings()
        self._lock = threading.Lock()
        self._web_port = 0

    def snapshot(self) -> dict:
        cfg = dict(self.settings)
        st = status_mod.probe(cfg.get("port"))
        return {
            "status": st,
            "settings": cfg,
            "actions": build_actions(cfg),
            "jobs": self.runner.recent(),
            "autostart": autostart_enabled(),
            "repo_root": str(repo_root() or ""),
            "web_port": self._web_port,
        }

    # ---------- 给托盘用的便捷入口 ----------

    def autostart_enabled(self) -> bool:
        return autostart_enabled()

    def config_dir(self) -> Path:
        return config_dir()

    def update_settings(self, data: dict) -> None:
        with self._lock:
            for key in ("port", "hostname", "preset", "launcher_mode", "git_proxy"):
                if key not in data or data[key] is None:
                    continue
                val = str(data[key]).strip()
                if key == "port":
                    try:
                        val = int(val)
                    except ValueError:
                        continue
                self.settings[key] = val

    def run_action(self, action_id: str, params: dict | None = None) -> dict:
        if params:
            self.update_settings(params)
        actions = {a["id"]: a for a in build_actions(self.settings)}
        action = actions.get(action_id)
        if action is None:
            return {"ok": False, "error": f"未知动作: {action_id}"}
        if action.get("disabled"):
            return {"ok": False, "error": action.get("hint", "动作不可用")}

        builtin = action.get("builtin")
        if builtin:
            return self._run_builtin(builtin, action)

        argv = action.get("cli") or []
        if not argv:
            return {"ok": False, "error": "没有可用的执行命令"}
        job = self.runner.start(action["label"], argv, cwd=str(repo_root() or Path.cwd()))
        return {"ok": True, "job": job.snapshot()}

    def _run_builtin(self, builtin: str, action: dict) -> dict:
        if builtin == "open_dash":
            port = self.settings.get("port") or 10100
            url = f"http://127.0.0.1:{port}/"
            try:
                webbrowser.open(url)
            except Exception as exc:
                return {"ok": False, "error": str(exc)}
            return {"ok": True, "message": f"已打开 {url}"}
        if builtin == "open_config":
            d = config_dir()
            try:
                if os.name == "nt":
                    os.startfile(str(d))
                else:
                    webbrowser.open(d.as_uri())
            except Exception as exc:
                return {"ok": False, "error": str(exc)}
            return {"ok": True, "message": f"已打开 {d}"}
        if builtin == "autostart":
            want = not autostart_enabled()
            if not set_autostart(want):
                return {"ok": False, "error": "写注册表失败"}
            return {
                "ok": True,
                "message": "已设置开机自启" if want else "已取消开机自启",
            }
        return {"ok": False, "error": f"未实现的内置动作: {builtin}"}

    # ---------- web ----------

    def build_web_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/", self._index)
        app.router.add_get("/app.js", self._asset)
        app.router.add_get("/style.css", self._asset)
        app.router.add_get("/api/state", self._api_state)
        app.router.add_post("/api/action", self._api_action)
        app.router.add_get("/api/logs", self._api_logs)
        app.router.add_post("/api/cancel", self._api_cancel)
        app.router.add_post("/api/settings", self._api_settings)
        return app

    async def _index(self, request: web.Request) -> web.StreamResponse:
        path = WEB_DIR / "index.html"
        if not path.exists():
            return web.Response(text="launcher web 目录缺失", status=500)
        return web.Response(
            text=path.read_text(encoding="utf-8"),
            content_type="text/html",
            charset="utf-8",
        )

    async def _asset(self, request: web.Request) -> web.StreamResponse:
        name = request.path.rsplit("/", 1)[-1]
        if name not in ("app.js", "style.css"):
            return web.Response(text="not found", status=404)
        path = WEB_DIR / name
        if not path.exists():
            return web.Response(text="asset missing", status=500)
        ctype = "application/javascript" if name.endswith(".js") else "text/css"
        return web.Response(
            text=path.read_text(encoding="utf-8"), content_type=ctype, charset="utf-8"
        )

    async def _api_state(self, request: web.Request) -> web.StreamResponse:
        return web.json_response(self.snapshot())

    async def _api_action(self, request: web.Request) -> web.StreamResponse:
        try:
            data = await request.json()
        except Exception:
            data = {}
        res = self.run_action(str(data.get("id") or ""), data.get("params") or {})
        return web.json_response(res)

    async def _api_settings(self, request: web.Request) -> web.StreamResponse:
        try:
            data = await request.json()
        except Exception:
            data = {}
        self.update_settings(data)
        return web.json_response(self.snapshot())

    async def _api_logs(self, request: web.Request) -> web.StreamResponse:
        job_id = request.query.get("job") or ""
        since = int(request.query.get("since") or 0)
        job = self.runner.get(job_id) if job_id else self.runner.latest()
        if job is None:
            return web.json_response({"lines": [], "job": None})
        return web.json_response({"lines": job.tail(since), "job": job.snapshot()})

    async def _api_cancel(self, request: web.Request) -> web.StreamResponse:
        try:
            data = await request.json()
        except Exception:
            data = {}
        return web.json_response({"ok": self.runner.cancel(str(data.get("id") or ""))})

    # ---------- 生命周期 ----------

    def start_server(self) -> int:
        """在后台线程里起 web 服务，返回实际端口。"""
        holder: dict = {}

        async def _run() -> None:
            runner = web.AppRunner(self.build_web_app())
            await runner.setup()
            site = web.TCPSite(runner, "127.0.0.1", 0)
            await site.start()
            holder["port"] = runner.addresses[0][1]
            await asyncio.Event().wait()

        def _thread() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(_run())
            finally:
                try:
                    loop.close()
                except Exception:
                    pass

        t = threading.Thread(target=_thread, daemon=True, name="ocx-launcher-web")
        t.start()
        for _ in range(100):
            if "port" in holder:
                break
            threading.Event().wait(0.05)
        self._web_port = holder.get("port", 0)
        return self._web_port

    def web_url(self) -> str:
        return f"http://127.0.0.1:{self._web_port}/"
