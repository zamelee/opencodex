"""模型清单路径容错：上游只提供 /models 时也应能拉到。"""

import asyncio

from aiohttp import web

from ha_gateway.app import HaApp
from ha_gateway.models import Upstream


async def _upstream_only_models():
    """只提供 /models（没有 /v1/models），并接受 /v1/responses 探测。"""
    seen = {"models": 0, "v1models": 0, "probe": None}

    async def models(request):
        seen["models"] += 1
        return web.json_response({"data": [{"id": "only-models-path"}]})

    async def v1models(request):
        seen["v1models"] += 1
        return web.json_response({"error": "not found"}, status=404)

    async def responses(request):
        seen["probe"] = await request.json()
        return web.json_response({"id": "resp_x", "usage": {}})

    app = web.Application()
    app["seen"] = seen
    app.router.add_get("/models", models)
    app.router.add_get("/v1/models", v1models)
    app.router.add_post("/v1/responses", responses)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    return runner, seen, runner.addresses[0][1]


def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_list_models_falls_back_to_models_path(tmp_path):
    asyncio.run(_run(tmp_path))


async def _run(tmp_path):
    runner, seen, port = await _upstream_only_models()
    try:
        app = HaApp(str(tmp_path / "mp.db"))
        up = app.storage.add_upstream(
            Upstream(
                id="",
                name="仅有models路径",
                provider="p",
                base_url=f"http://127.0.0.1:{port}",
                api_key="k",
                protocol="openai-responses",
            )
        )
        app.settings.listen_port = _free_port()
        app.settings.web_port = _free_port()
        app.storage.save_settings(app.settings)
        app.reload_settings()
        app.start()
        try:
            res = await app.list_models_async(up.id)
            assert res["ok"] is True, res
            assert res["models"] == ["only-models-path"]
            assert res["path"] == "/models"
            assert seen["v1models"] == 1 and seen["models"] == 1

            # 下游拉清单同样应回退到 /models
            import aiohttp

            key = app.new_client_key("t")
            async with aiohttp.ClientSession() as sess:
                async with sess.get(
                    "http://127.0.0.1:%d/v1/models" % app.settings.listen_port,
                    headers={"Authorization": f"Bearer {key}"},
                ) as resp:
                    assert resp.status == 200
                    data = await resp.json()
            assert [m["id"] for m in data["data"]] == ["only-models-path"]
        finally:
            app.stop()
    finally:
        await runner.cleanup()
