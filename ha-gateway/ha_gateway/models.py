"""数据模型。"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum


class Health(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    DOWN = "down"


class Phase(str, Enum):
    """一次上游尝试所处的传输阶段。"""

    NOT_SENT = "not_sent"
    PARTIALLY_SENT = "partially_sent"
    FULLY_SENT = "fully_sent"
    UPSTREAM_RESPONSE_STARTED = "upstream_response_started"
    DOWNSTREAM_COMMITTED = "downstream_committed"


class Rule(str, Enum):
    """参与自动切换的状态组。"""

    CONNECT_FAIL = "connect_fail"
    UPSTREAM_5XX = "upstream_5xx"
    UPSTREAM_429 = "upstream_429"
    UPSTREAM_4XX = "upstream_4xx"
    POST_COMMIT_BREAK = "post_commit_break"


DEFAULT_RULES: dict[Rule, bool] = {
    Rule.CONNECT_FAIL: True,
    Rule.UPSTREAM_5XX: True,
    Rule.UPSTREAM_429: True,
    Rule.UPSTREAM_4XX: False,
    Rule.POST_COMMIT_BREAK: False,
}


RULE_LABELS: dict[Rule, str] = {
    Rule.CONNECT_FAIL: "连接失败 / DNS 失败",
    Rule.UPSTREAM_5XX: "上游 5xx",
    Rule.UPSTREAM_429: "上游 429（限流）",
    Rule.UPSTREAM_4XX: "上游 4xx（除 429）",
    Rule.POST_COMMIT_BREAK: "已提交后断流",
}


@dataclass
class Upstream:
    id: str
    name: str
    provider: str
    base_url: str
    api_key: str = ""  # 内存中的明文，落库时加密
    protocol: str = "openai-responses"
    enabled: bool = True
    weight: int = 1


@dataclass
class ClientKey:
    id: str
    label: str
    key: str  # 明文，仅内存；落库用 hash
    enabled: bool = True


@dataclass
class Settings:
    protocol: str = "openai-responses"
    listen_host: str = "127.0.0.1"
    listen_port: int = 10110
    web_host: str = "127.0.0.1"
    web_port: int = 10111
    precommit_budget_s: float = 15.0
    upstream_read_timeout_s: float = 300.0
    upstream_connect_timeout_s: float = 10.0
    max_switches_per_request: int = 2
    max_switches_per_minute: int = 5
    min_residency_s: float = 30.0
    probe_interval_s: float = 3.0
    probe_timeout_s: float = 2.0
    fail_threshold: int = 3
    recover_threshold: int = 5
    sticky_ttl_s: float = 24 * 3600
    retry_after_commit: bool = False
    forced_upstream_id: str = ""  # 手动锁定通道；空 = 自动路由
    excluded_upstream_ids: list[str] = field(default_factory=list)
    rules: dict[Rule, bool] = field(default_factory=lambda: dict(DEFAULT_RULES))


@dataclass
class HealthState:
    upstream_id: str
    health: Health = Health.HEALTHY
    consecutive_fail: int = 0
    consecutive_ok: int = 0
    last_error: str = ""
    last_ok_at: float = 0.0  # monotonic
    last_change_at: float = 0.0  # monotonic，最小驻留计时用
    down_since: float = 0.0

    def snapshot(self) -> dict:
        return {
            "upstream_id": self.upstream_id,
            "health": self.health.value,
            "consecutive_fail": self.consecutive_fail,
            "consecutive_ok": self.consecutive_ok,
            "last_error": self.last_error,
        }


@dataclass
class Attempt:
    """一次上游尝试的结果。"""

    upstream_id: str
    phase: Phase
    status: int | None = None
    error: str = ""
    rule: Rule | None = None
    switchable: bool = False


def now_mono() -> float:
    return time.monotonic()
