"""网页管理界面：独立端口、只监听本机，供浏览器调试与日常操作。"""

from __future__ import annotations

import json
import os
import socket

from aiohttp import web

from .models import Rule
from .urlnorm import normalize_base_url, provider_from_base_url

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def _local_ips() -> list[str]:
    """本机可被访问到的 IPv4 地址（不含回环）。"""
    ips: set[str] = set()
    # UDP connect 不会真的发包，只是让系统选路，从而问出本机出口 IP
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ips.add(s.getsockname()[0])
        finally:
            s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    ips.discard("127.0.0.1")
    return sorted(ips)


def _state(app) -> dict:
    ups = []
    for u in app.upstreams():
        st = app.health.state(u.id)
        ups.append(
            {
                "id": u.id,
                "name": u.name,
                "provider": u.provider,
                "base_url": u.base_url,
                "protocol": u.protocol,
                # 只回传"有没有填"，不回传明文密钥
                "has_key": bool(u.api_key),
                "enabled": u.enabled,
                "health": st.health.value,
                "last_error": st.last_error,
                "consecutive_fail": st.consecutive_fail,
            }
        )
    keys = [
        {"id": k.id, "label": k.label, "key": k.key}
        for k in app.storage.list_client_keys()
    ]
    s = app.settings
    metrics = app.gateway.metrics.snapshot([u.id for u in app.upstreams()])
    return {
        "upstreams": ups,
        "keys": keys,
        "local_ips": _local_ips(),
        "settings": {
            "protocol": s.protocol,
            "listen_host": s.listen_host,
            "listen_port": s.listen_port,
            "max_switches_per_request": s.max_switches_per_request,
            "max_switches_per_minute": s.max_switches_per_minute,
            "min_residency_s": s.min_residency_s,
            "precommit_budget_s": s.precommit_budget_s,
            "retry_after_commit": s.retry_after_commit,
            "forced_upstream_id": s.forced_upstream_id,
            "excluded_upstream_ids": list(s.excluded_upstream_ids),
            "rules": {r.value: bool(v) for r, v in s.rules.items()},
        },
        "running": app._started.is_set(),
        "metrics": metrics,
    }


