#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
opencodex 启动脚本（Python / 跨平台）

Phase 5 launcher-mode aware 版本：spawn bun 之前检测 bun → 缺失时尝试 npm/pnpm 自动安装；
spawn 时透传 Phase 5 launcher flag（OCX_LAUNCHER_MODE / OCX_SYNC_ROUTED_MODELS /
OCX_SYNC_NATIVE_OPENAI_MODELS / OCX_PRESET）；日常 `python ocx-start.py` 不带参数默认后台。

用法（不带参数 → 默认后台）：

  python ocx-start.py                     后台运行（默认；shell 立刻返回）
  python ocx-start.py --foreground        前台启动（Ctrl+C 停）
  python ocx-start.py --background        后台启动（shell 立刻返回）
  python ocx-start.py --init              只 init（交互填 provider / api key）
  python ocx-start.py --init-and-start    首次：init + 前台启动
  python ocx-start.py --bootstrap         首次装机（克隆 + 装依赖 + init + 后台启动；out-of-tree 自动判断）
  python ocx-start.py --with-shim         装 codex-shim + 跑代理（自启动模式）
  python ocx-start.py --stop              停服务并恢复原生 Codex
  python ocx-start.py --status            看状态
  python ocx-start.py --clean             清 dist / gui/dist
  python ocx-start.py --port 8080         改端口（默认 10100）
  python ocx-start.py --no-auto-bootstrap bun 缺失时不要自动装 bun，只打 err
  python ocx-start.py --hostname 0.0.0.0    bind 到所有网络接口（默认仅 127.0.0.1）
  python ocx-start.py --help              帮助

Phase 5 launcher-mode flag 透传：

  python ocx-start.py --preset=proxy-only             # CodexPlusPlus 接管 routed，opencodex 仅代理 + 原生
  python ocx-start.py --launcher-mode=false           # 等价于 --preset=proxy-only 一部分
  python ocx-start.py --launcher-mode=true            # 强制 launcher 模式（即便 config.json 已关）

