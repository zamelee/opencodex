"""拉模型列表 + 按所选模型探测。"""

import asyncio

from aiohttp import web

from ha_gateway.app import HaApp
from ha_gateway.models import Upstream


async def _fake_upstream():
    """一个只提供 /v1/models 和 /v1/responses 的假上游。"""
    seen = {"probe": None, "models": 0, "models_status": 200}

    async def models(request):
        seen["models"] += 1
        if seen["models_status"] != 200:
            return web.json_response({"error": "not found"}, status=seen["models_status"])
        return web.json_response(
            {"object": "list", "data": [{"id": "m-1"}, {"id": "m-2"}]}
        )

    async def responses(request):
        body = await request.json()
        seen["probe"] = body
        return web.json_response({"id": "resp_x", "usage": {}})

    app = web.Application()
    app["seen"] = seen
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/responses", responses)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    return runner, seen, port


def test_list_models_and_probe_with_selected_model(tmp_path):
    asyncio.run(_run(tmp_path))


async def _run(tmp_path):
    runner, seen, port = await _fake_upstream()
    try:
        app = HaApp(str(tmp_path / "m.db"))
        up = app.storage.add_upstream(
            Upstream(
                id="",
                name="假上游",
                provider="p",
                base_url=f"http://127.0.0.1:{port}",
                api_key="k",
                protocol="openai-responses",
            )
        )
        app.start()
        try:
            res = await app.list_models_async(up.id)
            assert res["ok"] is True
            assert res["models"] == ["m-1", "m-2"]
            assert seen["models"] == 1

            # 没选模型 -> 不该发请求
            res = await app.probe_upstream_async(up.id, "")
            assert res["ok"] is False
            assert "模型" in res["body"]
            assert seen["probe"] is None

            # 选了模型 -> 用该模型发请求，且请求体是 responses 格式
            res = await app.probe_upstream_async(up.id, "m-2")
            assert res["ok"] is True, res
            assert seen["probe"]["model"] == "m-2"
            assert "input" in seen["probe"]
        finally:
            app.stop()
    finally:
        await runner.cleanup()


def test_downstream_models_falls_back_to_cache(tmp_path):
    asyncio.run(_run_fallback(tmp_path))


def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _run_fallback(tmp_path):
    runner, seen, port = await _fake_upstream()
    try:
        app = HaApp(str(tmp_path / "m2.db"))
        up = app.storage.add_upstream(
            Upstream(
                id="",
                name="假上游",
                provider="p",
                base_url=f"http://127.0.0.1:{port}",
                api_key="k",
                protocol="openai-responses",
            )
        )
        app.storage.add_upstream_models(up.id, ["cached-model"])
        seen["models_status"] = 404
        # 用临时端口，别撞上正在跑的生产实例
        app.settings.listen_port = _free_port()
        app.settings.web_port = _free_port()
        app.storage.save_settings(app.settings)
        app.reload_settings()
        app.start()
        try:
            import aiohttp

            key = app.new_client_key("t")
            async with aiohttp.ClientSession() as sess:
                async with sess.get(
                    "http://127.0.0.1:%d/v1/models" % app.settings.listen_port,
                    headers={"Authorization": f"Bearer {key}"},
                ) as resp:
                    assert resp.status == 200
                    data = await resp.json()
            ids = [m["id"] for m in data["data"]]
            assert ids == ["cached-model"]
        finally:
            app.stop()
    finally:
        await runner.cleanup()
