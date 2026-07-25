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
import sys
import time
import urllib.request
from pathlib import Path

ROOT   = Path(__file__).resolve().parent
CONFIG = Path.home() / ".opencodex" / "config.json"
BUN    = "bun"


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
    """返回当前 effective launcher_mode；None = 未设置（= true 默认）。"""
    if cfg.get("preset") == "proxy-only" or cfg.get("preset") == "full-pass-through":
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
    init = is_initialized()
    if effective_port is None:
        effective_port = read_runtime_port_file()  # post-spawn drift
    actual_port = effective_port if effective_port is not None else port
    run = health_ok(actual_port)
    print()
    print("=" * 40)
    print("  opencodex 面板")
    print("=" * 40)
    print(f"  配置     : {'已初始化' if init else '未初始化'}")
    if actual_port != port:
        print(f"  进程     : {'运行中' if run else 'fallback 后未起来'}")
        print(f"  默认端口 : {port}")
        print(f"  实际端口 : {actual_port} (fallback 启用)")
        print(f"  面板地址 : http://localhost:{actual_port}")
    else:
        print(f"  进程     : {'运行中' if run else '未运行'}")
        print(f"  默认端口 : {port}")
        if run:
            print(f"  面板地址 : http://localhost:{port}")
    mode = effective_launcher_mode(load_opencodex_config())
    if mode is False:
        print("  launcher : 关（HTTP-only 模式）")
    print("=" * 40)
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
    """Return absolute path to bun executable (resolved through PATHEXT),
    or None if not found. Windows .cmd shims cannot always be invoked directly
    by subprocess with list args + no shell=True, so we resolve first and
    pass the absolute path as cmd[0].
    """
    p = shutil.which(BUN)
    if p is None:
        return None
    try:
        return str(Path(p).resolve())
    except OSError:
        return p


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
    if gui_index.exists():
        return True  # already built
    bun = find_bun_exe()
    if bun is None:
        if not quiet:
            print("[gui] gui/dist 缺失，bun 也找不到。跳过自动 build GUI。", file=sys.stderr)
        return False
    if not quiet:
        print("[gui] gui/dist 缺失，跳 `bun run build:gui` ...", file=sys.stderr)
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

    for mgr in ("npm", "pnpm", "yarn"):
        if shutil.which(mgr) is None:
            continue
        found_mgr = True
        try:
            if mgr == "npm":
                print("[bootstrap] npm install -g bun", file=sys.stderr)
                rc = subprocess.call([mgr, "install", "-g", "bun"])
            elif mgr == "pnpm":
                print("[bootstrap] pnpm add -g bun", file=sys.stderr)
                rc = subprocess.call([mgr, "add", "-g", "bun"])
            else:
                print("[bootstrap] yarn global add bun", file=sys.stderr)
                rc = subprocess.call([mgr, "global", "add", "bun"])
            attempted_any = True
            if rc == 0 and has_bun():
                print("[bootstrap] bun 安装成功", file=sys.stderr)
                return True
            print(f"[bootstrap] {mgr} 装 bun 返 exit={rc}", file=sys.stderr)
            last_failed_mgr = mgr
        except FileNotFoundError:
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
    """根据 config + CLI overrides 计算要 spawn 给 bun 子进程的 launcher-mode env vars。
    cli_overrides 形状（任意字段可缺省）：
      {"preset": "proxy-only" | "launcher" | "full-pass-through" | None,
       "launcher_mode": true/false/None,
       "sync_routed_models": true/false/None,
       "sync_native_openai_models": true/false/None}"""
    overrides = cli_overrides or {}
    env: dict[str, str] = {}
    # preset 优先
    preset = overrides.get("preset", cfg.get("preset"))
    if preset:
        env["OCX_PRESET"] = str(preset)
        if preset in ("proxy-only", "full-pass-through"):
            env["OCX_LAUNCHER_MODE"] = "false"
            env["OCX_SYNC_ROUTED_MODELS"] = "false"
        elif preset == "launcher":
            env["OCX_LAUNCHER_MODE"] = "true"
            env["OCX_SYNC_ROUTED_MODELS"] = "true"
        if preset in ("full-pass-through",):
            env["OCX_SYNC_NATIVE_OPENAI_MODELS"] = "false"
        elif preset in ("proxy-only", "launcher"):
            env["OCX_SYNC_NATIVE_OPENAI_MODELS"] = "true"
    # per-flag 覆盖 preset 设的
    if overrides.get("launcher_mode") is not None:
        env["OCX_LAUNCHER_MODE"] = "true" if overrides["launcher_mode"] else "false"
    if overrides.get("sync_routed_models") is not None:
        env["OCX_SYNC_ROUTED_MODELS"] = "true" if overrides["sync_routed_models"] else "false"
    if overrides.get("sync_native_openai_models") is not None:
        env["OCX_SYNC_NATIVE_OPENAI_MODELS"] = "true" if overrides["sync_native_openai_models"] else "false"
    if overrides.get("hostname"):
        env["OCX_HOSTNAME"] = str(overrides["hostname"])
    return env


