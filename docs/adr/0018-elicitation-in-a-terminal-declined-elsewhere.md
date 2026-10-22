# 0018. elicitation：终端里交互回答，其他情形一律拒绝并说明

- 状态：已接受
- 日期：2026-10-21

## 背景

MCP 的 elicitation 让 server 在一次调用的中途向用户要输入：`2025-11-25` 里是 server 发给 client 的 `elicitation/create` 请求（表单模式：按一个扁平的 JSON Schema 填字段；URL 模式：请用户去一个网页完成授权或支付之类的事），tools/call 也可以用错误 `-32042`（`URLElicitationRequired`）要求 client 先完成 URL 模式再重试；`2026-07-28` 里同样的请求不再是独立的 JSON-RPC 请求，而是嵌在调用结果的 `input_required` 里，client 回答后重试（[ADR 0017](0017-protocol-versions-newest-first-with-fallback.md)，roots 已经是这个形态）。server 会越来越多地用它做「确认」「补一个参数」「去浏览器授权」。

via 的调用是一次性的 CLI 命令，调用方常常是 agent，没有人在场；同一条路径也经 daemon 转发，daemon 没有终端。三个问题要回答：

- 谁来回答？agent 不应该替用户回答 server 向**用户**提的问题（授权、确认），也不应该看到 server 以为只有用户看得到的文字当作指令之外的东西来执行。
- 没有人时怎么办？`via serve`、`via batch`、管道里的 stdin、agent 经 shell 调用都没有终端。
- daemon 里的调用怎么把问题交到发起调用的那个 CLI 进程？

[ADR 0010](0010-mcp-resources-prompts-and-roots.md) 把 elicitation 列为「不做」（当时认为它需要反向询问用户，与一次一命令的模型不合）；本篇取代这一句，其余不变。

约束：

- 不为特定 server 适配（[ADR 0007](0007-no-gateway-specific-adaptation.md)）。
- via 不调用模型（[ADR 0011](0011-find-synonym-expansion-and-optional-embeddings.md) 的原则），所以**不声明 `sampling`**：server 的 `sampling/createMessage` 在 via 眼里是一个没有声明的能力。
- 凭证不出现在任何输出里；server 的文字是不可信数据（[security.md](../spec/security.md)）。
- CLI 冷启动不受影响：提示界面只在真有 elicitation 时才加载。

## 决策

**always 声明 `elicitation`（表单与 URL 两种模式），按调用的环境决定怎么处理。** 能力是会话级的（daemon 里一个会话服务多个 CLI 进程），不能按调用开关；不声明的话 server 退回它自己的无交互路径，用户却看不到「这里本来有一个要你确认的问题」。声明之后：

- **交互终端**（stdin 与 stderr 都是 TTY，且不是 `via serve`、`via batch`）：在 stderr 上提示。先写明是**哪个 provider** 在问、这段文字**来自 server**（不是 via 写的），文字经脱敏、控制字符与转义序列显示为可见的 `\uXXXX`。表单按 schema 逐字段提问（字符串、数字、整数、布尔、单选与多选枚举），校验类型、范围、长度、`format`，无效就重问；最后在 stdin 上 `accept`（默认）、`decline`、`cancel` 三选一。输入结束与重试次数用尽按 `cancel`（输入结束时各字段取默认值，最后一问没有默认，所以不会被当成同意）；`Ctrl-C` 照常结束整条命令。
- **非交互**：回答 `decline`，调用继续。调用的结果带上「server 问过用户、没有终端可答」：成功的调用在元信息行之前给一条 `warning:` 和一条 `next:`；调用以 `isError` 结束（或 server 在协议层拒绝）时，退出码改为 **5**，错误第一行写明 provider 问过用户，`next:` 是 `ask the user to run this in a terminal: <原命令行>`。
- **退出码 5 而不是新码**：output.md 里 5 的含义是「被拒绝」，其中已经包括「危险操作缺少 `--yes`」与「`via trust` 没有得到确认」，即「这一步需要一个人的明确同意，而现在没有」；elicitation 与它们同一类，`next:` 的写法也与 `via trust` 没有终端时一致。不发明新码，因为脚本关心的是「要不要找人」，5 已经表达了这一点。调用成功（server 在被拒绝之后仍给出结果）则退出码保持 0。

