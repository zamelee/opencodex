"""会话键、防横跳上限、手动锁定通道。"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ha_gateway.session import session_key  # noqa: E402
from test_e2e import FakeUpstream, _call, _make_app  # noqa: E402


def test_session_key_separates_installation_and_client_key():
    h = {
        "x-codex-turn-metadata": json.dumps(
            {"thread_id": "T1", "installation_id": "I1"}
        )
    }
    k1 = session_key("openai-responses", h, "keyA")
    k2 = session_key("openai-responses", h, "keyB")
    k3 = session_key("openai-responses", h, "keyA", "fallback")
    assert k1 != k2, "不同下游 key 必须分开"
    assert k1 == k3, "有 thread_id 时 fallback 不参与"

    h2 = {"x-codex-turn-metadata": json.dumps({"thread_id": "T1", "installation_id": "I2"})}
    assert session_key("openai-responses", h2, "keyA") != k1, "不同安装实例必须分开"


def test_switch_budget_blocks_flip_flop():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            app = await _make_app(d, [], 10931)
            try:
                from ha_gateway.models import Upstream

                for i in range(2):
                    app.storage.add_upstream(
                        Upstream(
                            id=f"u{i}",
                            name=f"u{i}",
                            provider="fake",
                            base_url="http://127.0.0.1:1",
                            api_key="k",
                        )
                    )
                # 允许每个请求切 2 次，但一分钟内总共只准切 1 次
                app.settings.max_switches_per_request = 2
                app.settings.max_switches_per_minute = 1
                app.gateway.selector.settings = app.settings
                ups = app.storage.list_upstreams()
                plan = app.gateway.selector.plan(ups, "sess-1")
                from ha_gateway.models import Phase, Rule

                assert app.gateway.selector.should_switch(plan, Rule.UPSTREAM_5XX, Phase.NOT_SENT)
                app.gateway.selector.note_switch(plan)
                # 窗口内已经切过一次 -> 预算用完，不再允许切
                assert not app.gateway.selector.should_switch(
                    plan, Rule.UPSTREAM_5XX, Phase.NOT_SENT
                )
                # 另一个会话的预算独立
                plan2 = app.gateway.selector.plan(ups, "sess-2")
                assert app.gateway.selector.should_switch(plan2, Rule.UPSTREAM_5XX, Phase.NOT_SENT)
            finally:
                app.storage.close()

    asyncio.run(run())


def test_forced_upstream_is_preferred():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            a = FakeUpstream("a")
            b = FakeUpstream("b")
            for fu in (a, b):
                await fu.start()
            try:
                app = await _make_app(d, [a, b], 10932)
                app.settings.forced_upstream_id = "u0"
                app.gateway.selector.settings = app.settings
                app.start()
                try:
                    status, _ = await _call(app, "/v1/responses")
                    assert status == 200
                    assert a.hits == 1, "锁定通道应优先命中"
                    assert b.hits == 0
                finally:
                    app.stop()
                    app.storage.close()
                    await asyncio.sleep(0.2)
            finally:
                for fu in (a, b):
                    await fu.stop()

    asyncio.run(run())


def test_excluded_upstream_is_not_in_auto_candidates():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            a = FakeUpstream("a")
            b = FakeUpstream("b")
            for fu in (a, b):
                await fu.start()
            try:
                app = await _make_app(d, [a, b], 10933)
                # 排除第一条：自动路由不应再选它
                app.settings.excluded_upstream_ids = ["u0"]
                app.gateway.selector.settings = app.settings
                plan = app.gateway.selector.plan(app.upstreams(), "sess-x")
                assert all(c.id != "u0" for c in plan.candidates), "被排除的通道不应进入候选"
                assert any(c.id == "u1" for c in plan.candidates)
                # 但手动锁定可以覆盖排除
                app.settings.forced_upstream_id = "u0"
                plan2 = app.gateway.selector.plan(app.upstreams(), "sess-x")
                assert plan2.candidates[0].id == "u0", "手动锁定优先于排除"
            finally:
                app.storage.close()

    asyncio.run(run())
