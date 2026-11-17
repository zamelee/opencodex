"""opencodex 图形启动器：托盘常驻 + 内嵌控制台窗口。

它只是壳——每个动作都对应一次 `ocx-start.py` 的参数化调用，
业务逻辑仍然只在 CLI 里，UI 不重写一遍。
"""

__all__ = ["main"]


def main() -> int:
    from .main import main as _main

    return _main()
