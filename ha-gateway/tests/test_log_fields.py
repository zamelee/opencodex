"""日志对账字段：request_id / resp_id / model 的提取，以及槽位标签去重。"""

from ha_gateway.labels import upstream_label
from ha_gateway.server import (
    _extract_usage,
    _extract_model,
    _extract_request_id,
    _extract_response_id,
    _merge_usage,
    UsageCollector,
)


class U:
    def __init__(self, uid, name):
        self.id = uid
        self.name = name


def test_extract_request_id_json():
    body = b'{"error":{"message":"boom","request_id":"80187d21abc"}}'
    assert _extract_request_id(body) == "80187d21abc"


def test_extract_request_id_camel():
    body = b'{"error":{"message":"boom","requestId":"req-9988"}}'
    assert _extract_request_id(body) == "req-9988"


def test_extract_request_id_text():
    body = b"something went wrong (request id: 202611101155375552668738268d9d6d)"
    assert _extract_request_id(body) == "202611101155375552668738268d9d6d"


def test_extract_request_id_absent():
    assert _extract_request_id(b'{"error":{"message":"boom"}}') == ""
    assert _extract_request_id(b"") == ""


def test_extract_response_id():
    assert _extract_response_id(b'{"id":"resp_abc123"}') == "resp_abc123"
    assert _extract_response_id(b'{"id":"chatcmpl-abc"}') == ""
    assert _extract_response_id(b"") == ""


def test_extract_model():
    assert _extract_model(b'{"model":"claude-opus-5","input":"hi"}') == "claude-opus-5"
    assert _extract_model(b"not json") == ""
    assert _extract_model(b'{"messages":[]}') == ""


def test_label_dedupes_slot_prefix():
    ups = [U("a", "模拟通道 A"), U("b", "通道 5")]
    assert upstream_label(ups, "a") == "主通道 模拟通道 A"
    # 通道名本身就带槽位说法时，不再叠一层
    assert upstream_label(ups, "b") == "通道 5"


def test_label_falls_back_to_id():
    ups = [U("a", "模拟通道 A")]
    assert upstream_label(ups, "zzz") == "zzz"


def test_extract_usage_responses_style():
    chunk = b'{"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":5,"total_tokens":16}}}'
    u = _extract_usage(chunk)
    assert u == {"in": 11, "out": 5, "total": 16}


def test_extract_usage_chat_style():
    chunk = b'{"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150}}'
    u = _extract_usage(chunk)
    assert u == {"in": 120, "out": 30, "total": 150}


def test_extract_usage_absent():
    assert _extract_usage(b'{"id":"resp_x"}') is None
    assert _extract_usage(b"") is None


def test_merge_usage_keeps_partial_fields():
    acc = _merge_usage({}, {"in": 10, "out": 2})
    acc = _merge_usage(acc, {"out": 7})
    assert acc == {"in": 10, "out": 7}


def test_usage_collector_across_chunk_boundary():
    """SSE 分块把 "usage" 切成两半时也要抓得到。"""
    c = UsageCollector()
    c.feed(b'{"type":"response.completed","response":{"usage":{"input_to')
    c.feed(b'kens":1234,"output_tokens":56,"total_tokens":1290}}')
    assert c.snapshot() == {"in": 1234, "out": 56, "total": 1290}


def test_usage_collector_later_value_wins():
    c = UsageCollector()
    c.feed(b'{"usage":{"input_tokens":10,"output_tokens":1}}')
    c.feed(b'{"usage":{"output_tokens":9}}')
    assert c.snapshot() == {"in": 10, "out": 9}
