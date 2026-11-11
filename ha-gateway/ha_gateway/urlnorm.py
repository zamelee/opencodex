"""Base URL 归一化：按协议纠正用户填的地址。

网关转发时会在 Base URL 之后**再拼**协议路径（/v1/responses 等），
所以 Base URL 必须只到端口。用户经常顺手把完整路径也填进来，
这里在保存时自动纠正，而不是等到 404 才发现。
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit, urlunsplit

# 各协议下会被网关自己拼接的路径后缀
PROTOCOL_SUFFIXES: dict[str, tuple[str, ...]] = {
    "openai-responses": (
        "/v1/responses",
        "/responses",
        "/v1/responses/compact",
    ),
    "openai-chat": (
        "/v1/chat/completions",
        "/chat/completions",
    ),
    "anthropic": (
        "/v1/messages",
        "/messages",
        "/v1/messages/count_tokens",
        "/v1/messages/batches",
    ),
}


LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}


def default_scheme(host: str) -> str:
    """没写协议头时的默认：本机回环走 http，公网域名走 https。"""
    h = (host or "").strip().lower()
    if h.startswith("[") and "]" in h:  # [::1]:port
        h = h[1 : h.index("]")]
    h = h.split(":")[0]
    if not h or h in LOCAL_HOSTS:
        return "http"
    if h.endswith(".local") or h.endswith(".lan") or h.endswith(".home"):
        return "http"
    try:
        ipaddress.ip_address(h)
        return "http"  # 裸 IP（含内网）通常没有 TLS
    except ValueError:
        pass
    return "https"


def normalize_base_url(raw: str, protocol: str) -> tuple[str, str]:
    """返回 (纠正后的 Base URL, 备注)。备注为空表示原样可用。"""
    s = (raw or "").strip()
    if not s:
        return s, ""

    note = ""

    # 1) 没写 scheme 就补一个合适的默认（本地 http，公网 https）
    if "://" not in s:
        host = s.split("/")[0]
        sch = default_scheme(host)
        s = f"{sch}://{s}"
        note = f"已补全协议头 {sch}://"

    parts = urlsplit(s)
    if not parts.hostname:
        return s, note

    path = parts.path.rstrip("/")
    lowered = path.lower()

    # 2) 按协议剥掉被网关重复拼接的路径
    for suf in PROTOCOL_SUFFIXES.get(protocol, ()):
        if lowered.endswith(suf.lower()):
            path = path[: -len(suf)]
            note = (note + " " if note else "") + f"已按 {protocol} 去掉路径 {suf}"
            break

    # 3) 其它协议不认识，但路径里明显是 LLM 接口的一并剥到根
    if path and not note:
        for suf in ("/v1/responses", "/v1/chat/completions", "/v1/messages"):
            if lowered.endswith(suf):
                path = path[: -len(suf)]
                note = f"已去掉路径 {suf}"
                break

    host = parts.netloc
    out = urlunsplit((parts.scheme, host, path, "", ""))
    return out.rstrip("/"), note


def provider_from_base_url(base_url: str) -> str:
    """Base URL 的域名+端口（无端口则只给域名），用作 Provider 缺省值。"""
    s = (base_url or "").strip()
    if not s:
        return ""
    if "://" not in s:
        s = f"{default_scheme(s.split('/')[0])}://{s}"
    parts = urlsplit(s)
    if not parts.hostname:
        return ""
    if parts.port:
        return f"{parts.hostname}:{parts.port}"
    return parts.hostname
