# HA Gateway（高可用 LLM 网关）规格说明

版本：v0.1（实现基线）　状态：已与需求方对齐，按本文档实现

## 1. 目标

给 Codex（以及任何 OpenAI 兼容 / Anthropic 兼容客户端）提供一个本机前置的高可用网关。下游只需连一个地址、持一把网关签发的 key；网关背后挂多路上游（各自的 provider、各自的 api key），任一路故障时在下游无感的前提下切换到另一路。

核心约束：

1. 切换必须发生在下游尚未收到任何响应字节之前；一旦下游已提交，就不再切换，改为把错误如实归一化后返回。
2. 网关对下游只暴露 LLM 三协议（openai-responses / openai-chat / anthropic），不提供任何管理 API，管理只走 GUI。
3. 单进程 + 托盘常驻，关窗口不杀网关。

## 2. 架构

    上游 A（provider + key1）   上游 B（provider + key2）   上游 C（provider + key3）
              |                         |                         |
              +------------+------------+------------+
                           |
                    [ HA Gateway ]
        粘性路由 / 健康状态 / 预提交缓冲 / 故障转移 / 日志
                           |
                    下游 key（sk_own_*，多把）
                           |
                         Codex

上游在上、网关居中、下游在下。GUI 用连线式流程图表达同一结构：上游节点（可多个）汇聚到网关节点，网关分叉到多个下游 key 节点。

## 3. 凭据

两层凭据，互不混用：

| 层 | 形态 | 存储 |
|---|---|---|
| 下游 | 网关自签 sk_own_<16hex> | SQLite 明文（仅本机） |
| 上游 | provider 的真实 api key | SQLite + DPAPI 加密 |

hop-by-hop 头部必须从下游请求里剥离后再转发上游：host、connection、keep-alive、proxy-authenticate、proxy-authorization、te、trailer、transfer-encoding、upgrade、content-length。

下游的 authorization 一律替换为上游 key，不转发下游原始凭据。

DPAPI：Windows 用 ctypes 调 CryptProtectData / CryptUnprotectData；非 Windows 退化为明文存储并在日志里打一条显著警告。

## 4. 协议

全局三选一，所有上游与下游必须同协议：openai-responses（默认，POST /v1/responses）、openai-chat（POST /v1/chat/completions）、anthropic（POST /v1/messages）。

endpoint registry（禁止通配）：网关按注册表精确匹配路径，不使用 startswith("/v1/") 这类前缀匹配，否则 /v1/responses/../admin 之类会被误路由。

### 4.1 openai-responses

| 下游路径 | 上游路径 | 说明 |
|---|---|---|
| POST /v1/responses | POST /v1/responses | 转发，SSE 原样透传 |
| GET /v1/responses/{id} | GET /v1/responses/{id} | 单条查询 |
| DELETE /v1/responses/{id} | DELETE /v1/responses/{id} | 删除 |
| POST /v1/responses/compact | POST /v1/responses/compact | 压缩 |

### 4.2 openai-chat

| 下游路径 | 上游路径 |
|---|---|
| POST /v1/chat/completions | POST /v1/chat/completions |
| GET /v1/models | GET /v1/models |

### 4.3 anthropic

| 下游路径 | 上游路径 |
|---|---|
| POST /v1/messages | POST /v1/messages |
| POST /v1/messages/count_tokens | POST /v1/messages/count_tokens |
| POST /v1/messages/batches | POST /v1/messages/batches |
| GET /v1/messages/batches/{id} | GET /v1/messages/batches/{id} |

## 5. 故障转移

### 5.1 传输阶段

每个上游尝试都被标记阶段，决定还能不能换人：

| 阶段 | 含义 | 可否切换 |
|---|---|---|
| NOT_SENT | 尚未发出（连接失败、池耗尽） | 可以 |
| PARTIALLY_SENT | 已写出部分请求体 | 可以，上游多半是坏的 |
| FULLY_SENT | 请求体写完，未收到响应 | 可以 |
| UPSTREAM_RESPONSE_STARTED | 上游已开始回包但未提交给下游 | 视规则 |
| DOWNSTREAM_COMMITTED | 已向下游写出首个字节 | 不可以 |

### 5.2 两个总开关

1. 已提交后重试（可勾选）：默认关。勾选后 UI 弹窗要求手输 OK，勾选框转红底红字警示。若开启且请求已进入 DOWNSTREAM_COMMITTED 且上游中断，网关会终止本次流并让下游感知到断流（由客户端重试），而不是静默补数据。
2. 已开始吐字后断流（可勾选）：默认关。开启后允许在已提交后换上游重放，仅非流式请求可安全重放，流式请求重放会导致内容重复。

### 5.3 预提交缓冲

上游响应到达后，网关先把首个响应块读进内存缓冲，判断它是错误还是正常：5xx 可切换；429 可切换（这是上游限流，不是下游的问题）；4xx（除 429）不可切换，属于请求本身的问题，直接归一化返回；2xx 提交给下游。

预提交等待预算：最多 15 秒。超时则直接提交给下游并留在当前上游，不再换人（避免为了更优而拖慢用户）。

