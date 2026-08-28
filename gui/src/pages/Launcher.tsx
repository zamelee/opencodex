import { useEffect, useRef, useState } from "react";


import {


  fetchOpenCodexConfig,


  saveOpenCodexConfig,


  restartProxy,


  type OpenCodexConfigPayload,


  type OpenCodexConfigUpdate,


  type OpenCodexPreset,


} from "../api";


import { useT } from "../i18n";


import type { TKey } from "../i18n/en";





const PRESETS: { value: NonNullable<OpenCodexPreset>; valueTKey: TKey }[] = [


  { value: "launcher", valueTKey: "settings.preset.launcher" as TKey },


  { value: "proxy-only", valueTKey: "settings.preset.proxyOnly" as TKey },


  { value: "full-pass-through", valueTKey: "settings.preset.fullPassThrough" as TKey },


];





const FLAG_ROWS = [


  { key: "enableCodexLauncherMode", labelKey: "settings.launcherMode", onKey: "settings.flagOnSeen.launcherMode", offKey: "settings.flagOffSeen.launcherMode" },


  { key: "syncRoutedModels",          labelKey: "settings.syncRouted",    onKey: "settings.flagOnSeen.syncRouted",    offKey: "settings.flagOffSeen.syncRouted" },


  { key: "syncNativeOpenaiModels",    labelKey: "settings.syncNative",    onKey: "settings.flagOnSeen.syncNative",    offKey: "settings.flagOffSeen.syncNative" },


] as const;





type RestartStatus = "idle" | "restarting" | "healthy" | "failed";





