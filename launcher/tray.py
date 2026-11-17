"""托盘：右下角常驻图标 + 右键菜单。

菜单项一一对应 CLI 的动作（见 actions.py），所以托盘能干的，
命令行也都能干，两边不会打架。
"""

from __future__ import annotations

import os
import threading


def _icon_image(state: str = "stopped", size: int = 64):
    """现画一个状态圆点：绿=运行中，灰=已停止，红=异常。"""
    from PIL import Image, ImageDraw

    colors = {
        "running": (30, 140, 70, 255),
        "stopped": (120, 124, 132, 255),
        "error": (190, 45, 40, 255),
    }
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, size - 4, size - 4), fill=colors.get(state, colors["stopped"]))
    d.ellipse(
        (size // 2 - 8, size // 2 - 8, size // 2 + 8, size // 2 + 8),
        fill=(255, 255, 255, 255),
    )
    return img


class Tray:
    """Windows 右下角常驻图标。

    菜单项与 actions.py 一一对应，所以托盘能干的命令行也都能干。
    """

    def __init__(self, app, on_show_window=None, on_quit=None) -> None:
        self.app = app
        self.on_show_window = on_show_window
        self.on_quit = on_quit
        self.icon = None
        self._state = "stopped"
        self._lock = threading.Lock()

    # ---------- 状态 ----------

    def _probe_state(self) -> str:
        try:
            st = self.app.snapshot()["status"]
        except Exception:
            return "stopped"
        if st.get("running"):
            return "running"
        return "stopped" if not st.get("error") else "error"

    def refresh(self) -> None:
        """刷新图标颜色和菜单文字（后台线程调用）。"""
        state = self._probe_state()
        with self._lock:
            self._state = state
        if self.icon is None:
            return
        try:
            self.icon.icon = _icon_image(state)
            self.icon.title = f"opencodex · {state}"
            self.icon.menu = self.build_menu()
            self.icon.update_menu()
        except Exception:
            pass

    def _status_text(self, _item=None) -> str:
        try:
            st = self.app.snapshot()["status"]
        except Exception:
            return "状态未知"
        if st.get("running"):
            return f"运行中 · 端口 {st.get('port')}"
        if st.get("error"):
            return "服务未运行（探测异常）"
        return "已停止"

    # ---------- 动作 ----------

    def _run(self, action_id: str) -> None:
        try:
            self.app.run_action(action_id)
        except Exception:
            pass
        threading.Timer(0.8, self.refresh).start()

    def _open_path(self, path: str) -> None:
        try:
            if os.name == "nt":
                os.startfile(path)
            else:
                import webbrowser

                webbrowser.open(path)
        except Exception:
            pass

    def build_menu(self):
        import pystray

        auto = self.app.autostart_enabled()
        return pystray.Menu(
            pystray.MenuItem(
                self._status_text,
                lambda _item: None,
                enabled=False,
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("启动服务", lambda _i, _s=self: self._run("start")),
            pystray.MenuItem("停止服务", lambda _i, _s=self: self._run("stop")),
            pystray.MenuItem("重启服务", lambda _i, _s=self: self._run("restart")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("打开仪表盘", lambda _i, _s=self: self._run("open_dash")),
            pystray.MenuItem(
                "打开控制台窗口",
                lambda _i, _s=self: self.on_show_window() if self.on_show_window else None,
            ),
            pystray.MenuItem(
                "打开配置目录",
                lambda _i, _s=self: self._open_path(str(self.app.config_dir())),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "开机自启",
                lambda _i, _s=self: self._run("autostart"),
                checked=lambda _i: auto,
            ),
            pystray.MenuItem(
                "升级",
                pystray.Menu(
                    pystray.MenuItem("最新 tag", lambda _i, _s=self: self._run("upgrade_tag")),
                    pystray.MenuItem("origin/main", lambda _i, _s=self: self._run("upgrade_main")),
                ),
            ),
            pystray.MenuItem("清理 dist", lambda _i, _s=self: self._run("clean")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "退出", lambda _i, _s=self: self.on_quit() if self.on_quit else None
            ),
        )

    def start(self) -> None:
        import pystray

        self.icon = pystray.Icon(
            "opencodex",
            icon=_icon_image(self._probe_state()),
            title="opencodex",
            menu=self.build_menu(),
        )
        threading.Thread(target=self.icon.run, daemon=True, name="ocx-tray").start()
        self._poll()

    def _poll(self) -> None:
        def _loop() -> None:
            while True:
                threading.Event().wait(5.0)
                self.refresh()

        threading.Thread(target=_loop, daemon=True, name="ocx-tray-poll").start()

    def stop(self) -> None:
        if self.icon is not None:
            try:
                self.icon.stop()
            except Exception:
                pass
