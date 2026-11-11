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
let lastStateSig = "";        // 上一次 /api/state 的指纹，用于跳过无谓重绘
let pendingPanel = false;     // 编辑中状态变了，等用户松手后再刷新右侧面板

const RULE_LABELS = {
  connect_fail: "连接失败 / DNS 失败",
  upstream_5xx: "上游 5xx",
  upstream_429: "上游 429（限流）",
  upstream_4xx: "上游 4xx（除 429）",
  post_commit_break: "已提交后断流",
};
const SLOT_NAMES = ["主通道", "备通道", "通道 3", "通道 4"];
const PROTOCOLS = ["openai-responses", "openai-chat", "anthropic"];

const HINTS = {
  protocol: "下游请求使用的 wire 协议，决定请求/响应格式与上游适配方式。",
  listen_host: "HA Gateway 对下游（Codex）暴露的监听地址，默认只监听本机。",
  listen_port: "转发端口。10110 是 LLM 转发口，10111 是这个管理页面。",
  max_switches: "一个请求内最多向上游切换几次，防止来回横跳。",
  switch_per_minute: "同一个会话在一分钟内最多切换几次。超过就不再切，避免两边来回甩。",
  residency: "切换后至少在同一上游驻留多少秒，避免刚切就又切。",
  budget: "请求已发出、上游尚未响应时，允许在多少秒内换上游重试。",
  up_name: "这条上游在拓扑图里的显示名。",
  up_provider: "上游服务商标识（例如 m.aiio.chat），用于分组与展示。",
  up_base: "上游的 OpenAI 兼容接口根地址，例如 http://127.0.0.1:10100 或 https://api.example.com。只填到端口，不要带 /v1/responses 这类路径——网关会在其后自己拼协议路径。不写协议头时，本机回环默认 http，公网域名默认 https。",
  up_key: "调用上游的密钥；留空表示不修改已保存的密钥。",
};

const RULE_HINTS = {
  connect_fail: "连不上上游或 DNS 解析失败时，判定该通道不可用并切换。",
  upstream_5xx: "上游返回 5xx（服务端错误）时切换。",
  upstream_429: "上游返回 429（限流或额度用尽）时切换，这通常是该换 key 的信号。",
  upstream_4xx: "上游返回 4xx（参数错误等）时切换；同一请求重发通常还是会失败，默认不切。",
  post_commit_break: "固定行为：请求已交给下游之后，上游断流不再切换（避免重复内容与重复计费）。",
};

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// 轻提示：替代 alert/confirm 那种硬弹框
function toast(msg, kind) {
  const t = el("div", "toast" + (kind ? " " + kind : ""), msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => {
    t.classList.remove("in");
    setTimeout(() => t.remove(), 300);
  }, 2800);
}

// 往底部日志窗格写一行（探测详情这类长文本用，不弹框）
function pushLog(level, message) {
  const body = $("#logBody");
  const line = el("div");
  line.appendChild(el("span", "ts", "[" + fmtTs(Date.now() / 1000) + "] "));
  line.appendChild(el("span", level, level.toUpperCase().padEnd(5) + " " + message));
  body.appendChild(line);
  if ($("#logFollow").checked) body.scrollTop = body.scrollHeight;
}
function jsonH() {
  return { "Content-Type": "application/json" };
}

// ---------- 状态 ----------

