"""GUI：拓扑图 + 上游/下游管理 + 规则面板 + 日志。"""

from __future__ import annotations

import queue
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk

from .models import Health, RULE_LABELS, Rule


def _fmt_ts(ts: float) -> str:
    lt = time.localtime(ts)
    ms = int((ts - int(ts)) * 1000)
    return time.strftime("%Y-%m-%d %H:%M:%S", lt) + f".{ms:03d}"


class LogPane(ttk.Frame):
    """事件日志：默认展开；自动跟随滚动，人为拖动时自动取消。"""

    def __init__(self, master, app) -> None:
        super().__init__(master)
        self.app = app
        self._queue: "queue.Queue[dict]" = queue.Queue()
        self._last_ts_bucket = 0.0
        self._pending_line: str | None = None
        self._user_scrolling = False

        bar = ttk.Frame(self)
        bar.pack(fill="x")
        self.follow = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            bar,
            text="自动跟随滚动",
            variable=self.follow,
            command=self._on_follow_toggle,
        ).pack(side="left")
        ttk.Button(bar, text="清空", command=self._clear).pack(side="right")
        ttk.Button(bar, text="刷新", command=self._reload).pack(side="right", padx=4)

        self.text = tk.Text(self, height=10, wrap="none", state="disabled")
        ysb = ttk.Scrollbar(self, orient="vertical", command=self.text.yview)
        self.text.configure(yscrollcommand=self._on_scroll)
        ysb.pack(side="right", fill="y")
        self.text.pack(side="left", fill="both", expand=True)

        for level, color in (("error", "#b3261e"), ("warn", "#8a5a00"), ("info", "#333333")):
            self.text.tag_configure(level, foreground=color)

        app.events.subscribe(self._on_event)
        self._reload()
        self.after(120, self._drain)

    # ---------- 滚动行为 ----------

    def _on_scroll(self, first, last) -> None:
        # 文本未到底部说明用户在往回看 -> 取消自动跟随
        if float(last) < 1.0 and self.follow.get():
            self.follow.set(False)
        self.text.yview_moveto(first)

    def _on_follow_toggle(self) -> None:
        if self.follow.get():
            self._scroll_to_end()

    def _scroll_to_end(self) -> None:
        self.text.see("end")

    # ---------- 内容 ----------

    def _reload(self) -> None:
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        for ev in self.app.events.recent(500):
            self.text.insert(
                "end",
                f"[{_fmt_ts(ev['ts'])}] {ev['level'].upper():5s} {ev['message']}\n",
                ev["level"] if ev["level"] in ("info", "warn", "error") else "info",
            )
        self.text.configure(state="disabled")
        if self.follow.get():
            self._scroll_to_end()

    def _clear(self) -> None:
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        self.text.configure(state="disabled")

    def _on_event(self, ev: dict) -> None:
        self._queue.put(ev)

    def _drain(self) -> None:
        changed = False
        while True:
            try:
                ev = self._queue.get_nowait()
            except queue.Empty:
                break
            changed = True
            bucket = round(ev["ts"], 3)
            line = f"[{_fmt_ts(ev['ts'])}] {ev['level'].upper():5s} {ev['message']}"
            if bucket == self._last_ts_bucket and self._pending_line is not None:
                self._pending_line += "  |  " + ev["message"]
            else:
                if self._pending_line is not None:
                    self._write(self._pending_line)
                self._pending_line = line
                self._last_ts_bucket = bucket
        if self._pending_line is not None and changed:
            self._write(self._pending_line)
            self._pending_line = None
        if changed and self.follow.get():
            self._scroll_to_end()
        self.after(120, self._drain)

    def _write(self, line: str) -> None:
        level = "info"
        if " ERROR " in line or " WARN " in line:
            level = "warn" if " WARN " in line else "error"
        self.text.configure(state="normal")
        self.text.insert("end", line + "\n", level)
        self.text.configure(state="disabled")


class ScrollFrame(ttk.Frame):
    """可纵向滚动的内容容器。"""

    def __init__(self, master) -> None:
        super().__init__(master)
        self.canvas = tk.Canvas(self, highlightthickness=0, background="#ffffff")
        self.inner = ttk.Frame(self.canvas)
        self._win = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        sb = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.inner.bind("<Configure>", lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(self._win, width=e.width))
        for w in (self.canvas, self.inner):
            w.bind("<MouseWheel>", self._wheel)

    def _wheel(self, event) -> None:
        self.canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    def scroll_to(self, widget) -> None:
        self.canvas.update_idletasks()
        bbox = self.canvas.bbox("all")
        if not bbox:
            return
        y = widget.winfo_rooty() - self.canvas.winfo_rooty() + self.canvas.yview()[0] * bbox[3]
        self.canvas.yview_moveto(max(0.0, y / max(1, bbox[3])))


class Section(ttk.Frame):
    """抽屉里的一个小节：标题 + 分隔线 + 内容。"""

    def __init__(self, master, title: str, hint: str = "") -> None:
        super().__init__(master)
        self.pack(fill="x", padx=14, pady=(10, 2))
        head = ttk.Frame(self)
        head.pack(fill="x")
        ttk.Label(head, text=title, font=("Microsoft YaHei UI", 10, "bold")).pack(
            side="left"
        )
        if hint:
            ttk.Label(head, text=hint, foreground="#8a9099").pack(side="left", padx=8)
        ttk.Separator(self).pack(fill="x", pady=(4, 2))
        self.body = ttk.Frame(self)
        self.body.pack(fill="x")


