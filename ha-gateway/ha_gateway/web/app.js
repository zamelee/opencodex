const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let STATE = { upstreams: [], keys: [], settings: {}, running: false };
let activeUpstream = null;    // 拓扑里当前活跃的上游 id
let selected = null;          // {kind:"upstream"|"key"|"gw", id}
let draft = null;             // 当前对象的草稿
let logSeen = 0;
let nodePos = {};             // 节点 id -> {x,y}

const RULE_LABELS = {
  connect_fail: "连接失败 / DNS 失败",
  upstream_5xx: "上游 5xx",
  upstream_429: "上游 429（限流）",
  upstream_4xx: "上游 4xx（除 429）",
  post_commit_break: "已提交后断流",
};
const SLOT_NAMES = ["主通道", "备通道", "通道 3", "通道 4"];
const PROTOCOLS = ["openai-responses", "openai-chat", "anthropic"];

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
function jsonH() {
  return { "Content-Type": "application/json" };
}

// ---------- 状态 ----------

async function loadState() {
  STATE = await api("/api/state");
  renderTop();
  renderTopology();
  if (!isEditing()) {
    rebuildDraft();
    renderPanels();
  }
}

function isEditing() {
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "SELECT")) {
    if (a.closest("#inline") || a.closest("#gwConsole") || a.closest("#dockBody")) return true;
  }
  return !!(draft && draft.dirty);
}

function renderTop() {
  const s = STATE.settings;
  $("#dot").className = "dot" + (STATE.running ? "" : " off");
  $("#addr").textContent = `${s.listen_host}:${s.listen_port}`;
  $("#proto").textContent = s.protocol;
}

// ---------- 草稿 ----------

function rebuildDraft() {
  if (!selected) {
    draft = null;
    return;
  }
  if (selected.kind === "upstream") {
    const u = STATE.upstreams.find((x) => x.id === selected.id);
    if (!u) return;
    draft = {
      kind: "upstream",
      id: u.id,
      isNew: false,
      fields: { name: u.name, provider: u.provider, base_url: u.base_url, api_key: "" },
      dirty: false,
    };
  } else if (selected.kind === "key") {
    draft = { kind: "key", id: selected.id, fields: {}, dirty: false };
  } else if (selected.kind === "gw") {
    const s = STATE.settings;
    draft = {
      kind: "gw",
      id: "gw",
      fields: {
        protocol: s.protocol,
        listen_host: s.listen_host,
        listen_port: s.listen_port,
        max_switches_per_request: s.max_switches_per_request,
        min_residency_s: s.min_residency_s,
        precommit_budget_s: s.precommit_budget_s,
      },
      rules: Object.assign({}, s.rules || {}),
      retry: !!s.retry_after_commit,
      dirty: false,
    };
  }
}

function setField(name, value) {
  if (!draft) return;
  draft.fields[name] = value;
  draft.dirty = true;
  syncField(name, value);
}

function syncField(name, value) {
  $$(`[data-field="${name}"]`).forEach((i) => {
    if (i === document.activeElement) return;
    if (i.type === "checkbox") i.checked = !!value;
    else i.value = value;
  });
}

function syncRule(name, value) {
  if (!draft) return;
  draft.rules[name] = value;
  draft.dirty = true;
  $$(`[data-rule="${name}"]`).forEach((i) => {
    if (i !== document.activeElement) i.checked = !!value;
  });
}

// ---------- 脏数据拦截 ----------

function askSaveCancel() {
  return new Promise((resolve) => {
    const bar = el("div", "dirty-bar");
    bar.appendChild(el("span", null, "当前对象有未保存的修改"));
    const save = el("button", "btn primary", "保存并继续");
    save.onclick = async () => {
      bar.remove();
      resolve(await saveDraft());
    };
    const cancel = el("button", "btn", "取消");
    cancel.onclick = () => {
      bar.remove();
      rebuildDraft();
      renderPanels();
      resolve(false);
    };
    const discard = el("button", "btn ghost", "放弃并切换");
    discard.onclick = () => {
      bar.remove();
      rebuildDraft();
      resolve(true);
    };
    bar.appendChild(save);
    bar.appendChild(cancel);
    bar.appendChild(discard);
    $("#stage").appendChild(bar);
  });
}

async function guard() {
  if (!draft || !draft.dirty) return true;
  return await askSaveCancel();
}

