"""内嵌窗口：用 Edge WebView2 承载管理页，不外开浏览器。

pywebview 不可用时（缺依赖 / 缺 WebView2 Runtime）降级为系统浏览器。
"""

from __future__ import annotations

import sys
import webbrowser
import traceback

from .branding import APP_NAME

_WIN = None


def _log_exc(tag: str) -> None:
    """把异常写到同目录 ha-desktop.log，方便排查打包后的装载问题。"""
    try:
        import os
        import tempfile

        path = os.path.join(tempfile.gettempdir(), "ha-desktop.log")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"--- {tag}\n{traceback.format_exc()}\n")
    except Exception:
        pass


def webview_available() -> bool:
    try:
        import webview  # noqa: F401
    except Exception:
        _log_exc("import webview")
        return False
    return True


def create_window(url: str, width: int = 1440, height: int = 920):
    """在内嵌窗口里打开管理页。必须在主线程调用（WebView2 需要 STA）。"""
    global _WIN
    try:
        import webview
    except Exception:
        _log_exc("import webview")
        return None
    try:
        _WIN = webview.create_window(
            APP_NAME,
            url,
            width=width,
            height=height,
            min_size=(1024, 680),
            text_select=True,
        )
    except Exception:
        _log_exc("create_window")
        _WIN = None
    return _WIN


def start_webview() -> None:
    """跑 WebView2 事件循环（阻塞，直到所有窗口关闭）。"""
    try:
        import webview

        webview.start()
    except Exception:
        _log_exc("webview.start")


def show_window() -> bool:
    """把已隐藏的内嵌窗口重新拉出来。"""
    if _WIN is None:
        return False
    try:
        _WIN.show()
        return True
    except Exception:
        return False


def hide_window() -> None:
    if _WIN is None:
        return
    try:
        _WIN.hide()
    except Exception:
        pass


def open_external(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:
        pass


def is_windows() -> bool:
    return sys.platform == "win32"