class ManagePane(ttk.Frame):
    """右侧抽屉：一页纵向，把上游/下游 Key/规则/设置串成一条长页。"""

    def __init__(self, master, app) -> None:
        super().__init__(master)
        self.app = app
        self.on_collapse = None
        head = ttk.Frame(self)
        head.pack(fill="x", padx=10, pady=(8, 0))
        ttk.Label(head, text="管理", font=("Microsoft YaHei UI", 9, "bold")).pack(side="left")
        ttk.Button(head, text="◀", width=3, command=self._collapse).pack(side="right")
        ttk.Separator(self).pack(fill="x", padx=10, pady=(6, 0))
        self.scroll = ScrollFrame(self)
        self.scroll.pack(fill="both", expand=True)
        inner = self.scroll.inner

        self.sec_up = Section(inner, "上游通道", "主通道 / 备通道")
        self.upstream_editor = UpstreamEditor(self.sec_up.body, app)
        self.upstream_editor.pack(fill="x")

        self.sec_key = Section(inner, "下游 Key", "Codex 用这一把")
        self.key_pane = KeyPane(self.sec_key.body, app)
        self.key_pane.pack(fill="x")

        self.sec_rules = Section(inner, "故障转移规则", "勾选 = 参与自动切换")
        self.rules_pane = RulesPane(self.sec_rules.body, app)
        self.rules_pane.pack(fill="x")

        self.sec_set = Section(inner, "网关设置")
        self.settings_pane = SettingsPane(self.sec_set.body, app)
        self.settings_pane.pack(fill="x")

    def _collapse(self) -> None:
        if self.on_collapse:
            self.on_collapse()

    def show_section(self, name: str) -> None:
        mapping = {
            "upstream": self.sec_up,
            "key": self.sec_key,
            "rules": self.sec_rules,
            "settings": self.sec_set,
        }
        sec = mapping.get(name)
        if sec is not None:
            self.scroll.scroll_to(sec)


