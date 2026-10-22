# 0020. tasks 与 Skills：两个内置子命令，像 `via resources` 与 `via prompts` 一样按 provider 取用

- 状态：已接受
- 日期：2026-10-21

## 背景

路线图 e4（tasks）与 e6（MCP Skills 扩展）都要给 via 增加协议里的新东西，命令形态一直留在[待定问题](../open-questions.md)里：是新增内置子命令（名字成为保留字），还是像 `via resources`、`via prompts` 一样按 provider 取用；任务 ID 带不带 provider 前缀。两者与 [ADR 0010](0010-mcp-resources-prompts-and-roots.md) 面对的是同一个问题，约束也相同：

- 命令语法是 `via <provider> <resource>:<verb>`（[ADR 0005](0005-command-grammar-provider-resource-verb.md)），任务 ID、技能 URI 都不适合放进以冒号标明工具的语法。
- 不为特定 server 适配（[ADR 0007](0007-no-gateway-specific-adaptation.md)）。
- 新增能力不应让 `via prompt` 生成的说明变长；浏览命令不加载 SDK。

**tasks** 有两代协议里两种形态：`2025-11-25` 的核心协议（实验性）与 `2026-07-28` 的 `io.modelcontextprotocol/tasks` 扩展。

| | 2025-11-25（核心） | 2026-07-28（扩展） |
| --- | --- | --- |
| 谁决定建任务 | client：`tools/call` 带 `task: {}`，工具要声明 `execution.taskSupport`（`optional`/`required`），server 要声明 `capabilities.tasks.requests.tools.call` | server：声明扩展，client 在请求里声明扩展，server 对任何 `tools/call` 都可以回一个任务（`resultType: "task"`） |
| 查询 | `tasks/get`（只有状态）、`tasks/result`（阻塞到结束，返回工具结果） | `tasks/get`（`completed` 时内联 `result`，`failed` 时带 `error`，`input_required` 时带 `inputRequests`） |
| 列出 | `tasks/list`（server 声明 `tasks.list` 时） | 没有；client 只知道自己建的任务 |
| 取消 | `tasks/cancel` 返回任务 | `tasks/cancel` 只回执，取消是协作式的，任务可能还在 `working` |
| 时间字段 | `ttl`、`pollInterval`（毫秒） | `ttlMs`、`pollIntervalMs` |

SDK v2 对两者都只有词汇，没有运行时：类型化方法不提供 `tasks/*`，2026 的解码器拒绝 `resultType: "task"`，所以 via 要自己发请求，并在响应解码前把任务取出来。

**Skills** 只存在于 `2026-07-28`：server 声明 `io.modelcontextprotocol/skills` 扩展，`skills/list` 与 `skills/get` 返回条目（`SKILL.md` 的 URI、frontmatter 里的 `name` 与 `description`、文件清单 `resources`——每个文件的 URI、`sha256:` 摘要与字节数，或字符串 `"dynamic"`），内容用普通的 `resources/read` 取。扩展要求 host 在使用内容前按清单核对。

## 决策

**两个新的内置子命令，保留字 `skills` 与 `tasks`。**

```text
via skills <provider>                          列出 server 发布的技能
via skills <provider> <名称>                   读技能的 SKILL.md
via skills <provider> <名称> <文件>            读技能的某个附属文件
via tasks <provider>                           列出任务
via tasks <provider> <任务ID>                  等任务结束并输出结果（`--status` 只看状态）
via tasks <provider> <任务ID> --cancel         取消任务
```

- 与 `resources`、`prompts` 同形：第二个参数是 provider（唯一前缀、大小写、`-`/`_` 宽松），只读的 `skills` 没有 `--yes`/`--dry-run`/`deny` 的含义；`tasks` 只作用于已经存在的任务。名叫 `skills` 或 `tasks` 的 server 需要用 `alias` 改名，规则同其他内置子命令，记入 CHANGELOG。
- 输出走现有的[渲染流水线](../spec/output.md)：预算、游标、媒体落盘、脱敏与元信息行不变，没有新的输出格式。
- `via serve` 这次**不**新增元工具：集合固定为七个（[ADR 0016](0016-via-serve-meta-tools-over-stdio.md)）。工具调用经 `via_call` 同样会跟随任务到结果，`--detach` 与任务管理需要 shell。有人需要时另开 ADR。

**tasks：工具调用默认跟随到结果，`--detach` 立即返回。**