后台日志：项目根目录下 ocx.out.log / ocx.err.log
"""

import argparse
import errno
import json
import os
import select
import shutil
import socket
import subprocess

try:
    import ctypes  # AVX detection; Windows-only
except ImportError:
    ctypes = None  # type: ignore[assignment]

import sys
import time
import urllib.request
from pathlib import Path

ROOT   = Path(__file__).resolve().parent
CONFIG = Path.home() / ".opencodex" / "config.json"
BUN    = "bun"

# --- AVX detection + node fallback (Patch 1) -------------------------------------
# Bun v1.3.x on Windows without AVX runs the no_avx compat path, which can crash after
# sustained socket pool use (~3-4h on Windows 10 19H1 + older CPU). Detect AVX once at
# startup and route to Node (V8) as the runtime instead. Detection must NEVER block startup.
PF_AVX_INSTRUCTIONS_AVAILABLE = 39
PF_AVX2_INSTRUCTIONS_AVAILABLE = 40
PF_XSAVE_ENABLED = 38
NODE_BIN = "node"


def _avx_detect_cpu_features():
    feats = {"avx": True, "avx2": True, "xsave": True, "source": "default-true"}
    if sys.platform == "win32" and ctypes is not None:
        try:
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            present = k32.IsProcessorFeaturePresent
            try:
                present.argtypes = [ctypes.c_uint]
                present.restype = ctypes.c_bool
            except (AttributeError, TypeError):
                pass
            feats["avx"] = bool(present(PF_AVX_INSTRUCTIONS_AVAILABLE))
            feats["avx2"] = bool(present(PF_AVX2_INSTRUCTIONS_AVAILABLE))
            feats["xsave"] = bool(present(PF_XSAVE_ENABLED))
            feats["source"] = "kernel32!IsProcessorFeaturePresent"
        except OSError as e:
            feats["source"] = f"kernel32-error:{e.winerror if e.winerror else e}"
        except Exception as e:
            feats["source"] = f"kernel32-exception:{type(e).__name__}"
    elif sys.platform.startswith("linux"):
        try:
            txt = Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="ignore")
            for line in txt.splitlines():
                if line.lower().startswith("flags"):
                    flags = line.split(":", 1)[1].split()
                    feats["avx"] = "avx" in flags
                    feats["avx2"] = "avx2" in flags
                    feats["source"] = "linux-/proc/cpuinfo"
                    break
        except OSError as e:
            feats["source"] = f"cpuinfo-error:{e}"
    elif sys.platform == "darwin":
        try:
            out = subprocess.run(["sysctl", "-n", "machdep.cpu.features"],
                                 capture_output=True, text=True, timeout=2).stdout.strip().lower()
            feats["avx"] = "avx1.0" in out or "avx" in out
            feats["avx2"] = "avx2" in out
            feats["source"] = "darwin-sysctl"
        except (OSError, subprocess.TimeoutExpired) as e:
            feats["source"] = f"sysctl-error:{e}"
    return feats


def _avx_find_node_exe():
    global _NODE_CACHE
    if _NODE_CACHE is not None:
        return _NODE_CACHE
    p = shutil.which(NODE_BIN)
    if p:
        _NODE_CACHE = str(Path(p).resolve())
        return _NODE_CACHE
    if sys.platform == "win32":
        for raw in (r"C:\Program Files\nodejs\node.exe",
                    r"C:\Program Files (x86)\nodejs\node.exe",
                    r"D:\nodejs\node.exe"):
            try:
                c = Path(raw)
                if c.exists() and c.is_file():
                    _NODE_CACHE = str(c.resolve())
                    return _NODE_CACHE
            except OSError:
                continue
    return None
# NOTE: this project hard-depends on Bun runtime (`bun:sqlite`, `Bun.serve`,
# `Bun.sleepSync`, tsconfig `moduleResolution: "bundler"`, extension-less
# imports). Node ESM cannot satisfy any of these — `bun run` would either
# crash on `bun:` URL scheme or fail to resolve `src/codex/inject` style paths.
# AVX is no longer part of the runtime gate: Bun 1.2+ targets Nehalem
# (SSE4.2) as the baseline, with AVX2/AVX-512 selected at runtime when
# supported. Older revisions of this script refused on NO_AVX based on a
# misreading of bun's pre-1.2 compatibility shim — the real binary has
# no such gate. AVX is now reported for diagnostic logging only.
def decide_runtime(force=None):
    """Pick runtime command prefix. force: 'bun'|'node'|None.

    Returns dict with runtime/reason/avx. Runtime is 'bun' for normal use
    and 'none' only when force=='node' (no Node backend exists, refuse
    to mask a real failure). AVX is included for logging only — the
    SSE4.2 baseline shipped by Bun 1.2+ covers all x64 CPUs we care
    about, including Apollo Lake (J3455) and other Atom/Celeron parts.
    """
    feats = _avx_detect_cpu_features()
    info = {
        "avx": bool(feats.get("avx", False)),
        "avx2": bool(feats.get("avx2", False)),
        "source": feats.get("source", ""),
        "runtime": "bun",
        "reason": "default",
    }
    if force == "bun":
        info["reason"] = "forced"
    elif force == "node":
        info["runtime"] = "none"
        info["reason"] = "node-backend-not-implemented"
    return info


def log_runtime_decision(decision):
    avx = decision["avx"]
    rt = decision["runtime"]
    reason = decision["reason"]
    RED = "\x1b[31m"
    YELLOW = "\x1b[33m"
    DIM = "\x1b[2m"
    RESET = "\x1b[0m"
    if not avx:
        tag = f"{YELLOW}NO_AVX{RESET}"
        print(
            f"[avx] {tag}  (Bun ships a SSE4.2 baseline build; runtime continues. "
            f"Long uptimes on Windows may be unstable.) [{decision.get('source','')}]",
            file=sys.stderr,
        )
    else:
        tag = f"{DIM}avx ok{RESET}"
        print(f"[avx] CPU feature detection: {tag} ({decision.get('source','')})", file=sys.stderr)


# --- end Patch 1 ---


# Windows 控制台默认 GBK，会把脚本里的中文输出打乱。强制 stdout 走 UTF-8。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, OSError):
    pass


def is_initialized() -> bool:
    return CONFIG.exists()


def load_opencodex_config() -> dict:
    """读取 ~/.opencodex/config.json，缺失 / 解析失败时返空 dict。"""
    if not CONFIG.exists():
        return {}
    try:
        with CONFIG.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def effective_launcher_mode(cfg: dict) -> bool | None:
    """Resolve the effective launcher mode from cfg.

    Returns:
      True  = launcher mode ON (opencodex writes ~/.codex/* catalog/config)
      False = launcher mode OFF (HTTP-only / pass-through; CodexPlusPlus owns Codex)
      None  = unconfigured (caller should warn loudly + treat as False safe default)

    Reads BOTH the Phase-5 `preset` and the current `enableCodexLauncherMode`
    (camelCase, what src/config.ts writes today). Preset wins when both are set:
      preset=launcher                        -> True
      preset=proxy-only / full-pass-through  -> False
      enableCodexLauncherMode=true           -> True
      enableCodexLauncherMode=false          -> False
    """
    preset = cfg.get("preset")
    if preset == "launcher":
        return True
    if preset in ("proxy-only", "full-pass-through"):
        return False
    val = cfg.get("enableCodexLauncherMode")
    if val is None:
        return None
    return bool(val)


def health_ok(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/healthz", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def show_state(port: int, effective_port: int | None = None) -> None:
    """Print the status card: config / port / mode / CodexPlusPlus / uptime.

    Always rendered BEFORE the menu so the user knows what state the proxy
    is in (and which Codex files the current mode will touch) before picking
    an action.
    """
    init = is_initialized()
    if effective_port is None:
        effective_port = read_runtime_port_file()
    actual_port = effective_port if effective_port is not None else port
    run = health_ok(actual_port)
    cfg = load_opencodex_config()
    mode = effective_launcher_mode(cfg)
    cpp = probe_codex_plus_plus()

    print()
    print("=" * 60)
    print("  opencodex 控制面板  v2.7.8")
    print("=" * 60)
    print(f"  配置       : {CONFIG}  {"已初始化" if init else "未初始化"}")
    if actual_port != port:
        print(f"  程序       : {"运行中" if run else "fallback 后未起来"} (port {actual_port}, fallback 启用)")
    else:
        print(f"  程序       : {"运行中" if run else "未运行"} (port {actual_port})")

    label = mode_label(mode)
    if mode is None:
        mode_line = f"  模式       : {label}  (HTTP-only 安全回退)"
    else:
        mode_line = f"  模式       : {label}" + ("  (开启 CodexPlusPlus 可能被覆盖)" if cpp["present"] and mode else "")
    print(mode_line)
    for line in list_codex_impact(mode):
        prefix = "├─ " if cpp["present"] and mode else "  "
        print(f"{prefix}{line}")
    print()
    cpp_present = cpp["present"]
    cpp_pid = cpp["pid"]
    cpp_line = f"  CodexPlusPlus : ✓ 在跑 (PID {cpp_pid}, port 9222)" if cpp_present else f"  CodexPlusPlus : ✗ 未跑"
    print(cpp_line)
    if mode is None:
        print("  ⚠ launcher_mode 未显式配置。下次启动会提示是否写入安全默认 (HTTP-only)。")
    print("=" * 60)
    print()
def read_runtime_port_file() -> int | None:
    """Best-effort read of runtime-port.json written by bun on bind (mirrors src/cli/index.ts:153 writeRuntimePort).
    Falls back to OPENCODEX_HOME if set (matches src/config.ts resolveConfigDir()).
    Returns the port number if the file looks valid, else None.
    """
    candidates = [Path.home() / ".opencodex" / "runtime-port.json"]
    env_home = os.environ.get("OPENCODEX_HOME")
    if env_home:
        candidates.append(Path(env_home) / "runtime-port.json")
    for path in candidates:
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            port = int(data.get("port", 0))
            pid = int(data.get("pid", 0))
            if 1 <= port <= 65535 and pid > 0:
                return port
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    return None


def is_port_busy(port: int, host: str = "127.0.0.1", timeout: float = 0.4) -> bool:
    """Return True if host:port is held by another listener.
    
    Uses bind()-probe rather than connect()-probe because connect() gets
    fooled by full accept-queues (5 connects succeed, further connects time
    out and read as "free", masking the busy signal).
    bind() is direct: any bind() failure with EADDRINUSE means port is taken.
    
    Stdlib only.
    """
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.bind((host, port))
            return False  # bind succeeded → port is free
        except OSError as e:
            # EADDRINUSE on Linux/macOS is errno 98; on Windows it's winerror 10048.
            in_use = (
                e.errno == errno.EADDRINUSE
                or getattr(e, "winerror", None) == 10048
            )
            return bool(in_use)
    except Exception:
        return False
    finally:
        if s is not None:
            try:
                s.close()
            except Exception:
                pass


def suggest_next_free_port(start: int, host: str = "127.0.0.1", max_scan: int = 10) -> int | None:
    """Walk start+1 .. start+max_scan, return first free port. None if all busy."""
    for off in range(1, max_scan + 1):
        p = start + off
        if p > 65535:
            break
        if not is_port_busy(p, host):
            return p
    return None


def _read_line_windows(prompt: str, timeout_sec: int) -> str | None:
    """Win32 console line read with live countdown. Returns entered line or None on timeout/EOF."""
    import msvcrt
    end = time.time() + timeout_sec
    buf: list[str] = []
    sys.stdout.write(prompt)
    sys.stdout.flush()
    last = time.time()
    while time.time() < end:
        if msvcrt.kbhit():
            ch = msvcrt.getwch()
            if ch in ("\r", "\n"):
                sys.stdout.write("\n")
                sys.stdout.flush()
                return "".join(buf)
            if ch == "\b":
                if buf:
                    buf.pop()
                    sys.stdout.write("\b \b")
                    sys.stdout.flush()
                continue
            if ch == "\x03":
                raise KeyboardInterrupt
            if ch in ("\x00", "\xe0"):
                if msvcrt.kbhit():
                    msvcrt.getwch()
                continue
            buf.append(ch)
            sys.stdout.write(ch)
            sys.stdout.flush()
            end = time.time() + timeout_sec  # typing resets countdown
        n = time.time()
        if n - last >= 1.0:
            rem = max(0, int(end - n))
            sys.stdout.write("\r" + prompt + f" (剩 {rem}s)")
            sys.stdout.flush()
            last = n
        time.sleep(0.05)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return None


def _read_line_posix(prompt: str, timeout_sec: int) -> str | None:
    """POSIX stdin line read with timeout. Returns entered line or None on timeout/EOF."""
    sys.stdout.write(prompt)
    sys.stdout.flush()
    r, _, _ = select.select([sys.stdin], [], [], timeout_sec)
    if r:
        line = sys.stdin.readline().rstrip("\n").rstrip("\r")
        return line
    sys.stdout.write("\n")
    sys.stdout.flush()
    return None


def prompt_with_echo_and_timeout(prompt: str, default: str, timeout_sec: int = 30) -> str | None:
    """Cross-platform stdin read with countdown timer.
    Returns the entered string (possibly empty = user pressed Enter = default)
    or None if timeout occurred / EOF / non-interactive stdin.
    """
    full_prompt = f"{prompt} [默认: {default}, {timeout_sec}s 超时 → 默认]: "
    try:
        if sys.platform == "win32":
            try:
                return _read_line_windows(full_prompt, timeout_sec)
            except ImportError:
                sys.stdout.write(f"{full_prompt}(非交互模式, 自动用 {default})\n")
                sys.stdout.flush()
                return None
        return _read_line_posix(full_prompt, timeout_sec)
    except (KeyboardInterrupt, EOFError):
        sys.stdout.write("\n")
        sys.stdout.flush()
        return None


def resolve_runtime_port(port: int, max_attempts: int = 3, timeout_sec: int = 30) -> int:
    """Probe-and-prompt loop. If `port` is busy, walk user through re-probing
    until they pick a free one, type "n" to bail, or max_attempts is hit.
    On bail/timeout/max_attempts, returns the original `port` so bun's own
    port-hop fallback (src/cli/index.ts:97 chooseListenPort) can rescue.
    """
    target = port
    attempts = 0
    while is_port_busy(target):
        suggested = suggest_next_free_port(target) or (target + 1 if target < 65535 else target)
        print(file=sys.stderr)
        print(f"⚠️  端口 {target} 被占用", file=sys.stderr)
        print(f"   建议 fallback : {suggested}  ({target}+{suggested - target}, 按递增扫描)", file=sys.stderr)
        print(f"   ▶ 输入新端口号覆盖", file=sys.stderr)
        print(f"   ▶ 直接回车接受 {suggested}", file=sys.stderr)
        print(f"   ▶ 输入 n 或 {timeout_sec}s 超时 = 交给 bun 自有兜底", file=sys.stderr)
        choice = prompt_with_echo_and_timeout("选择", str(suggested), timeout_sec)
        attempts += 1
        if choice is None or choice.strip().lower() == "n":
            print(f"[port] 用户放弃 / 超时 → 把原 {port} 交给 bun 兜底", file=sys.stderr)
            return port
        if attempts > max_attempts:
            print(f"[port] 尝试 {attempts} 次 (> {max_attempts}) → bun 兜底", file=sys.stderr)
            return port
        try:
            new_target = int(choice.strip())
        except ValueError:
            new_target = suggested
        if not (1 <= new_target <= 65535):
            print(f"[port] {new_target} 超出 1-65535 范围，跳过", file=sys.stderr)
            attempts += 1
            continue
        if new_target == target:
            print(f"[port] {target} 仍被占（你坚持原值）→ bun 兜底", file=sys.stderr)
            return port
        target = new_target
        # loop → re-probe
    return target


def has_bun() -> bool:
    return find_bun_exe() is not None


def find_bun_exe() -> str | None:
    """Return absolute path to a real (non-stub) bun executable, or None.

    Resolution order (highest priority first):
      1. Project-local node_modules: ROOT/node_modules/.bin/bun{,.exe,.cmd}
      2. Project-local node_modules: ROOT/node_modules/bun/bin/bun{,.exe}
         (npm installs the real ~86MB binary here; the .cmd shim that nvm
         creates at PATH priority is only a few hundred bytes and prints
         "version of bun.exe is not compatible" when invoked.)
      3. shutil.which(BUN) on PATH, with the same size gate applied.

    The size gate rejects nvm/npm-placeholder stubs (~hundreds of bytes);
    the real Windows binary is ~86 MB (1.4.x) and never under 30 MB.
    Windows .cmd shims cannot always be invoked directly by subprocess
    with list args + no shell=True, so we resolve first and pass the
    absolute path as cmd[0].
    """
    REAL_BUN_MIN_BYTES = 30 * 1024 * 1024  # 30 MB floor; real bun ~86 MB

    def _candidates_from_dir(d: Path):
        out = []
        nm_bin = d / "node_modules" / ".bin"
        for name in ("bun", "bun.exe", "bun.cmd"):
            out.append(nm_bin / name)
        nm_pkg = d / "node_modules" / "bun" / "bin"
        for name in ("bun", "bun.exe", "bun.cmd"):
            out.append(nm_pkg / name)
        return out

    # 1+2: project-local node_modules (ROOT and CWD).
    seen: set[str] = set()
    for base in {ROOT, Path.cwd()}:
        for cand in _candidates_from_dir(base):
            try:
                real = cand.resolve(strict=False)
            except OSError:
                continue
            key = str(real).lower()
            if key in seen:
                continue
            seen.add(key)
            try:
                if real.is_file() and real.stat().st_size >= REAL_BUN_MIN_BYTES:
                    return str(real)
            except OSError:
                continue

    # 3: npm-global node_modules. On nvm/Node-managed machines `npm install
    #    -g bun` writes to <npm-prefix>/node_modules/bun/bin/bun.exe — and
    #    that path passes the size gate even when the PATH-relative
    #    `bun(.cmd)` shim is the nvm ~135-byte stub. Resolve via
    #    `npm root -g` when npm is on PATH; fall back to walking parent
    #    dirs of each node binary for the sibling `node_modules/`.
    global_npm_roots: list[Path] = []
    npm = shutil.which("npm")
    if npm is not None:
        try:
            r = subprocess.run([npm, "root", "-g"], capture_output=True, text=True, timeout=8)
            if r.returncode == 0:
                global_npm_roots.append(Path(r.stdout.strip()))
        except (OSError, subprocess.TimeoutExpired):
            pass
    # Fallback: derive from `where.exe node` parent dir (covers nvm on
    # Windows where `npm root -g` may be blocked by ExecutionPolicy).
    node_bin = shutil.which("node")
    if node_bin is not None:
        # `_candidates_from_dir` already appends `/node_modules/bun/bin`
        # and `/node_modules/.bin` itself, so feed the parent of node_modules
        # (the nvm nodejs root) directly, not the node_modules dir.
        node_root = Path(node_bin).resolve().parent  # <...>/nodejs
        if (node_root / "node_modules").exists():
            global_npm_roots.append(node_root)
        elif (node_root / "lib" / "node_modules").exists():
            global_npm_roots.append(node_root / "lib")
    for npm_root in global_npm_roots:
        for cand in _candidates_from_dir(npm_root):
            try:
                real = cand.resolve(strict=False)
            except OSError:
                continue
            key = str(real).lower()
            if key in seen:
                continue
            seen.add(key)
            try:
                if real.is_file() and real.stat().st_size >= REAL_BUN_MIN_BYTES:
                    return str(real)
            except OSError:
                continue

    # 4: PATH (covers nvm/node-managed locations whose .cmd shim would
    # otherwise print a misleading "version incompatible" error).
    p = shutil.which(BUN)
    if p is not None:
        try:
            real = Path(p).resolve()
            size = real.stat().st_size if real.exists() else 0
        except OSError:
            real = Path(p)
            size = 0
        if size >= REAL_BUN_MIN_BYTES:
            return str(real)
        print(
            f"[warn] PATH 命中的 bun({p})大小={size} bytes，"
            f"远低于真 binary 阈值({REAL_BUN_MIN_BYTES // (1024*1024)} MB)，疑似 nvm/npm placeholder stub。"
            f"已跳过。请检查 ROOT/node_modules/bun/bin/bun.exe 是否存在。",
            file=sys.stderr,
        )

    return None


def ensure_deps_installed(quiet: bool = False) -> bool:
    """确保 ROOT/node_modules 存在；缺失则跳 bun install。返回 True 表示成功。"""
    pkg = ROOT / "package.json"
    if not pkg.exists():
        return True  # out-of-tree; nothing to install
    nm = ROOT / "node_modules"
    if nm.exists():
        return True  # already installed
    bun = find_bun_exe()
    if bun is None:
        if not quiet:
            print("[deps] node_modules 缺失，bun 也找不到。跳过自动装依赖。", file=sys.stderr)
        return False
    if not quiet:
        print("[deps] node_modules 缺失，跳 bun install ...", file=sys.stderr)
    rc = subprocess.call([bun, "install"], cwd=str(ROOT))
    if rc != 0:
        if not quiet:
            print(f"[err] bun install 失败 (exit={rc})", file=sys.stderr)
        return False
    if not quiet:
        print("[deps] bun install 完成", file=sys.stderr)
    return True


def ensure_gui_built(quiet: bool = False) -> bool:
    """确ӝ ROOT/gui/dist/index.html 存在；缺失则跳 `bun run build:gui`。返回 True 表示成功或已存在。"""
    gui_pkg = ROOT / "gui" / "package.json"
    if not gui_pkg.exists():
        return True  # out-of-tree / no gui subdir
    gui_index = ROOT / "gui" / "dist" / "index.html"
    gui_src = ROOT / "gui" / "src"

    needs_rebuild = False
    reason = "gui/dist 缺失"
    if not gui_index.exists():
        needs_rebuild = True
    else:
        # Compare mtime: any gui/src file newer than gui/dist/index.html?
        # Without this check, a git pull that only updates gui/src/*.tsx
        # leaves the user running the old bundle (broken clipboard fix,
        # missing auth prompt, etc.) because the dist still exists.
        try:
            dist_mtime = gui_index.stat().st_mtime
            newest_src = 0.0
            newest_path = None
            for src_file in gui_src.rglob("*"):
                if not src_file.is_file():
                    continue
                if "node_modules" in src_file.parts:
                    continue
                mt = src_file.stat().st_mtime
                if mt > newest_src:
                    newest_src = mt
                    newest_path = src_file
            if newest_src > dist_mtime:
                needs_rebuild = True
                rel = newest_path.relative_to(ROOT) if newest_path else None
                reason = "源码更新（" + str(rel) + "）比 dist 新"
        except OSError as e:
            needs_rebuild = True
            reason = "stat 失败：" + str(e)

    if not needs_rebuild:
        return True  # up to date

    bun = find_bun_exe()
    if bun is None:
        if not quiet:
            print("[gui] 需要 rebuild 但 bun 找不到。跳过自动 build GUI。", file=sys.stderr)
        return False
    if not quiet:
        print("[gui] " + reason + "，跳 `bun run build:gui` ...", file=sys.stderr)
    rc = subprocess.call([bun, "run", "build:gui"], cwd=str(ROOT))
    if rc != 0:
        if not quiet:
            print(f"[err] bun run build:gui 失败 (exit={rc})", file=sys.stderr)
        return False
    if not quiet:
        print("[gui] bun run build:gui 完成", file=sys.stderr)
    return True


def try_bootstrap_bun(non_interactive: bool = False) -> bool:
    """尝试自动装 bun。顺序探测 npm / pnpm / yarn。non_interactive=True 时不询问。
    装完返回 has_bun() 结果（true = 成功）。

    失败时退到官方备用命令（手动装）：
      winget install --id=Oven-sh.Bun -e
      irm bun.sh/install.ps1 | iex
      scoop install bun
    """
    if has_bun():
        return True
    if non_interactive:
        print("[err] 未检测到 bun，且 --no-auto-bootstrap 设置；请手动安装 Bun 并把它加到 PATH",
              file=sys.stderr)
        return False
    print("[bootstrap] 未检测到 bun，尝试自动安装 ...", file=sys.stderr)

    # Phase 7: 退到官方备用命令（随场景调整提示）
    fallback_cmds = [
        "winget install --id=Oven-sh.Bun -e",
        "irm bun.sh/install.ps1 | iex",
        "scoop install bun",
    ]

    found_mgr = False        # 是否有任一个包管理器被检测到
    attempted_any = False    # 是否至少跳了一次 subprocess.call
    last_failed_mgr = None   # 最后一次走到 subprocess.call 但失败的包管器
    last_launch_err = None   # 最后一次 subprocess.call 抛出的异常（FileNotFoundError 等）

    # Windows 上 npm / pnpm / yarn 的安装产物是 .CMD shim。Python subprocess 用 list args
    # + 无 shell=True 时直接走 CreateProcess，不解析 .CMD shim -> FileNotFoundError。
    # 这是手动跑 `python ocx-start.py` 报 "bun 装失败" 但无任何 exit 信息的根因。
    # 走 cmd.exe /c 让 PATHEXT 解析 .CMD。args 是字面量，无 shell 注入风险。
    use_shell = sys.platform == "win32"

    for mgr in ("npm", "pnpm", "yarn"):
        mgr_path = shutil.which(mgr)
        if mgr_path is None:
            continue
        found_mgr = True
        try:
            if mgr == "npm":
                print("[bootstrap] npm install -g bun", file=sys.stderr)
                rc = subprocess.call([mgr, "install", "-g", "bun"], shell=use_shell)
            elif mgr == "pnpm":
                print("[bootstrap] pnpm add -g bun", file=sys.stderr)
                rc = subprocess.call([mgr, "add", "-g", "bun"], shell=use_shell)
            else:
                print("[bootstrap] yarn global add bun", file=sys.stderr)
                rc = subprocess.call([mgr, "global", "add", "bun"], shell=use_shell)
            attempted_any = True
            if rc == 0 and has_bun():
                print("[bootstrap] bun 安装成功", file=sys.stderr)
                return True
            print(f"[bootstrap] {mgr} 装 bun 返 exit={rc}", file=sys.stderr)
            last_failed_mgr = mgr
        except FileNotFoundError as e:
            # 之前 silently continue 让用户看不到任何诊断。现在记下来 + 打 stderr，
            # 让脚本失败时能区分「安装失败」vs「调起失败」两种根因。
            attempted_any = True
            last_failed_mgr = mgr
            last_launch_err = f"{type(e).__name__}: {e}"
            print(f"[bootstrap] {mgr} 调起失败（shim={mgr_path}）: {last_launch_err}",
                  file=sys.stderr)
            continue

    # 所有路径都走完，还是不成功 → 错误诊断
    print("[err] 自动安装 bun 失败。请手动安装 Bun: https://bun.sh", file=sys.stderr)
    if not found_mgr:
        # 场景 1: Node.js 未装 / npm 不在 PATH
        print("[hint] 未检测到任何 Node 包管理器（npm / pnpm / yarn）。", file=sys.stderr)
        print("       可能是 Node.js 未装、或 npm 未加入 PATH。", file=sys.stderr)
        print("       推荐先装 Node.js LTS（自带 npm）：", file=sys.stderr)
        print("         winget install --id=OpenJS.NodeJS.LTS -e", file=sys.stderr)
        print("       或直接用官方命令装 bun（不需要 npm）：", file=sys.stderr)
        for cmd in fallback_cmds:
            print(f"         {cmd}", file=sys.stderr)
    elif attempted_any and last_failed_mgr is not None:
        # 场景 2: 有 npm/pnpm/yarn 但装不上（网络 / 权限 / 镜像问题）
        print(f"[hint] {last_failed_mgr} 存在但装 bun 失败。", file=sys.stderr)
        print("       可能是网络问题、权限不足、或 npm registry 镜像不可达。", file=sys.stderr)
        print("       可试以下官方备用命令（跳过 npm）：", file=sys.stderr)
        for cmd in fallback_cmds:
            print(f"         {cmd}", file=sys.stderr)
    return False


def launcher_env(cfg: dict, cli_overrides: dict | None = None) -> dict:
    """Compute env vars to pass to the bun subprocess.

    Resolution order (high -> low):
      1. cli_overrides (CLI flags win)
      2. cfg["preset"] (Phase 5)
      3. cfg["enableCodexLauncherMode"] (camelCase; what src/config.ts writes today)
      4. cfg["syncRoutedModels"], cfg["syncNativeOpenaiModels"]

    When preset is set, it overrides the per-flag values (Phase 5 contract):
      proxy-only / full-pass-through -> launcher_mode=false, sync_routed_models=false
      launcher                       -> launcher_mode=true,  sync_routed_models=true
      full-pass-through              -> sync_native_openai_models=false
      proxy-only / launcher          -> sync_native_openai_models=true

    Always emits OCX_LAUNCHER_MODE when its intent is determinable so the bun
    subprocess never has to fall back to its internal default.
    """
    overrides = cli_overrides or {}
    env: dict[str, str] = {}

    # Resolve each flag from cli_overrides -> cfg (camelCase) -> None
    preset = overrides.get("preset", cfg.get("preset"))
    launcher_mode = overrides.get("launcher_mode")
    if launcher_mode is None and cfg.get("enableCodexLauncherMode") is not None:
        launcher_mode = bool(cfg["enableCodexLauncherMode"])
    sync_routed = overrides.get("sync_routed_models")
    if sync_routed is None and cfg.get("syncRoutedModels") is not None:
        sync_routed = bool(cfg["syncRoutedModels"])
    sync_native = overrides.get("sync_native_openai_models")
    if sync_native is None and cfg.get("syncNativeOpenaiModels") is not None:
        sync_native = bool(cfg["syncNativeOpenaiModels"])

    if preset:
        env["OCX_PRESET"] = str(preset)
        if preset in ("proxy-only", "full-pass-through"):
            launcher_mode = False
            sync_routed = False
        elif preset == "launcher":
            launcher_mode = True
            sync_routed = True
        if preset == "full-pass-through":
            sync_native = False
        elif preset in ("proxy-only", "launcher"):
            sync_native = True

    if launcher_mode is not None:
        env["OCX_LAUNCHER_MODE"] = "true" if launcher_mode else "false"
    if sync_routed is not None:
        env["OCX_SYNC_ROUTED_MODELS"] = "true" if sync_routed else "false"
    if sync_native is not None:
        env["OCX_SYNC_NATIVE_OPENAI_MODELS"] = "true" if sync_native else "false"
    if overrides.get("hostname"):
        env["OCX_HOSTNAME"] = str(overrides["hostname"])
    return env


# --- launcher mode helpers (Phase 6 redesign) -------------------------------

def mode_label(mode: bool | None) -> str:
    """Human-readable label for the launcher-mode value.
    True   -> "launcher"     (opencodex writes ~/.codex/*)
    False  -> "pass-through" (HTTP-only; CodexPlusPlus/other launcher owns Codex)
    None   -> "unconfigured" (treated as pass-through but caller should warn)
    """
    if mode is True:
        return "launcher"
    if mode is False:
        return "pass-through"
    return "unconfigured"


def list_codex_impact(mode: bool | None) -> list[str]:
    """Files opencodex touches in launcher mode, or skips in pass-through.
    Same list also surfaced in the [i] "view impact" menu action.
    """
    if mode is True:
        return [
            "~/.codex/config.toml (model_provider, openai_base_url on each toggle)",
            "~/.codex/state_5.sqlite (model_provider tag on each thread)",
            "~/.codex/opencodex-journal.json (opencodex-internal ledger)",
            "~/.codex/model-catalogs/relay-*.json (routed model entries appended)",
        ]
    return [
        "(none - pass-through mode leaves ~/.codex/* untouched)",
    ]


def probe_codex_plus_plus() -> dict:
    """Best-effort detection of CodexPlusPlus running on this machine.

    Two signals combined (process name + port 9222 hold):
      - Windows process named Codex-win32-x64 (CodexPlusPlus Electron binary)
      - 127.0.0.1:9222 bound (Chrome DevTools debug port CodexPlusPlus uses)

    Returns dict with keys: present (bool), pid (int|None),
    port_held (bool), codex_home (Path|None).
    CodexPlusPlus is Windows-only as of this writing; on other OSes returns
    present=False without an error.
    """
    info = {"present": False, "pid": None, "port_held": False, "codex_home": Path.home() / ".codex"}
    if sys.platform != "win32":
        return info
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-Process | Where-Object { $_.ProcessName -eq 'codex' -or $_.ProcessName -eq 'Codex-win32-x64' -or $_.ProcessName -eq 'codex-plus-plus-manager' } -ErrorAction SilentlyContinue | "
             "Select-Object -First 1 -ExpandProperty Id"],
            capture_output=True, text=True, timeout=4,
        )
        pid_text = (out.stdout or "").strip()
        if pid_text.isdigit():
            info["pid"] = int(pid_text)
            info["present"] = True
    except (OSError, subprocess.TimeoutExpired):
        pass
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.3)
        s.bind(("127.0.0.1", 9222))
    except OSError as e:
        if e.errno == errno.EADDRINUSE or getattr(e, "winerror", None) == 10048:
            info["port_held"] = True
            info["present"] = True
    finally:
        if s is not None:
            try:
                s.close()
            except Exception:
                pass
    return info


def ensure_safe_default(cfg: dict) -> bool:
    """If cfg has neither enableCodexLauncherMode nor preset, backfill the
    safe default (enableCodexLauncherMode=false, preset="full-pass-through").
    Called lazily by the menu on first launch. Returns True if a write happened.
    Does NOT touch any other fields. Safe to call repeatedly (idempotent).
    """
    if cfg.get("enableCodexLauncherMode") is not None or cfg.get("preset") is not None:
        return False
    if not CONFIG.exists():
        return False
    try:
        with CONFIG.open("r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return False
    if not isinstance(raw, dict):
        return False
    if raw.get("enableCodexLauncherMode") is not None or raw.get("preset") is not None:
        return False
    raw["enableCodexLauncherMode"] = False
    raw["preset"] = "full-pass-through"
    try:
        with CONFIG.open("w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2, ensure_ascii=False)
            f.write("\n")
    except OSError:
        return False
    return True


def warn_if_proxy_mode(cfg: dict) -> None:
    """启动前把"proxy-only / full-pass-through"提示打到 stderr，让用户视觉确认。"""
    mode = effective_launcher_mode(cfg)
    if mode is False:
        preset = cfg.get("preset")
        name = preset if preset in ("proxy-only", "full-pass-through") else "proxy-only"
        print(f"[warn] launcher_mode=false（{name}）；opencodex 不再写 ~/.codex/config.toml、", file=sys.stderr)
        print("       state_5.sqlite、journal.json；routed 由 CodexPlusPlus 或其他 launcher 接管", file=sys.stderr)


def run_cli(*args: str, env_overrides: dict | None = None, no_bootstrap: bool = False) -> int:
    # Patch 1: AVX-driven runtime choice. Logs the decision every run so persistent
    # no_avx shows up in operator stderr; no extra UI.
    runtime_decision = decide_runtime()
    log_runtime_decision(runtime_decision)
    ocx_env_marker = runtime_decision.get("runtime", "bun")

    bun_exe = find_bun_exe()
    if bun_exe is None:
        if not try_bootstrap_bun(non_interactive=no_bootstrap):
            return 127
        bun_exe = find_bun_exe()
        if bun_exe is None:
            print("[err] bun 装完后 PATH 仍找不到。请重新打开 PowerShell 让 PATH 生效，或手动检查 bun 安装位置。", file=sys.stderr)
            return 127
    if not ensure_deps_installed():
        print("[err] 依赖装不上，请先手动跳 `bun install` 再重试。", file=sys.stderr)
        return 127
    if not ensure_gui_built():
        print("[err] GUI build 不上，请先手动跳 `bun run build:gui` 再重试。", file=sys.stderr)
        return 127
    # Pick runtime command. Project hard-depends on Bun; if runtime="none"
    # (CPU lacks AVX, or operator explicitly forced "node" but no Node
    # backend exists), refuse instead of falling through to a known-bad
    # command.
    if ocx_env_marker == "none":
        reason = runtime_decision.get("reason", "unknown")
        print(
            f"[err] 无法启动 opencodex：runtime 决策为 none (reason={reason}). "
            f"本项目强依赖 Bun runtime（bun:sqlite / Bun.serve），且不存在 Node backend。"
            "AVX 不再参与判定 — Bun 的 SSE4.2 baseline 已覆盖 Apollo Lake / Atom / Celeron。",
            file=sys.stderr,
        )
        return 2
    cmd = [bun_exe, "run", "src/cli/index.ts", *args]
    print(f"[run] {' '.join(cmd)}", file=sys.stderr)
    env = None
    if env_overrides:
        env = dict(**subprocess.os.environ)
        env.update(env_overrides)
    try:
        return subprocess.call(cmd, cwd=str(ROOT), env=env)
    except KeyboardInterrupt:
        return 0
    except FileNotFoundError:
        print("[err] bun 路径解析后仍无法启动。请重新打开 PowerShell 后重试。", file=sys.stderr)
        return 127


def run_init() -> int:
    print("[init] 打开交互模式（会问 provider / api key）...", file=sys.stderr)
    return run_cli("init")


def run_start(port: int, cli_overrides: dict | None = None, no_bootstrap: bool = False) -> int:
    print("[start] 前台启动（Ctrl+C 停）。", file=sys.stderr)
    cfg = load_opencodex_config()
    warn_if_proxy_mode(cfg)
    # Phase-6A: probe-and-prompt loop pre-spawn
    effective_port = resolve_runtime_port(port)
    return run_cli("start", "--port", str(effective_port), env_overrides=launcher_env(cfg, cli_overrides), no_bootstrap=no_bootstrap)


def run_background(port: int, cli_overrides: dict | None = None, no_bootstrap: bool = False) -> int:
    print("[bg] 后台启动中...", file=sys.stderr)
    # Config is OPTIONAL. The proxy itself can run with an empty ~/.opencodex/config.json;
    # providers / API keys / launcher-mode are managed via the web GUI (http://localhost:<port>).
    # Users who want a CLI-driven first run can pick [5] in the menu, or pass --init / --init-and-start.
    if not is_initialized():
        print("[bg] 未发现 config.json：以空配置启动，请到 http://localhost:<port> 的网页设置 provider / env。", file=sys.stderr)

    # Phase-6A: probe-and-prompt loop pre-spawn; on bail returns original port
    effective_port = resolve_runtime_port(port)
    print(f"[bg] resolved port: {effective_port}", file=sys.stderr)

    cfg = load_opencodex_config()
    warn_if_proxy_mode(cfg)
    launcher_env_vars = launcher_env(cfg, cli_overrides)
    if launcher_env_vars:
        print(f"[bg] launcher-mode env: {launcher_env_vars}", file=sys.stderr)

    out_log = ROOT / "ocx.out.log"
    err_log = ROOT / "ocx.err.log"
    for f in (out_log, err_log):
        if f.exists():
            f.unlink()

    out_fp = open(out_log, "wb")
    err_fp = open(err_log, "wb")

    creationflags = 0
    if sys.platform == "win32":
        DETACHED_PROCESS = 0x00000008
        CREATE_NO_WINDOW = 0x08000000
        creationflags = DETACHED_PROCESS | CREATE_NO_WINDOW

    env = dict(**subprocess.os.environ)
    env.update(launcher_env_vars)

    try:
        bun_exe = find_bun_exe()
        if bun_exe is None:
            if not try_bootstrap_bun(non_interactive=no_bootstrap):
                return 127
            bun_exe = find_bun_exe()
            if bun_exe is None:
                print("[err] bun 装后 PATH 仍找不到。请重新打开 PowerShell。", file=sys.stderr)
                return 127
        # Runtime decision. Mirror run_cli: refuse only if runtime="none"
        # (currently only triggered by explicit --force=node, since AVX is
        # no longer part of the gate).
        runtime_decision = decide_runtime()
        log_runtime_decision(runtime_decision)
        if runtime_decision.get("runtime") == "none":
            reason = runtime_decision.get("reason", "unknown")
            print(
                f"[err] 后台启动中止：runtime 决策为 none (reason={reason}). "
                f"本项目强依赖 Bun runtime（bun:sqlite / Bun.serve），且不存在 Node backend。",
                file=sys.stderr,
            )
            return 2
        spawn_cmd = [bun_exe, "run", "src/cli/index.ts", "start", "--port", str(effective_port)]
        proc = subprocess.Popen(
            spawn_cmd,
            cwd=str(ROOT),
            stdout=out_fp,
            stderr=err_fp,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
            env=env,
        )
    except FileNotFoundError:
        print("[err] 找不到 bun", file=sys.stderr)
        return 127

    print(f"[bg] 后台 PID: {proc.pid}", file=sys.stderr)
    print(f"[bg] 实际端口: {effective_port}", file=sys.stderr)
    print(f"[bg] stdout : {out_log}", file=sys.stderr)
    print(f"[bg] stderr : {err_log}", file=sys.stderr)
    print("[bg] 等待 5 秒看是否起来...", file=sys.stderr)
    time.sleep(5)
    # Post-spawn: prefer the port bun actually wrote to runtime-port.json
    actual = read_runtime_port_file() or effective_port
    show_state(port, actual)
    if health_ok(actual):
        print(f"[bg] 起来了。打开 http://localhost:{actual}", file=sys.stderr)
        return 0
    print("[bg] 似乎没起来。看 stderr 找原因：", file=sys.stderr)
    if err_log.exists():
        with err_log.open("r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= 30:
                    break
                print(line, end="")
    return 1


def run_shim_then_start(port: int, cli_overrides: dict | None = None, no_bootstrap: bool = False) -> int:
    print("[shim] 装 Codex 自启动垫片...", file=sys.stderr)
    rc = run_cli("codex-shim", "install")
    if rc != 0:
        return rc
    print(file=sys.stderr)
    return run_start(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)


def run_stop(port: int) -> int:
    print("[stop] 停服务并恢复原生 Codex...", file=sys.stderr)
    rc = run_cli("stop")
    time.sleep(1)
    show_state(port)
    return rc


def run_status() -> int:
    return run_cli("status")


def run_bootstrap(port: int, repo_url: str | None, target_dir: str | None,
                  cli_overrides: dict | None = None, no_bootstrap: bool = False) -> int:
    """首次装机（克隆 + 装依赖 + init + 后台启动）。

    调用方：菜单 [4]（out-of-tree）或 CLI `--bootstrap`。

    流程：
      1) 装 Bun（如缺）
      2) git clone <repo_url> <target_dir>（已有则跳过）
      3) 在 clone 内 bun install（如缺）
      4) exec 子进程跑 in-tree ocx-start.py --background，让它处理 init + 后台启动

    设计要点：
      - ROOT 是模块级常量（取自 __file__），chdir 不安全；直接 subprocess exec 子进程。
      - 子进程的 sys.executable = 当前 Python，确保 shebang-less 也能起。
      - target_dir 已有 package.json 时不重复 clone；不空但无 package.json 时 fail-fast。
    """
    print("[bootstrap] 开始首次装机", file=sys.stderr)
    if not has_bun():
        if not try_bootstrap_bun(non_interactive=no_bootstrap):
            return 127

    target = Path(target_dir) if target_dir else (Path.home() / "opencodex")
    if target.exists() and not (target / "package.json").exists():
        print(f"[err] {target} 已存在但没有 package.json。请先手动清理再试。", file=sys.stderr)
        return 1
    if not (target / "package.json").exists():
        url = repo_url or "https://github.com/zamelee/opencodex.git"
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"[bootstrap] git clone {url} -> {target}", file=sys.stderr)
        rc = subprocess.call(["git", "clone", url, str(target)])
        if rc != 0 or not (target / "package.json").exists():
            print(f"[err] git clone 失败 (exit {rc})", file=sys.stderr)
            return rc or 1
    else:
        print(f"[bootstrap] {target} 已是 opencodex repo，跳过 clone", file=sys.stderr)

    if not (target / "node_modules").exists():
        print(f"[bootstrap] bun install in {target}", file=sys.stderr)
        rc = subprocess.call([BUN, "install"], cwd=str(target))
        if rc != 0:
            print(f"[err] bun install 失败 (exit {rc})", file=sys.stderr)
            return rc
    else:
        print(f"[bootstrap] {target}/node_modules 已存在，跳过 bun install", file=sys.stderr)

    new_script = target / "ocx-start.py"
    if not new_script.exists():
        print(f"[err] 找不到 {new_script}", file=sys.stderr)
        return 1
    py = sys.executable or "python"
    args = [py, str(new_script), "--background", "--port", str(port)]
    if no_bootstrap:
        args.append("--no-auto-bootstrap")
    print(f"[bootstrap] 接管到 in-tree ocx-start.py: {chr(0x20)}{" ".join(args)}", file=sys.stderr)
    return subprocess.call(args)


def run_clean() -> int:
    print("[clean] 删 dist ...", file=sys.stderr)
    for d in ("dist", "gui/dist"):
        p = ROOT / d
        if p.exists():
            shutil.rmtree(p)
            print(f"  已删除 {p}", file=sys.stderr)
    return 0


def parse_bool_arg(v: str | None) -> bool | None:
    if v is None:
        return None
    s = str(v).strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off"):
        return False
    return None


def _menu_action_start(port: int, cli_overrides: dict, no_bootstrap: bool, in_tree: bool) -> int:
    """[s] start the proxy. Sub-prompt: f=foreground, b=background, shim=install shim then fg."""
    print()
    print("  启动方式:")
    print("    [f] 前台 (Ctrl+C 停)")
    print("    [b] 后台 (shell 立刻返回)")
    if in_tree:
        print("    [shim] 安装 codex-shim + 前台启动")
    print("    [返回] 上一级")
    try:
        sub = input("  选 > ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return 0
    if sub == "f":
        return run_start(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
    if sub == "b" or sub == "":
        return run_background(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
    if sub == "shim" and in_tree:
        return run_shim_then_start(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
    return 0


def _menu_action_toggle_mode(port: int, cli_overrides: dict, no_bootstrap: bool) -> int:
    """[m] toggle launcher mode. Requires stop -> write config -> start."""
    cfg = load_opencodex_config()
    cur = effective_launcher_mode(cfg)
    next_mode = not (cur is True)  # None / False -> True; True -> False
    cpp = probe_codex_plus_plus()
    print()
    print(f"  当前模式: {mode_label(cur)}")
    print(f"  目标模式: {mode_label(next_mode)}")
    print()
    print("  影响文件 (目标模式下):")
    for line in list_codex_impact(next_mode):
        print(f"    {line}")
    print()
    if cpp["present"] and next_mode:
        print("  ⚠ 检测到 CodexPlusPlus 在跑。切到 launcher 模式会覆盖 CodexPlusPlus 的路由配置。")
    elif cpp["present"] and not next_mode:
        print("  ✓ 检测到 CodexPlusPlus 在跑。切到 pass-through 不会冲突。")
    print()
    try:
        ans = input("  确认切换吗？[y/N] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return 0
    if ans != "y":
        print("  取消。")
        return 0
    # Stop running proxy first so the env vars we set actually take effect.
    rc = run_stop(port)
    if rc != 0 and rc != 124:
        print(f"  [warn] 停服务返回 {rc}，仍会尝试写入 config", file=sys.stderr)
    # Write the new value into config.
    try:
        with CONFIG.open("r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = {}
    raw["enableCodexLauncherMode"] = bool(next_mode)
    raw["preset"] = "launcher" if next_mode else "full-pass-through"
    try:
        with CONFIG.open("w", encoding="utf-8") as f:
            json.dump(raw, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"  [cfg] 写入配置: enableCodexLauncherMode={next_mode}, preset={raw['preset']}")
    except OSError as e:
        print(f"  [err] 写入失败: {e}", file=sys.stderr)
        return 1
    # Restart so the new env vars are picked up.
    return run_background(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)


def _menu_action_view_impact() -> int:
    """[i] show which ~/.codex/* files the current mode would touch."""
    cfg = load_opencodex_config()
    mode = effective_launcher_mode(cfg)
    print()
    print(f"  当前模式: {mode_label(mode)}")
    print("  影响的 Codex 文件:")
    for line in list_codex_impact(mode):
        print(f"    {line}")
    print()
    return 0


def _menu_action_status(port: int) -> int:
    """[?] proxy status via bun status command."""
    return run_status()


def main_menu(port: int, cli_overrides: dict | None = None, no_bootstrap: bool = False) -> int:
    in_tree = (ROOT / "package.json").exists()
    while True:
        show_state(port)
        # One-time backfill: if config has neither enableCodexLauncherMode
        # nor preset, propose writing the safe default.
        cfg = load_opencodex_config()
        if is_initialized() and cfg.get("enableCodexLauncherMode") is None and cfg.get("preset") is None:
            print("  [hint] launcher_mode 未显式配置。如果你计划长期用 CodexPlusPlus 管 Codex，")
            print("         推荐为安全默认 enableCodexLauncherMode=false（HTTP-only）。")
            try:
                ans = input("  现在写入默认配置吗？[y/N] ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                ans = "n"
            if ans == "y":
                if ensure_safe_default(cfg):
                    print("  [cfg] 已写入 enableCodexLauncherMode=false + preset=full-pass-through。下次启动会传递给 bun。")
                else:
                    print("  [err] 写入失败，跳过。")
                print()

        if in_tree:
            print("  动作:")
            print("    [s] 启动  (f=前台 / b=后台 / shim=安 codex-shim)")
            print("    [x] 停止  (停服务 + 恢复原生 Codex)")
            print("    [m] 切换模式  (HTTP-only <-> Launcher)")
            print("    [i] 查看影响  (列出当前模式会动哪些 Codex 文件)")
            print("    [?] 查看状态  (proxy status)")
            print("    [c] 配置 init  (首次安装 / 重新 init)")
            print("    [r] 清理 dist  (gui/dist + dist)")
            print("    [q] 退出")
        else:
            print("  动作 (out-of-tree，尚未 init):")
            print("    [s] 启动  (含首次安装 bootstrap)")
            print("    [x] 停止")
            print("    [m] 切换模式  (需先 init)")
            print("    [i] 查看影响")
            print("    [?] 查看状态")
            print("    [q] 退出")
            print()
            print("  ⚠ 检测到未 init，请先运行 [s] bootstrap 。")
        print()
        try:
            c = input("选 > ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        if c == "q":
            return 0
        if c == "x":
            return run_stop(port)
        if c == "i":
            _menu_action_view_impact()
            continue
        if c == "?":
            _menu_action_status(port)
            continue
        if c == "c":
            if not in_tree:
                print("  out-of-tree 环境下 init 走 bootstrap 路径。")
                continue
            run_init()
            continue
        if c == "r":
            run_clean()
            continue
        if c == "m":
            if not is_initialized():
                print("  未 init，跳过。")
                continue
            _menu_action_toggle_mode(port, cli_overrides or {}, no_bootstrap)
            continue
        if c == "s" or c == "":
            if not in_tree:
                # Out-of-tree: bootstrap (clone + install + init + background)
                rc = run_bootstrap(port, None, None, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
                return rc
            return _menu_action_start(port, cli_overrides or {}, no_bootstrap, in_tree)
        # Unrecognized key: show hint, loop back.
        print(f"  未识别的选项：{c!r}。按上面列表选。", file=sys.stderr)


def build_cli_overrides(args: argparse.Namespace) -> dict:
    o: dict = {}
    if getattr(args, "preset", None):
        v = str(args.preset)
        if v in ("launcher", "proxy-only", "full-pass-through"):
            o["preset"] = v
    lm = parse_bool_arg(getattr(args, "launcher_mode", None))
    if lm is not None:
        o["launcher_mode"] = lm
    rm = parse_bool_arg(getattr(args, "sync_routed_models", None))
    if rm is not None:
        o["sync_routed_models"] = rm
    nm = parse_bool_arg(getattr(args, "sync_native_openai_models", None))
    if nm is not None:
        o["sync_native_openai_models"] = nm
    host = getattr(args, "hostname", None)
    if host:
        o["hostname"] = str(host)
    return o


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="ocx-start.py",
        description="opencodex 启动面板",
        add_help=False,
    )
    parser.add_argument("--foreground", action="store_true", help="前台运行")
    parser.add_argument("--background", action="store_true", help="后台运行（默认）")
    parser.add_argument("--init", action="store_true", help="只跑 init")
    parser.add_argument("--init-and-start", action="store_true", help="首次：init + 启动")
    parser.add_argument("--with-shim", action="store_true", help="装 codex-shim + 启动")
    parser.add_argument("--stop", action="store_true", help="停服务")
    parser.add_argument("--status", action="store_true", help="看状态")
    parser.add_argument("--clean", action="store_true", help="清 dist / gui/dist")
    parser.add_argument("--port", type=int, default=10100, help="端口（默认 10100）")
    parser.add_argument("--no-auto-bootstrap", action="store_true",
                        help="bun 缺失时不要自动安装，只打 err")
    parser.add_argument("--preset", choices=("launcher", "proxy-only", "full-pass-through"),
                        help="Phase 5 launcher preset（覆盖 config.json + CLI flag 优先级最高）")
    parser.add_argument("--launcher-mode", help="覆盖 enableCodexLauncherMode（true/false）")
    parser.add_argument("--sync-routed-models", help="覆盖 syncRoutedModels（true/false）")
    parser.add_argument("--sync-native-openai-models", help="覆盖 syncNativeOpenaiModels（true/false）")
    parser.add_argument("--hostname", "--bind", dest="hostname", help="bind 地址（默认 127.0.0.1；需要其他 IP 访问请设 0.0.0.0）")
    parser.add_argument("--bootstrap", action="store_true",
                        help="首次装机（克隆 repo + 装依赖 + init + 后台启动）")
    parser.add_argument("--bootstrap-repo", help="覆盖默认 repo URL（仅 --bootstrap 生效）")
    parser.add_argument("--bootstrap-dir", help="覆盖默认目标目录（仅 --bootstrap 生效）")
    parser.add_argument("-h", "--help", action="store_true", dest="show_help")
    ns = parser.parse_args()

    if ns.show_help:
        print(__doc__)
        return 0

    cli_overrides = build_cli_overrides(ns)
    no_bootstrap = ns.no_auto_bootstrap

    if ns.bootstrap:
        return run_bootstrap(ns.port, ns.bootstrap_repo, ns.bootstrap_dir,
                              cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
    if ns.stop:    return run_stop(ns.port)
    if ns.status:  return run_status()
    if ns.clean:   return run_clean()
    if ns.init:    return run_init()
    if ns.init_and_start:
        if is_initialized():
            print(f"[init] 已发现 {CONFIG}，跳过 init", file=sys.stderr)
        else:
            rc = run_init()
            if rc != 0 or not is_initialized():
                print("[init] init 后仍未生成 config，终止", file=sys.stderr)
                return rc or 1
        return run_start(ns.port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
    if ns.with_shim:  return run_shim_then_start(ns.port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
    if ns.background: return run_background(ns.port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
    if ns.foreground: return run_start(ns.port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)

    return main_menu(ns.port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)


if __name__ == "__main__":
    sys.exit(main())