async function selectObject(kind, id) {
  if (selected && selected.kind === kind && selected.id === id) return;
  if (!(await guard())) return;
  selected = { kind, id };
  rebuildDraft();
  renderTopology();
  renderPanels();
  if (kind === "gw") focusGwConsole();
}

async function deselect() {
  if (!(await guard())) return;
  selected = null;
  draft = null;
  renderTopology();
  renderPanels();
}

// ---------- 拓扑 ----------

function layout() {
  const stage = $("#stage");
  const sw = stage.clientWidth;
  const h = stage.clientHeight;
  const ups = STATE.upstreams;
  const keys = STATE.keys;
  const slotCount = Math.max(2, ups.length);

  // 网关控制台打开时，给它留出位置，拓扑在剩余区域里居中，避免遮挡
  const drawerOpen = !$("#drawer").classList.contains("hidden");
  const gwOpen = !!(draft && draft.kind === "gw");
  // 控制台只在画布上出现（抽屉关闭时），此时它占左侧，画布整体右移
  const compact = sw < 760;
  const off = gwOpen && !drawerOpen && !compact ? 344 : 0;
  const w = sw - off;

  const spread = (n, width) => {
    if (!n) return [];
    const step = Math.max(150, Math.min(200, (width - 40) / n));
    const span = Math.min(width - 30, step * n);
    return Array.from({ length: n }, (_, i) => off + (width - span) / 2 + step * i + step / 2);
  };

  const upX = spread(slotCount + 1, w);
  // 下游只有一个 Key 时居中放置，多个时才平铺
  let keyX;
  if (keys.length === 0) keyX = [off + w / 2];
  else if (keys.length === 1) keyX = [off + w / 2, Math.min(off + w / 2 + 190, off + w - 90)];
  else keyX = spread(keys.length + 1, w);
  const gw = { x: off + w / 2, y: h / 2 };
  const topY = 64;
  const botY = h - 76;
  return { w, h, ups, keys, slotCount, upX, keyX, gw, topY, botY, addX: upX[slotCount] };
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
  nodePos = {};
  nodePos.__gw = { x: L.gw.x, y: L.gw.y };
  $("#emptyHint").classList.toggle("hidden", L.ups.length > 0);

  const edges = [];
  for (let i = 0; i < L.slotCount; i++) {
    const u = L.ups[i];
    edges.push({
      kind: u ? "up" : "ghost",
      x1: L.upX[i],
      y1: L.topY + 26,
      x2: L.gw.x,
      y2: L.gw.y,
    });
  }
  L.keys.forEach((k, i) => {
    edges.push({ kind: "down", x1: L.gw.x, y1: L.gw.y, x2: L.keyX[i], y2: L.botY - 26 });
  });

  edges.forEach((e) => {
    const dy = (e.y2 - e.y1) * 0.55;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      `M ${e.x1} ${e.y1} C ${e.x1} ${e.y1 + dy}, ${e.x2} ${e.y2 - dy}, ${e.x2} ${e.y2}`
    );
    const isActive = e.kind === "up" && e.owner === activeUpstream;
    path.setAttribute("stroke", isActive ? "#1a73e8" : e.kind === "ghost" ? "#dfe3e8" : "#d5d9e0");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("fill", "none");
    if (e.kind === "ghost") path.setAttribute("stroke-dasharray", "4 4");
    svg.appendChild(path);
  });

  // 上游节点（含空槽位）
  for (let i = 0; i < L.slotCount; i++) {
    const u = L.ups[i];
    const x = L.upX[i];
    const n = el("div", "node");
    n.style.left = x + "px";
    n.style.top = L.topY + "px";
    if (u) {
      nodePos[u.id] = { x, y: L.topY };
      if (selected && selected.kind === "upstream" && selected.id === u.id) n.classList.add("sel");
      const hc = healthClass(u);
      if (hc) n.classList.add(hc);
      n.appendChild(el("div", "slot-tag", SLOT_NAMES[i] || `通道 ${i + 1}`));
      n.appendChild(el("div", "n-title", u.name));
      n.appendChild(el("div", "n-sub", u.health === "down" ? u.provider + " · 不可用" : u.provider));
      n.onclick = (ev) => {
        ev.stopPropagation();
        selectObject("upstream", u.id);
      };
    } else {
      n.classList.add("ghost");
      n.appendChild(el("div", "slot-tag", SLOT_NAMES[i] || `通道 ${i + 1}`));
      n.appendChild(el("div", "n-title", "未配置"));
      n.appendChild(el("div", "n-sub", "点击添加上游"));
      n.onclick = (ev) => {
        ev.stopPropagation();
        newUpstream();
      };
    }
    nodes.appendChild(n);
  }

  // 行末：新增上游通道的虚线方块
  const addX = L.addX;
  nodePos.__new__ = { x: addX, y: L.topY };
  const addU = el("div", "node ghost");
  addU.style.left = addX + "px";
  addU.style.top = L.topY + "px";
  addU.appendChild(el("div", "slot-tag", "新增"));
  addU.appendChild(el("div", "n-title", "＋"));
  addU.appendChild(el("div", "n-sub", "新增上游通道"));
  addU.onclick = (ev) => {
    ev.stopPropagation();
    newUpstream();
  };
  nodes.appendChild(addU);

  // 网关
  const gw = el("div", "node gateway");
  gw.style.left = L.gw.x + "px";
  gw.style.top = L.gw.y + "px";
  if (selected && selected.kind === "gw") gw.classList.add("sel");
  gw.appendChild(el("div", "n-title", "HA Gateway"));
  gw.appendChild(el("div", "n-sub", "HA 高可用网关"));
  gw.onclick = (ev) => {
    ev.stopPropagation();
    selectObject("gw", "gw");
  };
  nodes.appendChild(gw);

  // 下游 key
  L.keys.forEach((k, i) => {
    const n = el("div", "node down");
    n.style.left = L.keyX[i] + "px";
    n.style.top = L.botY + "px";
    if (selected && selected.kind === "key" && selected.id === k.id) n.classList.add("sel");
    n.appendChild(el("div", "n-title", k.label));
    n.appendChild(el("div", "n-sub mono", k.key.slice(0, 16) + "…"));
    const acts = el("div", "node-actions");
    const cp = el("button", null, "复制");
    cp.title = "复制 Key";
    cp.onclick = (ev) => {
      ev.stopPropagation();
      navigator.clipboard.writeText(k.key);
      cp.textContent = "已复制";
      setTimeout(() => (cp.textContent = "复制"), 1200);
    };
    const del = el("button", "danger", "删除");
    del.title = "删除该 Key";
    del.onclick = (ev) => {
      ev.stopPropagation();
      deleteKey(k);
    };
    acts.appendChild(cp);
    acts.appendChild(del);
    n.appendChild(acts);
    n.onclick = (ev) => {
      ev.stopPropagation();
      selectObject("key", k.id);
    };
    nodes.appendChild(n);
  });
  const addK = el("div", "node ghost");
  addK.style.left = L.keyX[L.keyX.length - 1] + "px";
  addK.style.top = L.botY + "px";
  addK.appendChild(el("div", "n-title", "＋"));
  addK.appendChild(el("div", "n-sub", "新增下游 Key"));
  addK.onclick = (ev) => {
    ev.stopPropagation();
    newKey();
  };
  nodes.appendChild(addK);
}