def warn_if_proxy_mode(cfg: dict) -> None:
    """启动前把"proxy-only / full-pass-through"提示打到 stderr，让用户视觉确认。"""
    mode = effective_launcher_mode(cfg)
    if mode is False:
        preset = cfg.get("preset")
        name = preset if preset in ("proxy-only", "full-pass-through") else "proxy-only"
        print(f"[warn] launcher_mode=false（{name}）；opencodex 不再写 ~/.codex/config.toml、", file=sys.stderr)
        print("       state_5.sqlite、journal.json；routed 由 CodexPlusPlus 或其他 launcher 接管", file=sys.stderr)


def run_cli(*args: str, env_overrides: dict | None = None, no_bootstrap: bool = False) -> int:
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
        proc = subprocess.Popen(
            [bun_exe, "run", "src/cli/index.ts", "start", "--port", str(effective_port)],
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


def main_menu(port: int, cli_overrides: dict | None = None, no_bootstrap: bool = False) -> int:
    while True:
        show_state(port)
        print("请选择启动方式（直接回车 = 2 后台）：")
        print()
        if (ROOT / "package.json").exists():
            print("  [1] 前台运行")
            print("  [2] 后台运行（shell 立刻返回；默认）")
            print("  [3] 装 codex-shim + 前台跑")
            print("  [4] 首次：init + 后台启动")
            print("  [5] 只跑 init（交互）")
            print("  [6] 停服务")
            print("  [7] 看 status")
            print("  [8] 清 dist")
            print("  [q] 退出")
        else:
            print("  [1] 首次装机（克隆 repo + 装依赖 + init + 后台启动）")
            print("  [2] 后台运行（shell 立刻返回；默认）")
            print("  [3] 装 codex-shim + 前台跑")
            print("  [4] 前台运行")
            print("  [5] 只跑 init（交互）")
            print("  [6] 停服务")
            print("  [q] 退出")
            print()
            print("  ★ 检测到尚未初始化。推荐先跑 [1] 首次装机。", file=__import__("sys").stderr)
        print()
        try:
            c = input("选项 > ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        in_tree = (ROOT / "package.json").exists()
        if in_tree:
            # In-tree menu: 老布局
            if   c == "1": return run_start(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
            elif c in ("", "2"): return run_background(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
            elif c == "3": return run_shim_then_start(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
            elif c == "4":
                if is_initialized():
                    print(f"[init] 已发现 {CONFIG}，跳过 init", file=sys.stderr)
                else:
                    rc = run_init()
                    if rc != 0 or not is_initialized():
                        print("[init] init 后仍未生成 config，终止", file=sys.stderr)
                        return rc or 1
                return run_background(port, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
            elif c == "5": return run_init()
            elif c == "6": return run_stop(port)
            elif c == "7": return run_status()
            elif c == "8": run_clean()
            elif c == "q": return 0
        else:
            # Out-of-tree menu: bootstrap 是首选
            if   c == "1": return run_bootstrap(port, None, None, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
            elif c == "2": return run_bootstrap(port, None, None, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
            elif c == "3": return run_bootstrap(port, None, None, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
            elif c == "4":
                print("[hint] 尚未初始化。请先跑 [1] 首次装机，或自己 clone + bun install。", file=sys.stderr)
                time.sleep(2)
            elif c == "5": return run_bootstrap(port, None, None, cli_overrides=cli_overrides, no_bootstrap=no_bootstrap)
            elif c == "6": return run_stop(port)
            elif c == "q": return 0
            else:
                print(f"无效: {c}", file=sys.stderr)
                time.sleep(1)


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