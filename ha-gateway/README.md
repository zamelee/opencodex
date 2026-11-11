# 乾坤机枢（HA Gateway）

本机前置的高可用 LLM 网关。下游（Codex 等）只连一个地址、持一把网关签发的 key；
网关背后挂多路上游（各自的 provider、各自的 api key），任一路故障时在下游无感的前提下切换。

> 命名取自武侠里的「机关枢纽」：乾坤为势，机枢为枢——正是主备两路互为犄角的意象。

![拓扑](docs/HA-GATEWAY-SPEC.md)

## 快速开始

```bat
run.bat
```

或打包成单文件 exe：

```bat
build.bat
```

产物是 `dist\HA-Gateway.exe`（约 55 MB，onefile）。运行后：

- 弹出一个**内嵌窗口**（Edge WebView2）就是管理页，不再外开浏览器；
- 关窗口只是隐藏到系统托盘，网关继续跑；
- 托盘菜单：打开管理页 / 退出；
- 单实例：重复启动会提示「乾坤机枢 已经在运行了」；
- 没装 WebView2 Runtime 的机器自动降级为系统浏览器打开管理页。

exe 用正式配置目录（`%APPDATA%`），和 `dev.bat` 的临时库**不互通**。

首次使用：

1. 「上游」页添加上游：名称、Provider、Base URL、API Key。
2. 「下游 Key」页生成一把 `sk_own_*`，填进 Codex 的 `~/.codex/config.toml`：

   ```toml
   [model_providers.ha]
   name = "乾坤机枢"
   base_url = "http://127.0.0.1:10110/v1/"
   env_key = "HA_GATEWAY_KEY"
   wire_api = "responses"
   ```

3. Codex 侧设置 `HA_GATEWAY_KEY=sk_own_...` 后重启 Codex。

## 网页管理界面

除了桌面窗口，网关还自带一个网页管理界面，**独立端口、只监听本机**：

    http://127.0.0.1:10111

页面里有拓扑图、右侧单页管理面板（上游 / 下游 Key / 故障转移规则 / 网关设置）和事件日志，
点节点可以就地编辑。改 UI 时用浏览器直接调，比截图快得多。

调试模式（无控制台、临时数据库）：

```bat
dev.bat
```

LLM 转发端口 10110 与管理端口 10111 分开，管理端口不会暴露到局域网。

## 设计要点

- **切换只发生在下游收到首个响应字节之前**。一旦提交，就不再换人。
- **错误归一化**：能救的故障一律回 502（Codex 只重试 5xx 与传输错误），
  上游的 429 / 400 不会被直接透传下去打死对话。
- **endpoint registry 精确匹配**，不用路径前缀通配，防止路径穿越式误路由。
- **四层防横跳**：会话粘性、健康迟滞（3 败判死 / 5 成恢复）、最小驻留 30 秒、
  单请求最多切换 2 次。
- **上游 key 用 Windows DPAPI 加密**落库，下游 key 只存哈希。
- **单进程 + 托盘常驻**：关窗口不杀网关。

完整规格见 [docs/HA-GATEWAY-SPEC.md](docs/HA-GATEWAY-SPEC.md)。

## 协议

全局三选一：`openai-responses`（默认）/ `openai-chat` / `anthropic`。
所有上游与下游必须同协议。

## 测试

```bat
python -m pytest tests -q
```