// ---------- 面板渲染 ----------

function renderPanels() {
  renderInline();
  renderGwConsole();
  renderDock();
}

function field(label, name, value, type, placeholder) {
  const l = el("label");
  l.appendChild(el("span", null, label));
  const i = el("input");
  i.type = type || "text";
  i.value = value === undefined || value === null ? "" : value;
  i.dataset.field = name;
  if (placeholder) i.placeholder = placeholder;
  i.oninput = () => setField(name, i.type === "number" ? Number(i.value) : i.value);
  l.appendChild(i);
  return l;
}

// 名称输入：清空后在失焦时恢复默认名（新建上游时自动填好，可改）
function nameField(draft) {
  const l = field("名称", "name", draft.fields.name, null, draft.defaultName || "");
  const i = l.querySelector("input");
  i.onblur = () => {
    if (!i.value.trim() && draft.defaultName) setField("name", draft.defaultName);
  };
  return l;
}

function selectField(label, name, value, options) {
  const l = el("label");
  l.appendChild(el("span", null, label));
  const s = el("select");
  s.dataset.field = name;
  options.forEach((o) => {
    const opt = el("option", null, o);
    opt.value = o;
    if (o === value) opt.selected = true;
    s.appendChild(opt);
  });
  s.onchange = () => setField(name, s.value);
  l.appendChild(s);
  return l;
}

