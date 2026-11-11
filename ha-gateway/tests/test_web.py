"""网页管理界面：静态资源 + 管理 API。"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile

import aiohttp

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ha_gateway.app import HaApp  # noqa: E402

PORT = 10941


def test_manual_probe_endpoint_returns_json():
    """手动探测接口必须返回 JSON，不能 500。

    回归点：网页管理接口与网关跑在同一个事件循环里，早前用
    run_coroutine_threadsafe + fut.result() 把循环自己堵死，
    再叠加 `await` 一个普通 dict，直接 TypeError -> 500。
    """

    async def run():
        with tempfile.TemporaryDirectory() as d:
            app = HaApp(os.path.join(d, "ha.db"))
            app.settings.listen_port = 10942
            app.settings.web_port = 10943
            app.settings.web_host = "127.0.0.1"
            app.start()
            await asyncio.sleep(0.6)
            try:
                base = "http://127.0.0.1:10943"
                async with aiohttp.ClientSession() as sess:
                    async with sess.post(
                        base + "/api/upstreams",
                        json={
                            "name": "u1",
                            "provider": "p",
                            "base_url": "http://127.0.0.1:1",
                            "api_key": "k",
                        },
                    ) as r:
                        uid = (await r.json())["id"]

                    async with sess.post(
                        base + f"/api/upstreams/{uid}/probe",
                        timeout=aiohttp.ClientTimeout(total=40),
                    ) as r:
                        assert r.status == 200, r.status
                        out = await r.json()
                        assert "ok" in out, out
                        # 127.0.0.1:1 连不上，应判定为不可用但结构完整
                        assert out["ok"] is False, out
                        assert out["status"] is None, out
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)

    asyncio.run(run())


def test_lock_and_exclude_are_mutually_exclusive():
    """锁定与排除是互斥状态：锁定会自动解除排除，排除会自动解除锁定。"""

    async def run():
        with tempfile.TemporaryDirectory() as d:
            app = HaApp(os.path.join(d, "ha.db"))
            app.settings.listen_port = 10940
            app.settings.web_port = PORT
            app.settings.web_host = "127.0.0.1"
            app.start()
            await asyncio.sleep(0.6)
            try:
                base = f"http://127.0.0.1:{PORT}"
                async with aiohttp.ClientSession() as sess:
                    async with sess.post(
                        base + "/api/upstreams",
                        json={
                            "name": "u1",
                            "provider": "p",
                            "base_url": "http://127.0.0.1:1",
                            "api_key": "k",
                        },
                    ) as r:
                        uid = (await r.json())["id"]

                    # 先排除，再锁定 -> 锁定生效，排除被解除
                    async with sess.post(
                        base + "/api/exclude", json={"ids": [uid]}
                    ) as r:
                        out = await r.json()
                        assert out["excluded_upstream_ids"] == [uid]
                        assert out["forced_upstream_id"] == ""
                    async with sess.post(
                        base + "/api/force", json={"id": uid}
                    ) as r:
                        out = await r.json()
                        assert out["forced_upstream_id"] == uid
                        assert out["excluded_upstream_ids"] == [], (
                            "锁定后应自动解除该通道的排除"
                        )

                    # 反过来：先锁定，再排除 -> 排除生效，锁定被解除
                    async with sess.post(
                        base + "/api/exclude", json={"ids": [uid]}
                    ) as r:
                        out = await r.json()
                        assert out["excluded_upstream_ids"] == [uid]
                        assert out["forced_upstream_id"] == "", (
                            "排除后应自动解除该通道的锁定"
                        )

                    # 落盘状态也必须是互斥的
                    async with sess.get(base + "/api/state") as r:
                        st = await r.json()
                        s = st["settings"]
                        assert s["forced_upstream_id"] == ""
                        assert s["excluded_upstream_ids"] == [uid]
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)

    asyncio.run(run())


def test_web_ui_and_api():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            app = HaApp(os.path.join(d, "ha.db"))
            app.settings.listen_port = 10940
            app.settings.web_port = PORT
            app.settings.web_host = "127.0.0.1"
            app.start()
            await asyncio.sleep(0.6)
            try:
                base = f"http://127.0.0.1:{PORT}"
                async with aiohttp.ClientSession() as sess:
                    async with sess.get(base + "/") as r:
                        assert r.status == 200
                        html = await r.text()
                        assert "乾坤机枢" in html
                    async with sess.get(base + "/app.js") as r:
                        assert r.status == 200
                    async with sess.get(base + "/style.css") as r:
                        assert r.status == 200
                    async with sess.get(base + "/api/state") as r:
                        assert r.status == 200
                        state = await r.json()
                        assert "upstreams" in state
                        assert state["settings"]["protocol"] == "openai-responses"
                    async with sess.post(
                        base + "/api/upstreams",
                        json={
                            "name": "u1",
                            "provider": "p",
                            "base_url": "http://127.0.0.1:1",
                            "api_key": "k",
                        },
                    ) as r:
                        assert r.status == 200
                        out = await r.json()
                        uid = out["id"]
                    async with sess.get(base + "/api/state") as r:
                        state = await r.json()
                        assert len(state["upstreams"]) == 1
                    async with sess.put(
                        base + "/api/upstreams/" + uid,
                        json={"name": "u1-renamed"},
                    ) as r:
                        assert r.status == 200
                    async with sess.post(base + "/api/keys", json={"label": "codex"}) as r:
                        assert r.status == 200
                        out = await r.json()
                        assert out["key"].startswith("sk_own_")
                    async with sess.get(base + "/api/events") as r:
                        assert r.status == 200
                    async with sess.delete(base + "/api/upstreams/" + uid) as r:
                        assert r.status == 200
            finally:
                app.stop()
                app.storage.close()
                await asyncio.sleep(0.2)

    asyncio.run(run())


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