**URL 模式只打开 `http(s)`，规则与 OAuth 回调相同**（[auth.md](../spec/auth.md#流程)）：完整 URL 与主机名（IDN 以 punycode 显示）总是先打印，由用户确认后才打开，从不自动打开；平台打开命令与 OAuth 共用（Windows 用 `rundll32 url.dll,FileProtocolHandler`，不经 `cmd.exe`）；其他 scheme、带用户名密码的 URL 直接 `decline`；SSH 会话、无显示器时不尝试打开，只打印让用户自己打开。`accept` 只表示「用户同意去做这件事」，via 不知道也不检查用户是否完成。

**daemon：问题经 socket 交给发起调用的 CLI，答案从同一条连接回来。** `call` 请求带 `elicit: "interactive" | "decline"`（这个 CLI 是否有终端），daemon 在 `call` 的会话里登记一个应答人；server 提问时 daemon 向该请求发一个 `elicit` 事件（已脱敏的请求），CLI 提示用户后用新的 `elicit-reply` 请求把答案送回，daemon 转给 server。连接断开、调用结束、期限到时，未答的问题按 `cancel` 处理。同一会话上同时有几个调用时，协议无法说明是哪个调用引出的提问：交给最早的、有终端的调用；一个都没有终端就拒绝，并通知最早的调用。daemon 不弹窗、不读自己的 stdin。

**答案与问题的内容不进日志。** 日志只记「在 provider X 上有一次表单/URL 提问、字段个数、结果是 accept/decline/cancel」（[ADR 0019](0019-per-server-logs-rotated-and-redacted.md)）。用户键入的答案只发给提问的 server，不写盘、不进 daemon 的日志。

**`--timeout` 仍然约束整个调用，包括用户作答的时间。** SDK 的请求超时无法暂停；提示里显示剩余时间，到期按 `cancel`，再由调用本身报超时。需要更多时间时加大 `--timeout`。

## 备选方案

- **非交互时不声明 `elicitation`，让 server 走它自己的退路**：会话是共享的，daemon 里无法按调用声明；而且 server 的退路常常是「报错：缺少参数」，agent 看不到「这里需要用户」的信号。声明加拒绝能给出明确的 `next:`。
- **非交互时让 agent 回答（例如读 `--elicit '{"name":"x"}'`）**：server 问的是用户。确认类问题由 agent 自答等于绕过确认，与 `--yes` 需要显式开启的立场相反。以后若有需要，可以加一个显式的、按字段名预填的选项，但不是默认行为。
- **新增退出码**：见上，5 已经是「需要一个人」。
- **daemon 里自己弹终端/系统对话框**：daemon 是分离的后台进程，没有终端，弹窗要平台相关的原生代码，且回答的人未必是发起调用的人。
- **把 daemon 里的调用降级为进程内再问**：调用已经发出，server 在等；重来会重复副作用。

## 后果

- 每个 server 会看到 via 声明了 `elicitation`；只在非交互里行为是「被拒绝」。`via serve` 的调用方拿到的是带 `next:` 的 `isError` 结果，由 agent 转告用户。
- 新增 daemon 协议项：`call.elicit`、事件 `elicit`、请求 `elicit-reply`（[daemon.md](../spec/daemon.md)）。版本握手保证两端一致，不需要兼容层。
- 一致性测试的 `elicitation-sep1034-client-defaults` 场景由适配器在伪终端里回车接受默认值来驱动，不是靠一个绕过终端的开关，所以实现与用户看到的一致；它从 `expected-failures.yml` 中移除。
- 不实现：`notifications/elicitation/complete`（URL 模式完成通知；via 不等待，用户回来后 server 自己继续）、任务相关的 elicitation（随 tasks，路线图 e4）。