function renderInline() {
  const box = $("#inline");
  box.innerHTML = "";
  if (!draft || draft.kind !== "upstream") {
    box.classList.add("hidden");
    return;
  }
  const pos = nodePos[draft.id];
  const stage = $("#stage");
  const w = stage.clientWidth;
  box.classList.remove("hidden");
  if (pos) {
    const left = Math.min(Math.max(8, pos.x - 90), w - 296);
    box.style.left = left + "px";
    box.style.top = Math.max(8, pos.y + 32) + "px";
  }
  box.appendChild(el("div", "po-title", draft.isNew ? "新增上游通道" : "上游通道"));
  const f = el("div", "form");
  f.appendChild(nameField(draft));
  f.appendChild(field("Provider", "provider", draft.fields.provider));
  f.appendChild(field("Base URL", "base_url", draft.fields.base_url));
  f.appendChild(field("API Key", "api_key", draft.fields.api_key, "password", "留空则不修改"));
  box.appendChild(f);
  const row = el("div", "row");
  const save = el("button", "btn primary", draft.isNew ? "添加" : "保存");
  save.onclick = () => saveDraft();
  row.appendChild(save);
  if (!draft.isNew) {
    const probe = el("button", "btn", "探测");
    probe.onclick = () => probeUpstream(draft.id);
    row.appendChild(probe);
    const del = el("button", "btn danger", "删除");
    del.onclick = () => deleteUpstream(draft.id);
    row.appendChild(del);
  }
  box.appendChild(row);
}

function renderGwConsole() {
  const box = $("#gwConsole");
  box.innerHTML = "";
  if (!draft || draft.kind !== "gw") {
    box.classList.add("hidden");
    renderGwLink();
    return;
  }
  // 右侧抽屉打开时，配置内容搬进抽屉，画布左侧不再显示控制台
  if (!$("#drawer").classList.contains("hidden")) {
    box.classList.add("hidden");
    renderGwLink();
    return;
  }
  box.classList.remove("hidden");
  const stage = $("#stage");
  box.classList.toggle("compact", stage.clientWidth < 760);
  box.appendChild(el("div", "po-title", "网关控制台"));
  box.appendChild(el("div", "hint", "网关与故障转移的核心设置，改动后点「保存应用」。"));
  box.appendChild(gwControls());
  renderGwLink();
}

// 网关控制台的控件组（画布控制台与右侧抽屉共用）
function gwControls() {
  const wrap = el("div");
  const f = el("div", "form");
  f.appendChild(selectField("协议", "protocol", draft.fields.protocol, PROTOCOLS));
  f.appendChild(field("监听主机", "listen_host", draft.fields.listen_host));
  f.appendChild(field("监听端口", "listen_port", draft.fields.listen_port, "number"));
  f.appendChild(field("单请求最大切换", "max_switches_per_request", draft.fields.max_switches_per_request, "number"));
  f.appendChild(field("最小驻留(秒)", "min_residency_s", draft.fields.min_residency_s, "number"));
  f.appendChild(field("提交前预算(秒)", "precommit_budget_s", draft.fields.precommit_budget_s, "number"));
  wrap.appendChild(f);

  wrap.appendChild(el("div", "sub-title", "触发自动切换的状态"));
  const rules = el("div", "rules");
  Object.keys(RULE_LABELS).forEach((k) => {
    const l = el("label");
    const i = el("input");
    i.type = "checkbox";
    i.dataset.rule = k;
    i.checked = !!draft.rules[k];
    i.onchange = () => syncRule(k, i.checked);
    l.appendChild(i);
    l.appendChild(el("span", null, RULE_LABELS[k]));
    rules.appendChild(l);
  });
  wrap.appendChild(rules);

  const dz = el("div", "danger-zone");
  const rl = el("label");
  const ri = el("input");
  ri.type = "checkbox";
  ri.dataset.retry = "1";
  ri.checked = draft.retry;
  ri.onchange = () => {
    if (ri.checked) {
      const ans = prompt("开启后，已提交给下游的请求仍可能重放，可能重复内容或重复计费。\n确认请输入 OK：");
      if (ans !== "OK") {
        ri.checked = false;
        return;
      }
    }
    draft.retry = ri.checked;
    draft.dirty = true;
    dz.classList.toggle("on", ri.checked);
  };
  rl.appendChild(ri);
  rl.appendChild(el("span", null, "已提交后仍重试（危险）"));
  dz.appendChild(rl);
  dz.classList.toggle("on", draft.retry);
  wrap.appendChild(dz);

  const row = el("div", "row");
  const save = el("button", "btn primary", "保存应用");
  save.onclick = () => saveDraft();
  row.appendChild(save);
  const copy = el("button", "btn", "复制 Codex 配置");
  copy.onclick = () => copyCodexSnippet();
  row.appendChild(copy);
  wrap.appendChild(row);
  return wrap;
}

