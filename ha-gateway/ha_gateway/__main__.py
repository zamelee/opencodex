"""入口：python -m ha_gateway"""

from __future__ import annotations

import sys
import tkinter as tk
from tkinter import messagebox

from .app import HaApp
from .singleton import acquire, release
from .tray import Tray
from .ui import MainWindow


def main() -> int:
    if not acquire():
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo(
            "HA Gateway", "HA Gateway 已经在运行了。\n请到系统托盘里查看。"
        )
        root.destroy()
        return 0

    app = HaApp()
    app.start()

    win = MainWindow(app)

    def show() -> None:
        try:
            win.deiconify()
            win.lift()
            win.focus_force()
        except tk.TclError:
            pass

    def quit_all() -> None:
        release()
        app.stop()
        try:
            win.destroy()
        except tk.TclError:
            pass
        sys.exit(0)

    tray = Tray(app, show, quit_all)
    try:
        tray.start()
        win.tray_available = True
    except Exception:
        win.tray_available = False

    win.mainloop()
    release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
