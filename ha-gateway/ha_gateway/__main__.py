"""入口：python -m ha_gateway / 打包后的 exe。

产品形态是内嵌窗口 + 托盘常驻：
启动服务 -> 弹出内嵌管理页窗口（Edge WebView2），关窗口只隐藏到托盘，
网关继续跑；托盘菜单可以重新打开管理页或彻底退出。
"""

from __future__ import annotations

import os
import time
import tkinter as tk
from tkinter import messagebox

from .app import HaApp
from .branding import APP_NAME, APP_TAGLINE
from .desktop import (
    create_window,
    hide_window,
    open_external,
    show_window,
    start_webview,
    webview_available,
)
from .singleton import acquire, release
from .tray import Tray


def _web_url(app: HaApp) -> str:
    host = app.settings.web_host or "127.0.0.1"
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    return f"http://{host}:{app.settings.web_port}"


def main() -> int:
    if not acquire():
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo(
            APP_NAME, f"{APP_NAME} 已经在运行了。\n请到系统托盘里查看。"
        )
        root.destroy()
        return 0

    app = HaApp()
    app.start()
    url = _web_url(app)

    def show() -> None:
        if not show_window():
            open_external(url)

    def quit_all() -> None:
        release()
        app.stop()
        # pystray 回调在自己的线程里，sys.exit 不安全，直接退进程
        os._exit(0)

    tray = Tray(app, show, quit_all)
    try:
        tray.start()
    except Exception:
        pass

    print(f"{APP_NAME} · {APP_TAGLINE} 已启动：{url}", flush=True)

    no_browser = os.environ.get("HA_GATEWAY_NO_BROWSER") == "1"
    if not no_browser:
        if webview_available():
            win = create_window(url)
            if win is not None:
                def _on_closing():
                    # 关窗口只隐藏到托盘，网关继续跑
                    hide_window()
                    return False

                win.events.closing += _on_closing
                start_webview()
        else:
            # 没装 WebView2 运行时，只能退回系统浏览器
            open_external(url)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