// 控制台背后指向所属网关节点的提示线（带箭头，箭头压在节点之上不被遮挡）
function renderGwLink() {
  const svg = $("#overlay");
  svg.innerHTML = "";
  const box = $("#gwConsole");
  const gw = nodePos.__gw;
  if (!gw || box.classList.contains("hidden")) return;
  const stage = $("#stage");
  const sb = stage.getBoundingClientRect();
  const cb = box.getBoundingClientRect();
  const x1 = cb.left - sb.left + cb.width / 2;
  const y1 = cb.top - sb.top + cb.height / 2;
  // 终点停在节点边框之外，箭头完整露出、不压到节点上
  const t = rectEnterT(x1, y1, gw.x, gw.y, gw.x, gw.y, 80, 32);
  const x2 = x1 + (gw.x - x1) * Math.max(0, t - 0.02);
  const y2 = y1 + (gw.y - y1) * Math.max(0, t - 0.02);

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "gwArrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "11");
  marker.setAttribute("markerHeight", "11");
  marker.setAttribute("orient", "auto-start-reverse");
  const head = document.createElementNS("http://www.w3.org/2000/svg", "path");
  head.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  head.setAttribute("fill", "#1a73e8");
  head.setAttribute("stroke", "#ffffff");
  head.setAttribute("stroke-width", "1");
  marker.appendChild(head);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${x1} ${y1} L ${x2} ${y2}`);
  path.setAttribute("stroke", "#1a73e8");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-dasharray", "5 4");
  path.setAttribute("fill", "none");
  path.setAttribute("marker-end", "url(#gwArrow)");
  svg.appendChild(path);
}

// 求从 (x1,y1) 指向 (x2,y2) 的射线进入矩形（中心 cx,cy，半宽 hw，半高 hh）时的参数 t
function rectEnterT(x1, y1, x2, y2, cx, cy, hw, hh) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tmin = 0;
  let tmax = 1;
  const slab = (p, d, lo, hi) => {
    if (d === 0) return p >= lo && p <= hi;
    let t1 = (lo - p) / d;
    let t2 = (hi - p) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    return tmax >= tmin;
  };
  if (!slab(x1, dx, cx - hw, cx + hw)) return 1;
  if (!slab(y1, dy, cy - hh, cy + hh)) return 1;
  return Math.min(1, Math.max(0, tmin));
}

function focusGwConsole() {
  const box = $("#gwConsole");
  box.classList.remove("hidden");
}

function renderDock() {
  const body = $("#dockBody");
  const title = $("#dockTitle");
  body.innerHTML = "";
  if (!draft) {
    title.textContent = "管理";
    const t = el("div", "sec");
    const h = el("h3", null, "对象属性面板");
    t.appendChild(h);
    t.appendChild(
      el(
        "p",
        "hint",
        "在左侧拓扑图里点任意对象（上游通道 / 网关 / 下游 Key），这里会显示它的编辑；点画布空白处取消选中。"
      )
    );
    body.appendChild(t);
    const list = el("div", "sec");
    list.appendChild(el("h3", null, "概览"));
    const s = STATE.settings;
    list.appendChild(el("div", "po-line", `协议　${s.protocol}`));
    list.appendChild(el("div", "po-line", `监听　${s.listen_host}:${s.listen_port}`));
    list.appendChild(el("div", "po-line", `上游　${STATE.upstreams.length} 条`));
    list.appendChild(el("div", "po-line", `下游 Key　${STATE.keys.length} 把`));
    body.appendChild(list);
    return;
  }
  if (draft.kind === "upstream") {
    title.textContent = draft.isNew ? "新增上游" : "上游通道";
    const sec = el("div", "sec");
    const h = el("h3", null, "上游通道");
    if (draft.dirty) h.appendChild(el("small", null, "（未保存）"));
    sec.appendChild(h);
    const f = el("div", "form");
    f.appendChild(nameField(draft));
    f.appendChild(field("Provider", "provider", draft.fields.provider));
    f.appendChild(field("Base URL", "base_url", draft.fields.base_url));
    f.appendChild(field("API Key", "api_key", draft.fields.api_key, "password", "留空则不修改"));
    sec.appendChild(f);
    const row = el("div", "row");
    const save = el("button", "btn primary", draft.isNew ? "添加" : "保存");
    save.onclick = () => saveDraft();
    row.appendChild(save);
    if (!draft.isNew) {
      const probe = el("button", "btn", "探测");
      probe.onclick = () => probeUpstream(draft.id);
      row.appendChild(probe);
      const del = el("button", "btn danger", "删除");
      del.onclick = () => deleteUpstream(draft.id);
      row.appendChild(del);
    }
    sec.appendChild(row);
    body.appendChild(sec);
    return;
  }
  if (draft.kind === "key") {
    title.textContent = "下游 Key";
    const k = STATE.keys.find((x) => x.id === draft.id);
    const sec = el("div", "sec");
    sec.appendChild(el("h3", null, "下游 Key"));
    if (k) {
      sec.appendChild(el("div", "po-line", `名称　${k.label}`));
      sec.appendChild(el("div", "po-key", k.key));
    }
    const row = el("div", "row");
    const cp = el("button", "btn primary", "复制");
    cp.onclick = () => {
      if (!k) return;
      navigator.clipboard.writeText(k.key);
      cp.textContent = "已复制";
      setTimeout(() => (cp.textContent = "复制"), 1200);
    };
    row.appendChild(cp);
    const del = el("button", "btn danger", "删除");
    del.onclick = () => deleteKey(k);
    row.appendChild(del);
    sec.appendChild(row);
    body.appendChild(sec);
    return;
  }
  if (draft.kind === "gw") {
    title.textContent = "网关";
    const s = STATE.settings;
    const sec = el("div", "sec");
    const h = el("h3", null, "网关");
    if (draft.dirty) h.appendChild(el("small", null, "（未保存）"));
    sec.appendChild(h);
    const drawerOpen = !$("#drawer").classList.contains("hidden");
    if (drawerOpen) {
      // 抽屉里直接给出完整配置，画布左侧不再出现控制台
      sec.appendChild(gwControls());
    } else {
      sec.appendChild(el("div", "po-line", `协议　${s.protocol}`));
      sec.appendChild(el("div", "po-line", `监听　${s.listen_host}:${s.listen_port}`));
      sec.appendChild(el("div", "po-line", `上游　${STATE.upstreams.length} 条`));
      const row = el("div", "row");
      const open = el("button", "btn primary", "在画布中打开网关控制台");
      open.onclick = () => focusGwConsole();
      row.appendChild(open);
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }
}

// ---------- 动作 ----------

async function saveDraft() {
  if (!draft) return true;
  if (draft.kind === "upstream") {
    const body = {
      name: (draft.fields.name || "").trim() || draft.defaultName || "",
      provider: draft.fields.provider,
      base_url: draft.fields.base_url,
    };
    if (draft.fields.api_key) body.api_key = draft.fields.api_key;
    if (!body.name || !body.base_url) {
      alert("名称与 Base URL 必填");
      return false;
    }
    if (draft.isNew) {
      await api("/api/upstreams", { method: "POST", headers: jsonH(), body: JSON.stringify(body) });
      selected = null;
      draft = null;
    } else {
      await api("/api/upstreams/" + draft.id, { method: "PUT", headers: jsonH(), body: JSON.stringify(body) });
      draft.dirty = false;
    }
  } else if (draft.kind === "gw") {
    await api("/api/settings", {
      method: "PUT",
      headers: jsonH(),
      body: JSON.stringify({
        protocol: draft.fields.protocol,
        listen_host: draft.fields.listen_host,
        listen_port: Number(draft.fields.listen_port),
        max_switches_per_request: Number(draft.fields.max_switches_per_request),
        min_residency_s: Number(draft.fields.min_residency_s),
        precommit_budget_s: Number(draft.fields.precommit_budget_s),
      }),
    });
    await api("/api/rules", {
      method: "PUT",
      headers: jsonH(),
      body: JSON.stringify({ rules: draft.rules, retry_after_commit: draft.retry }),
    });
    draft.dirty = false;
  }
  await loadState();
  return true;
}

async function newUpstream() {
  if (!(await guard())) return;
  selected = { kind: "upstream", id: "__new__" };
  const idx = STATE.upstreams.length;
  const defName = SLOT_NAMES[idx] || `通道 ${idx + 1}`;
  draft = {
    kind: "upstream",
    id: "__new__",
    isNew: true,
    defaultName: defName,
    fields: { name: defName, provider: "", base_url: "", api_key: "" },
    dirty: false,
  };
  renderTopology();
  renderPanels();
}

async function deleteUpstream(id) {
  if (!id || id === "__new__") return;
  await api("/api/upstreams/" + id, { method: "DELETE" });
  selected = null;
  draft = null;
  await loadState();
  renderPanels();
}

async function probeUpstream(id) {
  const res = await api("/api/upstreams/" + id + "/probe", { method: "POST" });
  alert(`HTTP ${res.status}\n耗时 ${res.ms}ms\n\n${res.body || ""}`);
}

async function deleteKey(k) {
  if (!k) return;
  await api("/api/keys/" + k.id, { method: "DELETE" });
  selected = null;
  draft = null;
  await loadState();
  renderPanels();
}

async function newKey() {
  if (!(await guard())) return;
  const res = await api("/api/keys", { method: "POST", headers: jsonH(), body: JSON.stringify({ label: "client" }) });
  try {
    await navigator.clipboard.writeText(res.key);
  } catch (e) {}
  alert("已生成并复制：\n" + res.key);
  await loadState();
}

function copyCodexSnippet() {
  const s = STATE.settings;
  const wire = { "openai-responses": "responses", "openai-chat": "chat", anthropic: "anthropic" }[s.protocol];
  const snippet =
    `[model_providers.ha_gateway]\nname = "HA Gateway"\nbase_url = "http://${s.listen_host}:${s.listen_port}/v1/"\nenv_key = "HA_GATEWAY_KEY"\nwire_api = "${wire}"\n`;
  navigator.clipboard.writeText(snippet);
  alert("配置片段已复制");
}

// ---------- 抽屉 ----------

function openDrawer() {
  $("#drawer").classList.remove("hidden");
  $("#toggleDrawer").textContent = "◀";
  $("#toggleDrawer").title = "收起管理面板";
  renderTopology();
  renderPanels();
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
  $("#toggleDrawer").textContent = "▶";
  $("#toggleDrawer").title = "管理面板";
  renderTopology();
  renderPanels();
}

// ---------- 日志 ----------

async function loadEvents() {
  const evs = await api("/api/events?limit=200");
  const body = $("#logBody");
  evs.forEach((e) => {
    if (e.ts * 1000 <= logSeen) return;
    logSeen = e.ts * 1000;
    const line = el("div");
    line.appendChild(el("span", "ts", "[" + fmtTs(e.ts) + "] "));
    line.appendChild(el("span", e.level, e.level.toUpperCase().padEnd(5) + " " + e.message));
    body.appendChild(line);
  });
  if ($("#logFollow").checked) body.scrollTop = body.scrollHeight;
}

function fmtTs(ts) {
  const d = new Date(ts * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// ---------- 事件绑定 ----------

$("#toggleDrawer").onclick = async () => {
  const d = $("#drawer");
  if (d.classList.contains("hidden")) openDrawer();
  else {
    if (!(await guard())) return;
    closeDrawer();
  }
};
$("#closeDrawer").onclick = async () => {
  if (!(await guard())) return;
  closeDrawer();
};
$("#refresh").onclick = loadState;
$("#copyAddr").onclick = () => {
  const s = STATE.settings;
  const url = `http://${s.listen_host}:${s.listen_port}/v1/`;
  navigator.clipboard.writeText(url);
  $("#copyAddr").textContent = "已复制";
  setTimeout(() => ($("#copyAddr").textContent = "复制地址"), 1200);
};

$("#logClear").onclick = () => ($("#logBody").innerHTML = "");
$("#logBody").addEventListener("scroll", (e) => {
  const b = e.target;
  if (b.scrollTop + b.clientHeight < b.scrollHeight - 8) $("#logFollow").checked = false;
});

$("#stage").addEventListener("click", (ev) => {
  const ignore = [".node", ".inline-card", ".gw-console", ".dirty-bar", ".drawer-toggle"];
  if (ignore.some((s) => ev.target.closest(s))) return;
  deselect();
});

window.addEventListener("resize", () => {
  renderTopology();
  renderPanels();
});
window.addEventListener("keydown", async (ev) => {
  if (ev.key !== "Escape") return;
  if (!(await guard())) return;
  selected = null;
  draft = null;
  renderTopology();
  renderPanels();
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
