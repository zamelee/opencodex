"""流量指标：在途数 / RPS / P95。"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ha_gateway.metrics import Metrics  # noqa: E402
from test_e2e import FakeUpstream, _call, _make_app  # noqa: E402


def test_snapshot_empty():
    m = Metrics()
    snap = m.snapshot([])
    assert snap["gateway"]["inflight"] == 0
    assert snap["gateway"]["rps"] == 0
    assert snap["upstreams"] == {}


def test_percentile():
    m = Metrics()
    for i in range(100):
        m.downstream_start()
        m.downstream_end(float(i))
    snap = m.snapshot([])
    assert snap["gateway"]["p95_ms"] == 94.0  # 最近秩法：0..99 的第 95 名
    assert snap["gateway"]["inflight"] == 0
    assert snap["gateway"]["rps"] > 0


def test_inflight_visible_during_request():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            slow = FakeUpstream("slow")
            slow.delay = 0.6
            await slow.start()
            try:
                app = await _make_app(d, [slow], 10921)
                app.start()
                try:
                    task = asyncio.create_task(_call(app, "/v1/responses"))
                    await asyncio.sleep(0.25)
                    snap = app.gateway.metrics.snapshot(["u0"])
                    assert snap["gateway"]["inflight"] == 1, snap
                    assert snap["upstreams"]["u0"]["inflight"] == 1, snap
                    status, _ = await task
                    assert status == 200
                    snap2 = app.gateway.metrics.snapshot(["u0"])
                    assert snap2["gateway"]["inflight"] == 0, snap2
                    assert snap2["upstreams"]["u0"]["inflight"] == 0, snap2
                    assert snap2["upstreams"]["u0"]["rps"] > 0
                    assert snap2["upstreams"]["u0"]["p95_ms"] > 0
                finally:
                    app.stop()
                    app.storage.close()
                    await asyncio.sleep(0.2)
            finally:
                await slow.stop()

    asyncio.run(run())


def test_error_attempt_counted_as_error():
    async def run():
        with tempfile.TemporaryDirectory() as d:
            bad = FakeUpstream("bad")
            bad.status = 500
            bad.body = b'{"error":{"message":"boom"}}'
            await bad.start()
            try:
                app = await _make_app(d, [bad], 10922)
                app.start()
                try:
                    status, _ = await _call(app, "/v1/responses")
                    assert status == 502
                    snap = app.gateway.metrics.snapshot(["u0"])
                    assert snap["upstreams"]["u0"]["errors"] == 1, snap
                    assert snap["gateway"]["inflight"] == 0, snap
                finally:
                    app.stop()
                    app.storage.close()
                    await asyncio.sleep(0.2)
            finally:
                await bad.stop()

    asyncio.run(run())
