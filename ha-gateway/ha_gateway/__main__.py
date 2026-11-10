"""入口：python -m ha_gateway"""

from __future__ import annotations

import sys
import tkinter as tk

from .app import HaApp
from .tray import Tray
from .ui import MainWindow


def main() -> int:
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
        app.stop()
        try:
            win.destroy()
        except tk.TclError:
            pass
        sys.exit(0)

    tray = Tray(app, show, quit_all)
    try:
        tray.start()
    except Exception:
        pass

    win.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
