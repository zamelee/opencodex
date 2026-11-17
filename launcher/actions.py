"""动作注册表。

一个动作 = 一次（或一串）`ocx-start.py` 的参数化调用。
CLI 那边是唯一入口，这里只负责把界面上的选择翻译成参数。

对应 CLI 菜单：
    [1] 启动   → start      [2] 停止 → stop      [3] 状态 → status
    [4] init   → init（M3，图形向导还没做，先不进菜单）
    [5] 清理   → clean      [6] 升级 → upgrade（tag / origin/main 二选一）
"""

from __future__ import annotations

from .paths import python_argv, repo_root


def _cli_args() -> list[str] | None:
    """能调用 ocx-start.py 的命令前缀；没有就返回 None（走降级）。"""
    py = python_argv()
    root = repo_root()
    if not py or not root:
        return None
    return py + [str(root / "ocx-start.py")]


def _start_steps(ctx: dict) -> list[str]:
    """启动：把界面上的参数翻译成 ocx-start.py 的 flag。"""
    base = ["--background"]
    port = ctx.get("port")
    if port:
        base += ["--port", str(int(port))]
    host = (ctx.get("hostname") or "").strip()
    if host:
        base += ["--hostname", host]
    preset = (ctx.get("preset") or "").strip()
    if preset:
        base += ["--preset", preset]
    lm = (ctx.get("launcher_mode") or "").strip()
    if lm in ("true", "false"):
        base += ["--launcher-mode", lm]
    # GUI 没有 stdin 可喂：端口被占就自动换一个，别卡住
    base += ["--port-conflict", "auto"]
    return base


def build_actions(ctx: dict) -> list[dict]:
    """按当前表单值生成动作清单。"""
    cli = _cli_args()
    proxy = (ctx.get("git_proxy") or "").strip()

    def step(*args: str) -> list[str]:
        return list(args)

    upgrade_common = step("--upgrade")
    if proxy:
        upgrade_common += ["--git-proxy", proxy]

    actions: list[dict] = []
    if cli:
        actions += [
            {
                "id": "start",
                "label": "启动服务",
                "hint": "后台启动，端口冲突时自动换",
                "cli": cli + _start_steps(ctx),
            },
            {
                "id": "restart",
                "label": "重启服务",
                "hint": "先停再起",
                "cli": cli + step("--stop"),
                "then": cli + _start_steps(ctx),
            },
            {
                "id": "stop",
                "label": "停止服务",
                "hint": "停服务并恢复原生 Codex",
                "cli": cli + step("--stop"),
            },
            {
                "id": "status",
                "label": "查看状态",
                "hint": "proxy status",
                "cli": cli + step("--status"),
            },
            {
                "id": "clean",
                "label": "清理 dist",
                "hint": "删除 dist 与 gui/dist",
                "cli": cli + step("--clean"),
                "confirm": "会删除 dist 和 gui/dist，确定继续？",
                "danger": True,
            },
            {
                "id": "upgrade_tag",
                "label": "升级 · 最新 tag",
                "hint": "从 GitHub 拉最新 tag 并重建",
                "cli": cli + upgrade_common + step("--upgrade-target", "tag"),
            },
            {
                "id": "upgrade_main",
                "label": "升级 · origin/main",
                "hint": "跟踪 origin/main 最新提交",
                "cli": cli + upgrade_common + step("--upgrade-target", "main"),
            },
        ]
    else:
        actions.append(
            {
                "id": "no_cli",
                "label": "找不到 ocx-start.py",
                "hint": "请在仓库目录里启动本程序，或设置 OCX_ROOT",
                "disabled": True,
            }
        )

    actions += [
        {
            "id": "open_dash",
            "label": "打开仪表盘",
            "hint": f"http://127.0.0.1:{ctx.get('port') or 10100}/",
            "builtin": "open_dash",
        },
        {
            "id": "open_config",
            "label": "打开配置目录",
            "hint": "~/.opencodex",
            "builtin": "open_config",
        },
        {
            "id": "autostart",
            "label": "开机自启",
            "hint": "写入当前用户的 Run 项",
            "builtin": "autostart",
            "toggle": True,
        },
    ]
    return actions
