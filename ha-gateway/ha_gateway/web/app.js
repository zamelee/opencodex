const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let STATE = { upstreams: [], keys: [], settings: {}, running: false };
let activeUpstream = null;   // 拓扑里当前活跃的上游 id
let selectedRow = null;       // 抽屉表格里选中的上游 id
let popover = null;           // 就地编辑卡
let logSeen = 0;

const RULE_LABELS = {
  connect_fail: "连接失败 / DNS 失败",
  upstream_5xx: "上游 5xx",
  upstream_429: "上游 429（限流）",
  upstream_4xx: "上游 4xx（除 429）",
  post_commit_break: "已提交后断流",
};
const SLOT_NAMES = ["主通道", "备通道", "通道 3", "通道 4"];

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---------- 状态 ----------

async function loadState() {
  STATE = await api("/api/state");
  renderTop();
  renderTopology();
  renderTable();
  renderKeys();
  renderRules();
  renderSettings();
}

function renderTop() {
  const s = STATE.settings;
  $("#dot").className = "dot" + (STATE.running ? "" : " off");
  $("#addr").textContent = `${s.listen_host}:${s.listen_port}`;
  $("#proto").textContent = s.protocol;
}

// ---------- 拓扑 ----------

function layout() {
  const stage = $("#stage");
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const ups = STATE.upstreams;
  const keys = STATE.keys;
  const slotCount = Math.max(2, ups.length);

  const spread = (n, width) => {
    if (!n) return [];
    const span = Math.min(width - 80, n * 200);
    const step = span / n;
    return Array.from({ length: n }, (_, i) => (width - span) / 2 + step * i + step / 2);
  };

  const upX = spread(slotCount, w);
  const keyX = spread(keys.length, w);
  const gw = { x: w / 2, y: h / 2 };
  const topY = 64;
  const botY = h - 76;
  return { w, h, ups, keys, slotCount, upX, keyX, gw, topY, botY };
}

function healthClass(u) {
  if (u.health === "down") return "bad";
  if (u.health === "degraded") return "warn";
  return "";
}

