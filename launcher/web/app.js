(function () {
  "use strict";

  var state = { actions: [], jobs: [], jobId: "", since: 0, timer: null };

  function $(id) {
    return document.getElementById(id);
  }

  function api(path, opts) {
    return fetch(path, opts || {}).then(function (r) {
      return r.json();
    });
  }

  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function renderStatus(snap) {
    var st = snap.status || {};
    var dot = $("dot");
    dot.className = "dot" + (st.running ? " running" : st.error ? " error" : "");
    $("statusText").textContent = st.running
      ? "服务运行中 · 端口 " + st.port
      : "服务未运行";
    var bits = [];
    if (st.pid) bits.push("pid " + st.pid);
    if (st.version) bits.push("v" + st.version);
    if (st.uptime) bits.push("uptime " + st.uptime);
    if (snap.repo_root) bits.push(snap.repo_root);
    $("metaText").textContent = bits.join(" · ");
  }

  function renderActions(actions) {
    var box = $("actions");
    box.textContent = "";
    actions.forEach(function (a) {
      var btn = document.createElement("button");
      btn.className = "act" + (a.danger ? " danger" : "");
      btn.disabled = !!a.disabled;
      var title = document.createElement("span");
      title.textContent = a.label;
      btn.appendChild(title);
      if (a.hint) {
        var hint = document.createElement("small");
        hint.textContent = a.hint;
        btn.appendChild(hint);
      }
      btn.addEventListener("click", function () {
        if (a.confirm && !window.confirm(a.confirm)) return;
        post("/api/action", { id: a.id }).then(function (res) {
          if (!res.ok && res.error) {
            $("saveHint").textContent = res.error;
          }
          refresh();
        });
      });
      box.appendChild(btn);
    });
  }

  function renderJobs(jobs) {
    var sel = $("jobSelect");
    var prev = sel.value;
    sel.textContent = "";
    jobs.forEach(function (j) {
      var opt = document.createElement("option");
      opt.value = j.id;
      opt.textContent = j.label + " · " + j.state + (j.rc !== null && j.rc !== undefined ? " (" + j.rc + ")" : "");
      sel.appendChild(opt);
    });
    if (prev && jobs.some(function (j) { return j.id === prev; })) {
      sel.value = prev;
    } else if (jobs.length) {
      sel.value = jobs[0].id;
    }
    if (sel.value !== state.jobId) {
      state.jobId = sel.value;
      state.since = 0;
      $("log").textContent = "";
    }
  }

  function renderSettings(settings) {
    var form = $("settings");
    ["port", "hostname", "preset", "launcher_mode"].forEach(function (k) {
      if (form.elements[k] && settings[k] !== undefined && settings[k] !== null) {
        form.elements[k].value = settings[k];
      }
    });
  }

  function refresh() {
    return api("/api/state").then(function (snap) {
      renderStatus(snap);
      renderActions(snap.actions || []);
      renderJobs(snap.jobs || []);
      renderSettings(snap.settings || {});
      pollLogs();
    });
  }

  function pollLogs() {
    var q = "/api/logs?job=" + encodeURIComponent(state.jobId) + "&since=" + state.since;
    api(q).then(function (res) {
      if (res.lines && res.lines.length) {
        var log = $("log");
        res.lines.forEach(function (line) {
          log.textContent += line.text + "\n";
        });
        state.since = res.lines[res.lines.length - 1].seq;
        log.scrollTop = log.scrollHeight;
      }
    }).catch(function () {});
  }

  $("settings").addEventListener("submit", function (e) {
    e.preventDefault();
    var form = e.target;
    var payload = {
      port: form.elements.port.value,
      hostname: form.elements.hostname.value,
      preset: form.elements.preset.value,
      launcher_mode: form.elements.launcher_mode.value,
      git_proxy: form.elements.git_proxy.value,
    };
    post("/api/settings", payload).then(function () {
      $("saveHint").textContent = "已保存";
      setTimeout(function () { $("saveHint").textContent = ""; }, 1500);
      refresh();
    });
  });

  $("refreshBtn").addEventListener("click", refresh);

  $("jobSelect").addEventListener("change", function (e) {
    state.jobId = e.target.value;
    state.since = 0;
    $("log").textContent = "";
    pollLogs();
  });

  $("cancelBtn").addEventListener("click", function () {
    if (!state.jobId) return;
    post("/api/cancel", { id: state.jobId });
  });

  refresh();
  state.timer = window.setInterval(pollLogs, 1500);
  window.setInterval(refresh, 5000);
})();
