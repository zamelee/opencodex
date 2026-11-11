"""请求流量指标：在途数、RPS、P95 延迟。

只做内存统计，不落盘——进程重启即清零，这是"实时快照"语义。
第二阶段前端的数据球就靠这里：`inflight` -> 球的数量，`rps` -> 生成频率，
`p95` -> 节点/连线上的延迟提示。
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


def _percentile(samples: list[float], q: float) -> float:
    """q 分位（0-1）。样本为空返回 0。"""
    if not samples:
        return 0.0
    s = sorted(samples)
    if len(s) == 1:
        return round(s[0], 1)
    idx = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return round(s[idx], 1)


class Metrics:
    def __init__(self, window_s: float = 60.0) -> None:
        self.window_s = window_s
        self._lock = threading.Lock()
        # 上游 -> 在途数
        self._up_inflight: dict[str, int] = defaultdict(int)
        # 上游 -> 最近窗口内的时间戳队列（RPS）与延迟样本
        self._up_events: dict[str, deque] = defaultdict(deque)
        # 延迟样本是"值"，不是时间戳：只按个数保留最近的若干条
        self._up_ttfb: dict[str, deque] = defaultdict(lambda: deque(maxlen=200))
        # 下游（客户端 -> 网关）整体
        self._down_inflight = 0
        self._down_events: deque = deque()
        self._down_ttfb: deque = deque(maxlen=200)
        self._up_errors: dict[str, int] = defaultdict(int)

    # ---------- 采集 ----------

    def downstream_start(self) -> None:
        with self._lock:
            self._down_inflight += 1

    def downstream_end(self, ttfb_ms: float | None = None) -> None:
        with self._lock:
            self._down_inflight = max(0, self._down_inflight - 1)
            now = time.monotonic()
            self._down_events.append(now)
            if ttfb_ms is not None:
                self._down_ttfb.append(ttfb_ms)
            self._trim(self._down_events)

    def upstream_start(self, upstream_id: str) -> None:
        with self._lock:
            self._up_inflight[upstream_id] += 1

    def upstream_end(
        self,
        upstream_id: str,
        ttfb_ms: float | None = None,
        ok: bool = True,
    ) -> None:
        with self._lock:
            self._up_inflight[upstream_id] = max(
                0, self._up_inflight.get(upstream_id, 0) - 1
            )
            now = time.monotonic()
            self._up_events[upstream_id].append(now)
            self._trim(self._up_events[upstream_id])
            if ttfb_ms is not None:
                self._up_ttfb[upstream_id].append(ttfb_ms)
            if not ok:
                self._up_errors[upstream_id] += 1

    def _trim(self, dq: deque) -> None:
        cutoff = time.monotonic() - self.window_s
        while dq and dq[0] < cutoff:
            dq.popleft()

    # ---------- 快照 ----------

    def snapshot(self, upstream_ids: list[str] | None = None) -> dict:
        with self._lock:
            now = time.monotonic()
            win = max(1.0, self.window_s)
            ups = {}
            ids = upstream_ids if upstream_ids is not None else list(self._up_inflight)
            for uid in ids:
                events = self._up_events.get(uid, deque())
                ttfb = list(self._up_ttfb.get(uid, deque()))
                ups[uid] = {
                    "inflight": self._up_inflight.get(uid, 0),
                    "rps": round(len(events) / win, 2),
                    "p95_ms": _percentile(ttfb, 0.95),
                    "errors": self._up_errors.get(uid, 0),
                }
            down_events = list(self._down_events)
            return {
                "window_s": self.window_s,
                "upstreams": ups,
                "gateway": {
                    "inflight": self._down_inflight,
                    "rps": round(len(down_events) / win, 2),
                    "p95_ms": _percentile(list(self._down_ttfb), 0.95),
                },
            }

    def reset(self) -> None:
        with self._lock:
            self._up_inflight.clear()
            self._up_events.clear()
            self._up_ttfb.clear()
            self._down_inflight = 0
            self._down_events.clear()
            self._down_ttfb.clear()
            self._up_errors.clear()
