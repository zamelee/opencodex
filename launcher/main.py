"""启动器入口。

干三件事：
1. 抢单实例锁（同一台机器只允许一个启动器）；
2. 起本地 web 服务（内嵌窗口加载它）；
3. 起托盘图标，窗口关掉只是隐藏，进程留在托盘。
"""

from __future__ import annotations

import argparse
import os
import sys
import threading


def _acquire_singleton() -> bool:
    """Windows 上用命名互斥体，别的平台退回文件锁。"""
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(None, True, "Local\\OpenCodex-Launcher-Singleton")
        if not handle:
            return True
        if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            kernel32.CloseHandle(handle)
            return False
        globals()["_mutex_handle"] = handle
        return True

    import fcntl
    from pathlib import Path

    path = Path.home() / ".opencodex" / "launcher.instance.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return False
    globals()["_lock_file"] = fh
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="opencodex-launcher", description="opencodex 图形启动器（托盘 + 内嵌控制台）"
    )
    parser.add_argument("--root", help="opencodex 仓库根目录（默认自动探测）")
    parser.add_argument(
        "--tray-only", action="store_true", help="只驻留托盘，不开窗口"
    )
    parser.add_argument("--port", type=int, help="opencodex 服务端口（默认读配置）")
    ns = parser.parse_args(argv)

    if ns.root:
        os.environ["OCX_ROOT"] = ns.root

    if not _acquire_singleton():
        print("[launcher] 已经有一个启动器在跑了，本次退出。")
        return 0

    from .app import LauncherApp
    from .tray import Tray

    app = LauncherApp()
    if ns.port:
        app.settings["port"] = int(ns.port)

    web_port = app.start_server()
    if not web_port:
        print("[launcher] 本地 web 服务启动失败，退出。")
        return 1
    url = app.web_url()
    print(f"[launcher] 控制台: {url}")

    quit_event = threading.Event()
    state: dict = {"window": None, "tray": None}

    def show_window() -> None:
        win = state.get("window")
        if win is not None:
            try:
                win.show()
            except Exception:
                pass

    def do_quit() -> None:
        quit_event.set()
        tray = state.get("tray")
        if tray is not None:
            tray.stop()
        win = state.get("window")
        if win is not None:
            try:
                win.destroy()
            except Exception:
                pass

    tray = Tray(app, on_show_window=show_window, on_quit=do_quit)
    state["tray"] = tray

    if ns.tray_only:
        tray.start()
        try:
            while not quit_event.is_set():
                quit_event.wait(0.5)
        except KeyboardInterrupt:
            do_quit()
        return 0

    import webview

    win = webview.create_window(
        "opencodex",
        url,
        width=1040,
        height=700,
        min_size=(820, 560),
    )
    state["window"] = win

    def on_closing():
        # 返回 False = 阻止关闭，只隐藏到托盘
        try:
            win.hide()
        except Exception:
            pass
        return False

    win.events.closing += on_closing
    tray.start()
    webview.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
