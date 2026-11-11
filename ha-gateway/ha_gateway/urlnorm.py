"""Base URL 归一化：按协议纠正用户填的地址。

网关转发时会在 Base URL 之后**再拼**协议路径（/v1/responses 等），
所以 Base URL 必须只到端口。用户经常顺手把完整路径也填进来，
这里在保存时自动纠正，而不是等到 404 才发现。
"""

from __future__ import annotations

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


def normalize_base_url(raw: str, protocol: str) -> tuple[str, str]:
    """返回 (纠正后的 Base URL, 备注)。备注为空表示原样可用。"""
    s = (raw or "").strip()
    if not s:
        return s, ""

    note = ""

    # 1) 没写 scheme 就补 http://
    if "://" not in s:
        s = "http://" + s
        note = "已补全协议头 http://"

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
        s = "http://" + s
    parts = urlsplit(s)
    if not parts.hostname:
        return ""
    if parts.port:
        return f"{parts.hostname}:{parts.port}"
    return parts.hostname