async function loadState() {
  const next = await api("/api/state");
  // 状态没变就别重绘：避免每 2 秒把 DOM 拆一遍
  // （这会让元素拾取抓不到目标、界面闪烁、输入焦点丢失）
  // 流量指标每轮都在变，不能进签名——否则等于每 2 秒重绘整张拓扑图
  const sig = JSON.stringify(Object.assign({}, next, { metrics: null }));
  const changed = sig !== lastStateSig;
  lastStateSig = sig;
  STATE = next;
  if (changed) {
    renderTop();
    renderTopology();
  }
  // 指标单独走数据球通道，与拓扑渲染解耦
  flowDriver.sync(next.metrics);
  if (!isEditing()) {
    if (changed || pendingPanel) {
      pendingPanel = false;
      rebuildDraft();
      renderPanels();
    }
  } else if (changed) {
    pendingPanel = true;
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
  renderRouteMode();
}

// 画布左上角：当前是自动路由还是手动锁定到某条通道
function renderRouteMode() {
  const box = $("#routeMode");
  if (!box) return;
  const s = STATE.settings || {};
  const forced = s.forced_upstream_id || "";
  const excluded = s.excluded_upstream_ids || [];
  box.classList.remove("locked", "excluded");
  if (forced) {
    const u = STATE.upstreams.find((x) => x.id === forced);
    box.textContent = "路由：锁定 " + (u ? u.name : forced);
    box.classList.add("locked");
    box.title = "已手动锁定到「" + (u ? u.name : forced) + "」。点一下恢复自动路由。";
  } else if (excluded.length) {
    const names = excluded
      .map((id) => {
        const u = STATE.upstreams.find((x) => x.id === id);
        return u ? u.name : id;
      })
      .join("、");
    box.textContent = "路由：排除 " + excluded.length + " 条";
    box.classList.add("excluded");
    box.title =
      "已排除「" + names + "」，不参与自动路由（仍会探测健康）。点一下恢复全部。";
  } else {
    box.textContent = "路由：自动";
    box.title = "自动路由：健康优先 + 会话粘性 + 故障转移。点一下打开网关设置。";
  }
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
    const k = STATE.keys.find((x) => x.id === selected.id);
    draft = { kind: "key", id: selected.id, fields: { label: k ? k.label : "" }, dirty: false };
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
        max_switches_per_minute: s.max_switches_per_minute,
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
  refreshDirtyMarks();
}

// 未保存标记：给带 data-dirty-mark 的按钮加一个橙色星号
function refreshDirtyMarks() {
  const dirty = !!(draft && draft.dirty);
  $$("[data-dirty-mark]").forEach((b) => b.classList.toggle("dirty", dirty));
}

function syncField(name, value) {
  $$(`[data-field="${name}"]`).forEach((i) => {
    if (i === document.activeElement) return;
    if (i.classList.contains("seg-btn")) {
      i.classList.toggle("on", i.dataset.value === value);
      return;
    }
    if (i.classList.contains("picker-btn")) {
      i.dataset.value = value;
      i.classList.remove("pi-loopback", "pi-all", "pi-specific", "pi-custom");
      i.classList.add(hostClass(value));
      i.textContent = hostLabel(value);
      const inp = i.parentNode.querySelector("input.picker-input");
      if (inp) inp.style.display = knownHost(value) ? "none" : "";
      return;
    }
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
  refreshDirtyMarks();
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

// 放弃当前草稿，恢复到已保存的值
function cancelDraft() {
  rebuildDraft();
  renderTopology();
  renderPanels();
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

function healthText(u) {
  if (u.health === "down") return "不可用";
  if (u.health === "degraded") return "降级";
  return "健康";
}

// ---------- 拓扑（增量渲染） ----------
// 关键约束：节点元素按 key 复用，只有内容真的变了才重建。
// 之前每 2 秒轮询都把 #nodes 全量清空重建，导致
//   1) 元素抓取（DevTools 拾取器 / 自动化点击）拿到正在被销毁的壳，表现为「空白框」
//   2) 界面每 2 秒闪一次
const SVG_NS = "http://www.w3.org/2000/svg";
const nodeEls = new Map(); // key -> 元素
let wirePool = []; // 连线 path 池
let wireEdges = []; // 当前这一帧的连线（含 id / 健康态 / 对应的 path 元素）

function renderWires(svg, edges) {
  while (wirePool.length < edges.length) {
    wirePool.push(document.createElementNS(SVG_NS, "path"));
  }
  edges.forEach((e, i) => {
    const p = wirePool[i];
    const dy = (e.y2 - e.y1) * 0.55;
    p.setAttribute(
      "d",
      `M ${e.x1} ${e.y1} C ${e.x1} ${e.y1 + dy}, ${e.x2} ${e.y2 - dy}, ${e.x2} ${e.y2}`
    );
    // 颜色只表达健康态，"当前活跃"用线宽强调，
    // 免得把降级通道画成一条健康的蓝线。
    p.setAttribute("class", wireClass(e));
    svg.appendChild(p); // 已存在的子节点只是移动，不重建
  });
  for (let i = edges.length; i < wirePool.length; i++) wirePool[i].remove();
  wireEdges = edges.map((e, i) => ({ ...e, path: wirePool[i] }));
  flowSystem.setPaths(wireEdges, svg);
  flowSystem.refreshHeat();
}

function wireClass(e) {
  if (e.kind === "ghost") return "wire-flow wire-flow-ghost";
  const h = e.health === "down" ? "down" : e.health === "degraded" ? "degraded" : "up";
  let cls = "wire-flow wire-flow-" + h;
  if (e.kind === "up") {
    const forced = (STATE.settings || {}).forced_upstream_id || "";
    if (forced && e.owner === forced) {
      // 锁定通道：实线加粗，视觉上就是"确定走这条"
      cls += " wire-flow-locked";
    } else if (forced) {
      // 别的通道淡下去，一眼看出当前钉住了谁
      cls += " wire-flow-dim";
    } else if (e.owner === activeUpstream) {
      cls += " wire-flow-active";
    }
    if (isExcluded(e.owner)) {
      // 被排除的通道：灰蓝细虚线，静止不流动 —— "不在候选池里"
      cls += " wire-flow-excluded";
    }
  }
  return cls;
}

function buildUpstreamNode(u, i) {
  const n = el("div", "node");
  n.appendChild(el("div", "slot-tag", SLOT_NAMES[i] || `通道 ${i + 1}`));
  n.appendChild(el("div", "n-title", u.name));
  n.appendChild(el("div", "n-sub", u.health === "down" ? u.provider + " · 不可用" : u.provider));
  if ((STATE.settings || {}).forced_upstream_id === u.id) {
    const lock = el("div", "node-lock", "锁");
    lock.title = "已手动锁定到这条通道";
    n.appendChild(lock);
  }
  if (isExcluded(u.id)) {
    const ex = el("div", "node-excluded", "排");
    ex.title = "已排除：不参与自动路由（仍会探测健康，也可手动锁定）";
    n.appendChild(ex);
  }
  const missing = missingFields(u);
  if (missing.length) {
    const badge = el("div", "node-badge", "!");
    badge.title = "信息未填完：" + missing.join("、");
    n.appendChild(badge);
  }
  const badUrl = baseUrlProblem(u);
  if (badUrl) {
    const badge = el("div", "node-badge warn", "!");
    badge.title = badUrl;
    n.appendChild(badge);
  }
  n.onclick = (ev) => {
    ev.stopPropagation();
    selectObject("upstream", u.id);
  };
  return n;
}

// 上游还缺哪些必填项（has_key 只表示"填没填"，不回传明文）
function missingFields(u) {
  const miss = [];
  if (!u.name || !u.name.trim()) miss.push("名称");
  if (!u.base_url || !u.base_url.trim()) miss.push("Base URL");
  if (u.has_key === false) miss.push("API Key");
  return miss;
}

// Base URL 只填根地址：网关会在其后拼接协议路径（/v1/responses 等）。
// 填了完整路径会导致路径重复，请求必然 404。
function baseUrlProblem(u) {
  const b = (u.base_url || "").trim();
  if (!b) return "";
  const path = b.replace(/^https?:\/\/[^/]+/, "");
  if (!path || path === "/") return "";
  return "Base URL 只填根地址（" + path + " 会被网关再拼一次协议路径）";
}

// 与后端 ha_gateway/urlnorm.py 保持一致：按协议归一化 Base URL
const PROTOCOL_SUFFIXES = {
  "openai-responses": ["/v1/responses", "/responses", "/v1/responses/compact"],
  "openai-chat": ["/v1/chat/completions", "/chat/completions"],
  anthropic: ["/v1/messages", "/messages", "/v1/messages/count_tokens", "/v1/messages/batches"],
};

function normalizeBaseUrl(raw, protocol) {
  let s = (raw || "").trim();
  if (!s) return { url: "", note: "" };
  let note = "";
  if (s.indexOf("://") < 0) {
    const sch = defaultScheme(s.split("/")[0]);
    s = sch + "://" + s;
    note = "已补全 " + sch + "://";
  }
  const m = /^([a-z0-9+.-]+:\/\/[^/?#]+)([^?#]*)/i.exec(s);
  if (!m) return { url: s, note };
  const schemeHost = m[1];
  let path = (m[2] || "").replace(/\/+$/, "");
  const lower = path.toLowerCase();
  const sufs = PROTOCOL_SUFFIXES[protocol] || [];
  for (const suf of sufs) {
    if (lower.endsWith(suf.toLowerCase())) {
      path = path.slice(0, path.length - suf.length);
      note = (note ? note + "，" : "") + "已去掉 " + suf;
      break;
    }
  }
  if (path && !note) {
    for (const suf of ["/v1/responses", "/v1/chat/completions", "/v1/messages"]) {
      if (lower.endsWith(suf)) {
        path = path.slice(0, path.length - suf.length);
        note = "已去掉 " + suf;
        break;
      }
    }
  }
  return { url: (schemeHost + path).replace(/\/+$/, ""), note };
}

// 没写协议头时的默认：本机回环 http，公网域名 https（与后端 urlnorm.py 一致）
function defaultScheme(host) {
  let h = (host || "").trim().toLowerCase();
  if (h.startsWith("[") && h.indexOf("]") > 0) h = h.slice(1, h.indexOf("]"));
  h = h.split(":")[0];
  if (!h) return "http";
  if (["127.0.0.1", "localhost", "::1", "0.0.0.0"].indexOf(h) >= 0) return "http";
  if (/\.(local|lan|home)$/.test(h)) return "http";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(":") >= 0) return "http"; // 裸 IP
  return "https";
}

// Provider 缺省值：Base URL 的域名+端口
function providerFromBaseUrl(baseUrl) {
  const s = (baseUrl || "").trim();
  if (!s) return "";
  const m = /^[a-z0-9+.-]+:\/\/([^/?#]+)/i.exec(
    s.indexOf("://") < 0 ? defaultScheme(s.split("/")[0]) + "://" + s : s
  );
  return m ? m[1] : "";
}

// Provider 留空时，随 Base URL 实时补成"域名+端口"（用户不用手填）
function autoFillProvider(formEl, provBlock, draft) {
  const baseInput = formEl.querySelector('input[data-field="base_url"]');
  const provInput = provBlock.querySelector('input[data-field="provider"]');
  if (!baseInput || !provInput) return;
  const hint = el("div", "f-hint", "留空则自动取 Base URL 的域名+端口。");
  provBlock.appendChild(hint);
  const sync = () => {
    const cur = (provInput.value || "").trim();
    const auto = providerFromBaseUrl(baseInput.value);
    if (cur && cur !== auto) {
      provInput.dataset.manual = "1";
      return;
    }
    provInput.value = auto;
    if (draft) draft.fields.provider = auto;
  };
  baseInput.addEventListener("input", sync);
  provInput.addEventListener("input", () => {
    if (draft) draft.fields.provider = provInput.value;
  });
  sync();
}

function buildGhostSlot(tag) {
  const n = el("div", "node ghost");
  n.appendChild(el("div", "slot-tag", tag));
  n.appendChild(el("div", "n-title", "未配置"));
  n.appendChild(el("div", "n-sub", "点击添加上游"));
  n.onclick = (ev) => {
    ev.stopPropagation();
    newUpstream();
  };
  return n;
}

function buildAddUp() {
  const n = el("div", "node ghost");
  n.appendChild(el("div", "slot-tag", "新增"));
  n.appendChild(el("div", "n-title", "＋"));
  n.appendChild(el("div", "n-sub", "新增上游通道"));
  n.onclick = (ev) => {
    ev.stopPropagation();
    newUpstream();
  };
  return n;
}

function buildGwNode() {
  const n = el("div", "node gateway");
  const s = STATE.settings || {};
  n.appendChild(el("div", "n-title", "乾坤机枢"));
  n.appendChild(el("div", "n-sub", "一主一备 · 自动接管"));
  const kv = (label, value, cls) => {
    const row = el("div", "n-kv");
    row.appendChild(el("span", "n-k", label));
    row.appendChild(el("span", "n-v " + (cls || ""), value));
    return row;
  };
  n.appendChild(kv("协议", s.protocol || "—", "mono"));
  n.appendChild(kv("网关监听", `${s.listen_host || "—"}:${s.listen_port || "—"}`, "mono"));
  n.onclick = (ev) => {
    ev.stopPropagation();
    selectObject("gw", "gw");
  };
  return n;
}

function buildKeyNode(k) {
  const n = el("div", "node down");
  const title = el("div", "n-title", k.label);
  title.title = "双击改名";
  title.ondblclick = (ev) => {
    ev.stopPropagation();
    startRenameKey(title, k);
  };
  n.appendChild(title);
  n.appendChild(el("div", "n-sub mono", maskKey(k.key)));
  const acts = el("div", "node-actions");
  const cp = el("button", null, "复制");
  cp.title = "复制 Key";
  cp.onclick = (ev) => {
    ev.stopPropagation();
    navigator.clipboard.writeText(k.key).catch(() => {});
    cp.textContent = "已复制";
    setTimeout(() => (cp.textContent = "复制"), 1200);
    toast("已复制这把 Key");
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
  return n;
}

// 节点上就地改名：标题换成输入框，回车提交，Esc 取消
function startRenameKey(title, k) {
  if (title.querySelector("input")) return;
  const inp = el("input", "rename-input");
  inp.value = k.label;
  title.textContent = "";
  title.appendChild(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
      const val = inp.value.trim();
      if (!commit || !val || val === k.label) {
        title.textContent = k.label;
        return;
      }
    title.textContent = val;
    renameKey(k.id, val);
  };
  inp.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") finish(true);
    else if (ev.key === "Escape") finish(false);
  };
  inp.onblur = () => finish(true);
}

// 右侧面板里的名称：失焦即存，不用额外的保存按钮
function keyNameField(k) {
  const wrap = el("div", "f");
  const l = el("label");
  l.appendChild(el("span", null, "名称"));
  const inp = el("input");
  inp.type = "text";
  inp.value = k.label;
  l.appendChild(inp);
  wrap.appendChild(l);
  const hint = el(
    "div",
    "f-hint",
    "这把 Key 在拓扑图上的名字，随便起个好认的，比如 codex、备用机。改完失焦自动保存；也可以直接在拓扑图上双击名字改。"
  );
  wrap.appendChild(hint);
  inp.oninput = () => {
    if (draft && draft.kind === "key") draft.fields.label = inp.value;
  };
  inp.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") inp.blur();
    else if (ev.key === "Escape") {
      inp.value = k.label;
      inp.blur();
    }
  };
  inp.onblur = () => {
    const val = inp.value.trim();
    if (!val || val === k.label) {
      inp.value = k.label;
      return;
    }
    renameKey(k.id, val);
  };
  return wrap;
}

async function renameKey(id, label) {
  try {
    await api("/api/keys/" + id, { method: "PUT", headers: jsonH(), body: JSON.stringify({ label }) });
    toast("已改名：" + label);
    await loadState();
  } catch (e) {
    toast("改名失败：" + e.message, "warn");
  }
}

function buildAddKey() {
  const n = el("div", "node ghost");
  n.appendChild(el("div", "n-title", "＋"));
  n.appendChild(el("div", "n-sub", "新增下游 Key"));
  n.onclick = (ev) => {
    ev.stopPropagation();
    newKey();
  };
  return n;
}

function renderTopology() {
  const L = layout();
  const nodes = $("#nodes");
  const svg = $("#wires");
  nodePos = {};
  nodePos.__gw = { x: L.gw.x, y: L.gw.y };
  $("#emptyHint").classList.toggle("hidden", L.ups.length > 0);

  // 上游 / 下游 区域底色
  const zoneUp = $("#zoneUp");
  const zoneDown = $("#zoneDown");
  zoneUp.style.top = L.topY - 50 + "px";
  zoneUp.style.height = "100px";
  zoneDown.style.top = L.botY - 50 + "px";
  zoneDown.style.height = "100px";

  const edges = [];
  for (let i = 0; i < L.slotCount; i++) {
    const u = L.ups[i];
    edges.push({
      id: u ? "up:" + u.id : "ghost:" + i,
      kind: u ? "up" : "ghost",
      owner: u ? u.id : null,
      health: u ? u.health : null,
      x1: L.upX[i],
      y1: L.topY + 26,
      x2: L.gw.x,
      y2: L.gw.y,
    });
  }
  L.keys.forEach((k, i) => {
    edges.push({
      id: "down:" + k.id,
      kind: "down",
      owner: k.id,
      health: null,
      x1: L.gw.x,
      y1: L.gw.y,
      x2: L.keyX[i],
      y2: L.botY - 26,
    });
  });
  renderWires(svg, edges);

  // 描述这一帧想要的节点
  const want = [];
  for (let i = 0; i < L.slotCount; i++) {
    const u = L.ups[i];
    const x = L.upX[i];
    const tag = SLOT_NAMES[i] || `通道 ${i + 1}`;
    if (u) {
      nodePos[u.id] = { x, y: L.topY };
      const hc = healthClass(u);
      const sel = selected && selected.kind === "upstream" && selected.id === u.id ? " sel" : "";
      const sub = u.health === "down" ? u.provider + " · 不可用" : u.provider;
      const miss = missingFields(u).join(",");
      want.push({
        key: "up:" + u.id,
        cls: "node" + (hc ? " " + hc : "") + sel,
        x,
        y: L.topY,
        sig: JSON.stringify([
          tag,
          u.name,
          sub,
          u.base_url,
          miss,
          (STATE.settings || {}).forced_upstream_id === u.id ? "locked" : "",
          isExcluded(u.id) ? "excluded" : "",
        ]),
        build: () => buildUpstreamNode(u, i),
      });
    } else {
      want.push({
        key: "slot:" + i,
        cls: "node ghost",
        x,
        y: L.topY,
        sig: JSON.stringify([tag, "未配置", "点击添加上游"]),
        build: () => buildGhostSlot(tag),
      });
    }
  }

  const addX = L.addX;
  nodePos.__new__ = { x: addX, y: L.topY };
  want.push({
    key: "add",
    cls: "node ghost",
    x: addX,
    y: L.topY,
    sig: JSON.stringify(["新增", "＋", "新增上游通道"]),
    build: buildAddUp,
  });

  const gs = STATE.settings || {};
  want.push({
    key: "gw",
    cls: "node gateway" + (selected && selected.kind === "gw" ? " sel" : ""),
    x: L.gw.x,
    y: L.gw.y,
    sig: JSON.stringify(["乾坤机枢", gs.protocol, gs.listen_host, gs.listen_port, "kv2"]),
    build: buildGwNode,
  });

  L.keys.forEach((k, i) => {
    want.push({
      key: "key:" + k.id,
      cls: "node down" + (selected && selected.kind === "key" && selected.id === k.id ? " sel" : ""),
      x: L.keyX[i],
      y: L.botY,
      sig: JSON.stringify([k.label, maskKey(k.key)]),
      build: () => buildKeyNode(k),
    });
  });

  want.push({
    key: "addkey",
    cls: "node ghost",
    x: L.keyX[L.keyX.length - 1],
    y: L.botY,
    sig: JSON.stringify(["＋", "新增下游 Key"]),
    build: buildAddKey,
  });

  // 归并：能复用就复用，只改 class / 位置
  const alive = new Set();
  const ordered = [];
  for (const d of want) {
    alive.add(d.key);
    let e = nodeEls.get(d.key);
    if (!e || e.__sig !== d.sig) {
      const ne = d.build();
      ne.__sig = d.sig;
      if (e) nodes.replaceChild(ne, e);
else nodes.appendChild(ne);
      e = ne;
      nodeEls.set(d.key, e);
    }
    e.className = d.cls;
    e.style.left = d.x + "px";
    e.style.top = d.y + "px";
    ordered.push(e);
  }
  for (const [k, e] of nodeEls) {
    if (!alive.has(k)) {
      e.remove();
      nodeEls.delete(k);
    }
  }
  // 统一叠放顺序（appendChild 移动已有节点，不重建）
  for (const e of ordered) nodes.appendChild(e);
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

// 带提示说明的字段块：
//   mode="tooltip" —— 画布小卡用，提示走鼠标 hover
//   mode="inline"  —— 右侧抽屉用，提示显示在控件下方
function fieldBlock(label, name, value, opts) {
  opts = opts || {};
  const wrap = el("div", "f");
  const l = el("label");
  l.appendChild(el("span", null, label));
  const i = el("input");
  i.type = opts.type || "text";
  i.value = value === undefined || value === null ? "" : value;
  i.dataset.field = name;
  if (opts.placeholder) i.placeholder = opts.placeholder;
  i.oninput = () => setField(name, i.type === "number" ? Number(i.value) : i.value);
  l.appendChild(i);
  wrap.appendChild(l);
  applyHint(wrap, l, i, opts.hint, opts.mode);
  return wrap;
}

function applyHint(wrap, labelEl, inputEl, hint, mode) {
  if (!hint) return;
  if (mode === "inline") {
    wrap.appendChild(el("div", "f-hint", hint));
  } else {
    const t = el("span", "f-tip", "ⓘ");
    t.title = hint;
    const span = labelEl.querySelector("span");
    if (span) span.appendChild(t);
    else labelEl.appendChild(t);
    if (inputEl) inputEl.title = hint;
  }
}

// 分段单选（不用原生 select，避免重绘时残留空白弹层）
function radioBlock(label, name, value, options, opts) {
  opts = opts || {};
  const wrap = el("div", "f");
  const l = el("label");
  l.appendChild(el("span", null, label));
  const group = el("div", "seg");
  options.forEach((o) => {
    const text = (opts.labels && opts.labels[o]) || o;
    const b = el("button", "seg-btn" + (o === value ? " on" : ""), text);
    b.type = "button";
    b.title = o;
    b.dataset.field = name;
    b.dataset.value = o;
    b.onclick = () => {
      setField(name, o);
      group.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("on", x.dataset.value === o));
    };
    group.appendChild(b);
  });
  l.appendChild(group);
  wrap.appendChild(l);
  applyHint(wrap, l, null, opts.hint, opts.mode);
  return wrap;
}

// 带说明的勾选项
function ruleBlock(name, text, checked, hint, mode) {
  const wrap = el("div", "f rule-f");
  const l = el("label");
  const i = el("input");
  i.type = "checkbox";
  i.dataset.rule = name;
  i.checked = !!checked;
  i.onchange = () => syncRule(name, i.checked);
  l.appendChild(i);
  l.appendChild(el("span", null, text));
  wrap.appendChild(l);
  applyHint(wrap, l, i, hint, mode);
  return wrap;
}

// 按钮 + 提示（tooltip 或下方说明）
function buttonWithHint(text, cls, onclick, hint, mode) {
  const wrap = el("div", "bwrap");
  const b = el("button", cls, text);
  b.type = "button";
  b.onclick = onclick;
  if (hint) b.title = hint;
  wrap.appendChild(b);
  if (hint && mode === "inline") wrap.appendChild(el("div", "f-hint", hint));
  return wrap;
}

// 名称输入：清空后在失焦时恢复默认名（新建上游时自动填好，可改）
function nameField(draft, mode) {
  const wrap = fieldBlock("名称", "name", draft.fields.name, {
    placeholder: draft.defaultName || "",
    hint: HINTS.up_name,
    mode,
  });
  const i = wrap.querySelector("input");
  i.onblur = () => {
    if (!i.value.trim() && draft.defaultName) setField("name", draft.defaultName);
  };
  return wrap;
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

// ---------- 监听主机选择器 ----------
// 监听地址不能靠手打：本机 IP 会变。本机回环 / 全部 IP / 本机各 IP 做成下拉，
// 另留「自定义…」入口填任意地址。
const HOST_LOOPBACK = "127.0.0.1";
const HOST_ALL = "0.0.0.0";
let openPickerMenu = null;

function knownHost(v) {
  return v === HOST_LOOPBACK || v === HOST_ALL || (STATE.local_ips || []).indexOf(v) >= 0;
}

// 监听范围的类别，决定下拉项与已选按钮的配色
function hostClass(v) {
  if (v === HOST_LOOPBACK) return "pi-loopback";
  if (v === HOST_ALL) return "pi-all";
  if ((STATE.local_ips || []).indexOf(v) >= 0) return "pi-specific";
  return "pi-custom";
}

function hostLabel(v) {
  if (v === HOST_LOOPBACK) return "本机回环 " + v;
  if (v === HOST_ALL) return "本机全部 IP " + v;
  if ((STATE.local_ips || []).indexOf(v) >= 0) return "指定 IP " + v;
  return v || "—";
}

function hostField(name, value, opts) {
  opts = opts || {};
  const wrap = el("div", "f");
  const l = el("label");
  l.appendChild(el("span", null, opts.label || "监听 IP"));
  const holder = el("div", "picker");
  const btn = el("button", "picker-btn");
  btn.type = "button";
  btn.dataset.field = name;
  btn.dataset.value = value;
  btn.classList.add(hostClass(value));
  btn.textContent = hostLabel(value);
  const inp = el("input", "picker-input");
  inp.type = "text";
  inp.dataset.field = name;
  inp.value = value;
  inp.style.display = knownHost(value) ? "none" : "";
  inp.oninput = () => setField(name, inp.value);
  holder.appendChild(btn);
  holder.appendChild(inp);
  l.appendChild(holder);
  wrap.appendChild(l);
  applyHint(wrap, l, null, opts.hint, opts.mode);

  btn.onclick = (ev) => {
    ev.stopPropagation();
    openHostMenu(btn, holder);
  };
  return wrap;
}

function openHostMenu(btn, holder) {
  if (openPickerMenu) {
    openPickerMenu.remove();
    openPickerMenu = null;
    return;
  }
  const menu = el("div", "picker-menu");
  const name0 = btn.dataset.field;
  const inp = holder.querySelector("input.picker-input");
  const closeMenu = () => {
    menu.remove();
    if (openPickerMenu === menu) openPickerMenu = null;
  };
  const add = (val, label, hint, cls) => {
    const b = el(
      "button",
      "picker-item" + (val === btn.dataset.value ? " on" : "") + (cls ? " " + cls : ""),
      label
    );
    b.type = "button";
    if (hint) b.title = hint;
    b.onclick = (ev) => {
      ev.stopPropagation();
      closeMenu();
      setField(name0, val);
      btn.dataset.value = val;
      btn.textContent = hostLabel(val);
      inp.style.display = knownHost(val) ? "none" : "";
    };
    menu.appendChild(b);
  };
  add(HOST_LOOPBACK, "本机回环  " + HOST_LOOPBACK, "只接受本机访问，外部连不上", "pi-loopback");
  add(HOST_ALL, "本机全部 IP  " + HOST_ALL, "监听所有网卡，允许局域网访问", "pi-all");
  (STATE.local_ips || []).forEach((ip) => add(ip, "指定 IP  " + ip, "只监听这张网卡", "pi-specific"));
  const custom = el("button", "picker-item pi-custom", "自定义…");
  custom.type = "button";
  custom.onclick = (ev) => {
    ev.stopPropagation();
    closeMenu();
    inp.style.display = "";
    inp.focus();
    inp.select();
  };
  menu.appendChild(custom);
  // 菜单用 fixed 定位，避免被画布的 overflow 裁掉
  menu.style.position = "fixed";
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  const mh = Math.min(menu.offsetHeight, 260);
  const below = window.innerHeight - r.bottom;
  const top = below < mh + 12 ? Math.max(8, r.top - mh - 4) : r.bottom + 4;
  menu.style.left = r.left + "px";
  menu.style.top = top + "px";
  menu.style.minWidth = r.width + "px";
  openPickerMenu = menu;
  setTimeout(() => document.addEventListener("click", closeOnOutside, true), 0);
  function closeOnOutside(e) {
    if (holder.contains(e.target) || menu.contains(e.target)) return;
    closeMenu();
    document.removeEventListener("click", closeOnOutside, true);
  }
}

function renderInline() {
  const box = $("#inline");
  box.innerHTML = "";
  if (!draft || draft.kind !== "upstream") {
    box.classList.add("hidden");
    renderLinks();
    return;
  }
  const pos = nodePos[draft.id];
  const stage = $("#stage");
  const w = stage.clientWidth;
  box.classList.remove("hidden");
  const u = STATE.upstreams.find((x) => x.id === draft.id);
  const color = draft.isNew ? "#c3c8d0" : healthColor(u);
  box.style.borderColor = color;
  if (pos) {
    const left = Math.min(Math.max(8, pos.x - 150), w - 296);
    box.style.left = left + "px";
    box.style.top = Math.max(8, pos.y + 32) + "px";
  }
  box.appendChild(el("div", "po-title", draft.isNew ? "新增上游通道" : u ? u.name : "上游通道"));
  box.appendChild(
    el(
      "div",
      "hint",
      draft.isNew
        ? "填好接入参数后点「添加」，新通道会立刻纳入自动切换候选。"
        : "这条上游的接入参数，改动后点「保存」生效。"
    )
  );
  const f = el("div", "form");
  f.appendChild(nameField(draft, "tooltip"));
  const provBlock = fieldBlock("Provider", "provider", draft.fields.provider, { hint: HINTS.up_provider, mode: "tooltip" });
  f.appendChild(provBlock);
  f.appendChild(fieldBlock("Base URL", "base_url", draft.fields.base_url, { hint: HINTS.up_base, mode: "tooltip" }));
  autoFillProvider(f, provBlock, draft);
  f.appendChild(
    fieldBlock("API Key", "api_key", draft.fields.api_key, {
      type: "password",
      placeholder: "留空则不修改",
      hint: HINTS.up_key,
      mode: "tooltip",
    })
  );
  box.appendChild(f);
  // 图示：按钮文字前面的小图标（内联 SVG，无外部依赖）
  const ICONS = {
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
    probe: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  };
  const icon = (name) => {
    const s = el("span", "ico");
    s.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      (ICONS[name] || "") +
      "</svg>";
    return s;
  };
  const mkBtn = (cls, ico, label, title, onclick) => {
    const b = el("button", "btn " + cls);
    b.appendChild(icon(ico));
    b.appendChild(el("span", "bt", label));
    b.title = title;
    b.onclick = onclick;
    return b;
  };

  const row = el("div", "row");
  const save = el("button", "btn primary");
  if (!draft.isNew) save.appendChild(icon("save"));
  save.appendChild(el("span", "bt", draft.isNew ? "添加" : "保存"));
  save.title = draft.isNew ? "创建这条上游通道" : "把改动写回这条上游通道";
  save.onclick = () => saveDraft();
  row.appendChild(save);
  if (!draft.isNew) {
    row.appendChild(
      mkBtn("", "probe", "探测", "对这条上游发一次实际请求，检查连通性与凭据是否有效", () =>
        probeUpstream(draft.id)
      )
    );
    const del = mkBtn("danger", "trash", "删除", "移除这条上游通道", () => deleteUpstream(draft.id));
    row.appendChild(del);
  }
  box.appendChild(row);

  if (!draft.isNew) {
    const row2 = el("div", "row");
    const forced = (STATE.settings || {}).forced_upstream_id === draft.id;
    const forceBtn = mkBtn(
      forced ? "primary" : "",
      "lock",
      forced ? "恢复自动" : "锁定此通道",
      forced
        ? "取消手动锁定，回到自动路由（健康优先 + 会话粘性）"
        : "手动把路由锁到这条通道；它不可用时仍会自动切走。锁定优先于「排除」。",
      () => setForcedUpstream(forced ? "" : draft.id)
    );
    row2.appendChild(forceBtn);
    const exc = isExcluded(draft.id);
    const excBtn = mkBtn(
      exc ? "excluded-on" : "",
      "ban",
      exc ? "取消排除" : "排除此通道",
      exc
        ? "这条通道目前不参与自动路由。点一下把它放回候选池。"
        : "把这条通道移出自动路由候选池（仍会探测健康，也可再手动锁定）。",
      async () => {
        const cur = ((STATE.settings || {}).excluded_upstream_ids || []).slice();
        const next = exc ? cur.filter((x) => x !== draft.id) : cur.concat([draft.id]);
        await setExcluded(next);
      }
    );
    row2.appendChild(excBtn);
    box.appendChild(row2);
  }
  renderLinks();
}

async function setForcedUpstream(id) {
  try {
    await api("/api/force", { method: "POST", headers: jsonH(), body: JSON.stringify({ id }) });
    await loadState();
    toast(id ? "已锁定到该通道" : "已恢复自动路由");
  } catch (e) {
    toast("切换失败：" + (e.message || e), "warn");
  }
}

async function setExcluded(ids) {
  try {
    await api("/api/exclude", { method: "POST", headers: jsonH(), body: JSON.stringify({ ids }) });
    await loadState();
    toast(ids && ids.length ? "已排除 " + ids.length + " 条通道" : "已恢复全部通道参与路由");
  } catch (e) {
    toast("设置失败：" + (e.message || e), "warn");
  }
}

function isExcluded(id) {
  return ((STATE.settings || {}).excluded_upstream_ids || []).includes(id);
}

function healthColor(u) {
  if (!u) return "#2e7d32";
  if (u.health === "down") return "#b3261e";
  if (u.health === "degraded") return "#c58a00";
  return "#2e7d32";
}

// 节点上只显示 首 + *** + 尾，完整值在右侧详情里看
function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return key.slice(0, 3) + "***" + key.slice(-2);
  return key.slice(0, 6) + "***" + key.slice(-4);
}

function renderGwConsole() {
  const box = $("#gwConsole");
  box.innerHTML = "";
  if (!draft || draft.kind !== "gw") {
    box.classList.add("hidden");
    renderLinks();
    return;
  }
  // 右侧抽屉打开时，配置内容搬进抽屉，画布左侧不再显示控制台
  if (!$("#drawer").classList.contains("hidden")) {
    box.classList.add("hidden");
    renderLinks();
    return;
  }
  box.classList.remove("hidden");
  const stage = $("#stage");
  box.classList.toggle("compact", stage.clientWidth < 760);
  box.appendChild(el("div", "po-title", "网关控制台"));
  // 快速设置：协议 / 监听 IP / 端口 三项就地可改，改完点「保存」
  const form = el("div", "form");
  form.appendChild(
    radioBlock("协议", "protocol", draft.fields.protocol, PROTOCOLS, {
      hint: HINTS.protocol,
      mode: "tooltip",
      labels: { "openai-responses": "responses", "openai-chat": "chat", anthropic: "anthropic" },
    })
  );
  form.appendChild(
    hostField("listen_host", draft.fields.listen_host, { hint: HINTS.listen_host, mode: "tooltip" })
  );
  form.appendChild(
    fieldBlock("端口", "listen_port", draft.fields.listen_port, {
      type: "number",
      hint: HINTS.listen_port,
      mode: "tooltip",
    })
  );
  box.appendChild(form);
  const row = el("div", "row");
  const save = el("button", "btn primary", "保存");
  save.dataset.dirtyMark = "1";
  save.title = "把协议、监听地址写入配置";
  save.onclick = (ev) => {
    ev.stopPropagation();
    saveDraft();
  };
  row.appendChild(save);
  const cancel = el("button", "btn", "取消");
  cancel.title = "放弃本次修改";
  cancel.onclick = (ev) => {
    ev.stopPropagation();
    cancelDraft();
  };
  row.appendChild(cancel);
  const more = el("button", "btn", "更多…");
  more.title = "在右侧面板调整全部参数：切换预算、故障转移规则等";
  more.onclick = (ev) => {
    // 重绘会摘掉当前按钮，必须阻止冒泡，否则画布会当成"点空白"取消选中
    ev.stopPropagation();
    openDrawer();
  };
  row.appendChild(more);
  box.appendChild(row);
  renderLinks();
}

// 网关控制台的控件组（画布控制台与右侧抽屉共用）
function gwControls(mode) {
  const wrap = el("div");
  const f = el("div", "form");
  f.appendChild(radioBlock("协议", "protocol", draft.fields.protocol, PROTOCOLS, { hint: HINTS.protocol, mode }));
  f.appendChild(hostField("listen_host", draft.fields.listen_host, { hint: HINTS.listen_host, mode }));
  f.appendChild(fieldBlock("监听端口", "listen_port", draft.fields.listen_port, { type: "number", hint: HINTS.listen_port, mode }));
  f.appendChild(
    fieldBlock("单请求最大切换", "max_switches_per_request", draft.fields.max_switches_per_request, {
      type: "number",
      hint: HINTS.max_switches,
      mode,
    })
  );
  f.appendChild(
    fieldBlock("每分钟最大切换", "max_switches_per_minute", draft.fields.max_switches_per_minute, {
      type: "number",
      hint: HINTS.switch_per_minute,
      mode,
    })
  );
  f.appendChild(fieldBlock("最小驻留(秒)", "min_residency_s", draft.fields.min_residency_s, { type: "number", hint: HINTS.residency, mode }));
  f.appendChild(
    fieldBlock("提交前预算(秒)", "precommit_budget_s", draft.fields.precommit_budget_s, { type: "number", hint: HINTS.budget, mode })
  );
  wrap.appendChild(f);

  wrap.appendChild(el("div", "sub-title", "触发自动切换的状态"));
  const rules = el("div", "rules");
  Object.keys(RULE_LABELS).forEach((k) => {
    // 「已提交后不重试」是固定行为，不给勾选框；
    // 想要"已提交后仍重试"请用下面的危险开关。
    if (k === "post_commit_break") {
      const fixed = el("div", "f rule-fixed");
      fixed.appendChild(el("span", "fixed-tag", "固定"));
      fixed.appendChild(el("span", null, "已提交后不重试"));
      rules.appendChild(fixed);
      const note = el("div", "f-hint", RULE_HINTS[k] + "（如需强制重试，见下方危险开关）");
      rules.appendChild(note);
      return;
    }
    rules.appendChild(ruleBlock(k, RULE_LABELS[k], draft.rules[k], RULE_HINTS[k], mode));
  });
  wrap.appendChild(rules);

  const dz = el("div", "danger-zone");
  const dzf = el("div", "f");
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
  dzf.appendChild(rl);
  applyHint(dzf, rl, ri, "开启后，已经把请求交给下游的失败请求仍会被重放，可能重复内容、重复计费。默认关闭。", mode);
  dz.appendChild(dzf);
  dz.classList.toggle("on", draft.retry);
  wrap.appendChild(dz);

  const row = el("div", "row");
  const save = el("button", "btn primary", "保存应用");
  save.dataset.dirtyMark = "1";
  save.title = "把协议、监听、切换预算与故障转移规则写入配置";
  save.onclick = () => saveDraft();
  row.appendChild(save);
  const cancel = el("button", "btn", "取消");
  cancel.title = "放弃本次修改，恢复到已保存的配置";
  cancel.onclick = () => cancelDraft();
  row.appendChild(cancel);
  wrap.appendChild(row);
  if (mode === "inline") {
    wrap.appendChild(el("div", "f-hint", "「保存应用」写入协议、监听、切换预算与故障转移规则。"));
  }
  return wrap;
}

// 当前显示的卡片背后，画一根指向它所属节点的提示线
// 提示线元素同样复用，避免每次重建导致目标元素被销毁
let linkEls = null;

function ensureLinkEls() {
  if (linkEls) return linkEls;
  const svg = $("#overlay");
  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", "linkArrow");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "8");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "11");
  marker.setAttribute("markerHeight", "11");
  marker.setAttribute("orient", "auto-start-reverse");
  const head = document.createElementNS(SVG_NS, "path");
  head.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  head.setAttribute("fill", "#1a73e8");
  head.setAttribute("stroke", "#ffffff");
  head.setAttribute("stroke-width", "1");
  marker.appendChild(head);
  defs.appendChild(marker);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-dasharray", "5 4");
  path.setAttribute("fill", "none");
  path.setAttribute("marker-end", "url(#linkArrow)");
  svg.appendChild(defs);
  svg.appendChild(path);
  linkEls = { defs, marker, head, path };
  return linkEls;
}

function renderLinks() {
  const L = ensureLinkEls();
  L.path.style.display = "none";
  const inline = $("#inline");
  if (draft && draft.kind === "upstream" && !inline.classList.contains("hidden")) {
    const pos = nodePos[draft.id];
    if (pos) {
      const u = STATE.upstreams.find((x) => x.id === draft.id);
      drawLink(inline, pos.x, pos.y, draft.isNew ? "#c3c8d0" : healthColor(u), 80, 34);
    }
    return;
  }
  const box = $("#gwConsole");
  const gw = nodePos.__gw;
  if (!draft || draft.kind !== "gw" || !gw || box.classList.contains("hidden")) return;
  drawLink(box, gw.x, gw.y, "#1a73e8", 80, 32);
}

// 从卡片中心画一条指向节点中心的虚线，箭头停在节点边框外
function drawLink(box, tx, ty, color, hw, hh) {
  const L = ensureLinkEls();
  const stage = $("#stage");
  const sb = stage.getBoundingClientRect();
  const cb = box.getBoundingClientRect();
  const x1 = cb.left - sb.left + cb.width / 2;
  const y1 = cb.top - sb.top + cb.height / 2;
  const t = rectEnterT(x1, y1, tx, ty, tx, ty, hw, hh);
  const x2 = x1 + (tx - x1) * Math.max(0, t - 0.02);
  const y2 = y1 + (ty - y1) * Math.max(0, t - 0.02);
  L.head.setAttribute("fill", color);
  L.path.setAttribute("d", `M ${x1} ${y1} L ${x2} ${y2}`);
  L.path.setAttribute("stroke", color);
  L.path.style.display = "";
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
  // 抽屉打开时，网关配置在右侧抽屉里；画布上的控制台必须保持隐藏，
  // 否则会留下一个空壳（蓝框）压在 HA Gateway 节点上，还会挡住点击
  if (!$("#drawer").classList.contains("hidden")) {
    box.classList.add("hidden");
    return;
  }
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
    const s = STATE.settings;

    // 概览：全部信息只读列出来
    const gw = el("div", "sec");
    gw.appendChild(el("h3", null, "网关"));
    gw.appendChild(el("div", "po-line", `协议　${s.protocol}`));
    gw.appendChild(el("div", "po-line", `监听　${s.listen_host}:${s.listen_port}`));
    gw.appendChild(el("div", "po-line", `单请求最大切换　${s.max_switches_per_request}`));
    gw.appendChild(el("div", "po-line", `最小驻留　${s.min_residency_s} 秒`));
    gw.appendChild(el("div", "po-line", `提交前预算　${s.precommit_budget_s} 秒`));
    const on = Object.keys(RULE_LABELS).filter((k) => (s.rules || {})[k]);
    gw.appendChild(el("div", "po-line", `自动切换　${on.length ? on.map((k) => RULE_LABELS[k]).join("、") : "关闭"}`));
    gw.appendChild(el("div", "po-line", `已提交后仍重试　${s.retry_after_commit ? "开启（危险）" : "关闭"}`));
    body.appendChild(gw);

    const up = el("div", "sec");
    up.appendChild(el("h3", null, `上游（${STATE.upstreams.length}）`));
    if (!STATE.upstreams.length) up.appendChild(el("div", "po-line", "还没有上游通道"));
    STATE.upstreams.forEach((u) => {
      const row = el("div", "po-card");
      row.appendChild(el("div", "po-card-t", u.name));
      row.appendChild(el("div", "po-line", `Provider　${u.provider || "—"}`));
      row.appendChild(el("div", "po-line", `Base URL　${u.base_url || "—"}`));
      row.appendChild(el("div", "po-line", `API Key　${u.has_key === false ? "未填写" : "已填写"}`));
      row.appendChild(el("div", "po-line", `状态　${healthText(u)}`));
      const ex = isExcluded(u.id);
      const forced = (STATE.settings || {}).forced_upstream_id === u.id;
      row.appendChild(
        el(
          "div",
          "po-line",
          "路由　" + (forced ? "已锁定此通道" : ex ? "已排除（不参与自动路由）" : "参与自动路由")
        )
      );
      up.appendChild(row);
    });
    body.appendChild(up);

    const kd = el("div", "sec");
    kd.appendChild(el("h3", null, `下游 Key（${STATE.keys.length}）`));
    if (!STATE.keys.length) kd.appendChild(el("div", "po-line", "还没有下游 Key"));
    STATE.keys.forEach((k) => {
      const row = el("div", "po-card");
      row.appendChild(el("div", "po-card-t", k.label));
      row.appendChild(el("div", "po-line mono", k.key));
      kd.appendChild(row);
    });
    body.appendChild(kd);
    return;
  }
  if (draft.kind === "upstream") {
    title.textContent = draft.isNew ? "新增上游" : "上游通道";
    const sec = el("div", "sec");
    const u = STATE.upstreams.find((x) => x.id === draft.id);
    const h = el("h3", null, draft.isNew ? "新增上游通道" : u ? u.name : "上游通道");
    if (draft.dirty) h.appendChild(el("small", null, "（未保存）"));
    sec.appendChild(h);
    sec.appendChild(
      el(
        "div",
        "hint",
        draft.isNew
          ? "填好接入参数后点「添加」，新通道会立刻纳入自动切换候选。"
          : "这条上游的接入参数，改动后点「保存」生效。"
      )
    );
    const f = el("div", "form");
    f.appendChild(nameField(draft, "inline"));
    const provBlock = fieldBlock("Provider", "provider", draft.fields.provider, { hint: HINTS.up_provider, mode: "inline" });
    f.appendChild(provBlock);
    f.appendChild(fieldBlock("Base URL", "base_url", draft.fields.base_url, { hint: HINTS.up_base, mode: "inline" }));
    autoFillProvider(f, provBlock, draft);
    f.appendChild(
      fieldBlock("API Key", "api_key", draft.fields.api_key, {
        type: "password",
        placeholder: "留空则不修改",
        hint: HINTS.up_key,
        mode: "inline",
      })
    );
    sec.appendChild(f);
    const row = el("div", "row");
    const save = el("button", "btn primary", draft.isNew ? "添加" : "保存");
    save.title = draft.isNew ? "创建这条上游通道" : "把改动写回这条上游通道";
    save.onclick = () => saveDraft();
    row.appendChild(save);
    if (!draft.isNew) {
      const probe = el("button", "btn", "探测");
      probe.title = "对这条上游发一次实际请求，检查连通性与凭据是否有效";
      probe.onclick = () => probeUpstream(draft.id);
      row.appendChild(probe);
      const del = el("button", "btn danger", "删除");
      del.title = "移除这条上游通道";
      del.onclick = () => deleteUpstream(draft.id);
      row.appendChild(del);
    }
    sec.appendChild(row);
    sec.appendChild(
      el(
        "div",
        "f-hint",
        "「保存」写回这条上游的接入参数；「探测」发一次实际请求检查连通性与凭据；「删除」移除这条通道。"
      )
    );
    body.appendChild(sec);
    return;
  }
  if (draft.kind === "key") {
    title.textContent = "下游 Key";
    const k = STATE.keys.find((x) => x.id === draft.id);
    const sec = el("div", "sec");
    sec.appendChild(el("h3", null, "下游 Key"));
    if (k) {
      sec.appendChild(keyNameField(k));
      sec.appendChild(el("div", "po-key", k.key));
      sec.appendChild(el("div", "f-hint", "这把 Key 是下游（Codex）用来调用网关的凭证，等同于一把单独发放的入口密码。"));
    }
    const row = el("div", "row");
    const cp = el("button", "btn", "复制");
    cp.title = "复制这把 Key，填进 Codex 的配置里";
    cp.onclick = () => {
      if (!k) return;
      navigator.clipboard.writeText(k.key).catch(() => {});
      cp.textContent = "已复制";
      setTimeout(() => (cp.textContent = "复制"), 1200);
      toast("已复制这把 Key");
    };
    row.appendChild(cp);
    const del = el("button", "btn danger", "删除");
    del.title = "删除这把 Key，持有它的下游会立刻失效";
    del.onclick = () => deleteKey(k);
    row.appendChild(del);
    sec.appendChild(row);
    sec.appendChild(el("div", "f-hint", "「复制」把这把 Key 复制到剪贴板；「删除」会立即让使用它的下游无法访问网关。"));
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
      sec.appendChild(gwControls("inline"));
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
    const proto = (STATE.settings || {}).protocol || "openai-responses";
    const norm = normalizeBaseUrl(draft.fields.base_url, proto);
    const body = {
      name: (draft.fields.name || "").trim() || draft.defaultName || "",
      provider: (draft.fields.provider || "").trim() || providerFromBaseUrl(norm.url),
      base_url: norm.url,
    };
    if (norm.note) toast("Base URL 已自动纠正：" + norm.note, "warn");
    if (draft.fields.api_key) body.api_key = draft.fields.api_key;
    if (!body.name || !body.base_url) {
      toast("名称与 Base URL 必填", "warn");
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
        max_switches_per_minute: Number(draft.fields.max_switches_per_minute),
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
  const detail = `HTTP ${res.status} · ${res.ms}ms`;
  pushLog(res.status >= 200 && res.status < 300 ? "info" : "warn", `探测上游 ${id}：${detail} ${res.body || ""}`);
  toast("探测完成 " + detail, res.status >= 200 && res.status < 300 ? "" : "warn");
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
  toast("已生成并复制：" + res.key);
  await loadState();
}

// ---------- 抽屉 ----------

function openDrawer() {
  $("#drawer").classList.remove("hidden");
  // 面板已经打开 -> 箭头朝右，点它表示"收起到右边"
  $("#toggleDrawer").textContent = "▶";
  $("#toggleDrawer").title = "收起管理面板";
  renderTopology();
  renderPanels();
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
  // 面板已收起 -> 箭头朝左，点它表示"把面板拉出来"
  $("#toggleDrawer").textContent = "◀";
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
$("#routeMode").onclick = () => {
  const s = STATE.settings || {};
  if (s.forced_upstream_id) {
    setForcedUpstream("");
  } else if ((s.excluded_upstream_ids || []).length) {
    setExcluded([]);
  } else {
    selectObject("gw", "gw");
  }
};
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
  // 目标已被重绘摘掉时不要当成"点空白"（否则点某个会重绘自己的控件就误触取消选中）
  if (ev.target && !ev.target.isConnected) return;
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

// 上下分隔条：拖动调整画布与日志窗格的高度比例
(() => {
  const sp = $("#splitter");
  if (!sp) return;
  const saved = localStorage.getItem("ha.logH");
  if (saved) document.documentElement.style.setProperty("--log-h", saved + "px");
  let dragging = false;
  let pending = false;
  sp.addEventListener("pointerdown", (e) => {
    dragging = true;
    sp.classList.add("dragging");
    try {
      sp.setPointerCapture(e.pointerId);
    } catch (err) {}
    e.preventDefault();
  });
  sp.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = $("#logpane").getBoundingClientRect();
    const h = Math.round(
      Math.max(80, Math.min(rect.bottom - e.clientY, window.innerHeight - 260))
    );
    document.documentElement.style.setProperty("--log-h", h + "px");
    localStorage.setItem("ha.logH", String(h));
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        renderTopology();
      });
    }
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    sp.classList.remove("dragging");
    try {
      sp.releasePointerCapture(e.pointerId);
    } catch (err) {}
  };
  sp.addEventListener("pointerup", stop);
  sp.addEventListener("pointercancel", stop);
})();

// ---------- 连线动画（流动虚线 + 请求数据球） ----------
//
// 两套独立机制：
//   1) 链路流动 —— CSS stroke-dashoffset，颜色表达健康态（up/degraded/down/ghost）
//   2) 请求数据球 —— JS rAF + path.getPointAtLength()，沿连线跑的小球
//
// 关键约束：数据球不参与 lastStateSig 的拓扑签名。
// 请求数一变就整图重绘会抵消已有的增量渲染优势，所以这里独立同步。

const flowSystem = (() => {
  const MAX_BALLS = 24;      // 全局上限
  const MAX_PER_EDGE = 4;    // 单条连线上限
  const MIN_SPACING = 36;    // 同一条线上两个球的最小间距（px）
  const RADIUS = 5.5; // 基础半径；实际按线的粗细放大
  const SPEED = 110;         // px/s
  const FADE_MS = 300;
  const MAX_DELTA = 50;      // 帧间隔截断，避免从后台切回来时球突然跳一大段

  let svg = null;
  let layer = null;
  const balls = [];
  let edges = []; // 当前这一帧的连线（edgeId -> path 元素）
  const lastHeat = new Map();
  let rafId = 0;
  let lastTime = null;
  let enabled = true;        // 用户开关（顶栏「动画」）
  let speedMul = 1;          // 用户速度滑块
  let destroyed = false;

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  function ensureLayer(targetSvg) {
    if (targetSvg) svg = targetSvg;
    if (!svg) return null;
    if (!layer) {
      layer = document.createElementNS(SVG_NS, "g");
      layer.setAttribute("class", "flow-layer");
      layer.setAttribute("aria-hidden", "true");
    }
    if (layer.parentNode !== svg || svg.lastElementChild !== layer) {
      svg.appendChild(layer);
    }
    return layer;
  }

  function createBall() {
    if (balls.length >= MAX_BALLS) return null;
    const node = document.createElementNS(SVG_NS, "circle");
    node.setAttribute("r", String(RADIUS));
    node.setAttribute("cx", "0");
    node.setAttribute("cy", "0");
    node.setAttribute("opacity", "0");
    node.setAttribute("class", "flow-ball");
    ensureLayer().appendChild(node);
    const ball = {
      node,
      state: "pooled", // pooled -> active -> fading -> pooled
      edgeId: null,
      path: null,
      pathLength: 0,
      distance: 0,
      dir: 1,
      fadeElapsed: 0,
      onComplete: null,
    };
    balls.push(ball);
    return ball;
  }

  function resetBall(ball) {
    ball.state = "pooled";
    ball.edgeId = null;
    ball.path = null;
    ball.pathLength = 0;
    ball.distance = 0;
    ball.dir = 1;
    ball.fadeElapsed = 0;
    ball.onComplete = null;
    ball.node.setAttribute("opacity", "0");
    ball.node.style.display = "none";
  }

  function positionOnPath(ball) {
    return ball.dir > 0 ? ball.distance : ball.pathLength - ball.distance;
  }

  function updatePosition(ball) {
    const t = Math.max(0, Math.min(ball.pathLength, positionOnPath(ball)));
    const pt = ball.path.getPointAtLength(t);
    ball.node.setAttribute("cx", pt.x);
    ball.node.setAttribute("cy", pt.y);
  }

  function edgeBalls(edgeId) {
    return balls.filter((b) => b.state !== "pooled" && b.edgeId === edgeId);
  }

  function canPlace(edgeId, position) {
    if (edgeBalls(edgeId).length >= MAX_PER_EDGE) return false;
    for (const b of edgeBalls(edgeId)) {
      if (Math.abs(position - positionOnPath(b)) < MIN_SPACING) return false;
    }
    return true;
  }

  function findSpawn(edgeId, dir, pathLength) {
    for (const d of [0, MIN_SPACING, MIN_SPACING * 2, MIN_SPACING * 3, MIN_SPACING * 4]) {
      if (d >= pathLength) continue;
      const pos = dir > 0 ? d : pathLength - d;
      if (canPlace(edgeId, pos)) return d;
    }
    return null;
  }

  function spawnBall(edgeId, dir, onComplete) {
    if (destroyed || !enabled || motionQuery.matches || document.hidden) return null;
    const edge = wireEdges.find((e) => e.id === edgeId);
    if (!edge || !edge.path || !edge.path.isConnected) return null;
    let pathLength = 0;
    try {
      pathLength = edge.path.getTotalLength();
    } catch (e) {
      return null;
    }
    if (!pathLength || !isFinite(pathLength)) return null;
    if (balls.filter((b) => b.state !== "pooled").length >= MAX_BALLS) return null;
    dir = dir < 0 ? -1 : 1;
    const d = findSpawn(edgeId, dir, pathLength);
    if (d === null) return null;
    const ball = balls.find((b) => b.state === "pooled") || createBall();
    if (!ball) return null;
    // 球大小跟线的粗细走：线本身越粗（锁定/当前通道），球越大；
    // 不用 computedStyle，免得"传输中变亮"时球在半路突然变大
    let r = RADIUS;
    try {
      const cls = edge.path.classList || { contains: () => false };
      const thick =
        cls.contains("wire-flow-locked") || cls.contains("wire-flow-active");
      r = thick ? 6.5 : RADIUS;
    } catch (e) {
      /* 取不到就用默认值 */
    }
    ball.node.setAttribute("r", String(r));
    ball.state = "active";
    ball.edgeId = edgeId;
    ball.path = edge.path;
    ball.pathLength = pathLength;
    ball.distance = d;
    ball.dir = dir;
    ball.fadeElapsed = 0;
    ball.onComplete = typeof onComplete === "function" ? onComplete : null;
    ball.node.style.display = "";
    ball.node.setAttribute("opacity", "0.95");
    ball.node.setAttribute("class", "flow-ball is-active");
    updatePosition(ball);
    ensureRunning();
    return ball;
  }

  function releaseBall(ball) {
    if (!ball || ball.state !== "active") return;
    ball.state = "fading";
    ball.fadeElapsed = 0;
    ball.onComplete = null;
  }

  function finishBall(ball) {
    const cb = ball.onComplete;
    resetBall(ball);
    if (typeof cb === "function") cb();
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (lastTime === null) lastTime = now;
    const dt = Math.min(MAX_DELTA, now - lastTime);
    lastTime = now;
    for (const ball of balls) {
      if (ball.state === "active") {
        ball.distance += (SPEED * speedMul * dt) / 1000;
        if (ball.distance >= ball.pathLength) {
          finishBall(ball);
          continue;
        }
        updatePosition(ball);
      } else if (ball.state === "fading") {
        ball.fadeElapsed += dt;
        const p = Math.min(1, ball.fadeElapsed / FADE_MS);
        ball.node.setAttribute("opacity", String(0.95 * (1 - p)));
        if (p >= 1) resetBall(ball);
      }
    }
    updateHeat();
  }

  // 传输态联动：有球在跑的线变亮；下游线的亮度是上面各线的"或"
  function updateHeat(force) {
    if (!edges.length) return;
    const hot = new Set();
    for (const b of balls) {
      if (b.state === "active" && b.edgeId) hot.add(b.edgeId);
    }
    let upHot = 0;
    const levels = new Map();
    for (const e of edges) {
      if (e.kind === "up") {
        const lv = hot.has(e.id) ? 1 : 0;
        levels.set(e.id, lv);
        if (lv) upHot++;
      }
    }
    for (const e of edges) {
      if (e.kind === "down") {
        // 上面只要有一条在传，下游就在传；两条以上同时传，下游更亮
        levels.set(e.id, upHot === 0 ? 0 : upHot > 1 ? 2 : 1);
      }
    }
    for (const e of edges) {
      const lv = levels.get(e.id) || 0;
      if (!force && lastHeat.get(e.id) === lv) continue;
      lastHeat.set(e.id, lv);
      const p = e.path;
      if (!p || !p.classList) continue;
      p.classList.toggle("wire-hot", lv === 1);
      p.classList.toggle("wire-hot2", lv === 2);
    }
  }

  function ensureRunning() {
    const want = enabled && !motionQuery.matches && !document.hidden;
    if (want && !rafId) {
      lastTime = null;
      rafId = requestAnimationFrame(tick);
    } else if (!want && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
      lastTime = null;
    }
  }

  function setPaths(nextEdges, targetSvg) {
    // path 元素是池化复用的，位置随时会变；这里只登记 id -> 元素，
    // 每帧真正取坐标时都从元素上重新算长度。
    ensureLayer(targetSvg);
    edges = nextEdges;
    for (const ball of balls) {
      if (ball.state === "pooled") continue;
      const edge = nextEdges.find((e) => e.id === ball.edgeId);
      if (!edge || !edge.path || !edge.path.isConnected) {
        releaseBall(ball);
        continue;
      }
      ball.path = edge.path;
      try {
        ball.pathLength = edge.path.getTotalLength();
        ball.distance = Math.min(ball.distance, ball.pathLength);
      } catch (e) {
        releaseBall(ball);
      }
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!enabled) {
      for (const ball of balls) resetBall(ball);
      if (layer) layer.style.display = "none";
    } else {
      if (layer) layer.style.display = "";
    }
    updateHeat(true);
    ensureRunning();
  }

  function refreshHeat() {
    updateHeat(true);
  }

  function isEnabled() {
    return enabled;
  }

  function setSpeed(mul) {
    speedMul = Math.max(0.25, Math.min(3, Number(mul) || 1));
  }

  function countActive(edgeId) {
    return balls.filter((b) => b.state === "active" && b.edgeId === edgeId).length;
  }

  // 目标数量下降时，淡出多余的球（优先回收走得最远的）
  function releaseEdge(edgeId, keep) {
    const list = balls
      .filter((b) => b.state === "active" && b.edgeId === edgeId)
      .sort((a, b) => b.distance - a.distance);
    let n = list.length - keep;
    for (const b of list) {
      if (n <= 0) break;
      releaseBall(b);
      n--;
    }
  }

  document.addEventListener("visibilitychange", () => {
    ensureRunning();
  });

  return {
    spawnBall,
    setPaths,
    setEnabled,
    isEnabled,
    ensureRunning,
    countActive,
    releaseEdge,
    setSpeed,
    refreshHeat,
  };
})();

// 第一阶段：没有后端 inflight 指标，用装饰性数据源顶替。
// 在活跃上游链路上定时发一颗球，跑到网关后再串一颗到下游（回包是流式的，不画球）。
const decorativeFlow = (() => {
  const MIN_INTERVAL = 1400;
  const MAX_INTERVAL = 2800;
  let timer = 0;
  let running = false;

  function allowed() {
    return running && !document.hidden && flowSystem.isEnabled();
  }

  function pick(list) {
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }

  function upEdges() {
    const usable = wireEdges.filter((e) => e.kind === "up" && e.health !== "down");
    const active = usable.filter((e) => e.owner === activeUpstream);
    // 没有明确的活跃通道时，就在所有可用通道里挑一条，别让动画空转
    return active.length ? active : usable;
  }

  function downEdges() {
    return wireEdges.filter((e) => e.kind === "down");
  }

  function pulse() {
    timer = 0;
    if (!allowed()) return;
    const up = pick(upEdges());
    if (up) {
      const down = pick(downEdges());
      flowSystem.spawnBall(up.id, 1, () => {
        if (down && allowed()) flowSystem.spawnBall(down.id, 1);
      });
    }
    schedule();
  }

  function schedule() {
    if (!allowed() || timer) return;
    timer = setTimeout(pulse, MIN_INTERVAL + Math.random() * (MAX_INTERVAL - MIN_INTERVAL));
  }

  function start() {
    running = true;
    if (timer) clearTimeout(timer);
    timer = 0;
    schedule();
  }

  function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = 0;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else schedule();
  });

  return { start, stop };
})();

// 数据球驱动：按后端真实并发数决定每条线上跑几颗球。
// 后端还没给指标时，退回装饰性模式（random pulse）。
const flowDriver = (() => {
  const MAX_PER_EDGE = 4;

  function sync(metrics) {
    if (!metrics) {
      decorativeFlow.start();
      return;
    }
    decorativeFlow.stop();
    if (!flowSystem.isEnabled()) return;
    const downs = wireEdges.filter((e) => e.kind === "down").length || 1;
    for (const e of wireEdges) {
      let want = 0;
      if (e.kind === "up") {
        const u = (metrics.upstreams || {})[e.owner] || {};
        want = Math.min(MAX_PER_EDGE, Math.round(u.inflight || 0));
      } else if (e.kind === "down") {
        const g = metrics.gateway || {};
        want = Math.min(MAX_PER_EDGE, Math.round((g.inflight || 0) / downs));
      }
      const have = flowSystem.countActive(e.id);
      if (have < want) {
        for (let i = have; i < want; i++) flowSystem.spawnBall(e.id, 1);
      } else if (have > want) {
        flowSystem.releaseEdge(e.id, want);
      }
    }
  }

  return { sync };
})();

// 顶栏「动画」开关：默认开，关掉后连线静止、数据球消失
const animToggle = $("#animToggle");
const animSpeed = $("#animSpeed");

function applyAnimSpeed(v) {
  const mul = Math.max(0.25, Math.min(3, Number(v) || 1));
  document.documentElement.style.setProperty("--anim-speed", String(mul));
  flowSystem.setSpeed(mul);
}

animSpeed.value = localStorage.getItem("ha.animSpeed") || "1";
applyAnimSpeed(animSpeed.value);
animSpeed.oninput = () => {
  localStorage.setItem("ha.animSpeed", animSpeed.value);
  applyAnimSpeed(animSpeed.value);
};

function applyAnim(on) {
  $("#wires").classList.toggle("anim-off", !on);
  flowSystem.setEnabled(on);
  if (on) decorativeFlow.start();
  else decorativeFlow.stop();
}
animToggle.checked = localStorage.getItem("ha.anim") !== "0";
animToggle.onchange = () => {
  localStorage.setItem("ha.anim", animToggle.checked ? "1" : "0");
  applyAnim(animToggle.checked);
  pushLog("info", "连线动画已" + (animToggle.checked ? "开启" : "关闭"));
};

loadState();
applyAnim(animToggle.checked);
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
