# opencodex 图形启动器

托盘常驻 + 内嵌控制台窗口，用来替掉 `ocx-start.py` 的命令行菜单。
它只是壳：每个动作都对应一次 `ocx-start.py` 的参数化调用，业务逻辑仍然只在 CLI 里。

## 源码运行

```bash
python -m launcher.main            # 窗口 + 托盘
python -m launcher.main --tray-only  # 只驻留托盘
python -m launcher.main --root D:\Documents\VibeCoding\opencodex
```

## 打包

```bat
launcher\build.bat
```

产物：`launcher\dist\opencodex-launcher.exe`（`--windowed`，不弹命令行框）。

## 目录

| 文件 | 作用 |
|---|---|
| `main.py` | 入口：单实例锁、web 服务、内嵌窗口、托盘 |
| `app.py` | 状态中枢 + aiohttp 路由 + 开机自启注册表 |
| `actions.py` | 动作注册表（对应 CLI 菜单） |
| `runner.py` | 子进程执行（`CREATE_NO_WINDOW`，无黑框） |
| `status.py` | 读 `~/.opencodex/runtime-port.json` + `/healthz` 探测 |
| `paths.py` | 仓库根、Python 解释器、配置目录定位 |
| `tray.py` | 右下角图标与菜单 |
| `web/` | 内嵌控制台页面（原生 JS，无框架） |

## 非交互开关

GUI 没有 stdin 可喂，所以 `ocx-start.py` 加了三个 flag：

- `--port-conflict {prompt,auto,abort}`：端口被占时自动换（GUI 用 `auto`）
- `--upgrade-target {tag,main}`：升级目标，不进交互询问
- `--git-proxy <addr|->`：升级用的代理，`-` 表示直连

## 开机自启

写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\opencodex-launcher`。

## 已知限制

- `--init` 图形向导还没做（CLI 的 `--init` 仍可用）
- 单实例锁用命名互斥体 `Local\OpenCodex-Launcher-Singleton`
