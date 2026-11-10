"""故障转移选择逻辑（纯逻辑，便于单测）。"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .models import Health, Phase, Rule, Upstream


def classify_status(status: int | None) -> Rule | None:
    """把上游 HTTP 状态码映射到规则组。"""
    if status is None:
        return Rule.CONNECT_FAIL
    if status == 429:
        return Rule.UPSTREAM_429
    if 500 <= status < 600:
        return Rule.UPSTREAM_5XX
    if 400 <= status < 500:
        return Rule.UPSTREAM_4XX
    return None


def classify_exception(exc: BaseException) -> Rule:
    return Rule.CONNECT_FAIL


@dataclass
class RequestPlan:
    """一次下游请求的上游尝试计划。"""

    candidates: list[Upstream] = field(default_factory=list)
    sticky_id: str | None = None
    switched: int = 0
    excluded: set[str] = field(default_factory=set)

    def next_upstream(self) -> Upstream | None:
        for c in self.candidates:
            if c.id not in self.excluded:
                return c
        return None

    def can_switch(self) -> bool:
        return self.switched < self.max_switches

    max_switches: int = 2

    def mark_failed(self, upstream_id: str) -> None:
        self.excluded.add(upstream_id)
        self.switched += 1

    def remaining(self) -> list[Upstream]:
        return [c for c in self.candidates if c.id not in self.excluded]


class UpstreamSelector:
    """根据粘性、健康、驻留与预算排出候选顺序。"""

    def __init__(self, settings, health, session_router=None) -> None:
        self.settings = settings
        self.health = health
        self.session_router = session_router
        self._rr = 0
        self._cool_until: dict[str, float] = {}

    def mark_failure(self, upstream_id: str) -> None:
        """刚失败的上下游一个最小驻留窗口内不再被选中（防横跳）。"""
        self._cool_until[upstream_id] = time.monotonic() + self.settings.min_residency_s

    def plan(self, upstreams: list[Upstream], session_key: str | None) -> RequestPlan:
        alive = [u for u in upstreams if u.enabled]
        now = time.monotonic()
        cooled = {uid for uid, until in self._cool_until.items() if until > now}
        if len(alive) > len(cooled & {u.id for u in alive}):
            fresh = [u for u in alive if u.id not in cooled]
        else:
            fresh = list(alive)
        sticky_id: str | None = None
        if session_key and self.session_router is not None:
            sticky_id = self.session_router.lookup(session_key, {u.id for u in alive})

        ordered: list[Upstream] = []
        if sticky_id:
            for u in fresh:
                if u.id == sticky_id and self.health.usable(u.id):
                    ordered.append(u)
        rest = [u for u in fresh if u.id != sticky_id]
        # 健康优先，然后轮转，避免总是压同一台
        rest.sort(key=lambda u: (self.health.health_of(u.id) is Health.DOWN, -u.weight))
        if rest:
            k = self._rr % len(rest)
            self._rr += 1
            rest = rest[k:] + rest[:k]
        ordered.extend(rest)

        return RequestPlan(
            candidates=ordered,
            sticky_id=sticky_id,
            max_switches=self.settings.max_switches_per_request,
        )

    def switch_allowed(self, rule: Rule | None) -> bool:
        if rule is None:
            return False
        return bool(self.settings.rules.get(rule, False))

    def should_switch(self, plan: RequestPlan, rule: Rule | None, phase: Phase) -> bool:
        """是否可以换上游继续尝试。"""
        if phase is Phase.DOWNSTREAM_COMMITTED:
            return False
        if not plan.can_switch():
            return False
        if not plan.remaining():
            return False
        if rule is None:
            return False
        return self.switch_allowed(rule)

    def prefer_sticky(self, plan: RequestPlan) -> bool:
        return plan.sticky_id is not None and plan.sticky_id not in plan.excluded