function renderTopology() {
  const L = layout();
  const nodes = $("#nodes");
  const svg = $("#wires");
  nodes.innerHTML = "";
  svg.innerHTML = "";
  $("#emptyHint").classList.toggle("hidden", L.ups.length > 0);

  const edges = [];
  for (let i = 0; i < L.slotCount; i++) {
    const u = L.ups[i];
    const x = L.upX[i];
    if (u) {
      edges.push({ kind: "up", owner: u.id, x1: x, y1: L.topY + 26, x2: L.gw.x, y2: L.gw.y });
    } else {
      edges.push({ kind: "ghost", owner: `slot${i}`, x1: x, y1: L.topY + 26, x2: L.gw.x, y2: L.gw.y });
    }
  }
  L.keys.forEach((k, i) => {
    edges.push({ kind: "down", owner: k.id, x1: L.gw.x, y1: L.gw.y, x2: L.keyX[i], y2: L.botY - 26 });
  });

  edges.forEach((e) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", e.x1);
    line.setAttribute("y1", e.y1);
    line.setAttribute("x2", e.x2);
    line.setAttribute("y2", e.y2);
    const isActive = e.kind === "up" && e.owner === activeUpstream;
    line.setAttribute("stroke", isActive ? "#1a73e8" : e.kind === "ghost" ? "#dfe3e8" : "#d5d9e0");
    line.setAttribute("stroke-width", "2");
    if (e.kind === "ghost") line.setAttribute("stroke-dasharray", "4 4");
    svg.appendChild(line);
    e.line = line;
  });

  // 上游节点（含空槽位）
  for (let i = 0; i < L.slotCount; i++) {
    const u = L.ups[i];
    const x = L.upX[i];
    const n = el("div", "node");
    n.style.left = x + "px";
    n.style.top = L.topY + "px";
    const tag = el("div", "slot-tag", SLOT_NAMES[i] || `通道 ${i + 1}`);
    n.appendChild(tag);
    if (u) {
      const hc = healthClass(u);
      if (hc) n.classList.add(hc);
      n.appendChild(el("div", "n-title", u.name));
      n.appendChild(el("div", "n-sub", u.health === "down" ? u.provider + " · 不可用" : u.provider));
      n.onclick = (ev) => {
        ev.stopPropagation();
        openPopover("upstream", u, ev.clientX, ev.clientY);
      };
    } else {
      n.classList.add("ghost");
      n.appendChild(el("div", "n-title", "未配置"));
      n.appendChild(el("div", "n-sub", "点击添加上游"));
      n.onclick = (ev) => {
        ev.stopPropagation();
        openPopover("slot", { slot: i }, ev.clientX, ev.clientY);
      };
    }
    nodes.appendChild(n);
  }

  // 网关
  const gw = el("div", "node gateway");
  gw.style.left = L.gw.x + "px";
  gw.style.top = L.gw.y + "px";
  gw.appendChild(el("div", "n-title", "HA Gateway"));
  gw.appendChild(el("div", "n-sub", "HA 高可用网关"));
  gw.onclick = (ev) => {
    ev.stopPropagation();
    openPopover("gw", null, ev.clientX, ev.clientY);
  };
  nodes.appendChild(gw);

  // 下游 key
  L.keys.forEach((k, i) => {
    const n = el("div", "node down");
    n.style.left = L.keyX[i] + "px";
    n.style.top = L.botY + "px";
    n.appendChild(el("div", "n-title", k.label));
    n.appendChild(el("div", "n-sub", k.key.slice(0, 16) + "…"));
    n.onclick = (ev) => {
      ev.stopPropagation();
      openPopover("key", k, ev.clientX, ev.clientY);
    };
    nodes.appendChild(n);
  });
  const addK = el("div", "node ghost");
  addK.style.left = Math.min((L.keyX[L.keyX.length - 1] || L.gw.x) + 185, L.w - 96) + "px";
  addK.style.top = L.botY + "px";
  addK.appendChild(el("div", "n-title", "＋"));
  addK.appendChild(el("div", "n-sub", "新增下游 Key"));
  addK.onclick = () => openDrawer("key");
  nodes.appendChild(addK);
}

// ---------- 就地编辑卡 ----------

function closePopover() {
  if (popover) popover.remove();
  popover = null;
}

