"""健康状态机：被动判定 + 主动探活，带迟滞与最小驻留。"""

from __future__ import annotations

import asyncio
import random
import time

from .models import Health, HealthState


class HealthMonitor:
    def __init__(
        self,
        settings,
        on_change=None,
    ) -> None:
        self.settings = settings
        self.states: dict[str, HealthState] = {}
        self.on_change = on_change
        self._lock = asyncio.Lock()

    # ---------- 状态访问 ----------

    def state(self, upstream_id: str) -> HealthState:
        st = self.states.get(upstream_id)
        if st is None:
            st = HealthState(upstream_id=upstream_id, last_change_at=time.monotonic())
            self.states[upstream_id] = st
        return st

    def health_of(self, upstream_id: str) -> Health:
        return self.state(upstream_id).health

    def snapshot(self) -> list[dict]:
        return [s.snapshot() for s in self.states.values()]

    def drop(self, upstream_id: str) -> None:
        self.states.pop(upstream_id, None)

    # ---------- 判定 ----------

    def record_success(self, upstream_id: str) -> None:
        st = self.state(upstream_id)
        st.consecutive_fail = 0
        st.consecutive_ok += 1
        st.last_error = ""
        if st.health is Health.DOWN and st.consecutive_ok >= self.settings.recover_threshold:
            self._set_health(st, Health.HEALTHY)
        elif st.health is Health.DEGRADED and st.consecutive_ok >= self.settings.recover_threshold:
            self._set_health(st, Health.HEALTHY)
        else:
            st.last_ok_at = time.monotonic()

    def record_failure(self, upstream_id: str, error: str) -> None:
        st = self.state(upstream_id)
        st.consecutive_ok = 0
        st.consecutive_fail += 1
        st.last_error = error
        if st.consecutive_fail >= self.settings.fail_threshold:
            if st.health is not Health.DOWN:
                st.down_since = time.monotonic()
                self._set_health(st, Health.DOWN)
        elif st.health is Health.HEALTHY:
            self._set_health(st, Health.DEGRADED)

    def _set_health(self, st: HealthState, h: Health) -> None:
        st.health = h
        st.last_change_at = time.monotonic()
        if self.on_change:
            try:
                self.on_change(st)
            except Exception:
                pass

    def in_residency(self, upstream_id: str) -> bool:
        """是否处于最小驻留期内（期间不因健康抖动切换）。"""
        st = self.state(upstream_id)
        return (time.monotonic() - st.last_change_at) < self.settings.min_residency_s

    def usable(self, upstream_id: str) -> bool:
        return self.health_of(upstream_id) is not Health.DOWN

    # ---------- 主动探活 ----------

    async def probe_once(self, upstream, probe_fn) -> bool:
        """调用 probe_fn(upstream) -> bool。"""
        ok = False
        try:
            ok = bool(await asyncio.wait_for(
                probe_fn(upstream), timeout=self.settings.probe_timeout_s
            ))
        except asyncio.TimeoutError:
            ok = False
        except Exception as exc:  # noqa: BLE001
            ok = False
            self.record_failure(upstream.id, f"probe: {exc}")
            return False
        if ok:
            self.record_success(upstream.id)
        else:
            self.record_failure(upstream.id, "probe failed")
        return ok

    async def probe_loop(self, upstream, probe_fn, stop: asyncio.Event) -> None:
        while not stop.is_set():
            jitter = random.uniform(-0.3, 0.3)
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=max(0.5, self.settings.probe_interval_s + jitter)
                )
                return
            except asyncio.TimeoutError:
                pass
            if not upstream.enabled:
                continue
            await self.probe_once(upstream, probe_fn)