- 默认：调用照常，server 建了任务（2026 由 server 决定；2025 只在工具声明 `taskSupport: required` 时 via 才去要，`optional` 的工具照旧同步调用）就轮询到结束，期间用 `progress:` 行报告任务 ID，最后输出与同步调用一致。整个过程受 `--timeout`（缺省为 server 的 `timeout`）约束；超时时任务**不被取消**，报错（退出码 6）给出任务 ID 和 `next: via tasks <provider> <任务ID>`，用同一个命令继续等。
- `--detach`（全局选项）：任务创建后立即返回，输出 `task: <provider>/<任务ID>` 与 `status:`，`next:` 指向 `via tasks`。2026 的 server 可以不建任务而直接回结果，这时照常输出结果并在元信息行标 `no task`。server（2025 还要加上工具）不支持任务时 `--detach` 是错误，不悄悄改成同步调用——它的意图就是不阻塞。
- 任务 ID 的**对外写法带 provider 前缀**：`gh/9f3a…`，与单字符串的工具引用 `gh/issue:read` 同一个约定。`via tasks` 两种写法都接受（`via tasks gh 9f3a…`、`via tasks gh/9f3a…`）：先把第一个参数当 provider 解析，不成再按第一个 `/` 拆开。任务 ID 是 server 给的不透明字符串，可能含 `/`，所以只拆第一个。命令行里的 `next:` 提示用两词写法，ID 按[引号规则](../spec/output.md#可粘贴的命令行)引用。
- 有 `input_required` 状态的任务（server 要 client 回答问题）：**via 回答 elicitation**，然后继续跟随（初版不回答，停下并给出 `--cancel`；补充于 2026-10-22，没有改变上面的任何决定，所以不另开 ADR）。跟随一个任务的命令（调用的默认路径、`via tasks <provider> <任务ID>` 的等待）就是被问的人，规则与调用中途的提问相同（[ADR 0018](0018-elicitation-in-a-terminal-declined-elsewhere.md)）：有终端就提问，没有（`via batch`、`via serve`、agent 经 shell）就回答 `decline`，任务继续，结果里说明（退出码 0 加 `warning:`，或任务因此失败为 5）。`--detach`、`--status` 与任务列表**不**提问：只显示状态，`next:` 是 `via tasks <provider> <任务ID>`，在终端里运行它即回答。两代协议的做法不同，都得到支持：
  - `2025-11-25`：任务在 `input_required` 时 client 调 `tasks/result`。它一直阻塞到任务结束，server 的 `elicitation/create` 请求沿同一条连接发给 client，由 via 注册的同一个处理器交给当前命令的 `ElicitSink`，`tasks/result` 最后返回任务的结果。`tasks/result` 失败而任务已经结束（失败的任务用请求的错误回答它）时取任务状态，按失败任务输出。
  - `2026-07-28`：`tasks/get` 在 `input_required` 时带 `inputRequests`（键 → `{method, params}`，与 `tools/call` 的 `input_required` 里嵌的请求同形）。client 用 `tasks/update` 回答：`{taskId, inputResponses}`，键与请求相同，值是请求的结果本身（elicitation 的 `{action, content?}`，不包 `{method, result}` 信封），之后继续轮询 `tasks/get`。SDK 2.3.1 没有 `tasks/update` 的类型（它只在 `Mcp-Name` 请求头的映射里出现），via 经 `request()` 自己发；同一个键只回答一次。
  - 只回答 `elicitation/create`。任务等的是别的请求（`sampling/createMessage`：via 不声明 sampling；`roots/list`：任务里不回答），或没有可答的请求时，仍然停止、退出码 1、`next:` 为 `--cancel`。
- **via 自己的记录**：2026 的扩展没有 `tasks/list`，所以 `via tasks <provider>` 只能列出 via 建的任务。记录放在用户缓存目录的 `tasks/<server 哈希>/`（哈希同目录缓存键，绑定 server 定义而不是别名），每个任务一个小文件（权限 0600，目录 0700）：任务 ID、规范写法的工具引用、创建时间、最近一次看到的状态；**不含参数与结果**。任务一创建（`progress:` 行同时）就写，所以跟随被中断也找得回；每个 server 最多 50 个、最长 30 天，超出时写入时清理。它是缓存：删掉只会失去「列出」，已知 ID 的 `via tasks <provider> <ID>` 照常工作。2025 的 server 声明了 `tasks.list` 时列表取自 server（并按 ID 补上记录里的工具名），否则同样用记录。列表对记录里的每个任务（最近 20 个）向 server 要当前状态，server 已不认识的标 `expired` 并从记录里删除。
- 任务 ID 相当于凭证（扩展里它就是访问任务的凭据）：不进元信息行里的名称；记录文件的权限同缓存目录。

**Skills：先核对，再显示。**

- 只在 `2026-07-28` 且 server 声明了扩展时才发请求；否则退出码 3，说明是协议版本不够还是没声明扩展，不发 `skills/*`。浏览视图的 `also:` 行在 server 声明时多一项 `via skills <provider>`（与 resources、prompts 同一个入口）。
- 核对在**会话层**做，不在 CLI：daemon 会替换返回内容里的凭证，替换后摘要就对不上了。会话层先 `skills/get` 取最新条目、再 `resources/read` 取文件，比较字节数与 `sha256`；文件不在清单里、大小或摘要不符一律**拒绝**，退出码 6（server 与自己的清单矛盾），不输出任何内容。核对通过后才轮到脱敏和渲染。
- `"dynamic"` 清单没有可核对的东西：照常显示，stderr 警告「could not be checked」。
- 名称按名字或路径匹配（`refunds`、`acme/refunds`），也接受 URI；名字只是标签，两个技能同名时不挑一个，列出候选（退出码 3）。列表里没有而 server 仍能服务的技能，用约定的 `skill://<名称>/SKILL.md` 再试一次。
- 附属文件名相对技能目录，`..` 与目录外的路径拒绝（退出码 2）；清单完整时不在清单里的文件不是这个技能的文件，不发请求（退出码 3，列出可用的文件）。

## 备选方案

- **做成工具语法的一部分**（`via <provider> task:get`）：任务 ID 与技能 URI 含冒号和斜杠，与 [ADR 0010](0010-mcp-resources-prompts-and-roots.md) 否定这条路的理由相同。
- **任务查询放进 `via call`/`via batch`**：这两个是「调用工具」，任务查询没有工具引用。
- **每个 server 一个 `via <provider> tasks`**：与 `resource:verb` 的解析顺序冲突（`tasks` 可能是某个 server 的资源名）。
- **任务 ID 不带前缀**：`--detach` 的输出被 agent 或脚本带到别处时，不知道该问哪个 server；单字符串前缀与已有的工具引用一致，成本只是多几个字符。
- **默认 detach**：agent 多数时候要的是结果，多一步 `via tasks` 就多一轮对话；同步调用的语义保持不变，需要异步时显式 `--detach`。
- **记录放在 daemon 里**：进程内模式与 daemon 回退时看不到；记录写在 CLI 一侧，两种模式一致，daemon 重启也不丢。
- **记录放配置/数据目录**：它是可重建的缓存，不是用户数据；放缓存目录，让「清缓存」的人得到预期的结果。
- **超时后取消任务**：超时只说明 via 不再等，不说明任务该死；取消是破坏性动作，要用户说。
- **在 CLI 里核对技能**：daemon 的脱敏会改变内容，核对要么失败要么得绕开脱敏；放在会话层，核对看到的是 server 发来的原字节。
- **同时核对 `SKILL.md` 的 frontmatter 与条目一致**（mcpc 做了）：需要 YAML 解析器，这次不做；大小与摘要已经保证内容就是清单发布的那一份。

## 后果

- 新的保留字 `skills`、`tasks`：叫这两个名字的 server 在改名（`alias`）之前不出现在任何视图里。
- 全局选项 `--detach` 成为需要 `--p.` 前缀的参数名（同 `--full`、`--yes`、`--complete`）；用在没有工具调用的命令上退出码 2。
- `ServerFeatures` 多一个可缺省的 `skills`；daemon 协议的 `call` 多 `detach`、`taskSupport` 和 `task` 事件，另有 `task`、`skills-list`、`skill-read` 请求；`McpClient` 多对应的方法。SDK 在首次连接时才加载，冷启动不变；`io.modelcontextprotocol/tasks` 在 client 能力里声明（所有连接，所有请求），所以 2026 的 server 可能把任何调用变成任务，via 总是跟随它。
- 任务相关的 `tasks/*` 请求经 SDK 发出（`Mcp-Name` 请求头由 SDK 设置），响应解码前由 via 的小垫片取出 `resultType: "task"`，SDK 提供自己的扩展 API 后可以删掉。
- 附带的限制：只回答 `input_required` 里的 elicitation（见上）；2026 的 `notifications/tasks/status` 不实现（轮询足够），`tasks/update` 只用来送回 elicitation 的答案；`tasks/list` 的分页取全。