function openPopover(kind, obj, cx, cy) {
  closePopover();
  const p = el("div", "popover");
  p.style.left = cx + 14 + "px";
  p.style.top = cy + 12 + "px";

  const f = el("div", "form");
  const mk = (label, value, id, type) => {
    const l = el("label", null, label);
    const i = el("input");
    i.id = id;
    i.value = value || "";
    if (type) i.type = type;
    l.appendChild(i);
    f.appendChild(l);
    return i;
  };

  if (kind === "upstream" || kind === "slot") {
    p.appendChild(el("div", "po-title", kind === "slot" ? "新增上游" : "编辑上游"));
    mk("名称", obj.name, "p_name");
    mk("Provider", obj.provider, "p_provider");
    mk("Base URL", obj.base_url, "p_base");
    mk("API Key", "", "p_key", "password");
    const row = el("div", "row");
    const save = el("button", "btn primary", kind === "slot" ? "添加" : "保存");
    save.onclick = async () => {
      const body = {
        name: $("#p_name").value,
        provider: $("#p_provider").value,
        base_url: $("#p_base").value,
        api_key: $("#p_key").value,
      };
      if (!body.name || !body.base_url) return alert("名称与 Base URL 必填");
      if (kind === "slot") await api("/api/upstreams", { method: "POST", headers: jsonH(), body: JSON.stringify(body) });
      else await api("/api/upstreams/" + obj.id, { method: "PUT", headers: jsonH(), body: JSON.stringify(body) });
      closePopover();
      loadState();
    };
    row.appendChild(save);
    if (kind === "upstream") {
      const probe = el("button", "btn", "探测");
      probe.onclick = async () => {
        const res = await api("/api/upstreams/" + obj.id + "/probe", { method: "POST" });
        alert(`HTTP ${res.status}\n耗时 ${res.ms}ms\n\n${res.body || ""}`);
      };
      row.appendChild(probe);
      const del = el("button", "btn danger", "删除");
      del.onclick = async () => {
        await api("/api/upstreams/" + obj.id, { method: "DELETE" });
        closePopover();
        loadState();
      };
      row.appendChild(del);
    }
    const cancel = el("button", "btn ghost", "取消");
    cancel.onclick = closePopover;
    row.appendChild(cancel);
    f.appendChild(row);
    p.appendChild(f);
  } else if (kind === "key") {
    p.appendChild(el("div", "po-title", "下游 Key"));
    p.appendChild(el("div", "po-key", obj.key));
    const row = el("div", "row");
    const cp = el("button", "btn primary", "复制");
    cp.onclick = () => {
      navigator.clipboard.writeText(obj.key);
      cp.textContent = "已复制";
    };
    row.appendChild(cp);
    const del = el("button", "btn danger", "删除");
    del.onclick = async () => {
      await api("/api/keys/" + obj.id, { method: "DELETE" });
      closePopover();
      loadState();
    };
    row.appendChild(del);
    const cancel = el("button", "btn ghost", "取消");
    cancel.onclick = closePopover;
    row.appendChild(cancel);
    p.appendChild(row);
  } else if (kind === "gw") {
    const s = STATE.settings;
    p.appendChild(el("div", "po-title", "HA Gateway"));
    p.appendChild(el("div", "po-line", `协议　${s.protocol}`));
    p.appendChild(el("div", "po-line", `监听　${s.listen_host}:${s.listen_port}`));
    p.appendChild(el("div", "po-line", `上游　${STATE.upstreams.length} 条`));
    const row = el("div", "row");
    const open = el("button", "btn primary", "打开管理");
    open.onclick = () => {
      closePopover();
      openDrawer("settings");
    };
    row.appendChild(open);
    const cancel = el("button", "btn ghost", "取消");
    cancel.onclick = closePopover;
    row.appendChild(cancel);
    p.appendChild(row);
  }

  document.body.appendChild(p);
  popover = p;
}

function jsonH() {
  return { "Content-Type": "application/json" };
}

// ---------- 抽屉 ----------

