"""上游凭据加密：Windows DPAPI（当前用户作用域），其它平台明文降级。"""

from __future__ import annotations

import base64
import ctypes
import os
import sys
from ctypes import wintypes

_MAGIC = "dpapi:"


def _is_windows() -> bool:
    return sys.platform == "win32"


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> tuple[_DATA_BLOB, ctypes.Array]:
    buf = ctypes.create_string_buffer(data, len(data))
    blob = _DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return blob, buf


def _protect(data: bytes) -> bytes:
    if not _is_windows():
        raise RuntimeError("DPAPI only available on Windows")
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    src, src_buf = _blob(data)
    out = _DATA_BLOB()
    ok = crypt32.CryptProtectData(
        ctypes.byref(src),
        None,
        None,
        None,
        None,
        0x01,  # CRYPTPROTECT_UI_FORBIDDEN
        ctypes.byref(out),
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)
        _ = src_buf


def _unprotect(data: bytes) -> bytes:
    if not _is_windows():
        raise RuntimeError("DPAPI only available on Windows")
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    src, src_buf = _blob(data)
    out = _DATA_BLOB()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(src), None, None, None, None, 0x01, ctypes.byref(out)
    )
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel32.LocalFree(out.pbData)
        _ = src_buf


def encrypt(plain: str) -> str:
    """把明文凭据加密成可落库字符串。非 Windows 返回 base64 明文。"""
    raw = plain.encode("utf-8")
    if _is_windows():
        return _MAGIC + base64.b64encode(_protect(raw)).decode("ascii")
    return "plain:" + base64.b64encode(raw).decode("ascii")


def decrypt(blob: str) -> str:
    """解密落库字符串。非 Windows 明文降级时直接还原。"""
    if blob.startswith(_MAGIC):
        return _unprotect(base64.b64decode(blob[len(_MAGIC):])).decode("utf-8")
    if blob.startswith("plain:"):
        return base64.b64decode(blob[len("plain:"):]).decode("utf-8")
    # 兼容历史上未加密的值
    return blob


def secure_store_available() -> bool:
    return _is_windows()


def data_dir() -> str:
    """用户数据目录（跨平台）。"""
    if _is_windows():
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    path = os.path.join(base, "ha-gateway")
    os.makedirs(path, exist_ok=True)
    return path
