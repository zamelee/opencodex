#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
opencodex 启动脚本（Python / 跨平台）

用法（不带参数 → 进交互菜单）：

  python ocx-start.py                     交互菜单
  python ocx-start.py --foreground        前台启动（Ctrl+C 停）
  python ocx-start.py --background        后台启动（shell 立刻返回）
  python ocx-start.py --init-and-start    首次：init + 前台启动
  python ocx-start.py --init              只 init（交互填 provider / api key）
  python ocx-start.py --with-shim         装 codex-shim + 跑代理（自启动模式）
  python ocx-start.py --stop              停服务并恢复原生 Codex
  python ocx-start.py --status            看状态
  python ocx-start.py --clean             清 dist / gui/dist
  python ocx-start.py --port 8080         改端口（默认 10100）
  python ocx-start.py --help              帮助

后台日志：项目根目录下 ocx.out.log / ocx.err.log
"""

import argparse
import shutil
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


def health_ok(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/healthz", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def show_state(port: int) -> None:
    init = is_initialized()
    run  = health_ok(port)
    print()
    print("=" * 40)
    print("  opencodex 面板")
    print("=" * 40)
    print(f"  配置     : {'已初始化' if init else '未初始化'}")
    print(f"  进程     : {'运行中' if run else '未运行'}")
    if run:
        print(f"  面板地址 : http://localhost:{port}")
    print(f"  默认端口 : {port}")
    print("=" * 40)
    print()


def run_cli(*args: str) -> int:
    cmd = [BUN, "run", "src/cli/index.ts", *args]
    print(f"[run] {' '.join(cmd)}")
    try:
        return subprocess.call(cmd, cwd=str(ROOT))
    except KeyboardInterrupt:
        return 0
    except FileNotFoundError:
        print("[err] 找不到 bun，请先安装 Bun 并把它加到 PATH", file=sys.stderr)
        return 127


def run_init() -> int:
    print("[init] 打开交互模式（会问 provider / api key）...", file=sys.stderr)
    return run_cli("init")


def run_start() -> int:
    print("[start] 前台启动（Ctrl+C 停）。", file=sys.stderr)
    return run_cli("start")


def run_background(port: int) -> int:
    print("[bg] 后台启动中...", file=sys.stderr)
    if not is_initialized():
        print("[bg] 未发现 config.json，先 init...", file=sys.stderr)
        rc = run_init()
        if rc != 0 or not is_initialized():
            print(f"[bg] init 失败 (exit={rc})", file=sys.stderr)
            return rc or 1

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

    try:
        proc = subprocess.Popen(
            [BUN, "run", "src/cli/index.ts", "start"],
            cwd=str(ROOT),
            stdout=out_fp,
            stderr=err_fp,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
        )
    except FileNotFoundError:
        print("[err] 找不到 bun", file=sys.stderr)
        return 127

    print(f"[bg] 后台 PID: {proc.pid}", file=sys.stderr)
    print(f"[bg] stdout : {out_log}", file=sys.stderr)
    print(f"[bg] stderr : {err_log}", file=sys.stderr)
    print("[bg] 等待 5 秒看是否起来...", file=sys.stderr)
    time.sleep(5)
    show_state(port)
    if health_ok(port):
        print(f"[bg] 起来了。打开 http://localhost:{port}", file=sys.stderr)
        return 0
    print("[bg] 似乎没起来。看 stderr 找原因：", file=sys.stderr)
    if err_log.exists():
        with err_log.open("r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= 30:
                    break
                print(line, end="")
    return 1


def run_shim_then_start() -> int:
    print("[shim] 装 Codex 自启动垫片...", file=sys.stderr)
    rc = run_cli("codex-shim", "install")
    if rc != 0:
        return rc
    print(file=sys.stderr)
    return run_start()


def run_stop(port: int) -> int:
    print("[stop] 停服务并恢复原生 Codex...", file=sys.stderr)
    rc = run_cli("stop")
    time.sleep(1)
    show_state(port)
    return rc


def run_status() -> int:
    return run_cli("status")


def run_clean() -> int:
    print("[clean] 删 dist ...", file=sys.stderr)
    for d in ("dist", "gui/dist"):
        p = ROOT / d
        if p.exists():
            shutil.rmtree(p)
            print(f"  已删除 {p}", file=sys.stderr)
    return 0


def main_menu(port: int) -> int:
    while True:
        show_state(port)
        print("请选择启动方式（直接回车 = 1 前台）：")
        print()
        print("  [1] 前台运行（最常用）")
        print("  [2] 后台运行（shell 立刻返回）")
        print("  [3] 装 codex-shim + 前台跑")
        print("  [4] 首次：init + 前台启动")
        print("  [5] 只跑 init（交互）")
        print("  [6] 停服务")
        print("  [7] 看 status")
        print("  [8] 清 dist")
        print("  [q] 退出")
        print()
        try:
            c = input("选项 > ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        if   c in ("", "1"): return run_start()
        elif c == "2":       return run_background(port)
        elif c == "3":       return run_shim_then_start()
        elif c == "4":
            if is_initialized():
                print(f"[init] 已发现 {CONFIG}，跳过 init", file=sys.stderr)
            else:
                rc = run_init()
                if rc != 0 or not is_initialized():
                    print("[init] init 后仍未生成 config，终止", file=sys.stderr)
                    return rc or 1
            return run_start()
        elif c == "5":       return run_init()
        elif c == "6":       return run_stop(port)
        elif c == "7":       return run_status()
        elif c == "8":       run_clean()
        elif c == "q":       return 0
        else:
            print(f"无效: {c}", file=sys.stderr)
            time.sleep(1)


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="ocx-start.py",
        description="opencodex 启动面板",
        add_help=False,
    )
    parser.add_argument("--foreground", action="store_true", help="前台运行（默认）")
    parser.add_argument("--background", action="store_true", help="后台运行（shell 立刻返回）")
    parser.add_argument("--init", action="store_true", help="只跑 init")
    parser.add_argument("--init-and-start", action="store_true", help="首次：init + 启动")
    parser.add_argument("--with-shim", action="store_true", help="装 codex-shim + 启动")
    parser.add_argument("--stop", action="store_true", help="停服务")
    parser.add_argument("--status", action="store_true", help="看状态")
    parser.add_argument("--clean", action="store_true", help="清 dist / gui/dist")
    parser.add_argument("--port", type=int, default=10100, help="端口（默认 10100）")
    parser.add_argument("-h", "--help", action="store_true", dest="show_help")
    ns = parser.parse_args()

    if ns.show_help:
        print(__doc__)
        return 0
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
        return run_start()
    if ns.with_shim:  return run_shim_then_start()
    if ns.background: return run_background(ns.port)
    if ns.foreground: return run_start()

    return main_menu(ns.port)


if __name__ == "__main__":
    sys.exit(main())
