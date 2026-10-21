# 0017. MCP 协议版本：新版本优先，自动回退，可以固定

- 状态：已接受
- 日期：2026-10-21

## 背景

via 锁定的 `@modelcontextprotocol/sdk` 1.x 最高协商到 `2025-11-25`。MCP 的 `2026-07-28` 把协议改成无状态：没有 `initialize` 握手，没有 server 端会话和会话 ID，每个请求自己带版本、客户端信息和能力，变更通知改为 `subscriptions/listen` 流，server 在 `server/discover` 里宣布支持的版本。官方 SDK 里只有 v2（`@modelcontextprotocol/client`）实现了它。新版协议的 server 会越来越多，旧版 server 在很长时间里仍是大多数；via 的用户不应该为此写配置，旧版 server 上的行为也不该变。

约束：

- 浏览命令的冷启动不变，SDK 仍只在要连接时才加载（[实现说明](../development/implementation.md#启动速度)）。
- 不为特定 server 适配（[ADR 0007](0007-no-gateway-specific-adaptation.md)）：协议差异按版本处理，不按 server 处理。
- via 对列表、资源、prompt 的结果一直是宽松取用（一个畸形条目不让整次操作失败），不因升级 SDK 变严。

## 决策

**迁移到官方 SDK v2**（client 与 server 两个包），旧的 1.x 只留作测试用的模拟 server（[实现说明](../development/implementation.md#mcp-sdkv2)）。

**默认新版本优先，自动回退。** 建立连接时先探测（`server/discover`），server 给出 `2026-07-28` 就按无状态协议谈，探测被拒绝就在同一条连接上用 `initialize` 握手。探测被拒绝（4xx 或 JSON-RPC 错误）不是错误；401/403 是鉴权问题，5xx 与网络错误照常报告。细节与 daemon 的行为见 [daemon.md](../spec/daemon.md#协议版本与无状态连接)。

**stdio 的探测代价用缓存记录消除。** SDK 在 server 进程的副本上探测（多启动一个进程，探测完才启动真正的进程），这对启动慢或启动有副作用的旧版 stdio server 不可接受。目录缓存因此记下上次协商出的版本；记录是旧版协议且缓存新鲜时直接握手、不探测，握手失败（超时除外）再探测一次。daemon 里同一会话重连沿用上次结果。

**`protocolVersion` 固定版本，不支持就报错，不回退。** 面向两种人：需要绕过某个 server 在新协议上的缺陷的人，和要求无状态部署的人。字段在 `servers.<name>` 下，取值是 SDK 支持的版本；退出码 6，`next:` 说明去掉或改值。

**可见。** `via servers`（读缓存里记下的）与 `via doctor`（实时）显示协商出的版本与连接是否有状态。「有状态」的定义：无状态协议的连接无状态；旧协议下 stdio 进程本身是会话，HTTP 只有 server 分配了会话 ID 才有状态。

**缓存提示取较短者，`0` 不算提示。** 无状态协议的 `tools/list` 结果可带 `ttlMs`；正数与 24 小时取较短。SDK 构造的 server 默认发 `ttlMs: 0`，如果照字面当作「立刻过期」，浏览命令每次都要连接 server，这与目录缓存存在的理由相反，所以 `0` 与缺省一样沿用 24 小时。

**通知。** 旧协议是 server 推送的 `notifications/tools/list_changed`，新协议是 `subscriptions/listen` 流上的事件；两者进 daemon 刷新目录的同一个入口。SDK 不会在流意外断开后重订，via 自己带退避重订，并在重订成功后立即刷新一次（断开期间可能错过事件）。

**roots、日志。** 新协议里 server 通过 `input_required` 向 client 要 roots，SDK 用 via 注册的同一个处理器应答，配置与声明条件不变（[ADR 0010](0010-mcp-resources-prompts-and-roots.md)）。`logging/setLevel` 被新协议去掉；via 在任何版本上都不发它。

## 备选方案

- **等 1.x 支持新协议**：1.x 已进入维护，没有这个计划；via 会一直停在 `2025-11-25`。
- **只在配置里开启新协议（opt-in）**：用户要知道每个 server 的协议版本才能配置，而 via 的前提是用户不关心这些；新版 server 多起来后默认关闭只会让大家都要写配置。
- **自己实现 `server/discover` 与无状态请求**：要复制 SDK 的版本协商、`Mcp-Method` 等请求头、`input_required` 的多轮重试，每次协议修订都要跟；SDK 是这些的权威实现。
- **对 stdio 完全不探测，只讲旧协议**：最省事，但永远用不上只讲新协议的 stdio server。保留探测，并用缓存把旧版 server 的代价降到零。
- **`ttlMs: 0` 按字面当立刻过期**：见上，会让浏览命令失去不连接的能力；真想让目录常新的 server 发正数，或用 `list_changed`。

## 后果

- 进程内模式（无 daemon）的一次调用慢约 50 ms，daemon 常驻内存多几 MiB（SDK v2 更大，数字见实现说明）。热 daemon 的调用开销不变。
- 第一次连接一个缓存为空的 stdio server 要多启动一个进程（探测的副本），之后的连接不再多。
- v2 的 HTTP 传输默认只跟随同源重定向，via 保持这个默认（重定向到别处报错并给出目标地址）。
- 测试对两代协议各跑一遍（[testing.md](../development/testing.md#两代协议)）；SDK 升级时，协议版本常量的单测会提示 via 保存的版本列表已经漂移。
- 配置里新增 `protocolVersion`；`ProtocolInfo`（`{ version, stateful }`）进入目录缓存、daemon 的 `list` 应答和 `status`。
