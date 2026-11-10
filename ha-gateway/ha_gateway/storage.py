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
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS client_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
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
"""


class Storage:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.path.join(crypto.data_dir(), "ha-gateway.db")
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    # ---------- settings ----------

    def load_settings(self) -> Settings:
        s = Settings()
        rows = self._conn.execute("SELECT key, value FROM settings").fetchall()
        raw = {r["key"]: r["value"] for r in rows}
        for name in (
            "protocol",
            "listen_host",
        ):
            if name in raw:
                setattr(s, name, raw[name])
        for name in (
            "listen_port",
            "max_switches_per_request",
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
            "precommit_budget_s": str(s.precommit_budget_s),
            "upstream_read_timeout_s": str(s.upstream_read_timeout_s),
            "upstream_connect_timeout_s": str(s.upstream_connect_timeout_s),
            "max_switches_per_request": str(s.max_switches_per_request),
            "min_residency_s": str(s.min_residency_s),
            "probe_interval_s": str(s.probe_interval_s),
            "probe_timeout_s": str(s.probe_timeout_s),
            "fail_threshold": str(s.fail_threshold),
            "recover_threshold": str(s.recover_threshold),
            "sticky_ttl_s": str(s.sticky_ttl_s),
            "retry_after_commit": "1" if s.retry_after_commit else "0",
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
                )
            )
        return out

    def add_upstream(self, u: Upstream) -> Upstream:
        if not u.id:
            u.id = uuid.uuid4().hex[:12]
        with self._lock:
            self._conn.execute(
                "INSERT INTO upstreams(id,name,provider,base_url,api_key_enc,protocol,"
                "enabled,weight,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    u.id,
                    u.name,
                    u.provider,
                    u.base_url,
                    crypto.encrypt(u.api_key),
                    u.protocol,
                    1 if u.enabled else 0,
                    u.weight,
                    time.time(),
                ),
            )
            self._conn.commit()
        return u

    def update_upstream(self, u: Upstream) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE upstreams SET name=?,provider=?,base_url=?,api_key_enc=?,"
                "protocol=?,enabled=?,weight=? WHERE id=?",
                (
                    u.name,
                    u.provider,
                    u.base_url,
                    crypto.encrypt(u.api_key),
                    u.protocol,
                    1 if u.enabled else 0,
                    u.weight,
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
        return [
            ClientKey(
                id=r["id"],
                label=r["label"],
                key=r["key_prefix"],
                enabled=bool(r["enabled"]),
            )
            for r in rows
        ]

    def add_client_key(self, label: str, key: str) -> ClientKey:
        import hashlib

        h = hashlib.sha256(key.encode("utf-8")).hexdigest()
        ck = ClientKey(id=uuid.uuid4().hex[:12], label=label, key=key)
        with self._lock:
            self._conn.execute(
                "INSERT INTO client_keys(id,label,key_hash,key_prefix,enabled,created_at) "
                "VALUES(?,?,?,?,1,?)",
                (ck.id, label, h, key[:12], time.time()),
            )
            self._conn.commit()
        return ck

    def delete_client_key(self, key_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM client_keys WHERE id=?", (key_id,))
            self._conn.commit()

    def client_key_hashes(self) -> set[str]:
        import hashlib

        return {
            r["key_hash"]
            for r in self._conn.execute("SELECT key_hash FROM client_keys WHERE enabled=1")
        }

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
