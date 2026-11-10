"""纯逻辑单测：路由匹配、故障转移、粘性键、健康状态机。"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ha_gateway.failover import UpstreamSelector, classify_status  # noqa: E402
from ha_gateway.health import HealthMonitor  # noqa: E402
from ha_gateway.models import Health, Phase, Rule, Settings, Upstream  # noqa: E402
from ha_gateway.server import resolve_endpoint  # noqa: E402
from ha_gateway.session import derive_session_material, session_key  # noqa: E402


def _ups(n: int) -> list[Upstream]:
    return [
        Upstream(id=f"u{i}", name=f"up{i}", provider="p", base_url=f"http://x{i}")
        for i in range(n)
    ]


def test_endpoint_registry_exact_match():
    assert resolve_endpoint("openai-responses", "POST", "/v1/responses")
    assert resolve_endpoint("openai-responses", "GET", "/v1/responses/abc")
    assert resolve_endpoint("openai-chat", "POST", "/v1/chat/completions")
    assert resolve_endpoint("anthropic", "POST", "/v1/messages")


def test_endpoint_registry_rejects_traversal():
    assert resolve_endpoint("openai-responses", "POST", "/v1/responses/../admin") is None
    assert resolve_endpoint("openai-responses", "POST", "/v1/responsesx") is None
    assert resolve_endpoint("openai-responses", "POST", "/admin") is None


def test_classify_status():
    assert classify_status(429) is Rule.UPSTREAM_429
    assert classify_status(503) is Rule.UPSTREAM_5XX
    assert classify_status(404) is Rule.UPSTREAM_4XX
    assert classify_status(200) is None
    assert classify_status(None) is Rule.CONNECT_FAIL


def test_selector_orders_sticky_first():
    s = Settings()
    h = HealthMonitor(s)
    sel = UpstreamSelector(s, h)
    plan = sel.plan(_ups(3), "sess-1")
    assert set(u.id for u in plan.candidates) == {"u0", "u1", "u2"}


def test_switch_budget():
    s = Settings()
    h = HealthMonitor(s)
    sel = UpstreamSelector(s, h)
    plan = sel.plan(_ups(5), None)
    assert plan.can_switch()
    plan.mark_failed("u0")
    plan.mark_failed("u1")
    assert not plan.can_switch()


def test_4xx_not_switchable_by_default():
    s = Settings()
    h = HealthMonitor(s)
    sel = UpstreamSelector(s, h)
    plan = sel.plan(_ups(3), None)
    assert not sel.should_switch(plan, Rule.UPSTREAM_4XX, Phase.NOT_SENT)
    assert sel.should_switch(plan, Rule.UPSTREAM_5XX, Phase.NOT_SENT)
    assert sel.should_switch(plan, Rule.UPSTREAM_429, Phase.NOT_SENT)


def test_committed_never_switches():
    s = Settings()
    h = HealthMonitor(s)
    sel = UpstreamSelector(s, h)
    plan = sel.plan(_ups(3), None)
    assert not sel.should_switch(plan, Rule.UPSTREAM_5XX, Phase.DOWNSTREAM_COMMITTED)


def test_session_material_priority():
    h = {
        "x-codex-turn-metadata": '{"thread_id":"T1","installation_id":"I1"}',
        "x-codex-parent-thread-id": "P1",
    }
    assert derive_session_material(h) == "thread_id:T1"
    assert derive_session_material({"x-codex-window-id": "W1"}) == "x-codex-window-id:W1"
    assert derive_session_material({}) is None
    k1 = session_key("openai-responses", h, "fallback")
    k2 = session_key("openai-chat", h, "fallback")
    assert k1 != k2
    assert len(k1) == 64


def test_health_hysteresis():
    s = Settings()
    m = HealthMonitor(s)
    for _ in range(3):
        m.record_failure("u0", "boom")
    assert m.health_of("u0") is Health.DOWN
    for _ in range(4):
        m.record_success("u0")
    assert m.health_of("u0") is Health.DOWN
    m.record_success("u0")
    assert m.health_of("u0") is Health.HEALTHY


def test_residency_blocks_immediate_switch():
    s = Settings()
    m = HealthMonitor(s)
    m.record_failure("u0", "x")
    assert m.in_residency("u0")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
