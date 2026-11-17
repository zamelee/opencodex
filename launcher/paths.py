"""定位 opencodex 仓库根，以及能跑起 ocx-start.py 的解释器。

启动器既可以从源码目录跑（`python launcher/main.py`），
也可以被 PyInstaller 打包成 exe 放在 `launcher/dist/` 里；
两种情况下仓库根的位置都不一样，所以这里挨个试。
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def _candidates() -> list[Path]:
    out: list[Path] = []
    env = os.environ.get("OCX_ROOT", "").strip()
    if env:
        out.append(Path(env))
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable).resolve()
        # 打包后通常在 <repo>/launcher/dist/xxx.exe，也可能被单独拷走
        out += [exe.parent.parent.parent, exe.parent.parent, exe.parent]
    here = Path(__file__).resolve()
    out += [here.parent.parent, here.parent]
    cwd = Path.cwd()
    out += [cwd, cwd / "opencodex"]
    return out


def repo_root() -> Path | None:
    """找到含 ocx-start.py 与 package.json 的那个目录。"""
    seen: set[str] = set()
    for c in _candidates():
        try:
            key = str(c)
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        try:
            if (c / "ocx-start.py").exists() and (c / "package.json").exists():
                return c
        except OSError:
            continue
    return None


def python_argv() -> list[str] | None:
    """能执行 ocx-start.py 的命令前缀；找不到就返回 None。"""
    if not getattr(sys, "frozen", False):
        return [sys.executable]
    for name, extra in (("py", ["-3"]), ("python", []), ("python3", [])):
        exe = shutil.which(name)
        if exe:
            return [exe] + extra
    return None


def config_dir() -> Path:
    """opencodex 的配置目录（跟 src/config.ts 的 resolveConfigDir 对齐）。"""
    env = os.environ.get("OPENCODEX_HOME", "").strip()
    if env:
        return Path(env)
    return Path.home() / ".opencodex"


def bun_exe() -> str | None:
    """找一个能用的 bun（降级路径用得上）。"""
    for name in ("bun", "bun.exe"):
        exe = shutil.which(name)
        if exe:
            return exe
    return None
