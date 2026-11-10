"""端到端：假上游故障注入 + 网关切换行为。"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile

import aiohttp
from aiohttp import web

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ha_gateway.app import HaApp  # noqa: E402
from ha_gateway.models import Rule, Upstream  # noqa: E402


class FakeUpstream:
    """可控的假上游：可设定状态码、延迟、是否断流。"""

    def __init__(self, name: str) -> None:
        self.name = name
        self.status = 200
        self.body = b'{"ok":true}'
        self.delay = 0.0
        self.hits = 0
        self.runner = None
        self.port = 0

    async def start(self) -> str:
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self._handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = self.runner.addresses[0][1]
        self.port = port
        return f"http://127.0.0.1:{port}"

    async def stop(self) -> None:
        if self.runner is not None:
            await self.runner.cleanup()

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        self.hits += 1
        await request.read()
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.status != 200:
            return web.Response(status=self.status, body=self.body, content_type="application/json")
        if request.headers.get("x-fake-stream") == "1":
            resp = web.StreamResponse(
                status=200, headers={"Content-Type": "text/event-stream"}
            )
            await resp.prepare(request)
            for i in range(3):
                await resp.write(f"data: chunk{i}\n\n".encode())
                await asyncio.sleep(0.01)
            await resp.write_eof()
            return resp
        return web.Response(body=self.body, content_type="application/json")


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
    key = app.new_client_key("codex")
    app._test_key = key
    return app


async def _call(app: HaApp, path: str, headers: dict | None = None, port: int | None = None):
    port = port or app.settings.listen_port
    h = {"authorization": f"Bearer {app._test_key}"}
    h.update(headers or {})
    async with aiohttp.ClientSession() as sess:
        async with sess.post(
            f"http://127.0.0.1:{port}{path}", json={"hello": "world"}, headers=h
        ) as resp:
            body = await resp.text()
            return resp.status, body


async def _scenario(upstreams, tmpdir, port, path="/v1/responses", headers=None):
    app = await _make_app(tmpdir, upstreams, port)
    app.start()
    try:
        return await _call(app, path, headers)
    finally:
        app.stop()
        app.storage.close()
        await asyncio.sleep(0.2)


def test_failover_on_500():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = FakeUpstream("bad")
            good = FakeUpstream("good")
            bad.status = 500
            bad.body = b'{"error":{"message":"upstream boom"}}'
            for fu in (bad, good):
                await fu.start()
            try:
                status, body = await _scenario([bad, good], d, 10911)
                assert status == 200, body
                assert good.hits == 1
                assert bad.hits == 1
            finally:
                for fu in (bad, good):
                    await fu.stop()

    asyncio.run(run())


def test_429_switches_and_normalizes_to_502():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = FakeUpstream("limited")
            bad.status = 429
            bad.body = b'{"error":{"message":"quota exhausted"}}'
            await bad.start()
            try:
                app = await _make_app(d, [bad], 10912)
                app.start()
                try:
                    status, body = await _call(app, "/v1/responses")
                    assert status == 502, body
                    assert "upstream_error" in body
                finally:
                    app.stop()
                    app.storage.close()
                    await asyncio.sleep(0.2)
            finally:
                await bad.stop()

    asyncio.run(run())


def test_400_does_not_switch_and_returns_502():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = FakeUpstream("badreq")
            good = FakeUpstream("good")
            bad.status = 400
            bad.body = b'{"error":{"message":"invalid request"}}'
            for fu in (bad, good):
                await fu.start()
            try:
                status, body = await _scenario([bad, good], d, 10913)
                assert status == 502, body
                assert good.hits == 0
                assert bad.hits == 1
            finally:
                for fu in (bad, good):
                    await fu.stop()

    asyncio.run(run())


def test_400_switches_when_rule_enabled():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = FakeUpstream("badreq")
            good = FakeUpstream("good")
            bad.status = 400
            for fu in (bad, good):
                await fu.start()
            try:
                app = await _make_app(d, [bad, good], 10914)
                app.settings.rules[Rule.UPSTREAM_4XX] = True
                app.start()
                try:
                    status, body = await _call(app, "/v1/responses")
                    assert status == 200, body
                    assert good.hits == 1
                finally:
                    app.stop()
                    app.storage.close()
                    await asyncio.sleep(0.2)
            finally:
                for fu in (bad, good):
                    await fu.stop()

    asyncio.run(run())


def test_unauthorized_downstream_key():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            up = FakeUpstream("u")
            await up.start()
            try:
                app = await _make_app(d, [up], 10915)
                app.start()
                try:
                    async with aiohttp.ClientSession() as sess:
                        async with sess.post(
                            "http://127.0.0.1:10915/v1/responses",
                            json={},
                            headers={"authorization": "Bearer sk_wrong"},
                        ) as resp:
                            assert resp.status == 401
                finally:
                    app.stop()
                    app.storage.close()
                    await asyncio.sleep(0.2)
            finally:
                await up.stop()

    asyncio.run(run())


def test_unknown_path_404():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            up = FakeUpstream("u")
            await up.start()
            try:
                app = await _make_app(d, [up], 10916)
                app.start()
                try:
                    status, body = await _call(app, "/v1/responses/../admin")
                    assert status == 404, body
                finally:
                    app.stop()
                    app.storage.close()
                    await asyncio.sleep(0.2)
            finally:
                await up.stop()

    asyncio.run(run())


def test_stream_passthrough():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            up = FakeUpstream("s")
            await up.start()
            try:
                app = await _make_app(d, [up], 10917)
                app.start()
                try:
                    status, body = await _call(
                        app, "/v1/responses", {"x-fake-stream": "1"}
                    )
                    assert status == 200
                    assert "chunk0" in body and "chunk2" in body
                finally:
                    app.stop()
                    app.storage.close()
                    await asyncio.sleep(0.2)
            finally:
                await up.stop()

    asyncio.run(run())


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
