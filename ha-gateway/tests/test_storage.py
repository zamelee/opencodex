"""存储层单测：上游、key、路由、事件。"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ha_gateway.models import Settings, Upstream  # noqa: E402
from ha_gateway.storage import Storage  # noqa: E402


def test_upstream_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        with Storage(os.path.join(d, "t.db")) as s:
            u = s.add_upstream(
                Upstream(
                    id="",
                    name="a",
                    provider="m.aiio.chat",
                    base_url="http://127.0.0.1:9",
                    api_key="sk-secret",
                )
            )
            got = s.list_upstreams()
            assert len(got) == 1
            assert got[0].id == u.id
            assert got[0].api_key == "sk-secret"


def test_client_key_hash():
    with tempfile.TemporaryDirectory() as d:
        with Storage(os.path.join(d, "t.db")) as s:
            raw = s.add_client_key("codex", "sk_own_abc").key
            h = hashlib.sha256(raw.encode()).hexdigest()
            assert h in s.client_key_hashes()


def test_settings_roundtrip():
    with tempfile.TemporaryDirectory() as d:
        with Storage(os.path.join(d, "t.db")) as s:
            cfg = Settings()
            cfg.listen_port = 10222
            s.save_settings(cfg)
            got = s.load_settings()
            assert got.listen_port == 10222
            assert got.protocol == "openai-responses"


def test_routes_and_migration():
    with tempfile.TemporaryDirectory() as d:
        with Storage(os.path.join(d, "t.db")) as s:
            s.set_session_route("k1", "u1")
            assert s.get_session_route("k1") == "u1"
            s.migrate_routes({"u2"})
            assert s.get_session_route("k1") is None


def test_loaded_settings_normalize_lock_vs_exclude():
    """历史脏数据：同一条既锁定又被排除，加载时以锁定为准自动归一。"""
    with tempfile.TemporaryDirectory() as d:
        with Storage(os.path.join(d, "t.db")) as s:
            cfg = Settings()
            cfg.forced_upstream_id = "u1"
            cfg.excluded_upstream_ids = ["u1", "u2"]
            s.save_settings(cfg)
            got = s.load_settings()
            assert got.forced_upstream_id == "u1"
            assert got.excluded_upstream_ids == ["u2"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
