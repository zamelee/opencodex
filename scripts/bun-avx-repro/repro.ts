/**
 * Bun-on-a-CPU-without-AVX reproduction harness.
 *
 * WHY: on 2026-11-12 the 8 GB / no-AVX box crashed with
 *   panic(main thread): Illegal instruction
 * after 31 hours of opencodex. Two explanations fit that evidence:
 *   (a) memory exhaustion corrupted the JIT code pages  (what we assumed first)
 *   (b) Bun's baseline JSC build has a defect on CPUs without AVX
 *       (oven-sh/bun#30613: "Bun crashes on non-AVX2 CPUs (all versions after v1.3.8)")
 * The application-side memory budget cannot fix (b), and a memory guard cannot
 * distinguish the two. This harness separates them.
 *
 * MODES
 *   plain    - a blank program that just lives. If THIS crashes with SIGILL, the
 *              application is not involved at all.
 *   pressure - the same, but it grows the heap on purpose, so a crash only under
 *              memory pressure points at (a) instead.
 *
 * It prints the numbers that matter (RSS, private commit, working set) so a run
 * that survives still tells us something.
 *
 * Usage:
 *   bun repro.ts plain    [minutes]
 *   bun repro.ts pressure [minutes] [targetMB]
 *
 * The pressure mode grows to a TARGET and then HOLDS it (default 3072 MB). It
 * does not grow without bound: the affected box has 8 GB and is a live machine,
 * and an unbounded grower would take the box down before it told us anything.
 * The incident happened around 4.94 GB RSS / 10.11 GB commit, so holding a few
 * GB for hours is the regime worth probing.
 */
import { dlopen, FFIType } from "bun:ffi";
import { cpus } from "node:os";

const mode = (process.argv[2] ?? "plain").toLowerCase();
const minutes = Number(process.argv[3] ?? "120");
const targetMb = Number(process.argv[4] ?? "3072");

let workingSetBytes = 0;
let privateBytes = 0;
let pageFaultCount = 0;

/**
 * Read the Windows counters NOW.
 *
 * (The first version sampled these once at startup and printed the cached
 * values every 10 s, so "working set" and "private" were frozen for the whole
 * run -- exactly the two numbers the pressure experiment needs. Sampling has to
 * happen per tick.)
 */
function sampleWindowsCounters(): void {
  if (process.platform !== "win32") return;
  try {
    const psapi = dlopen("psapi.dll", {
      GetProcessMemoryInfo: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
    const kernel32 = dlopen("kernel32.dll", {
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
    });
    const buf = new ArrayBuffer(80);
    const ok = (psapi.symbols.GetProcessMemoryInfo as any)(
      (kernel32.symbols.GetCurrentProcess as any)(),
      buf,
      80,
    );
    if (ok) {
      const view = new DataView(buf);
      workingSetBytes = Number(view.getBigUint64(16, true));
      privateBytes = Number(view.getBigUint64(72, true));
      pageFaultCount = view.getUint32(4, true);
    }
  } catch {
    /* counters are best-effort */
  }
}

sampleWindowsCounters();

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const started = Date.now();
console.log(`[repro] mode=${mode} minutes=${minutes} bun=${Bun.version} pid=${process.pid}`);
console.log(`[repro] argv=${process.argv.join(" ")}`);
console.log(`[repro] features=${Bun.version}`);

const heap: string[] = [];
let ticks = 0;

const timer = setInterval(() => {
  ticks++;
  sampleWindowsCounters();
  const usage = process.memoryUsage();
  const elapsedMin = ((Date.now() - started) / 60_000).toFixed(1);
  const line =
    `[repro] t=${elapsedMin}m rss=${mb(usage.rss)}MB heap=${mb(usage.heapUsed)}MB `
    + `external=${mb(usage.external)}MB workingSet=${mb(workingSetBytes)}MB `
    + `private=${mb(privateBytes)}MB faults=${pageFaultCount} `
    + `cpu=${cpus()[0]?.model ?? "?"}`;
  console.log(line);

  if (mode === "pressure") {
    // Grow the heap by ~32 MB per tick, but keep the strings reachable so the
    // allocator cannot just hand the pages back. Stop at the target and hold.
    //
    // (The first version of this script pushed 256 KB per tick and called it
    // "pressure" -- the whole run grew the heap by 15 MB, which is not pressure.
    // 32 MB x 6 ticks/min = ~190 MB/min, so the default 3 GB target is reached in
    // ~16 minutes and then held for the rest of the run.)
    const heldMb = heap.length * 32;
    if (heldMb < targetMb) heap.push("x".repeat(32 * 1024 * 1024));
  }

  if (ticks * 10 >= minutes * 60) {
    clearInterval(timer);
    console.log(`[repro] finished cleanly after ${elapsedMin}m (${ticks} samples)`);
    process.exit(0);
  }
}, 10_000);

process.on("uncaughtException", (err) => {
  console.error("[repro] uncaught:", err);
});
