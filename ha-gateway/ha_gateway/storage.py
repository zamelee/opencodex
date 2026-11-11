"""SQLite 持久化层。"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid

from . import crypto
from .models import DEFAULT_RULES, ClientKey, Rule, Settings, Upstream

_SCHEMA = """
CREATE TABLE IF NOT EXISTS upstreams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_enc TEXT NOT NULL,
    protocol TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    weight INTEGER NOT NULL DEFAULT 1,
    model TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS client_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    key_enc TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS session_routes (
    session_key TEXT PRIMARY KEY,
    upstream_id TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS response_routes (
    response_id TEXT PRIMARY KEY,
    upstream_id TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
    rule_group TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    PRIMARY KEY (rule_group, rule_key)
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    level TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    rid TEXT NOT NULL DEFAULT '',
    upstream_id TEXT NOT NULL DEFAULT '',
    upstream_name TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    status INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    ttfb_ms REAL
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_records(ts);
CREATE TABLE IF NOT EXISTS upstream_models (
    upstream_id TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (upstream_id, model)
);
"""


class Storage:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.path.join(crypto.data_dir(), "ha-gateway.db")
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._migrate()
            self._conn.commit()

    def _migrate(self) -> None:
        """老库补列（子项目迭代期间保持向后兼容）。"""
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(client_keys)")}
        if "key_enc" not in cols:
            self._conn.execute(
                "ALTER TABLE client_keys ADD COLUMN key_enc TEXT NOT NULL DEFAULT ''"
            )
        up_cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(upstreams)")}
        if "model" not in up_cols:
            self._conn.execute(
                "ALTER TABLE upstreams ADD COLUMN model TEXT NOT NULL DEFAULT ''"
            )

    # ---------- settings ----------

    def load_settings(self) -> Settings:
        s = Settings()
        rows = self._conn.execute("SELECT key, value FROM settings").fetchall()
        raw = {r["key"]: r["value"] for r in rows}
        for name in (
            "protocol",
            "listen_host",
            "web_host",
            "forced_upstream_id",
        ):
            if name in raw:
                setattr(s, name, raw[name])
        for name in (
            "listen_port",
            "web_port",
            "max_switches_per_request",
            "max_switches_per_minute",
            "fail_threshold",
            "recover_threshold",
        ):
            if name in raw:
                try:
                    setattr(s, name, int(raw[name]))
                except ValueError:
                    pass
        for name in (
            "precommit_budget_s",
            "upstream_read_timeout_s",
            "upstream_connect_timeout_s",
            "min_residency_s",
            "probe_interval_s",
            "probe_timeout_s",
            "sticky_ttl_s",
        ):
            if name in raw:
                try:
                    setattr(s, name, float(raw[name]))
                except ValueError:
                    pass
        if "retry_after_commit" in raw:
            s.retry_after_commit = raw["retry_after_commit"] == "1"
        if "excluded_upstream_ids" in raw:
            try:
                s.excluded_upstream_ids = [
                    x for x in json.loads(raw["excluded_upstream_ids"]) if isinstance(x, str)
                ]
            except (ValueError, TypeError):
                s.excluded_upstream_ids = []
        # 锁定与排除互斥：历史脏数据里若同一条既被锁定又被排除，
        # 以锁定为准（锁定是显式操作），把该条从排除名单里摘掉。
        forced = getattr(s, "forced_upstream_id", "") or ""
        if forced and forced in s.excluded_upstream_ids:
            s.excluded_upstream_ids = [
                x for x in s.excluded_upstream_ids if x != forced
            ]
        rules = dict(DEFAULT_RULES)
        for r in self._conn.execute("SELECT rule_key, enabled FROM rules"):
            try:
                rules[Rule(r["rule_key"])] = bool(r["enabled"])
            except ValueError:
                continue
        s.rules = rules
        return s

    def save_settings(self, s: Settings) -> None:
        data = {
            "protocol": s.protocol,
            "listen_host": s.listen_host,
            "listen_port": str(s.listen_port),
            "web_host": s.web_host,
            "web_port": str(s.web_port),
            "precommit_budget_s": str(s.precommit_budget_s),
            "upstream_read_timeout_s": str(s.upstream_read_timeout_s),
            "upstream_connect_timeout_s": str(s.upstream_connect_timeout_s),
            "max_switches_per_request": str(s.max_switches_per_request),
            "max_switches_per_minute": str(s.max_switches_per_minute),
            "min_residency_s": str(s.min_residency_s),
            "probe_interval_s": str(s.probe_interval_s),
            "probe_timeout_s": str(s.probe_timeout_s),
            "fail_threshold": str(s.fail_threshold),
            "recover_threshold": str(s.recover_threshold),
            "sticky_ttl_s": str(s.sticky_ttl_s),
            "retry_after_commit": "1" if s.retry_after_commit else "0",
            "forced_upstream_id": s.forced_upstream_id,
            "excluded_upstream_ids": json.dumps(s.excluded_upstream_ids),
        }
        with self._lock:
            self._conn.executemany(
                "INSERT INTO settings(key, value) VALUES(?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                list(data.items()),
            )
            self._conn.executemany(
                "INSERT INTO rules(rule_group, rule_key, enabled) VALUES(?,?,?) "
                "ON CONFLICT(rule_group, rule_key) DO UPDATE SET enabled=excluded.enabled",
                [("switch", r.value, "1" if v else "0") for r, v in s.rules.items()],
            )
            self._conn.commit()

    # ---------- upstreams ----------

    def list_upstreams(self) -> list[Upstream]:
        rows = self._conn.execute(
            "SELECT * FROM upstreams ORDER BY created_at"
        ).fetchall()
        out = []
        for r in rows:
            out.append(
                Upstream(
                    id=r["id"],
                    name=r["name"],
                    provider=r["provider"],
                    base_url=r["base_url"],
                    api_key=crypto.decrypt(r["api_key_enc"]),
                    protocol=r["protocol"],
                    enabled=bool(r["enabled"]),
                    weight=r["weight"],
                    model=r["model"] if "model" in r.keys() else "",
                )
            )
        return out

    def add_upstream(self, u: Upstream) -> Upstream:
        if not u.id:
            u.id = uuid.uuid4().hex[:12]
        with self._lock:
            self._conn.execute(
                "INSERT INTO upstreams(id,name,provider,base_url,api_key_enc,protocol,"
                "enabled,weight,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    u.id,
                    u.name,
                    u.provider,
                    u.base_url,
                    crypto.encrypt(u.api_key),
                    u.protocol,
                    1 if u.enabled else 0,
                    u.weight,
                    u.model or "",
                    time.time(),
                ),
            )
            self._conn.commit()
        return u

    def update_upstream(self, u: Upstream) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE upstreams SET name=?,provider=?,base_url=?,api_key_enc=?,"
                "protocol=?,enabled=?,weight=?,model=? WHERE id=?",
                (
                    u.name,
                    u.provider,
                    u.base_url,
                    crypto.encrypt(u.api_key),
                    u.protocol,
                    1 if u.enabled else 0,
                    u.weight,
                    u.model or "",
                    u.id,
                ),
            )
            self._conn.commit()

    def delete_upstream(self, upstream_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM upstreams WHERE id=?", (upstream_id,))
            self._conn.execute("DELETE FROM session_routes WHERE upstream_id=?", (upstream_id,))
            self._conn.execute("DELETE FROM response_routes WHERE upstream_id=?", (upstream_id,))
            self._conn.commit()

    # ---------- client keys ----------

    def list_client_keys(self) -> list[ClientKey]:
        rows = self._conn.execute(
            "SELECT * FROM client_keys ORDER BY created_at"
        ).fetchall()
        out = []
        for r in rows:
            key = r["key_prefix"]
            if r["key_enc"]:
                try:
                    key = crypto.decrypt(r["key_enc"])
                except Exception:
                    key = r["key_prefix"]
            out.append(
                ClientKey(
                    id=r["id"],
                    label=r["label"],
                    key=key,
                    enabled=bool(r["enabled"]),
                )
            )
        return out

    def add_client_key(self, label: str, key: str) -> ClientKey:
        import hashlib

        h = hashlib.sha256(key.encode("utf-8")).hexdigest()
        ck = ClientKey(id=uuid.uuid4().hex[:12], label=label, key=key)
        with self._lock:
            self._conn.execute(
                "INSERT INTO client_keys(id,label,key_hash,key_prefix,key_enc,enabled,created_at) "
                "VALUES(?,?,?,?,?,1,?)",
                (ck.id, label, h, key[:12], crypto.encrypt(key), time.time()),
            )
            self._conn.commit()
        return ck

    def delete_client_key(self, key_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM client_keys WHERE id=?", (key_id,))
            self._conn.commit()

    def update_client_key_label(self, key_id: str, label: str) -> None:
        with self._lock:
            self._conn.execute("UPDATE client_keys SET label=? WHERE id=?", (label, key_id))
            self._conn.commit()

    def client_key_hashes(self) -> set[str]:
        import hashlib

        return {
            r["key_hash"]
            for r in self._conn.execute("SELECT key_hash FROM client_keys WHERE enabled=1")
        }

    def client_key_id_by_hash(self, key_hash: str) -> str | None:
        """按 key 的 sha256 找到 key id（会话键的第三段材料）。"""
        row = self._conn.execute(
            "SELECT id FROM client_keys WHERE key_hash=?", (key_hash,)
        ).fetchone()
        return row["id"] if row else None

    # ---------- routes ----------

    def get_session_route(self, session_key: str) -> str | None:
        row = self._conn.execute(
            "SELECT upstream_id FROM session_routes WHERE session_key=?", (session_key,)
        ).fetchone()
        return row["upstream_id"] if row else None

    def set_session_route(self, session_key: str, upstream_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO session_routes(session_key,upstream_id,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(session_key) DO UPDATE SET "
                "upstream_id=excluded.upstream_id, updated_at=excluded.updated_at",
                (session_key, upstream_id, time.time()),
            )
            self._conn.commit()

    def drop_session_route(self, session_key: str) -> None:
        with self._lock:
            self._conn.execute(
                "DELETE FROM session_routes WHERE session_key=?", (session_key,)
            )
            self._conn.commit()

    def set_response_route(self, response_id: str, upstream_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO response_routes(response_id,upstream_id,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(response_id) DO UPDATE SET "
                "upstream_id=excluded.upstream_id, updated_at=excluded.updated_at",
                (response_id, upstream_id, time.time()),
            )
            self._conn.commit()

    def get_response_route(self, response_id: str) -> str | None:
        row = self._conn.execute(
            "SELECT upstream_id FROM response_routes WHERE response_id=?", (response_id,)
        ).fetchone()
        return row["upstream_id"] if row else None

    def migrate_routes(self, alive_ids: set[str]) -> None:
        """上游集合变化后清理失效绑定（CAS 语义：只删不写）。"""
        with self._lock:
            for table in ("session_routes", "response_routes"):
                for row in self._conn.execute(
                    f"SELECT rowid, upstream_id FROM {table}"
                ).fetchall():
                    if row["upstream_id"] not in alive_ids:
                        self._conn.execute(
                            f"DELETE FROM {table} WHERE rowid=?", (row["rowid"],)
                        )
            self._conn.commit()

    # ---------- events ----------

    def add_event(self, level: str, kind: str, message: str, detail: str = "") -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO events(ts,level,kind,message,detail) VALUES(?,?,?,?,?)",
                (time.time(), level, kind, message, detail),
            )
            self._conn.commit()

    def list_events(self, limit: int = 500) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in reversed(rows)]

    # ---------- usage ----------

    def add_usage_record(
        self,
        *,
        rid: str,
        upstream_id: str,
        upstream_name: str,
        model: str,
        status: int,
        input_tokens: int | None,
        output_tokens: int | None,
        total_tokens: int | None,
        ttfb_ms: float | None,
    ) -> None:
        """记一条用量。失败请求也记（status 非 0），token 为空。"""
        with self._lock:
            self._conn.execute(
                "INSERT INTO usage_records(ts,rid,upstream_id,upstream_name,model,status,"
                "input_tokens,output_tokens,total_tokens,ttfb_ms) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    time.time(),
                    rid,
                    upstream_id,
                    upstream_name,
                    model,
                    status,
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    ttfb_ms,
                ),
            )
            self._conn.commit()

    def usage_summary(self, days: int = 7) -> dict:
        """按天 + 按上游汇总用量。"""
        since = time.time() - days * 86400
        with self._lock:
            by_day = [
                dict(r)
                for r in self._conn.execute(
                    "SELECT date(ts,'unixepoch','localtime') AS day, "
                    "COUNT(*) AS requests, "
                    "SUM(COALESCE(input_tokens,0)) AS input_tokens, "
                    "SUM(COALESCE(output_tokens,0)) AS output_tokens, "
                    "SUM(COALESCE(total_tokens,0)) AS total_tokens "
                    "FROM usage_records WHERE ts >= ? GROUP BY day ORDER BY day",
                    (since,),
                )
            ]
            by_upstream = [
                dict(r)
                for r in self._conn.execute(
                    "SELECT upstream_name AS name, COUNT(*) AS requests, "
                    "SUM(COALESCE(input_tokens,0)) AS input_tokens, "
                    "SUM(COALESCE(output_tokens,0)) AS output_tokens, "
                    "SUM(COALESCE(total_tokens,0)) AS total_tokens "
                    "FROM usage_records WHERE ts >= ? AND upstream_name != '' "
                    "GROUP BY upstream_name ORDER BY total_tokens DESC",
                    (since,),
                )
            ]
            total = self._conn.execute(
                "SELECT COUNT(*) AS requests, "
                "SUM(COALESCE(input_tokens,0)) AS input_tokens, "
                "SUM(COALESCE(output_tokens,0)) AS output_tokens, "
                "SUM(COALESCE(total_tokens,0)) AS total_tokens "
                "FROM usage_records WHERE ts >= ?",
                (since,),
            ).fetchone()
        return {
            "days": days,
            "total": dict(total) if total else {},
            "by_day": by_day,
            "by_upstream": by_upstream,
        }

    def prune_usage(self, keep_days: int = 90) -> int:
        """清掉太老的用量记录，避免库无限长。"""
        cutoff = time.time() - keep_days * 86400
        with self._lock:
            cur = self._conn.execute("DELETE FROM usage_records WHERE ts < ?", (cutoff,))
            self._conn.commit()
            return cur.rowcount or 0

    # ---------- 上游模型清单 ----------

    def add_upstream_models(self, upstream_id: str, models: list[str]) -> None:
        """记下这条上游支持哪些模型（用户手动拉取时写入）。"""
        now = time.time()
        with self._lock:
            self._conn.executemany(
                "INSERT INTO upstream_models(upstream_id,model,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(upstream_id,model) DO UPDATE SET updated_at=excluded.updated_at",
                [(upstream_id, m, now) for m in models],
            )
            self._conn.commit()

    def known_models(self) -> list[str]:
        """所有已知模型的并集（上游不支持 /v1/models 时的兜底）。"""
        rows = self._conn.execute(
            "SELECT DISTINCT model FROM upstream_models ORDER BY model"
        ).fetchall()
        return [r["model"] for r in rows]

    def models_of(self, upstream_id: str) -> list[str]:
        rows = self._conn.execute(
            "SELECT model FROM upstream_models WHERE upstream_id=? ORDER BY model",
            (upstream_id,),
        ).fetchall()
        return [r["model"] for r in rows]

    def export_json(self) -> str:
        return json.dumps(
            {
                "upstreams": [
                    {**u.__dict__, "api_key": "***"} for u in self.list_upstreams()
                ],
                "settings": self.load_settings().__dict__,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def __enter__(self) -> "Storage":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
