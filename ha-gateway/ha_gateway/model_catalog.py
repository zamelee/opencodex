"""模型清单 + 「这条上游没有这个模型」的判定。

两件事，各管一头：

1. 名字归一与保守匹配（``model_matches``）。
   宁可多发一次请求，也别把能用的通道误排掉：只有"确实对不上"才算没有。

2. 从上游错误体里认出「模型不存在」这一族错误（``classify_model_error``）。
   不靠某个供应商的具体措辞，而是先看结构化的 code/type，再退回到强特征短语。
   跟 opencodex 那边的 ``upstream-error-normalize`` 是一套思路：
   认语义，不认死板的正则。
"""

from __future__ import annotations

import json

# 错误体里表示「模型不存在」的强特征。命中即判定，
# 所以只收语义明确的写法，不收 "model" 这种裸词。
_STRONG_PHRASES = (
    "model_not_found",
    "model not found",
    "model-not-found",
    "no such model",
    "unknown model",
    "invalid model",
    "model_invalid",
    "unsupported model",
    "model not supported",
    "not a valid model",
    "model not available",
    "model_unavailable",
    "cannot find model",
    "could not find model",
    "no model named",
    "model does not exist",
    "model doesn't exist",
    "model does not support",
    "model not found for",
    "no models named",
)

# 结构化字段里表示"否定"的词根
_NEGATIVE = (
    "not_found",
    "not found",
    "notfound",
    "unknown",
    "invalid",
    "unsupported",
    "not_available",
    "not available",
    "does not exist",
    "doesn't exist",
    "not exist",
    "unavailable",
    "no such",
)

_STRUCT_KEYS = ("code", "type", "message", "param", "error", "status", "reason")

_MAX_BODY = 64 * 1024


def normalize_model(name: str) -> str:
    """模型名归一：去空白、转小写、去掉供应商前缀（取最后一段）。"""
    if not name:
        return ""
    s = name.strip().lower()
    if "/" in s:
        s = s.rsplit("/", 1)[-1]
    return s.strip()


def model_matches(catalog: list[str], wanted: str) -> bool:
    """清单里是否包含 wanted 这个模型。

    偏宽松：宁可"以为有"（于是照发，跟现在的行为一样），
    也别"以为没有"（于是把能用的通道排掉）。
    """
    w = normalize_model(wanted)
    if not w:
        return False
    for c in catalog:
        cn = normalize_model(c)
        if not cn:
            continue
        if cn == w:
            return True
        # 供应商前缀差异（"anthropic/claude-x" vs "claude-x"）
        if cn.endswith("/" + w) or w.endswith("/" + cn):
            return True
    return False


def _collect_strings(obj, out: list[str], depth: int = 0) -> None:
    """在 JSON 树里收集可能带语义的字符串（限深、限量，别把大树拖进来）。"""
    if depth > 3 or len(out) > 40:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and k.lower() in _STRUCT_KEYS:
                out.append(v)
            else:
                _collect_strings(v, out, depth + 1)
    elif isinstance(obj, list):
        for v in obj[:8]:
            _collect_strings(v, out, depth + 1)


def _structured_reason(body: bytes) -> str:
    """结构化错误里的判定：code/type/message 里同时出现"模型"和否定词。"""
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except (ValueError, TypeError):
        return ""
    hits: list[str] = []
    _collect_strings(data, hits)
    for s in hits:
        low = s.lower()
        if "model" not in low:
            continue
        if any(n in low for n in _NEGATIVE):
            return s[:120]
    return ""


def classify_model_error(body: bytes, status: int) -> str:
    """判断这个错误是不是"上游没有这个模型"。

    返回可读的判定理由；不是这类错误就返回空串。
    只在 400 / 404 / 422 上认这类错误——5xx 是上游自己的毛病，
    跟模型存不存在没关系。
    """
    if status not in (400, 404, 422):
        return ""
    if not body:
        return ""
    reason = _structured_reason(body)
    if reason:
        return reason
    text = body[:_MAX_BODY].decode("utf-8", "replace").lower()
    for p in _STRONG_PHRASES:
        if p in text:
            return p
    return ""
