"""托盘常驻：关窗口不杀网关。"""

from __future__ import annotations

import threading


def _icon_image(ok: bool = True, size: int = 64):
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = (30, 120, 60, 255) if ok else (179, 38, 30, 255)
    d.ellipse((4, 4, size - 4, size - 4), fill=color)
    d.text((size / 2 - 6, size / 2 - 8), "HA", fill=(255, 255, 255, 255))
    return img


class Tray:
    def __init__(self, app, on_show, on_quit) -> None:
        self.app = app
        self.on_show = on_show
        self.on_quit = on_quit
        self._thread: threading.Thread | None = None
        self._icon = None

    def start(self) -> None:
        import pystray

        menu = pystray.Menu(
            pystray.MenuItem("显示主界面", lambda: self.on_show()),
            pystray.MenuItem("退出", lambda: self.on_quit()),
        )
        self._icon = pystray.Icon(
            "ha-gateway", _icon_image(True), "HA Gateway", menu
        )
        self._thread = threading.Thread(target=self._icon.run, daemon=True, name="ha-tray")
        self._thread.start()

    def update(self, ok: bool) -> None:
        if self._icon is not None:
            try:
                self._icon.icon = _icon_image(ok)
            except Exception:
                pass

    def stop(self) -> None:
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception:
                pass
