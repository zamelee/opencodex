"""服务状态探测：端口 / PID / 版本。

数据来自 opencodex 自己写的运行期记录（~/.opencodex/runtime-port.json、
ocx.pid），再补一次 /healthz 确认它真的活着。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .paths import config_dir


def read_runtime_state() -> dict:
    """读 runtime-port.json（没有就空 dict）。"""
    path = config_dir() / "runtime-port.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def read_config() -> dict:
    path = config_dir() / "config.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def probe(port: int | None = None) -> dict:
    """探测服务状态。"""
    rt = read_runtime_state()
    cfg = read_config()
    p = port or rt.get("port") or cfg.get("port") or 10100
    out = {
        "running": False,
        "port": p,
        "pid": rt.get("pid"),
        "hostname": rt.get("hostname") or "127.0.0.1",
        "version": None,
        "uptime": None,
        "error": "",
    }
    try:
        url = f"http://127.0.0.1:{p}/healthz"
        with urllib.request.urlopen(url, timeout=2.0) as resp:
            body = resp.read().decode("utf-8", "replace")
        data = json.loads(body)
        if isinstance(data, dict):
            out["running"] = data.get("status") == "ok"
            out["pid"] = data.get("pid") or out["pid"]
            out["port"] = data.get("port") or p
            out["version"] = data.get("version")
            out["uptime"] = data.get("uptime")
    except urllib.error.URLError as exc:
        out["error"] = str(exc.reason) if hasattr(exc, "reason") else str(exc)
    except Exception as exc:  # noqa: BLE001
        out["error"] = str(exc)
    return out


def settings() -> dict:
    """启动器表单的默认值：优先读 opencodex 自己的配置。"""
    cfg = read_config()
    port = cfg.get("port") or 10100
    return {
        "port": int(port),
        "hostname": "127.0.0.1",
        "preset": cfg.get("preset") or "",
        "launcher_mode": (
            "true" if cfg.get("enableCodexLauncherMode") else "false"
            if cfg.get("enableCodexLauncherMode") is not None
            else ""
        ),
    }
