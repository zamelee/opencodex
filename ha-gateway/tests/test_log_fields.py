"""日志对账字段：request_id / resp_id / model 的提取，以及槽位标签去重。"""

from ha_gateway.labels import upstream_label
from ha_gateway.server import (
    _extract_model,
    _extract_request_id,
    _extract_response_id,
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