function MermaidBlock({

  source,

  fsEnterLabel,

  fsExitLabel,

}: {

  source: string;

  fsEnterLabel: string;

  fsExitLabel: string;

}) {

  const wrapRef = useRef<HTMLDivElement | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);

  const [isFs, setIsFs] = useState(false);



  useEffect(() => {

    const handler = () => {

      setIsFs(document.fullscreenElement === wrapRef.current);

    };

    document.addEventListener("fullscreenchange", handler);

    return () => document.removeEventListener("fullscreenchange", handler);

  }, []);



  // Wheel zoom + drag pan + double-click reset, scoped to the inner viewport.

  // Wheel zoom + drag pan + double-click reset, scoped to the inner viewport.
  //   Initial zoom auto-fits the SVG to the viewport (filling whichever axis is
  //   short on space, capped at 3.5x); the user wheels/drags from there.
  //   Zoom is implemented by writing the SVG element's CSS width/height, NOT
  //   by CSS transform: scale(). Mermaid's htmlLabels:true emits node text via
  //   <foreignObject> wrapping HTML, and HTML inside a foreignObject gets
  //   rasterised once at the SVG's render size. Any subsequent CSS-scale
  //   rescales that bitmap and turns it blurry. Resizing the SVG forces a
  //   re-rasterisation of the foreignObject content at the new target pixel
  //   density, so it stays crisp at every zoom level.
  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return;

    let zoom = 1;
    let fitZoom = 1;
    let baseW = 800;
    let baseH = 400;
    let tx = 0;
    let ty = 0;
    let panning = false;
    let startX = 0;
    let startY = 0;
    let startTx = 0;
    let startTy = 0;

    const getSVG = (): SVGSVGElement | null =>
      canvas.querySelector(".mermaid svg");

    const readBaseSize = (svg: SVGSVGElement) => {
      const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(parseFloat);
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        baseW = vb[2];
        baseH = vb[3];
        return;
      }
      const r = svg.getBoundingClientRect();
      baseW = Math.max(r.width || 0, 200);
      baseH = Math.max(r.height || 0, 100);
    };

    const apply = () => {
      const svg = getSVG();
      if (!svg) return;
      const dw = baseW * zoom;
      const dh = baseH * zoom;
      svg.style.width = `${dw}px`;
      svg.style.height = `${dh}px`;
      canvas.style.transform = `translate(${tx}px, ${ty}px)`;
    };

    const recomputeFit = () => {
      const vw = viewport.clientWidth;
      // Width-aligned: SVG width = viewport width. The viewport's CSS
      // max-height/min-height then governs whether the SVG fits (short
      // diagram -> viewport shrinks to fit) or scrolls (very tall diagram
      // -> viewport max-height caps it, vertical scrollbar appears).
      let fit = vw / baseW;
      // Don't stretch tiny diagrams past 3.5x (otherwise a 50x50 diagram
      // would zoom to 27x and look pixellated).
      if (fit > 3.5) fit = 3.5;
      // No under-floor: a too-wide diagram legitimately shrinks below 1x so
      // its width matches the viewport. The user can still scroll-wheel back
      // up.
      fitZoom = fit;
      zoom = fit;
      tx = 0;
      ty = 0;
      apply();
    };

    const onSvgReady = (svg: SVGSVGElement) => {
      readBaseSize(svg);
      recomputeFit();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!getSVG()) return;
      const rect = viewport.getBoundingClientRect();
      // The viewport is overflow:auto, so the cursor position relative to
      // the visible viewport rect must be combined with the current scroll
      // offset to find the SVG-space coordinate under the cursor. Without
      // the +scrollLeft/+scrollTop, the zoom math drifts by
      //   scrollLeft * (1 - ratio)
      // pixels per wheel tick whenever the user has scrolled the canvas.
      const cx = e.clientX - rect.left + viewport.scrollLeft;
      const cy = e.clientY - rect.top + viewport.scrollTop;
      const delta = -e.deltaY * 0.0015;
      const newZoom = Math.min(4, Math.max(0.3, zoom * (1 + delta)));
      const ratio = newZoom / zoom;
      tx = cx - (cx - tx) * ratio;
      ty = cy - (cy - ty) * ratio;
      zoom = newZoom;
      apply();
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as Element | null;
      if (t && t.closest(".mermaid-fullscreen-btn")) return;
      panning = true;
      startX = e.clientX;
      startY = e.clientY;
      startTx = tx;
      startTy = ty;
      viewport.style.cursor = "grabbing";
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!panning) return;
      tx = startTx + (e.clientX - startX);
      ty = startTy + (e.clientY - startY);
      apply();
    };

    const onMouseUp = () => {
      panning = false;
      viewport.style.cursor = "grab";
    };

    const onDoubleClick = () => {
      zoom = fitZoom;
      tx = 0;
      ty = 0;
      apply();
    };

    const onResize = () => {
      // If user is still at the auto-fit zoom, refit for the new viewport size.
      if (Math.abs(zoom - fitZoom) < 0.01) {
        recomputeFit();
      }
    };

    viewport.style.cursor = "grab";
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("mousedown", onMouseDown);
    viewport.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("resize", onResize);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    // The viewport's pixel size changes when the wrap enters/leaves fullscreen,
    // but window "resize" does not fire on that transition. Hook the doc-level
    // fullscreenchange and refit on the next frame so the Min formula sees
    // the new clientWidth/clientHeight.
    const onFsChange = () => requestAnimationFrame(() => recomputeFit());
    document.addEventListener("fullscreenchange", onFsChange);

    // React to SVG insertion by the parent's mermaid render pass.
    const observer = new MutationObserver(() => {
      const svg = getSVG();
      if (svg) onSvgReady(svg);
    });
    observer.observe(canvas, { childList: true, subtree: true });

    return () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("mousedown", onMouseDown);
      viewport.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("fullscreenchange", onFsChange);
      observer.disconnect();
    };
  }, []);



  const toggleFs = () => {

    if (!wrapRef.current) return;

    if (document.fullscreenElement === wrapRef.current) {

      void document.exitFullscreen();

    } else {

      void wrapRef.current.requestFullscreen();

    }

  };



  return (

    <div className="mermaid-wrap" ref={wrapRef}>

      <button

        className="mermaid-fullscreen-btn"

        type="button"

        onClick={toggleFs}

        aria-label={isFs ? fsExitLabel : fsEnterLabel}

      >

        {isFs ? fsExitLabel : fsEnterLabel}

      </button>

      <div className="mermaid-viewport" ref={viewportRef}>

        <div className="mermaid-canvas" ref={canvasRef}>

          <pre className="mermaid">{source}</pre>

        </div>

      </div>

      <span className="mermaid-zoom-hint">滚轮缩放 · 拖拽平移 · 双击复位</span>

    </div>

  );

}