function openDrawer(section) {
  $("#drawer").classList.remove("hidden");
  $("#toggleDrawer").textContent = "◀";
  if (section) {
    const target = { upstream: ".sec:nth-of-type(1)", key: ".sec:nth-of-type(2)", rules: ".sec:nth-of-type(3)", settings: ".sec:nth-of-type(4)" }[section];
    const node = document.querySelector(target);
    if (node) node.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
  $("#toggleDrawer").textContent = "管理 ▶";
}

function renderTable() {
  const tb = $("#upTable tbody");
  tb.innerHTML = "";
  STATE.upstreams.forEach((u) => {
    const tr = el("tr");
    if (u.id === selectedRow) tr.className = "sel";
    const st = { healthy: "正常", degraded: "降级", down: "不可用" }[u.health];
    const cls = { healthy: "ok", degraded: "warn", down: "bad" }[u.health];
    tr.appendChild(el("td", null, u.name));
    tr.appendChild(el("td", null, u.provider));
    tr.appendChild(el("td", null, u.base_url));
    tr.appendChild(el("td", cls, st));
    tr.onclick = () => {
      selectedRow = u.id;
      $("#u_name").value = u.name;
      $("#u_provider").value = u.provider;
      $("#u_base").value = u.base_url;
      $("#u_key").value = "";
      renderTable();
    };
    tb.appendChild(tr);
  });
}

function renderKeys() {
  const box = $("#keyList");
  box.innerHTML = "";
  STATE.keys.forEach((k) => {
    const row = el("div", "krow");
    row.appendChild(el("span", "kname", k.label));
    row.appendChild(el("span", "kval", k.key));
    const cp = el("button", "btn ghost", "复制");
    cp.onclick = () => {
      navigator.clipboard.writeText(k.key);
      cp.textContent = "已复制";
    };
    const del = el("button", "btn danger", "删除");
    del.onclick = async () => {
      await api("/api/keys/" + k.id, { method: "DELETE" });
      loadState();
    };
    row.appendChild(cp);
    row.appendChild(del);
    box.appendChild(row);
  });
}

function renderRules() {
  const box = $("#ruleList");
  box.innerHTML = "";
  const rules = STATE.settings.rules || {};
  Object.keys(RULE_LABELS).forEach((k) => {
    const l = el("label");
    const i = el("input");
    i.type = "checkbox";
    i.checked = !!rules[k];
    i.dataset.rule = k;
    l.appendChild(i);
    l.appendChild(el("span", null, RULE_LABELS[k]));
    box.appendChild(l);
  });
  const retry = $("#r_retry");
  retry.checked = !!STATE.settings.retry_after_commit;
  retry.parentElement.classList.toggle("on", retry.checked);
}

function renderSettings() {
  const s = STATE.settings;
  $("#s_protocol").value = s.protocol;
  $("#s_host").value = s.listen_host;
  $("#s_port").value = s.listen_port;
  $("#s_switch").value = s.max_switches_per_request;
  $("#s_residency").value = s.min_residency_s;
  $("#s_budget").value = s.precommit_budget_s;
}

// ---------- 日志 ----------

async function loadEvents() {
  const evs = await api("/api/events?limit=200");
  const body = $("#logBody");
  evs.forEach((e) => {
    if (e.ts * 1000 <= logSeen) return;
    logSeen = e.ts * 1000;
    const line = el("div");
    const ts = el("span", "ts", "[" + fmtTs(e.ts) + "] ");
    line.appendChild(ts);
    const body2 = el("span", e.level, e.level.toUpperCase().padEnd(5) + " " + e.message);
    line.appendChild(body2);
    body.appendChild(line);
  });
  const box = $("#logBody");
  if ($("#logFollow").checked) box.scrollTop = box.scrollHeight;
}

function fmtTs(ts) {
  const d = new Date(ts * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ---------- 事件绑定 ----------

$("#toggleDrawer").onclick = () => {
  const d = $("#drawer");
  d.classList.contains("hidden") ? openDrawer() : closeDrawer();
};
$("#closeDrawer").onclick = closeDrawer;
$("#refresh").onclick = loadState;
$("#copyAddr").onclick = () => {
  const s = STATE.settings;
  const url = `http://${s.listen_host}:${s.listen_port}/v1/`;
  navigator.clipboard.writeText(url);
  $("#copyAddr").textContent = "已复制";
  setTimeout(() => ($("#copyAddr").textContent = "复制地址"), 1200);
};

$("#u_add").onclick = async () => {
  const body = {
    name: $("#u_name").value,
    provider: $("#u_provider").value,
    base_url: $("#u_base").value,
    api_key: $("#u_key").value,
  };
  if (!body.name || !body.base_url) return alert("名称与 Base URL 必填");
  await api("/api/upstreams", { method: "POST", headers: jsonH(), body: JSON.stringify(body) });
  ["u_name", "u_provider", "u_base", "u_key"].forEach((i) => ($("#" + i).value = ""));
  loadState();
};

$("#u_update").onclick = async () => {
  if (!selectedRow) return alert("请先在表格里选中一行");
  const body = {
    name: $("#u_name").value,
    provider: $("#u_provider").value,
    base_url: $("#u_base").value,
  };
  if ($("#u_key").value) body.api_key = $("#u_key").value;
  await api("/api/upstreams/" + selectedRow, { method: "PUT", headers: jsonH(), body: JSON.stringify(body) });
  loadState();
};

$("#u_delete").onclick = async () => {
  if (!selectedRow) return alert("请先在表格里选中一行");
  await api("/api/upstreams/" + selectedRow, { method: "DELETE" });
  selectedRow = null;
  loadState();
};

$("#u_probe").onclick = async () => {
  if (!selectedRow) return alert("请先在表格里选中一行");
  const res = await api("/api/upstreams/" + selectedRow + "/probe", { method: "POST" });
  alert(`HTTP ${res.status}\n耗时 ${res.ms}ms\n\n${res.body || ""}`);
};

$("#k_add").onclick = async () => {
  const res = await api("/api/keys", { method: "POST", headers: jsonH(), body: JSON.stringify({ label: $("#k_label").value || "client" }) });
  navigator.clipboard.writeText(res.key);
  alert("已生成并复制：\n" + res.key);
  loadState();
};

$("#r_retry").onchange = async (ev) => {
  const on = ev.target.checked;
  if (on) {
    const ans = prompt("开启后，已提交给下游的请求仍可能重放，可能重复内容或重复计费。\n确认请输入 OK：");
    if (ans !== "OK") {
      ev.target.checked = false;
      ev.target.parentElement.classList.remove("on");
      return;
    }
    ev.target.parentElement.classList.add("on");
  } else {
    ev.target.parentElement.classList.remove("on");
  }
};

$("#r_save").onclick = async () => {
  const rules = {};
  document.querySelectorAll("#ruleList input").forEach((i) => (rules[i.dataset.rule] = i.checked));
  await api("/api/rules", {
    method: "PUT",
    headers: jsonH(),
    body: JSON.stringify({ rules, retry_after_commit: $("#r_retry").checked }),
  });
  loadState();
};

$("#s_save").onclick = async () => {
  const body = {
    protocol: $("#s_protocol").value,
    listen_host: $("#s_host").value,
    listen_port: Number($("#s_port").value),
    max_switches_per_request: Number($("#s_switch").value),
    min_residency_s: Number($("#s_residency").value),
    precommit_budget_s: Number($("#s_budget").value),
  };
  await api("/api/settings", { method: "PUT", headers: jsonH(), body: JSON.stringify(body) });
  loadState();
};

$("#s_copy").onclick = () => {
  const s = STATE.settings;
  const wire = { "openai-responses": "responses", "openai-chat": "chat", anthropic: "anthropic" }[s.protocol];
  const snippet =
    `[model_providers.ha_gateway]\nname = "HA Gateway"\nbase_url = "http://${s.listen_host}:${s.listen_port}/v1/"\nenv_key = "HA_GATEWAY_KEY"\nwire_api = "${wire}"\n`;
  navigator.clipboard.writeText(snippet);
  alert("配置片段已复制");
};

$("#logClear").onclick = () => ($("#logBody").innerHTML = "");
$("#logBody").addEventListener("scroll", (e) => {
  const b = e.target;
  if (b.scrollTop + b.clientHeight < b.scrollHeight - 8) $("#logFollow").checked = false;
});

document.addEventListener("click", (ev) => {
  if (popover && !popover.contains(ev.target)) closePopover();
});
window.addEventListener("resize", renderTopology);
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    closePopover();
    closeDrawer();
  }
});

// ---------- 启动 ----------

loadState();
setInterval(loadState, 2000);
setInterval(loadEvents, 2000);
setInterval(async () => {
  try {
    const evs = await api("/api/events?limit=5");
    evs.forEach((e) => {
      if (e.kind === "route_active") {
        activeUpstream = e.detail;
        renderTopology();
      }
    });
  } catch (e) {}
}, 1000);
