"""单实例锁：同一台机器只允许一个 HA Gateway 在跑。"""

from __future__ import annotations

import os
import sys

_handle = None
_lock_file = None


def _lock_path() -> str:
    from . import crypto

    return os.path.join(crypto.data_dir(), "instance.lock")


def acquire() -> bool:
    """拿到锁返回 True；已有实例在跑返回 False。"""
    global _handle, _lock_file
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        name = "Local\\HA-Gateway-Singleton"
        h = kernel32.CreateMutexW(None, True, name)
        if not h:
            return True  # 拿不到锁就别拦用户
        already = kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS
        if already:
            kernel32.CloseHandle(h)
            return False
        _handle = h
        return True

    import fcntl

    path = _lock_path()
    _lock_file = open(path, "a+")
    try:
        fcntl.flock(_lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        _lock_file.close()
        _lock_file = None
        return False
    return True


def release() -> None:
    global _handle, _lock_file
    if _handle:
        import ctypes

        ctypes.windll.kernel32.ReleaseMutex(_handle)
        ctypes.windll.kernel32.CloseHandle(_handle)
        _handle = None
    if _lock_file:
        try:
            import fcntl

            fcntl.flock(_lock_file.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass
        _lock_file.close()
        _lock_file = None
