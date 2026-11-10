"""进阶场景：会话粘性、预提交预算、取消传播。"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile

import aiohttp
from aiohttp import web

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ha_gateway.app import HaApp  # noqa: E402
from ha_gateway.models import Upstream  # noqa: E402


class SlowUpstream:
    """首块延迟可配置的假上游。"""

    def __init__(self, name: str, first_chunk_delay: float = 0.0, endless: bool = False):
        self.name = name
        self.first_chunk_delay = first_chunk_delay
        self.endless = endless
        self.hits = 0
        self.aborted = 0
        self.port = 0
        self._runner = None

    async def start(self) -> str:
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self._handle)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        self.port = self._runner.addresses[0][1]
        return f"http://127.0.0.1:{self.port}"

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        self.hits += 1
        await request.read()
        resp = web.StreamResponse(
            status=200, headers={"Content-Type": "text/event-stream"}
        )
        await resp.prepare(request)
        try:
            if self.first_chunk_delay:
                await asyncio.sleep(self.first_chunk_delay)
            await resp.write(b"data: first\n\n")
            if self.endless:
                i = 0
                while True:
                    await resp.write(f"data: {i}\n\n".encode())
                    i += 1
                    await asyncio.sleep(0.05)
            else:
                await resp.write(b"data: last\n\n")
                await resp.write_eof()
        except (ConnectionResetError, ConnectionError):
            self.aborted += 1
        return resp


def _build(d: str, ups, port: int, budget: float | None = None) -> HaApp:
    app = HaApp(os.path.join(d, "ha.db"))
    app.settings.listen_port = port
    app.settings.listen_host = "127.0.0.1"
    if budget is not None:
        app.settings.precommit_budget_s = budget
    for i, u in enumerate(ups):
        app.storage.add_upstream(
            Upstream(
                id=f"u{i}",
                name=u.name,
                provider="fake",
                base_url=f"http://127.0.0.1:{u.port}",
                api_key=f"k{i}",
            )
        )
    app._test_key = app.new_client_key("codex")
    return app


def test_session_sticky_returns_to_same_upstream():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            a = SlowUpstream("a")
            b = SlowUpstream("b")
            for u in (a, b):
                await u.start()
            app = _build(d, [a, b], 10931)
            app.start()
            try:
                headers = {
                    "authorization": f"Bearer {app._test_key}",
                    "x-codex-turn-metadata": json.dumps({"thread_id": "T-42"}),
                }
                async with aiohttp.ClientSession() as sess:
                    for _ in range(3):
                        async with sess.post(
                            "http://127.0.0.1:10931/v1/responses", json={}, headers=headers
                        ) as r:
                            assert r.status == 200
                # 粘性生效：同一会话始终回到第一次命中的那一台
                assert max(a.hits, b.hits) == 3, (a.hits, b.hits)
                assert min(a.hits, b.hits) == 0, (a.hits, b.hits)
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)
                for u in (a, b):
                    await u.stop()

    asyncio.run(run())


def test_precommit_budget_switches_away_from_slow_upstream():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            slow = SlowUpstream("slow", first_chunk_delay=3.0)
            fast = SlowUpstream("fast")
            for u in (slow, fast):
                await u.start()
            app = _build(d, [slow, fast], 10932, budget=0.5)
            app.start()
            try:
                async with aiohttp.ClientSession() as sess:
                    async with sess.post(
                        "http://127.0.0.1:10932/v1/responses",
                        json={},
                        headers={"authorization": f"Bearer {app._test_key}"},
                    ) as r:
                        body = await r.text()
                        assert r.status == 200, body
                        assert "first" in body
                assert slow.hits == 1
                assert fast.hits == 1
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)
                for u in (slow, fast):
                    await u.stop()

    asyncio.run(run())


def test_downstream_disconnect_aborts_upstream():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            endless = SlowUpstream("endless", endless=True)
            await endless.start()
            app = _build(d, [endless], 10933)
            app.start()
            try:
                resp = await aiohttp.ClientSession().post(
                    "http://127.0.0.1:10933/v1/responses",
                    json={},
                    headers={"authorization": f"Bearer {app._test_key}"},
                )
                await resp.content.read(64)
                resp.close()  # 下游主动断开
                await asyncio.sleep(0.6)
                assert endless.aborted >= 1, endless.aborted
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)
                await endless.stop()

    asyncio.run(run())


def test_failed_upstream_is_cooled_down():
    """失败过的上游在最小驻留窗口内不再被选中（防横跳）。"""

    class Always500(SlowUpstream):
        async def _handle(self, request: web.Request):
            self.hits += 1
            await request.read()
            return web.Response(status=500, body=b'{"error":{"message":"boom"}}')

    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = Always500("bad")
            good = SlowUpstream("good")
            for u in (bad, good):
                await u.start()
            app = _build(d, [bad, good], 10934)
            app.start()
            try:
                headers = {"authorization": f"Bearer {app._test_key}"}
                async with aiohttp.ClientSession() as sess:
                    for _ in range(3):
                        async with sess.post(
                            "http://127.0.0.1:10934/v1/responses", json={}, headers=headers
                        ) as r:
                            assert r.status == 200
                assert bad.hits == 1, bad.hits
                assert good.hits == 3, good.hits
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)
                for u in (bad, good):
                    await u.stop()

    asyncio.run(run())


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