### 5.4 错误归一化

网关能救的故障，一律返回 502（Codex 只重试 5xx 与传输错误）；绝不把上游 429 / 400 / 403 直接透传给下游，否则 Codex 不会重试，一次限流就把整个对话打死。

归一化后的错误体形如 {"error":{"type":"upstream_error","message":"...","code":"upstream_5xx"}}。

### 5.5 切换预算

每请求最多切换 2 次（最多尝试 3 台上游）；排除集里的上游不再尝试；超过预算返回 502。

## 6. 防横跳

四层，缺一不可：

1. 会话粘性：同一会话优先回到上次成功的上游。
2. 健康迟滞：连续 3 次失败判死，连续 5 次成功才恢复（防抖）。
3. 最小驻留：切换后至少驻留 30 秒，期间不因健康抖动再切。
4. 每请求预算：单请求最多 2 次切换。

## 7. 健康状态机

每个上游三个状态：HEALTHY / DEGRADED / DOWN。

判定只用 time.monotonic()，不受系统时间跳变影响。主动探活间隔 3 秒（正负 0.3 秒抖动），超时 2 秒；探活走独立的 aiohttp session，不与业务连接池互相拖累。被动判定来自业务请求的真实返回码，主动判定来自探活。手动探测按钮发一个最小 1-token 请求，UI 明写可能计费。

健康检查是纯本地往返，不计费；只有手动按钮那条真实请求计费。

## 8. 会话键

优先级（取第一个能算出来的）：x-codex-turn-metadata 里的 thread_id → x-codex-parent-thread-id → x-codex-turn-state → x-codex-window-id → x-codex-installation-id → x-codex-routing-hint → 下游 api key。

命名空间：sha256(protocol + "|" + key_material)，只存哈希不存原文。

两张映射表：session_routes（会话键 → 上游 id）、response_routes（response_id → 上游 id，用于后续单条查询粘到同一上游）。

上游列表变化时的迁移：比较新旧集合，相同 id 的保留绑定，新 id 的按健康度选，被删掉的释放绑定。迁移用 CAS（比较并交换），避免并发请求互相覆盖。

同一 provider + 同一把 key 的两路上游不特殊处理：可能重复扣费，但需求方已确认接受。防横跳由上面四层兜底。

## 9. 取消传播

下游断开（客户端取消、用户停止生成）必须立刻中止上游请求：捕获 ConnectionResetError / ClientDisconnected，立刻 release 上游响应或关闭连接；并在超时与取消之间做二次检查，防止已取消却还在等超时。

## 10. GUI

### 10.1 拓扑图

上游节点在上排，网关节点居中，下游 key 节点在下排。连线：上游到网关为汇入，网关到下游为分出。活跃通路上有流动光点动画。点击节点弹出该节点详情，管理面板入口在节点右键菜单。

### 10.2 规则面板

checkbox 明示哪些状态参与自动切换，勾选即参与，未勾即跳过：

| 组 | 项 | 默认 |
|---|---|---|
| A | 连接失败 / DNS 失败 | 参与 |
| B | 上游 5xx | 参与 |
| C | 上游 429（限流） | 参与 |
| D | 上游 4xx（除 429） | 不参与 |
| E | 已提交后断流 | 不参与 |

### 10.3 日志

默认展开。自动跟随滚动：checkbox 勾选时开启；人为拖动查看时自动取消，窗口尺寸变化不算拖动（用 scroll 事件与 resize 事件区分）。时间戳格式 [2026-11-10 00:13:39.824]，同一毫秒内的事件合并为一条，不逐行打戳。

## 11. 参数默认值

| 参数 | 默认 |
|---|---|
| 监听端口 | 10110 |
| 监听地址 | 下拉：回环 / 本机某个 IP / 全域 0.0.0.0 |
| 预提交等待预算 | 15 秒 |
| 上游读超时 | 300 秒 |
| 上游连接超时 | 10 秒 |
| 每请求最大切换 | 2 |
| 最小驻留 | 30 秒 |
| 探活间隔 / 超时 | 3 秒 / 2 秒 |
| 判死 / 恢复阈值 | 连续 3 败 / 连续 5 成 |
| 粘性 TTL | 24 小时 |
| 协议 | openai-responses |

## 12. 存储

SQLite，单文件 ha-gateway.db，位于用户数据目录。

    upstreams(id, name, provider, base_url, api_key_enc, protocol, enabled, weight, created_at)
    client_keys(id, label, key_hash, key_prefix, enabled, created_at)
    session_routes(session_key, upstream_id, updated_at)
    response_routes(response_id, upstream_id, updated_at)
    rules(rule_group, rule_key, enabled)
    settings(key, value)
    events(id, ts, level, kind, message, detail)

## 13. 已知局限

1. 流式请求在 DOWNSTREAM_COMMITTED 后不能无缝换人，只能让下游感知断流。
2. 会话粘性用哈希做键，不解出原文，因此无法把旧会话迁移到语义等价的新会话，只能靠 Codex 每轮自带完整历史这一事实兜底。
3. 上游真实 api key 的 DPAPI 密文绑定当前 Windows 用户，换用户不可解。