class Topology(ttk.Frame):
    """连线式拓扑图：上游在上，网关居中，下游 key 在下。"""

    NODE_W = 150
    NODE_H = 46
    MIN_SLOTS = 2
    SLOT_NAMES = ["主通道", "备通道", "通道 3", "通道 4"]

    def __init__(self, master, app) -> None:
        super().__init__(master)
        self.app = app
        self.canvas = tk.Canvas(self, background="#f7f8fa", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self._nodes: list[dict] = []
        self._edges: list[dict] = []
        self._active_edge: str | None = None
        self._slot_map: dict[str, object] = {}
        self._node_pos: dict[str, tuple] = {}
        self._phase = 0
        self.on_select = None
        self._editing: dict | None = None
        self._editor_frame: ttk.Frame | None = None
        self._editor_item = None
        self.on_changed = None
        self.bind("<Configure>", lambda e: self.redraw())
        self.canvas.bind("<Button-1>", self._on_click)
        self.after(60, self._animate)

    def redraw(self) -> None:
        if self._editing is not None:
            return  # 正在编辑时不重绘，避免抢走输入焦点
        self._redraw_core()

    def _redraw_core(self) -> None:
        c = self.canvas
        c.delete("all")
        self._nodes = []
        self._edges = []
        self._slot_map = {}
        w = max(c.winfo_width(), 400)
        h = max(c.winfo_height(), 300)

        ups = self.app.upstreams()
        keys = self.app.storage.list_client_keys()
        self._node_pos = {}

        gw = (w // 2, h // 2)
        slot_count = max(self.MIN_SLOTS, len(ups))
        top_y = 60
        bot_y = h - 70

        up_pos = self._layout(slot_count, w, top_y)
        key_pos = self._layout(len(keys), w, bot_y)

        for i in range(slot_count):
            x, y = up_pos[i]
            u = ups[i] if i < len(ups) else None
            owner = u.id if u is not None else f"slot{i}"
            self._node_pos[owner] = (x, y)
            self._edge(c, (x, y + self.NODE_H // 2), gw, "up", owner, u is not None)
        for i, k in enumerate(keys):
            x, y = key_pos[i]
            self._node_pos[k.id] = (x, y)
            self._edge(c, gw, (x, y - self.NODE_H // 2), "down", k.id, True)

        for i in range(slot_count):
            x, y = up_pos[i]
            u = ups[i] if i < len(ups) else None
            if u is None:
                tag = f"slot:{i}"
                self._slot_map[tag] = ("slot", i)
                name = self.SLOT_NAMES[i] if i < len(self.SLOT_NAMES) else f"通道 {i + 1}"
                self._ghost_box(c, x, y, f"{name}\n未配置 · 点击添加", tag)
                continue
            state = self.app.health.health_of(u.id)
            color = {
                Health.HEALTHY: "#2e7d32",
                Health.DEGRADED: "#c58a00",
                Health.DOWN: "#b3261e",
            }[state]
            tag = f"up:{u.id}"
            self._slot_map[tag] = ("upstream", u.id)
            sub = f"{u.provider}"
            if state is Health.DOWN:
                sub = f"{u.provider} · 不可用"
            self._box(c, x, y, f"{u.name}\n{sub}", color, tag=tag)
            slot_name = (
                self.SLOT_NAMES[i] if i < len(self.SLOT_NAMES) else f"通道 {i + 1}"
            )
            c.create_text(
                x,
                y - self.NODE_H / 2 - 11,
                text=slot_name,
                fill="#9aa0a6",
                font=("Microsoft YaHei UI", 8),
            )

        self._box(c, gw[0], gw[1], "HA Gateway\nHA 高可用网关", "#1a73e8", tag="gw")
        self._slot_map["gw"] = ("gw", None)

        for i, k in enumerate(keys):
            x, y = key_pos[i]
            tag = f"key:{k.id}"
            self._slot_map[tag] = ("key", k.id)
            shown = k.key if len(k.key) <= 18 else k.key[:16] + "…"
            self._box(c, x, y, f"{k.label}\n{shown}", "#5f6368", tag=tag)

        # 下游新增位（夹在画布内）
        gx, gy = key_pos[-1] if key_pos else (gw[0], bot_y)
        add_x = min(gx + 185, w - self.NODE_W // 2 - 12)
        if add_x <= gx:
            add_x = min(gx + 185, w - 12)
        self._ghost_box(c, add_x, gy, "＋\n新增下游 Key", "key:add")
        self._slot_map["key:add"] = ("key_add", None)

        self._legend(c, w, h)
        if self._editing:
            self._build_editor()

    # ---------- 编辑卡 ----------

    def _build_editor(self) -> None:
        kind = self._editing.get("kind")
        ident = self._editing.get("id")
        pos = self._node_pos.get(ident if kind != "gw" else "gw", (self.canvas.winfo_width() // 2, 80))
        frame = ttk.LabelFrame(self.canvas, text=self._editor_title(kind), padding=8)
        self._editor_vars = {}
        if kind in ("upstream", "slot"):
            u = next((x for x in self.app.upstreams() if x.id == ident), None) if kind == "upstream" else None
            self._form_fields(frame, u)
            btns = ttk.Frame(frame)
            btns.pack(fill="x", pady=(6, 0))
            if kind == "upstream":
                ttk.Button(btns, text="保存", command=self._save_editor).pack(side="left")
                ttk.Button(btns, text="探测", command=self._probe_editor).pack(side="left", padx=4)
                ttk.Button(btns, text="删除", command=self._delete_editor).pack(side="left")
            else:
                ttk.Button(btns, text="添加", command=self._save_editor).pack(side="left")
            ttk.Button(btns, text="取消", command=self.close_editor).pack(side="right")
        elif kind == "key":
            k = next((x for x in self.app.storage.list_client_keys() if x.id == ident), None)
            body = ttk.Frame(frame)
            body.pack(fill="x")
            ttk.Label(body, text=k.label if k else "?").pack(anchor="w")
            ttk.Label(body, text=(k.key if k else ""), foreground="#1a73e8").pack(anchor="w")
            btns = ttk.Frame(frame)
            btns.pack(fill="x", pady=(6, 0))
            ttk.Button(btns, text="复制", command=lambda: self._copy_key(k)).pack(side="left")
            ttk.Button(btns, text="删除", command=self._delete_editor).pack(side="left", padx=4)
            ttk.Button(btns, text="取消", command=self.close_editor).pack(side="right")
        elif kind == "gw":
            s = self.app.settings
            body = ttk.Frame(frame)
            body.pack(fill="x")
            ttk.Label(body, text=f"协议　{s.protocol}").pack(anchor="w")
            ttk.Label(body, text=f"监听　{s.listen_host}:{s.listen_port}").pack(anchor="w")
            ttk.Label(body, text=f"上游　{len(self.app.upstreams())} 条").pack(anchor="w")
            btns = ttk.Frame(frame)
            btns.pack(fill="x", pady=(6, 0))
            ttk.Button(btns, text="打开管理", command=self._open_manage).pack(side="left")
            ttk.Button(btns, text="取消", command=self.close_editor).pack(side="right")

        # 下半区的节点把卡片放到上方，避免出画布；上半区放下方并右偏避开连线
        ch = self.canvas.winfo_height()
        below = pos[1] < ch / 2
        if below:
            x = max(8, min(pos[0] + 30, self.canvas.winfo_width() - 276))
            y = pos[1] + self.NODE_H // 2 + 26
            anchor = "nw"
        else:
            x = max(8, min(pos[0] + 30, self.canvas.winfo_width() - 276))
            y = pos[1] - self.NODE_H // 2 - 8
            anchor = "sw"
        self._editor_item = self.canvas.create_window(
            x, y, window=frame, anchor=anchor
        )
        self._editor_frame = frame

    def _editor_title(self, kind: str) -> str:
        return {
            "upstream": "编辑上游",
            "slot": "新增上游",
            "key": "下游 Key",
            "gw": "HA Gateway",
        }.get(kind, "")

    def _form_fields(self, frame, u) -> None:
        form = ttk.Frame(frame)
        form.pack(fill="x")
        specs = [
            ("name", "名称", getattr(u, "name", "")),
            ("provider", "Provider", getattr(u, "provider", "")),
            ("base_url", "Base URL", getattr(u, "base_url", "")),
            ("api_key", "API Key", getattr(u, "api_key", "")),
        ]
        for i, (key, label, val) in enumerate(specs):
            ttk.Label(form, text=label).grid(row=i, column=0, sticky="w", pady=2)
            var = tk.StringVar(value=val or "")
            self._editor_vars[key] = var
            entry = ttk.Entry(form, textvariable=var, width=26, show="•" if key == "api_key" else "")
            entry.grid(row=i, column=1, sticky="ew", pady=2)
        form.columnconfigure(1, weight=1)

    # ---------- 编辑动作 ----------

    def _save_editor(self) -> None:
        from .models import Upstream

        v = self._editor_vars
        kind = self._editing.get("kind")
        ident = self._editing.get("id")
        if kind == "slot":
            if not v["name"].get() or not v["base_url"].get():
                messagebox.showwarning("缺少参数", "名称与 Base URL 必填")
                return
            self.app.storage.add_upstream(
                Upstream(
                    id="",
                    name=v["name"].get(),
                    provider=v["provider"].get() or "unknown",
                    base_url=v["base_url"].get(),
                    api_key=v["api_key"].get(),
                    protocol=self.app.settings.protocol,
                )
            )
        else:
            u = next((x for x in self.app.upstreams() if x.id == ident), None)
            if u is None:
                self.close_editor()
                return
            u.name = v["name"].get() or u.name
            u.provider = v["provider"].get() or u.provider
            u.base_url = v["base_url"].get() or u.base_url
            if v["api_key"].get():
                u.api_key = v["api_key"].get()
            self.app.storage.update_upstream(u)
        self._editing = None
        self._destroy_editor()
        if self.on_changed:
            self.on_changed()
        self.redraw_now()

    def _probe_editor(self) -> None:
        ident = self._editing.get("id")

        def worker():
            res = self.app.probe_upstream(ident)
            self.after(0, lambda: messagebox.showinfo(
                "探测结果",
                f"HTTP {res.get('status')}\n耗时 {res.get('ms')}ms\n\n{res.get('body', '')}",
            ))

        threading.Thread(target=worker, daemon=True).start()

    def _delete_editor(self) -> None:
        ident = self._editing.get("id")
        kind = self._editing.get("kind")
        if kind == "upstream":
            self.app.storage.delete_upstream(ident)
        elif kind == "key":
            self.app.storage.delete_client_key(ident)
        self._editing = None
        self._destroy_editor()
        if self.on_changed:
            self.on_changed()
        self.redraw_now()

    def _copy_key(self, k) -> None:
        if k is None:
            return
        self.clipboard_clear()
        self.clipboard_append(k.key)
        self.update()

    def _open_manage(self) -> None:
        self.close_editor()
        if self.on_select:
            self.on_select("gw", None)

    # ---------- 节点就地编辑 ----------

    def open_editor(self, kind: str, ident) -> None:
        self._editing = {"kind": kind, "id": ident}
        self.redraw_now()

    def close_editor(self) -> None:
        self._editing = None
        self._destroy_editor()
        self.redraw_now()

    def redraw_now(self) -> None:
        """强制重绘（编辑中也会重建编辑卡，但保留输入内容）。"""
        saved = self._editor_values() if self._editing else None
        self._destroy_editor()
        self._redraw_core()
        if saved:
            self._fill_editor(saved)

    def _editor_values(self) -> dict | None:
        if self._editor_frame is None:
            return None
        vals = {}
        for name, var in getattr(self, "_editor_vars", {}).items():
            try:
                vals[name] = var.get()
            except Exception:
                pass
        return vals

    def _fill_editor(self, vals: dict) -> None:
        for name, var in getattr(self, "_editor_vars", {}).items():
            if name in vals:
                try:
                    var.set(vals[name])
                except Exception:
                    pass

    def _destroy_editor(self) -> None:
        if self._editor_frame is not None:
            self._editor_frame.destroy()
            self._editor_frame = None
        if self._editor_item is not None:
            try:
                self.canvas.delete(self._editor_item)
            except tk.TclError:
                pass
            self._editor_item = None
        self._editor_vars = {}

    def _layout(self, n: int, w: int, y: int) -> list[tuple[int, int]]:
        if n == 0:
            return []
        span = min(w - 80, n * 190)
        step = span / max(1, n)
        out = []
        for i in range(n):
            x = int((w - span) / 2 + step * i + step / 2)
            out.append((x, y))
        return out

    def _box(self, c, x, y, text, color, tag: str = "") -> None:
        w, h = self.NODE_W, self.NODE_H
        c.create_rectangle(
            x - w / 2,
            y - h / 2,
            x + w / 2,
            y + h / 2,
            fill="#ffffff",
            outline=color,
            width=2,
            tags=(tag,),
        )
        for i, part in enumerate(text.split("\n")):
            c.create_text(
                x,
                y - 8 + i * 15,
                text=part,
                fill=color,
                font=("Microsoft YaHei UI", 9, "bold" if i == 0 else "normal"),
                tags=(tag,),
            )

    def _edge(self, c, a, b, kind: str, owner: str, configured: bool) -> None:
        tag = f"edge:{kind}:{owner}"
        if not configured:
            c.create_line(
                a[0], a[1], b[0], b[1], fill="#dfe3e8", width=2, dash=(4, 4), tags=(tag,)
            )
            self._edges.append(
                {"a": a, "b": b, "kind": kind, "owner": owner, "tag": tag, "dashed": True}
            )
            return
        c.create_line(
            a[0], a[1], b[0], b[1], fill="#d5d9e0", width=2, tags=(tag,)
        )
        self._edges.append(
            {"a": a, "b": b, "kind": kind, "owner": owner, "tag": tag, "dashed": False}
        )

    def _ghost_box(self, c, x, y, text: str, tag: str) -> None:
        w, h = self.NODE_W, self.NODE_H
        c.create_rectangle(
            x - w / 2,
            y - h / 2,
            x + w / 2,
            y + h / 2,
            fill="#f2f4f7",
            outline="#c3c8d0",
            width=1,
            stipple="gray12",
            tags=(tag,),
        )
        for i, part in enumerate(text.split("\n")):
            c.create_text(
                x,
                y - 8 + i * 15,
                text=part,
                fill="#8a9099",
                font=("Microsoft YaHei UI", 9),
                tags=(tag,),
            )

    def _legend(self, c, w: int, h: int) -> None:
        items = [("#1a73e8", "当前通道"), ("#d5d9e0", "可切换"), ("#dfe3e8", "未配置")]
        x = 14
        y = h - 16
        for color, label in items:
            c.create_line(x, y, x + 16, y, fill=color, width=3)
            c.create_text(x + 22, y, text=label, anchor="w", fill="#6b7280",
                          font=("Microsoft YaHei UI", 8))
            x += 22 + 8 * len(label) + 18

    def _animate(self) -> None:
        self._phase += 0.06
        try:
            self.canvas.delete("dot")
        except tk.TclError:
            pass
        fallback = next((e for e in self._edges if e["kind"] == "up"), None)
        for e in self._edges:
            active = (
                e["kind"] == "up"
                and not e.get("dashed")
                and e["owner"] == self._active_edge
            )
            try:
                self.canvas.itemconfigure(e["tag"], fill="#1a73e8" if active else "#d5d9e0")
            except tk.TclError:
                continue
            if active:
                self._draw_dot(e)
        if self._active_edge is None and fallback is not None:
            self._draw_dot(fallback)
        self.after(60, self._animate)

    def _draw_dot(self, e: dict) -> None:
        """在连线上画一个流动光点。"""
        a, b = e["a"], e["b"]
        t = (self._phase % 1.0)
        x = a[0] + (b[0] - a[0]) * t
        y = a[1] + (b[1] - a[1]) * t
        self.canvas.create_oval(
            x - 4, y - 4, x + 4, y + 4, fill="#1a73e8", outline="", tags=("dot",)
        )
        self.canvas.tag_lower("dot")

    def on_route(self, upstream_id: str) -> None:
        """外部通知：某上游刚被命中，高亮其连线。"""
        self._active_edge = upstream_id

    def _on_click(self, event) -> None:
        items = self.canvas.find_overlapping(event.x, event.y, event.x, event.y)
        for item in reversed(items):
            for tag in self.canvas.gettags(item):
                if tag in self._slot_map:
                    kind, ident = self._slot_map[tag]
                    if kind in ("upstream", "slot", "key"):
                        self.open_editor(kind, ident)
                    elif kind == "gw":
                        self.open_editor("gw", None)
                    elif kind == "key_add":
                        self.on_node_click(kind, ident)
                    return
        self.close_editor()

    def on_node_click(self, kind: str, ident) -> None:
        """节点点击回调，由 MainWindow 接管（打开抽屉并定位）。"""
        if self.on_select:
            self.on_select(kind, ident)


class UpstreamEditor(ttk.Frame):
    def __init__(self, master, app) -> None:
        super().__init__(master)
        self.app = app
        self.name = tk.StringVar()
        self.provider = tk.StringVar()
        self.base_url = tk.StringVar()
        self.api_key = tk.StringVar()

        form = ttk.Frame(self)
        form.pack(fill="x", padx=6, pady=6)
        for i, (label, var) in enumerate(
            [
                ("名称", self.name),
                ("Provider", self.provider),
                ("Base URL", self.base_url),
                ("API Key", self.api_key),
            ]
        ):
            ttk.Label(form, text=label).grid(row=i, column=0, sticky="w", padx=4, pady=2)
            ttk.Entry(form, textvariable=var, width=42).grid(
                row=i, column=1, sticky="ew", padx=4, pady=2
            )
        form.columnconfigure(1, weight=1)
        ttk.Button(form, text="添加上游", command=self._add).grid(row=4, column=1, sticky="w", padx=4)

        self.tree = ttk.Treeview(
            self,
            columns=("name", "provider", "url", "health"),
            show="headings",
            height=6,
        )
        for col, title, w in (
            ("name", "名称", 100),
            ("provider", "Provider", 100),
            ("url", "Base URL", 190),
            ("health", "状态", 56),
        ):
            self.tree.heading(col, text=title)
            self.tree.column(col, width=w)
        self.tree.pack(fill="x", padx=6, pady=(0, 6))
        self.tree.tag_configure("ok", foreground="#2e7d32")
        self.tree.tag_configure("warn", foreground="#c58a00")
        self.tree.tag_configure("bad", foreground="#b3261e")
        row = ttk.Frame(self)
        row.pack(fill="x", padx=6, pady=(0, 6))
        ttk.Button(row, text="删除选中", command=self._delete).pack(side="left")
        ttk.Button(row, text="更新选中", command=self._update).pack(side="left", padx=6)
        ttk.Button(row, text="手动探测（可能计费）", command=self._probe).pack(
            side="left", padx=6
        )
        self.probe_status = ttk.Label(row, text="")
        self.probe_status.pack(side="left")

    def refresh(self) -> None:
        self.tree.delete(*self.tree.get_children())
        for u in self.app.upstreams():
            state = self.app.health.health_of(u.id)
            tag = {Health.HEALTHY: "ok", Health.DEGRADED: "warn", Health.DOWN: "bad"}[state]
            self.tree.insert(
                "",
                "end",
                iid=u.id,
                values=(
                    u.name,
                    u.provider,
                    u.base_url,
                    {"healthy": "正常", "degraded": "降级", "down": "不可用"}[state.value],
                ),
                tags=(tag,),
            )

    def _add(self) -> None:
        if not self.name.get() or not self.base_url.get():
            messagebox.showwarning("缺少参数", "名称与 Base URL 必填")
            return
        from .models import Upstream

        self.app.storage.add_upstream(
            Upstream(
                id="",
                name=self.name.get(),
                provider=self.provider.get() or "unknown",
                base_url=self.base_url.get(),
                api_key=self.api_key.get(),
                protocol=self.app.settings.protocol,
            )
        )
        self.app.storage.migrate_routes({u.id for u in self.app.upstreams()})
        self.name.set("")
        self.provider.set("")
        self.base_url.set("")
        self.api_key.set("")
        self.refresh()

    def _delete(self) -> None:
        for iid in self.tree.selection():
            self.app.storage.delete_upstream(iid)
        self.refresh()

    def _update(self) -> None:
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("提示", "请先选中一个上游")
            return
        u = next((x for x in self.app.upstreams() if x.id == sel[0]), None)
        if u is None:
            return
        u.name = self.name.get() or u.name
        u.provider = self.provider.get() or u.provider
        u.base_url = self.base_url.get() or u.base_url
        u.api_key = self.api_key.get() or u.api_key
        self.app.storage.update_upstream(u)
        self.refresh()
        messagebox.showinfo("已保存", f"上游 {u.name} 已更新")

    def select_upstream(self, upstream_id: str) -> None:
        """从拓扑点进来时，把该上游填进表单并选中表格行。"""
        u = next((x for x in self.app.upstreams() if x.id == upstream_id), None)
        if u is None:
            return
        self.name.set(u.name)
        self.provider.set(u.provider)
        self.base_url.set(u.base_url)
        self.api_key.set(u.api_key)
        if self.tree.exists(upstream_id):
            self.tree.selection_set(upstream_id)
            self.tree.see(upstream_id)

    def focus_form(self) -> None:
        self.name.set("")
        self.provider.set("")
        self.base_url.set("")
        self.api_key.set("")
        for child in self.winfo_children():
            if isinstance(child, ttk.Frame):
                for w in child.winfo_children():
                    if isinstance(w, ttk.Entry):
                        w.focus_set()
                        return

    def _probe(self) -> None:
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("提示", "请先选中一个上游")
            return
        uid = sel[0]
        self.probe_status.configure(text="探测中…")

        def worker():
            res = self.app.probe_upstream(uid)
            self.after(0, lambda: self._show_probe(res))

        threading.Thread(target=worker, daemon=True).start()

    def _show_probe(self, res: dict) -> None:
        self.probe_status.configure(text=f"HTTP {res.get('status')} / {res.get('ms')}ms")
        messagebox.showinfo(
            "探测结果",
            f"HTTP {res.get('status')}\n耗时 {res.get('ms')}ms\n\n{res.get('body', '')}",
        )


class KeyPane(ttk.Frame):
    def __init__(self, master, app) -> None:
        super().__init__(master)
        self.app = app
        self.label = tk.StringVar(value="codex")
        bar = ttk.Frame(self)
        bar.pack(fill="x", padx=6, pady=6)
        ttk.Label(bar, text="用途").pack(side="left")
        ttk.Entry(bar, textvariable=self.label, width=18).pack(side="left", padx=6)
        ttk.Button(bar, text="生成下游 Key", command=self._gen).pack(side="left")
        self.rows = ttk.Frame(self)
        self.rows.pack(fill="x", padx=6, pady=(0, 6))
        self.refresh()

    def refresh(self) -> None:
        for c in self.rows.winfo_children():
            c.destroy()
        for k in self.app.storage.list_client_keys():
            row = ttk.Frame(self.rows)
            row.pack(fill="x", pady=2)
            ttk.Label(row, text=k.label, width=10).pack(side="left")
            ttk.Label(row, text=k.key, foreground="#1a73e8").pack(side="left", padx=6)
            ttk.Button(
                row,
                text="复制",
                command=lambda kk=k: self._copy_key(kk),
            ).pack(side="left")
            ttk.Button(
                row,
                text="删除",
                command=lambda kk=k: self._delete_key(kk),
            ).pack(side="left", padx=4)

    def _copy_key(self, k) -> None:
        self.clipboard_clear()
        self.clipboard_append(k.key)

    def _delete_key(self, k) -> None:
        self.app.storage.delete_client_key(k.id)
        self.refresh()

    def _gen(self) -> None:
        raw = self.app.new_client_key(self.label.get() or "client")
        self.clipboard_clear()
        self.clipboard_append(raw)
        self.refresh()


class RulesPane(ttk.Frame):
    def __init__(self, master, app) -> None:
        super().__init__(master)
        self.app = app
        self.vars: dict[Rule, tk.BooleanVar] = {}
        self.retry_after_commit = tk.BooleanVar(value=False)

        ttk.Label(self, text="参与自动切换的状态（勾选 = 参与）").pack(anchor="w", padx=8, pady=(8, 4))
        for rule, label in RULE_LABELS.items():
            v = tk.BooleanVar(value=bool(app.settings.rules.get(rule, False)))
            self.vars[rule] = v
            ttk.Checkbutton(self, text=label, variable=v).pack(anchor="w", padx=20, pady=2)

        ttk.Separator(self).pack(fill="x", padx=8, pady=8)
        ttk.Label(self, text="危险开关").pack(anchor="w", padx=8)
        row = ttk.Frame(self)
        row.pack(anchor="w", padx=8, pady=4)
        cb = ttk.Checkbutton(
            row,
            text="已提交后重试",
            variable=self.retry_after_commit,
            command=self._on_danger_toggle,
        )
        cb.pack(side="left")
        self.warn = ttk.Label(row, text="", foreground="#b3261e")
        self.warn.pack(side="left", padx=8)
        ttk.Button(self, text="保存规则", command=self._save).pack(anchor="w", padx=8, pady=8)

    def _on_danger_toggle(self) -> None:
        if self.retry_after_commit.get():
            from tkinter import simpledialog

            ans = simpledialog.askstring(
                "危险操作确认",
                "开启「已提交后重试」后，响应已经发给下游后仍可能重放请求，\n"
                "可能导致内容重复或重复计费。\n\n"
                "确认请输入 OK：",
                parent=self,
            )
            if ans != "OK":
                self.retry_after_commit.set(False)
                self.warn.configure(text="")
                return
            self.warn.configure(text="⚠ 已提交后重试已开启，行为不可逆")
            self.configure(background="#ffe9e7")
        else:
            self.warn.configure(text="")
            self.configure(background="")

    def _save(self) -> None:
        s = self.app.settings
        for rule, v in self.vars.items():
            s.rules[rule] = bool(v.get())
        s.retry_after_commit = bool(self.retry_after_commit.get())
        self.app.save_settings(s)


class SettingsPane(ttk.Frame):
    @staticmethod
    def _local_ips() -> list[str]:
        ips = ["127.0.0.1", "0.0.0.0"]
        try:
            import socket

            host = socket.gethostname()
            for info in socket.getaddrinfo(host, None, socket.AF_INET):
                ip = info[4][0]
                if ip not in ips:
                    ips.append(ip)
        except Exception:
            pass
        return ips

    def __init__(self, master, app) -> None:
        super().__init__(master)
        self.app = app
        s = app.settings
        self.protocol = tk.StringVar(value=s.protocol)
        self.host = tk.StringVar(value=s.listen_host)
        self.port = tk.IntVar(value=s.listen_port)
        self.max_switch = tk.IntVar(value=s.max_switches_per_request)
        self.residency = tk.DoubleVar(value=s.min_residency_s)
        self.budget = tk.DoubleVar(value=s.precommit_budget_s)

        form = ttk.Frame(self)
        form.pack(fill="x", padx=8, pady=8)
        rows = [
            ("协议", ttk.Combobox(form, textvariable=self.protocol, values=["openai-responses", "openai-chat", "anthropic"], state="readonly", width=20)),
            ("监听地址", ttk.Combobox(form, textvariable=self.host, values=self._local_ips(), state="readonly", width=20)),
            ("监听端口", ttk.Entry(form, textvariable=self.port, width=20)),
            ("每请求最大切换", ttk.Entry(form, textvariable=self.max_switch, width=20)),
            ("最小驻留(秒)", ttk.Entry(form, textvariable=self.residency, width=20)),
            ("预提交预算(秒)", ttk.Entry(form, textvariable=self.budget, width=20)),
        ]
        for i, (label, widget) in enumerate(rows):
            ttk.Label(form, text=label).grid(row=i, column=0, sticky="w", pady=3)
            widget.grid(row=i, column=1, sticky="w", pady=3)
        btns = ttk.Frame(form)
        btns.grid(row=len(rows), column=0, columnspan=2, sticky="w", pady=8)
        ttk.Button(btns, text="保存设置", command=self._save).pack(side="left")
        ttk.Button(btns, text="复制 Codex 配置", command=self._copy_codex).pack(
            side="left", padx=8
        )

    def _copy_codex(self) -> None:
        """把当前网关地址与协议拼成一段可直接粘进 config.toml 的片段。"""
        s = self.app.settings
        wire = {"openai-responses": "responses", "openai-chat": "chat", "anthropic": "anthropic"}[
            s.protocol
        ]
        snippet = (
            "[model_providers.ha_gateway]\n"
            'name = "HA Gateway"\n'
            f'base_url = "http://{s.listen_host}:{s.listen_port}/v1/"\n'
            'env_key = "HA_GATEWAY_KEY"\n'
            f'wire_api = "{wire}"\n'
        )
        self.clipboard_clear()
        self.clipboard_append(snippet)
        messagebox.showinfo("已复制", "配置片段已复制到剪贴板")

    def _save(self) -> None:
        s = self.app.settings
        s.protocol = self.protocol.get()
        s.listen_host = self.host.get()
        s.listen_port = int(self.port.get())
        s.max_switches_per_request = int(self.max_switch.get())
        s.min_residency_s = float(self.residency.get())
        s.precommit_budget_s = float(self.budget.get())
        self.app.save_settings(s)
        messagebox.showinfo("已保存", "设置已保存，重启网关后生效")


class MainWindow(tk.Tk):
    def __init__(self, app) -> None:
        super().__init__()
        self.app = app
        self.title("HA Gateway — 高可用 LLM 网关")
        self.geometry("1240x800")
        self.minsize(900, 600)

        top = ttk.Frame(self)
        top.pack(fill="x", padx=8, pady=(8, 0))
        self.dot = tk.Label(top, text="●", foreground="#2e7d32", font=("Segoe UI", 11))
        self.dot.pack(side="left")
        self.status = tk.StringVar(value="")
        ttk.Label(top, textvariable=self.status).pack(side="left", padx=(4, 8))
        ttk.Button(top, text="复制地址", command=self._copy_addr).pack(side="left")
        ttk.Button(top, text="刷新拓扑", command=self._refresh_topology).pack(side="right")
        self.manage_btn = ttk.Button(top, text="管理", command=self._toggle_drawer)
        self.manage_btn.pack(side="right", padx=6)

        # 经典 Panedwindow：分隔条可拖拽
        paned = tk.PanedWindow(
            self, orient="horizontal", sashwidth=6, sashrelief="raised", bd=0
        )
        self.paned = paned
        paned.pack(fill="both", expand=True, padx=8, pady=8)
        self.topology = Topology(paned, app)
        paned.add(self.topology, minsize=360, stretch="always")

        right = ttk.Frame(paned)
        self.manage = ManagePane(right, app)
        self.manage.pack(fill="both", expand=True)
        self.right = right
        self.upstream_editor = self.manage.upstream_editor
        self.key_pane = self.manage.key_pane
        self.rules_pane = self.manage.rules_pane
        self.settings_pane = self.manage.settings_pane
        self.topology.on_select = self._on_node_select
        self.topology.on_changed = self._on_data_changed
        self.manage.on_collapse = lambda: self._toggle_drawer(False)
        self._drawer_open = False

        self.log_pane = LogPane(self, app)
        self.log_pane.pack(fill="both", expand=False)
        self.log_pane.configure(height=150)

        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.bind("<Escape>", lambda e: self._toggle_drawer(False))
        app.events.subscribe(self._on_event)
        self.upstream_editor.refresh()
        self.topology.redraw()
        self.after(1500, self._tick)

    def _on_data_changed(self) -> None:
        """拓扑上改了数据，刷新抽屉里的列表。"""
        self.upstream_editor.refresh()
        self.key_pane.refresh()

    def _copy_addr(self) -> None:
        s = self.app.settings
        url = f"http://{s.listen_host}:{s.listen_port}/v1/"
        self.clipboard_clear()
        self.clipboard_append(url)
        self.status.set(f"{url}　已复制")

    def _refresh_status(self) -> None:
        s = self.app.settings
        running = self.app._started.is_set()
        self.dot.configure(foreground="#2e7d32" if running else "#b3261e")
        self.status.set(
            f"{s.listen_host}:{s.listen_port}　{s.protocol}"
            + ("" if running else "　未监听")
        )

    # ---------- 右侧抽屉 ----------

    def _toggle_drawer(self, force: bool | None = None) -> None:
        open_now = (not self._drawer_open) if force is None else bool(force)
        if open_now:
            if not self._drawer_open:
                self.paned.add(self.right, minsize=360, width=500, stretch="never")
                self._drawer_open = True
                self.update_idletasks()
                total = max(self.paned.winfo_width(), 900)
                try:
                    self.paned.sashpos(0, total - 500)
                except Exception:
                    pass
                self.after(80, self.topology.redraw)
                self.after(120, self.topology.redraw_now)
            self.manage_btn.configure(text="◀")
        else:
            if self._drawer_open:
                try:
                    self.paned.forget(self.right)
                except Exception:
                    pass
                self._drawer_open = False
                self.after(80, self.topology.redraw)
                self.after(120, self.topology.redraw_now)
            self.manage_btn.configure(text="管理 ▶")

    def _toggle_arrow(self, open_now: bool) -> None:
        """抽屉开着时，顶部按钮变成收缩箭头。"""
        self.manage_btn.configure(text="◀" if open_now else "管理 ▶")

    def _on_node_select(self, kind: str, ident) -> None:
        if kind == "blank":
            return
        self._toggle_drawer(True)
        if kind == "upstream":
            self.manage.show_section("upstream")
            self.upstream_editor.select_upstream(ident)
        elif kind == "slot":
            self.manage.show_section("upstream")
            self.upstream_editor.focus_form()
        elif kind == "key":
            self.manage.show_section("key")
        elif kind == "key_add":
            self.manage.show_section("key")
        elif kind == "gw":
            self.manage.show_section("rules")

    def _on_event(self, ev: dict) -> None:
        if ev.get("kind") == "route_active" and ev.get("detail"):
            self.topology.on_route(ev["detail"])

    def _tick(self) -> None:
        self.topology.redraw()
        self.upstream_editor.refresh()
        self._refresh_status()
        self.after(2000, self._tick)

    def _refresh_topology(self) -> None:
        self.topology.redraw()
        self.upstream_editor.refresh()

    def _on_close(self) -> None:
        # 关窗口不杀网关：有托盘就收进托盘，否则才真退出
        if getattr(self, "tray_available", False):
            self.withdraw()
        else:
            self.destroy()