export default function Launcher() {


  const t = useT();


  const [cfg, setCfg] = useState<OpenCodexConfigPayload | null>(null);


  const [error, setError] = useState<string | null>(null);


  const [info, setInfo] = useState<string | null>(null);


  const [saving, setSaving] = useState(false);


  const [restartStatus, setRestartStatus] = useState<RestartStatus>("idle");


  const [restartElapsedMs, setRestartElapsedMs] = useState(0);


  const timerRef = useRef<number | null>(null);





  async function load() {


    setError(null); setInfo(null);


    try {


      setCfg(await fetchOpenCodexConfig());


    } catch (e) {


      setError(e instanceof Error ? e.message : String(e));


    }


  }





  // Mount + unmount


  useEffect(() => { void load(); }, []);


  useEffect(() => () => {


    if (timerRef.current) {


      window.clearInterval(timerRef.current);


      timerRef.current = null;


    }


  }, []);





  const detailsRef = useRef<HTMLDetailsElement | null>(null);


  // Mermaid: lazy-load on mount; render all .mermaid nodes; re-render when <details>


  // toggles open (mermaid can't size correctly while its host is display:none).


  // Mermaid: lazy-import once via ref; render diagrams whenever cfg becomes truthy (the


  // <details> block is only mounted after config loads, so we have to re-run on cfg change).


  const mermaidRef = useRef<Promise<typeof import("mermaid").default> | null>(null);


  useEffect(() => {


    if (!cfg) return;


    if (!mermaidRef.current) {


      mermaidRef.current = import("mermaid").then((m) => m.default);


    }


    let cancelled = false;


    void (async () => {


      const promise = mermaidRef.current;


      if (!promise) return;


      let mermaid: typeof import("mermaid").default;


      try {


        mermaid = await promise;


      } catch (err) {


        console.error("[Launcher] failed to import mermaid:", err);


        for (const el of Array.from(document.querySelectorAll<HTMLElement>(".mermaid"))) {


          el.innerHTML = `<pre class="mermaid-error">Failed to load mermaid: ${String(err).slice(0, 200)}</pre>`;


        }


        return;


      }


      mermaid.initialize({


        startOnLoad: false,


        theme: "default",


        securityLevel: "loose",


        flowchart: {

          htmlLabels: true,

          curve: "basis",

          nodeSpacing: 60,

          rankSpacing: 60,

          padding: 14,

        },


        fontFamily: "inherit",


      });


      async function renderAll() {


        const nodes = Array.from(document.querySelectorAll<HTMLElement>(".mermaid"));


        for (let i = 0; i < nodes.length; i++) {


          if (cancelled) return;


          const el = nodes[i];


          // Skip nodes we've already rendered. The first successful render replaces the


          // <pre>'s textContent with mermaid's SVG output (including its own <style> block),


          // so re-reading textContent would feed SVG back into the parser and crash.


          if (el.dataset.mermaidRendered === "true") continue;


          const code = el.textContent ?? "";


          if (!code.trim()) continue;


          try {


            const { svg } = await mermaid.render(`mermaid-svg-${Date.now()}-${i}`, code);


            if (cancelled) return;


            el.innerHTML = svg;


            el.dataset.mermaidRendered = "true";


          } catch (err) {


            const msg = err instanceof Error ? err.message : String(err);


            console.error("[Launcher] mermaid render failed for node", i, msg);


            // Preserve the source code so the user can see what they wrote AND the
            // mermaid-side error message in one place - no more "diagram disappears,
            // I have to go find what I typed elsewhere". HTML-escape the source so it
            // renders as <pre> text rather than being re-interpreted as markup.
            const source = el.textContent ?? "";
            const escaped = source
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            el.innerHTML = `
              <div class="mermaid-error">
                <div class="mermaid-error-title">⚠ Mermaid 渲染失败</div>
                <pre class="mermaid-error-code">${escaped.slice(0, 800)}</pre>
                <details class="mermaid-error-detail">
                  <summary>mermaid 报错</summary>
                  <pre class="mermaid-error-msg">${msg.slice(0, 400)}</pre>
                </details>
              </div>
            `;


            el.dataset.mermaidRendered = "error"; // also mark so we don't re-parse the error msg


          }


        }


      }


      await renderAll();


      const det = detailsRef.current;


      if (det) {


        det.addEventListener("toggle", () => { if (det.open) void renderAll(); });


      }


    })();


    return () => { cancelled = true; };


  }, [cfg]);





  if (error && !cfg) {


    return (


      <div className="settings-error">


        <p className="error">{error}</p>


        <button onClick={() => void load()}>{t("settings.reload")}</button>


      </div>


    );


  }


  if (!cfg) return <p className="muted">{t("common.loading")}</p>;





  function setPreset(value: OpenCodexPreset) {


    if (!cfg) return;


    setCfg({ ...cfg, preset: value });


  }





  type FlagKey = typeof FLAG_ROWS[number]["key"];


  function setFlag(key: FlagKey, value: boolean) {


    if (!cfg) return;


    // Picking a per-flag clears preset (they are mutually exclusive in the backend).


    setCfg({ ...cfg, [key]: value, preset: null });


  }





  async function onSave() {


    if (!cfg) return;


    setSaving(true); setError(null); setInfo(null);


    try {


      const update: OpenCodexConfigUpdate = {};


      if (cfg.preset !== null) {


        update.preset = cfg.preset;


      } else {


        update.enableCodexLauncherMode = cfg.enableCodexLauncherMode;


        update.syncRoutedModels = cfg.syncRoutedModels;


        update.syncNativeOpenaiModels = cfg.syncNativeOpenaiModels;


      }


      const next = await saveOpenCodexConfig(update);


      setCfg(next);


      setInfo(t("settings.saveSuccess"));


    } catch (e) {


      setError(t("settings.saveError", { msg: e instanceof Error ? e.message : String(e) }));


    } finally {


      setSaving(false);


    }


  }





  async function onRestart() {


    if (!window.confirm(t("settings.restartConf"))) return;


    setRestartStatus("restarting");


    setRestartElapsedMs(0);


    setError(null); setInfo(null);


    timerRef.current = window.setInterval(() => {


      setRestartElapsedMs((e) => e + 200);


    }, 200);


    try {


      const r = await restartProxy();


      if (timerRef.current) {


        window.clearInterval(timerRef.current);


        timerRef.current = null;


      }


      if (r.status === "healthy") {


        setRestartStatus("healthy");


        setInfo(t("settings.restartOk"));


        // The new proxy might have different effective config state — refetch shortly after.


        window.setTimeout(() => { void load(); }, 1500);


      } else {


        setRestartStatus("failed");


        setError(t("settings.restartFailed", { msg: r.error ?? "unknown" }));


      }


    } catch (err) {


      if (timerRef.current) {


        window.clearInterval(timerRef.current);


        timerRef.current = null;


      }


      setRestartStatus("failed");


      setError(err instanceof Error ? err.message : String(err));


    }


  }





  const usingFlags = cfg.preset === null;
  // Patch 2: render red warning whenever any preset/flag combo would write to ~/.codex.
  // preset=launcher turns it on unconditionally; preset=auto + enableCodexLauncherMode=true too.
  const codexWriting =
    cfg.preset === "launcher" ||
    (cfg.preset === null && cfg.enableCodexLauncherMode === true);


  const presetExplainKey: TKey =


    cfg.preset === null ? "settings.presetExplain.auto" as TKey :


    cfg.preset === "launcher" ? "settings.presetExplain.launcher" as TKey :


    cfg.preset === "proxy-only" ? "settings.presetExplain.proxyOnly" as TKey :


    "settings.presetExplain.fullPassThrough" as TKey;





  const restartBusy = restartStatus === "restarting";


  const restartLabel =


    restartStatus === "restarting" ? `${t("settings.restarting")} (${(restartElapsedMs / 1000).toFixed(1)}s)` :


    restartStatus === "healthy"   ? t("settings.restartOk") :


    restartStatus === "failed"    ? t("settings.restartFailed", { msg: "" }).replace(/[:\s].*$/, "") || t("settings.restartBtn") :


                                    t("settings.restartBtn");





  return (


    <div className="settings-page launcher-page">


      <h2>{t("settings.title")}</h2>


      <p className="muted">{t("settings.subtitle")}</p>


      <p className="settings-summary">{t("settings.summary")}</p>


      <p className="settings-apply">{t("settings.howApply")}</p>





      <details ref={detailsRef} className="settings-how-linkage">


        <summary>{t("settings.howLinkage.summary")}</summary>


        <div className="settings-how-linkage-body">





          <h3 className="settings-how-linkage-h">{t("settings.howLinkage.uiTitle")}</h3>


                    <MermaidBlock


            source={`flowchart LR


    subgraph Radio["Preset Radio<br/>4 个选项"]


        R["点任一 radio 选中 preset"]


    end





    subgraph Flags["3 Flag Checkbox"]


        F1["launcher-mode<br/>主开关"]


        F2["sync-routed<br/>目录半边 1"]


        F3["sync-native<br/>目录半边 2"]


    end





    R -->|"选 preset"| B{"cfg.preset<br/>是否非空"}


    B -->|"是"| Lock["3 个 flag<br/>灰掉 + 提示文案"]


    Lock -.->|显示| F1


    Lock -.->|显示| F2


    Lock -.->|显示| F3





    F1 -->|"点任意 flag"| Clear["setFlag()<br/>cfg.flag = 新值<br/>cfg.preset = null"]


    F2 -->|"点任意 flag"| Clear


    F3 -->|"点任意 flag"| Clear


    Clear -->|清掉| B





    B -->|"preset 非空"| S1["Save:<br/>{preset: X}<br/>单独传"]


    B -->|"preset 为空"| S2["Save:<br/>{3 flags}<br/>单独传"]


    S1 -->|互斥| API["PUT /api/opencodex/config"]


    S2 -->|互斥| API


    API -->|"两个同传 → 400"| Err["conflictReason<br/>'preset 不能与<br/>3 个 flag 同传'"]`}


            fsEnterLabel={t("settings.mermaidFs.enter")}


            fsExitLabel={t("settings.mermaidFs.exit")}


          />





          <h3 className="settings-how-linkage-h">{t("settings.howLinkage.flagsTitle")}</h3>


                    <MermaidBlock


            source={`flowchart TD


    F1["launcher-mode<br/>主开关：控 config.toml / journal"]


    F2["sync-routed<br/>目录半边 1：namespaced 条目"]


    F3["sync-native<br/>目录半边 2：原生 baseline"]





    F1 -->|ON| ON1["injectCodexConfig()<br/>写 ~/.codex/config.toml"]


    F1 -->|ON| ON2["writeJournal()<br/>写 ~/.codex/journal.json"]


    F1 -->|ON| ON3["reconcileJournal()<br/>崩溃时恢复"]





    F1 -->|OFF| OFF1["injectCodexConfig<br/>提前返回（不写）"]


    F1 -->|OFF| OFF2["writeJournal<br/>提前返回（不写）"]


    F1 -->|OFF| OFF3["reconcileJournal<br/>丢弃残留 journal<br/>（保护用户手改）"]





    F2 -->|ON| CAT1["gatherRoutedModels<br/>追加 namespaced slug<br/>如 minimax.chat/abab6.5-chat"]


    F2 -->|OFF| CAT1x["orderedGoModels = []<br/>无 namespaced 条目"]





    F3 -->|ON| CAT2["readNativeBaseline<br/>保留 gpt-5.5 / gpt-5.4 等"]


    F3 -->|OFF| CAT2x["baseline = 空 Map<br/>无原生优先级合并"]





    ON1 --> OUT1[("~/.codex/config.toml")]


    ON2 --> OUT2[("~/.codex/journal.json")]


    CAT1 --> OUT3[("~/.codex/opencodex-catalog.json")]


    CAT1x --> OUT3


    CAT2 --> OUT3


    CAT2x --> OUT3`}


            fsEnterLabel={t("settings.mermaidFs.enter")}


            fsExitLabel={t("settings.mermaidFs.exit")}


          />





          <h3 className="settings-how-linkage-h">{t("settings.howLinkage.pathsTitle")}</h3>


                    <MermaidBlock


            source={`flowchart LR


    subgraph CLI["CLI 路径：ocx-start.py --preset=X（启动时）"]


        P1["argv 里的 preset"] --> R1["resolveLauncherFlags<br/>launcher-flags.ts:138"]


        R1 -->|"launcher"| M1["3 个 flag 全 true"]


        R1 -->|"proxy-only"| M2["launcher=假<br/>sync-routed=假<br/>sync-native=真"]


        R1 -->|"full-pass-through"| M3["3 个 flag 全假"]


        M1 --> W1[("config.json")]


        M2 --> W1


        M3 --> W1


    end





    subgraph RT["GUI 路径：PUT /api/opencodex/config（运行时）"]


        P2["body 里的 preset"] --> W2[("config.json<br/>只存 preset")]


        W2 -.->|"3 个 flag 不动"| Note["运行时行为<br/>不变"]


    end





    W1 --> Load["loadConfig<br/>读 3 个 flag"]


    Note --> Load


    Load --> Beh["实际 proxy 行为"]`}


            fsEnterLabel={t("settings.mermaidFs.enter")}


            fsExitLabel={t("settings.mermaidFs.exit")}


          />





          <h3 className="settings-how-linkage-h">{t("settings.howLinkage.matrixTitle")}</h3>


          <p className="muted settings-how-linkage-caption">{t("settings.howLinkage.matrixCaption")}</p>


          <table className="settings-preset-matrix">


            <thead>


              <tr>


                <th>Preset</th>


                <th>launcher-mode</th>


                <th>sync-routed</th>


                <th>sync-native</th>


                <th>catalog file content</th>


                <th>config.toml</th>


              </tr>


            </thead>


            <tbody>


              <tr><td>launcher</td><td>ON</td><td>ON</td><td>ON</td><td>baseline + routed</td><td>写入</td></tr>


              <tr><td>proxy-only</td><td>OFF</td><td>OFF</td><td>ON</td><td>仅 baseline (gpt-* still visible)</td><td>不写</td></tr>


              <tr><td>full-pass-through</td><td>OFF</td><td>OFF</td><td>OFF</td><td>(almost empty)</td><td>不写</td></tr>


            </tbody>


          </table>





        </div>


      </details>





      <fieldset className="settings-preset">


        <legend>{t("settings.preset")}</legend>


        <label className="settings-row">


          <input


            type="radio"


            name="ocx-preset"


            checked={cfg.preset === null}


            onChange={() => setPreset(null)}


          />


          <span>{t("settings.preset.auto")}</span>


        </label>


        {PRESETS.map(({ value, valueTKey }) => (


          <label key={value} className="settings-row">


            <input


              type="radio"


              name="ocx-preset"


              checked={cfg.preset === value}


              onChange={() => setPreset(value)}


            />


            <span>{t(valueTKey)}</span>


          </label>


        ))}


        {codexWriting && (
          <div role="alert" style={{
            marginTop: 10,
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--red-soft)",
            border: "1px solid color-mix(in srgb, var(--red) 35%, transparent)",
            color: "var(--red)",
            fontSize: 13,
            lineHeight: 1.55,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {"⚠️"} {t("settings.codexWriteWarning")}
            </div>
            <div style={{ color: "var(--text)" }}>{t("settings.codexWriteDetail")}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "var(--muted)" }}>
              <code style={{ color: "var(--red)" }}>{t("settings.codexWriteFiles")}</code>
            </div>
          </div>
        )}

        <div className="settings-preset-explain">


          <p>{t(presetExplainKey)}</p>


        </div>


      </fieldset>





      <fieldset className="settings-flags" aria-disabled={!usingFlags}>


        {!usingFlags && (


          <p className="settings-flags-disabled muted">{t("settings.flagsDisabledReason")}</p>


        )}


        {FLAG_ROWS.map(({ key, labelKey, onKey, offKey }) => {
          {key === "enableCodexLauncherMode" && cfg.enableCodexLauncherMode === true && cfg.preset === null && (
            <span style={{ color: "var(--red)", fontSize: 11, marginLeft: 6 }} title={t("settings.codexWriteWarning")}>{"⚠️"}</span>
          )}



          const v = cfg[key as FlagKey];


          return (


            <div key={key} className="settings-flag-group">


              <label className="settings-row">


                <input


                  type="checkbox"


                  checked={v}


                  onChange={(e) => setFlag(key as FlagKey, e.target.checked)}


                  disabled={!usingFlags}


                />


                <span>{t(labelKey as TKey)}</span>


              </label>


              <p className="settings-flag-seen help">{t(v ? (onKey as TKey) : (offKey as TKey))}</p>


            </div>


          );


        })}


      </fieldset>





      {info && <p className="info">{info}</p>}


      {error && <p className="error">{error}</p>}





      <div className="settings-actions">


        <button onClick={onSave} disabled={saving}>


          {saving ? t("settings.saving") : t("common.save")}


        </button>


        <button onClick={() => void load()} disabled={saving}>


          {t("settings.reload")}


        </button>


        <button


          onClick={() => void onRestart()}


          disabled={saving || restartBusy}


          className={`settings-restart-btn settings-restart-${restartStatus}`}


        >


          {restartLabel}


        </button>


      </div>


    </div>


  );


}


