"""按模型挑通道：模型不存在就换人 + 模型清单缓存。

覆盖三件事：
1. 上游说「没这个模型」时，换一条通道，并且**不**把它当坏通道。
2. 换过一次之后，同模型的后续请求**根本不发**给那条通道。
3. 模型清单只在后台刷新；下游问 /v1/models 时优先用缓存。
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile

import aiohttp
from aiohttp import web

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ha_gateway.app import HaApp  # noqa: E402
from ha_gateway.failover import UpstreamSelector  # noqa: E402
from ha_gateway.health import HealthMonitor  # noqa: E402
from ha_gateway.models import Health, Rule, Settings, Upstream  # noqa: E402
from ha_gateway.model_catalog import (  # noqa: E402
    classify_model_error,
    model_matches,
    normalize_model,
)


class FakeUpstream:
    """可控的假上游：能回模型清单，也能按需报「没这个模型」。"""

    def __init__(
        self,
        name: str,
        models: list[str] | None = None,
        model_error: bool = False,
        want_model: str = "gpt-x",
    ) -> None:
        self.name = name
        self.models = models if models is not None else []
        self.model_error = model_error
        self.want_model = want_model
        self.hits = 0
        self.models_hits = 0
        self.runner = None
        self.port = 0

    async def start(self) -> None:
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self._handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.port = self.runner.addresses[0][1]

    async def stop(self) -> None:
        if self.runner is not None:
            await self.runner.cleanup()

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        if request.path.rstrip("/").endswith("/models"):
            self.models_hits += 1
            if not self.models:
                return web.json_response({"error": "not found"}, status=404)
            return web.json_response(
                {"object": "list", "data": [{"id": m, "object": "model"} for m in self.models]}
            )
        self.hits += 1
        await request.read()
        if self.model_error:
            return web.json_response(
                {
                    "error": {
                        "message": f"The model `{self.want_model}` does not exist",
                        "type": "invalid_request_error",
                        "code": "model_not_found",
                    }
                },
                status=404,
            )
        return web.json_response({"id": "resp_x", "usage": {}})


async def _make_app(tmpdir: str, upstreams: list[FakeUpstream], port: int) -> HaApp:
    app = HaApp(os.path.join(tmpdir, "ha.db"))
    app.settings.listen_port = port
    app.settings.listen_host = "127.0.0.1"
    for i, fu in enumerate(upstreams):
        app.storage.add_upstream(
            Upstream(
                id=f"u{i}",
                name=fu.name,
                provider="fake",
                base_url=f"http://127.0.0.1:{fu.port}",
                api_key=f"key-{i}",
            )
        )
    app._test_key = app.new_client_key("codex")
    app._test_key2 = app.new_client_key("codex-2")
    return app


async def _post(
    app: HaApp,
    model: str = "gpt-x",
    key: str | None = None,
    path: str = "/v1/responses",
):
    h = {"authorization": f"Bearer {key or app._test_key}"}
    async with aiohttp.ClientSession() as sess:
        async with sess.post(
            f"http://127.0.0.1:{app.settings.listen_port}{path}",
            json={"model": model, "input": "hi"},
            headers=h,
        ) as resp:
            return resp.status, await resp.text()


async def _get_models(app: HaApp, key: str | None = None):
    h = {"authorization": f"Bearer {key or app._test_key}"}
    async with aiohttp.ClientSession() as sess:
        async with sess.get(
            f"http://127.0.0.1:{app.settings.listen_port}/v1/models", headers=h
        ) as resp:
            return resp.status, await resp.text()


# ---------- 纯函数 ----------


def test_normalize_model():
    assert normalize_model("  MiniMax-M3.1-Flash ") == "minimax-m3.1-flash"
    assert normalize_model("m.aiio.chat/MiniMax-M3.1-Flash") == "minimax-m3.1-flash"
    assert normalize_model("") == ""


def test_model_matches_is_conservative():
    assert model_matches(["MiniMax-M3.1-Flash"], "minimax-m3.1-flash")
    assert model_matches(["anthropic/claude-x"], "claude-x")
    assert model_matches(["gpt-4o", "gpt-4o-mini"], "gpt-4o")
    # 清单里没有 -> 认不出来（宁可多发一次，也别把能用的排掉）
    assert not model_matches(["gpt-4o"], "gpt-4o-mini")
    assert not model_matches([], "gpt-4o")


def test_classify_model_error():
    b = b'{"error":{"message":"The model `x` does not exist","code":"model_not_found"}}'
    assert classify_model_error(b, 404)
    assert classify_model_error(b, 400)
    # 5xx 与模型无关
    assert classify_model_error(b, 500) == ""
    # 普通的 4xx 不是模型问题
    assert classify_model_error(b'{"error":{"message":"bad request"}}', 400) == ""
    # 额度用尽也不是模型问题
    assert classify_model_error(b'{"error":{"code":"insufficient_quota"}}', 400) == ""
    # 裸措辞也能认
    assert classify_model_error(b"unknown model: gpt-x", 404)


def test_selector_absent_excludes_demoted_keeps():
    """证实没有 -> 排除；清单里没有 -> 只是排到最后。"""
    settings = Settings()
    health = HealthMonitor(settings)
    sel = UpstreamSelector(settings, health)
    ups = [
        Upstream(id="a", name="a", provider="p", base_url="u"),
        Upstream(id="b", name="b", provider="p", base_url="u"),
    ]
    plan = sel.plan(ups, None, absent_models={"a"}, demoted_models={"b"})
    ids = [u.id for u in plan.candidates]
    assert "a" not in ids
    assert ids[-1] == "b"

    # 全被排空 -> fail-open，退回完整名单
    plan = sel.plan(ups, None, absent_models={"a", "b"})
    assert {u.id for u in plan.candidates} == {"a", "b"}


# ---------- 端到端 ----------


def test_model_not_found_switches_upstream():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = FakeUpstream("bad", models=["gpt-4o"], model_error=True)
            good = FakeUpstream("good", models=["gpt-x"])
            for fu in (bad, good):
                await fu.start()
            app = await _make_app(d, [bad, good], 10921)
            app.start()
            try:
                status, body = await _post(app)
                assert status == 200, body
                assert good.hits == 1
                assert bad.hits == 1
                # 换过人了：坏通道被记为「没有这个模型」
                assert app.storage.is_model_absent("u0", "gpt-x")
                # 但它本身没坏，健康度不受影响
                assert app.health.health_of("u0") is Health.HEALTHY
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)

    asyncio.run(run())


def test_absent_upstream_is_not_contacted_again():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = FakeUpstream("bad", models=["gpt-4o"], model_error=True)
            good = FakeUpstream("good", models=["gpt-x"])
            for fu in (bad, good):
                await fu.start()
            app = await _make_app(d, [bad, good], 10922)
            app.start()
            try:
                status, _ = await _post(app)
                assert status == 200
                assert bad.hits == 1
                # 换个下游 key，绕开粘性会话，纯看「还发不发」
                status, _ = await _post(app, key=app._test_key2)
                assert status == 200
                assert bad.hits == 1, "已证实没有这个模型的通道不该再收到请求"
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)

    asyncio.run(run())


def test_all_absent_still_sends():
    """fail-open：所有通道都被标记没有这个模型时，照样发。"""

    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = FakeUpstream("bad", models=["gpt-4o"], model_error=True)
            await bad.start()
            app = await _make_app(d, [bad], 10923)
            app.storage.mark_model_absent("u0", "gpt-x", 900)
            app.start()
            try:
                status, _ = await _post(app)
                assert status in (200, 502)
                assert bad.hits == 1, "全被排空时不能无处可去"
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)

    asyncio.run(run())


def test_models_endpoint_uses_cache():
    """清单拉过一次之后，下游问 /v1/models 不该再去戳上游。"""

    async def run():
        with tempfile.TemporaryDirectory() as d:
            up = FakeUpstream("up", models=["gpt-4o", "gpt-x"])
            await up.start()
            app = await _make_app(d, [up], 10924)
            app.start()
            try:
                res = await app.list_models_async("u0")
                assert res["ok"] is True, res
                assert up.models_hits == 1
                status, body = await _get_models(app)
                assert status == 200, body
                assert up.models_hits == 1, "命中缓存就不该再拉"
                assert "gpt-4o" in body
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)

    asyncio.run(run())


def test_catalog_without_endpoint_is_negatively_cached():
    """上游没有 /v1/models 端点 -> 记负缓存，别反复戳。"""

    async def run():
        with tempfile.TemporaryDirectory() as d:
            up = FakeUpstream("up", models=[])
            await up.start()
            app = await _make_app(d, [up], 10925)
            app.start()
            try:
                res = await app.list_models_async("u0")
                assert res["ok"] is False
                cat = app.storage.get_catalog("u0")
                assert cat is not None and cat["ok"] is False
                # 负缓存的时效由后台刷新循环判定：age < missing_ttl 就不再去戳
                assert cat["age_s"] < app.settings.model_catalog_missing_ttl_s
                assert up.models_hits == 2  # 两条路径各试一次（/v1/models 与 /models）
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)

    asyncio.run(run())


def test_rule_model_not_found_enabled_by_default():
    assert Rule.MODEL_NOT_FOUND in Settings().rules
    assert Settings().rules[Rule.MODEL_NOT_FOUND] is True