def build_web_app(app) -> web.Application:
    routes = web.RouteTableDef()

    async def index(request):
        return web.FileResponse(os.path.join(WEB_DIR, "index.html"))

    async def static_file(request):
        name = request.match_info["name"]
        path = os.path.normpath(os.path.join(WEB_DIR, name))
        if not path.startswith(WEB_DIR) or not os.path.isfile(path):
            raise web.HTTPNotFound()
        return web.FileResponse(path)

    async def get_state(request):
        return web.json_response(_state(app))

    async def get_events(request):
        limit = int(request.query.get("limit", 200))
        return web.json_response(app.events.recent(limit))

    async def add_upstream(request):
        from .models import Upstream

        data = await request.json()
        if not data.get("name") or not data.get("base_url"):
            raise web.HTTPBadRequest(reason="name and base_url required")
        base_url, note = normalize_base_url(
            data["base_url"], app.settings.protocol
        )
        provider = (data.get("provider") or "").strip() or provider_from_base_url(base_url)
        u = app.storage.add_upstream(
            Upstream(
                id="",
                name=data["name"],
                provider=provider,
                base_url=base_url,
                api_key=data.get("api_key") or "",
                protocol=app.settings.protocol,
            )
        )
        app.storage.migrate_routes({x.id for x in app.upstreams()})
        return web.json_response(
            {"ok": True, "id": u.id, "base_url": base_url, "provider": provider, "note": note}
        )

    async def update_upstream(request):
        uid = request.match_info["id"]
        data = await request.json()
        u = next((x for x in app.upstreams() if x.id == uid), None)
        if u is None:
            raise web.HTTPNotFound()
        if "name" in data:
            u.name = data["name"]
        if "provider" in data:
            u.provider = data["provider"]
        if "base_url" in data:
            base_url, note = normalize_base_url(data["base_url"], app.settings.protocol)
            u.base_url = base_url
            if not (u.provider or "").strip():
                u.provider = provider_from_base_url(base_url)
        if data.get("api_key"):
            u.api_key = data["api_key"]
        if "enabled" in data:
            u.enabled = bool(data["enabled"])
        app.storage.update_upstream(u)
        return web.json_response(
            {
                "ok": True,
                "base_url": u.base_url,
                "provider": u.provider,
                "note": note if "base_url" in data else "",
            }
        )

    async def delete_upstream(request):
        app.storage.delete_upstream(request.match_info["id"])
        return web.json_response({"ok": True})

    async def probe_upstream(request):
        uid = request.match_info["id"]
        res = await app.probe_upstream(uid)
        return web.json_response(res)

    async def add_key(request):
        data = await request.json()
        raw = app.new_client_key(data.get("label") or "client")
        return web.json_response({"ok": True, "key": raw})

    async def delete_key(request):
        app.storage.delete_client_key(request.match_info["id"])
        return web.json_response({"ok": True})

    async def update_key(request):
        uid = request.match_info["id"]
        data = await request.json()
        label = (data.get("label") or "").strip()
        if not label:
            raise web.HTTPBadRequest(reason="label required")
        app.storage.update_client_key_label(uid, label)
        return web.json_response({"ok": True})

    async def put_settings(request):
        data = await request.json()
        s = app.settings
        for key in (
            "protocol",
            "listen_host",
            "listen_port",
            "max_switches_per_request",
            "max_switches_per_minute",
            "min_residency_s",
            "precommit_budget_s",
            "retry_after_commit",
        ):
            if key in data:
                setattr(s, key, data[key])
        app.save_settings(s)
        return web.json_response({"ok": True})

    async def set_forced(request):
        """手动锁定路由：指定上游 id，或传空串恢复自动。"""
        data = await request.json()
        uid = (data.get("id") or "").strip()
        if uid:
            if not any(u.id == uid for u in app.upstreams()):
                raise web.HTTPNotFound()
        s = app.settings
        s.forced_upstream_id = uid
        app.save_settings(s)
        name = next((u.name for u in app.upstreams() if u.id == uid), "")
        app._log(
            "info",
            "route",
            f"手动锁定通道 {name or uid}" if uid else "恢复自动路由",
        )
        return web.json_response({"ok": True, "forced_upstream_id": uid})

    async def set_excluded(request):
        """排除模式：把指定通道移出自动路由候选池。"""
        data = await request.json()
        ids = data.get("ids")
        if ids is None:
            uid = (data.get("id") or "").strip()
            s0 = app.settings
            cur = list(getattr(s0, "excluded_upstream_ids", []) or [])
            if uid:
                ids = [x for x in cur if x != uid] + ([uid] if uid not in cur else [])
            else:
                ids = []
        ids = [str(x) for x in ids if x]
        known = {u.id for u in app.upstreams()}
        ids = [x for x in ids if x in known]
        s = app.settings
        s.excluded_upstream_ids = ids
        app.save_settings(s)
        names = [u.name for u in app.upstreams() if u.id in ids]
        app._log(
            "info",
            "route",
            f"排除通道：{'、'.join(names)}" if names else "清除排除，恢复全部通道参与路由",
        )
        return web.json_response({"ok": True, "excluded_upstream_ids": ids})

    async def put_rules(request):
        data = await request.json()
        s = app.settings
        for k, v in (data.get("rules") or {}).items():
            try:
                s.rules[Rule(k)] = bool(v)
            except ValueError:
                continue
        if "retry_after_commit" in data:
            s.retry_after_commit = bool(data["retry_after_commit"])
        app.save_settings(s)
        return web.json_response({"ok": True})

    routes.get("/")(index)
    routes.get("/{name}")(static_file)
    routes.get("/api/state")(get_state)
    routes.get("/api/events")(get_events)
    routes.post("/api/upstreams")(add_upstream)
    routes.put("/api/upstreams/{id}")(update_upstream)
    routes.delete("/api/upstreams/{id}")(delete_upstream)
    routes.post("/api/upstreams/{id}/probe")(probe_upstream)
    routes.post("/api/keys")(add_key)
    routes.put("/api/keys/{id}")(update_key)
    routes.delete("/api/keys/{id}")(delete_key)
    routes.put("/api/settings")(put_settings)
    routes.post("/api/force")(set_forced)
    routes.post("/api/exclude")(set_excluded)
    routes.put("/api/rules")(put_rules)

    web_app = web.Application()
    web_app.add_routes(routes)
    return web_app
