# 0024. `via serve` 暴露任务、技能与补全：两个新元工具，其余是已有工具的可选参数

- 状态：已接受
- 日期：2026-10-22

## 背景

[ADR 0016](0016-via-serve-meta-tools-over-stdio.md) 把 `via serve` 的元工具定为固定的七个，并写明「以后需要时追加工具，不改变已有工具的语义」。之后的三个功能各自留了一句「serve 这次不新增」：

- `via tasks`、`--detach`（[ADR 0020](0020-tasks-and-skills-commands.md)）：经 `via_call` 的调用已经会跟随任务到结果，但 `--detach` 与任务管理需要 shell。
- `via skills`（ADR 0020）：没有对应的工具。
- `--complete`（[ADR 0021](0021-server-self-description-and-completion.md)）：`via_prompts` 的 `args` 能表达参数，补全没有入口。

没有 shell 的 agent 因此用不到这三块。路线图把「`via serve` 暂不暴露这些命令」列为 e4、e6、e9 的后续。这一篇回答：加哪些工具、参数怎么写、长任务在 MCP 的一次工具调用里怎么不阻塞。

约束沿用 ADR 0016：每次调用就是一次 CLI 命令，不出现第二套语义；参数不能变成选项；`trust`、`auth` 等需要人的命令不暴露。另有两条：

- **工具定义要小。** 每个工具的定义都在每一轮对话里（`tools/list` 约 2.9 KB 即 730 token）。
- **elicitation 在 serve 下一律拒绝**（[ADR 0018](0018-elicitation-in-a-terminal-declined-elsewhere.md)）：任务进入 `input_required` 时 via 本来就不回答，不需要 serve 的特殊处理。

还有一个 MCP 的现实：不少 client 给一次工具调用的时限约 60 秒（官方 SDK 的请求默认值就是 60 秒），超时后 client 放弃，调用的结果（包括任务 ID）丢失。via 的缺省 `timeout` 也是 60 秒，所以「等到 server 的超时」在 serve 下可能恰好赶在 client 放弃的同一刻。

## 决策

**新增两个工具，共九个；补全并入已有的 `via_prompts` 与 `via_resources`。**

| 工具 | 新的参数 | 执行的命令 |
| --- | --- | --- |
| `via_skills`（新） | `provider`（必填）、`name`、`file`（需要 `name`） | `via skills <provider> [<name> [<file>]]` |
| `via_tasks`（新） | `provider`、`task`（二者至少一个）、`action`（`status` 或 `cancel`）、`timeout`（秒） | `via tasks <provider>`；`via tasks <provider>/<id>` 或 `via tasks <provider> <id>`，加 `--status`、`--cancel` 或 `--timeout` |
| `via_call` | `detach`（布尔）、`timeout`（秒） | 追加 `--detach`、`--timeout <秒>` |
| `via_prompts` | `complete`（参数名，需要 `name`） | 追加 `--complete <参数>`；已写出的值在 `args` 里 |
| `via_resources` | `template`、`args`（字符串值的对象）、`complete`（`template` 与 `complete` 同时给） | `via resources <provider> <template> [--args <json>] --complete <变量>` |

- **`via_skills`、`via_tasks` 是新工具，因为它们是新的命令**，参数形状与已有的七个都不同；塞进 `via_resources` 之类会让一个工具承担互不相干的几件事，描述也说不短。
- **补全不另开工具。** 它是 `via prompts` 与 `via resources` 的一个选项，输入就是那两条命令已有的参数加一个变量名；再开一个 `via_complete` 要多一份定义（约 300 字节）并重复 `provider`、`name`/`template`、`args`。代价是 `via_resources` 的定义长了一些，它的语义（不给 `template` 就是原来的列表）没有变。
- **`via_tasks` 的任务写法**：`task` 可以直接是 `--detach` 打印的带前缀的 ID（`gh/job/1`，此时 `provider` 可省），也可以是 `next:` 提示里的两词写法（`provider: "gh"`, `task: "job/1"`）。只写 `task` 而没有 `/` 时拒绝，不猜 provider。`task` 以 `-` 开头仍按 ADR 0016 的规则拒绝。
- **仍不暴露**：`trust`、`auth`、`daemon`、`prompt`、`sync`、`batch`、`doctor`、`servers`。`via_browse` 的第一个词是 `skills` 或 `tasks` 时拒绝，与其他内置子命令相同。
- **提示的对应关系**：`initialize` 的 `instructions` 增加 `via skills|tasks` → `via_skills`、`via_tasks`，`--complete`、`--detach`、`--timeout` → 同名参数；并说明超时的调用不会被取消，用 `via_tasks` 继续。

**不把 `--detach` 作为 serve 的缺省。**

- `--detach` 在 server 或工具不支持任务时是错误（退出码 2），而绝大多数调用不是任务。把它设为缺省，普通的调用就都失败；先试 detach 失败再同步重来，则会让「写操作被发了两次」成为可能，也让一次调用变成两次往返。
- agent 多数时候要的是结果；缺省的同步调用在任务很短时一次往返就拿到，与 CLI 的缺省一致（[ADR 0020](0020-tasks-and-skills-commands.md) 不选「默认 detach」的理由对 agent 同样成立）。
- 所以 `detach` 是 `via_call` 上的**显式参数**，由知道这是长任务的 agent 传，不满足时得到与 CLI 相同的错误和 `next: rerun without --detach`。

**等待受 `timeout` 约束，`via_tasks` 的缺省等待是 30 秒。**

- `via_call` 不传 `timeout` 时与 CLI 完全一致（server 的 `timeout`，缺省 60 秒）。传 `timeout`（秒）就是 `--timeout`：到点时任务**不被取消**，退出码 6，`next: via tasks <provider> <ID>` 对应 `via_tasks`；这个错误本身就是把任务 ID 交还给 agent 的方式。
- `via_tasks` 的整个作用就是等，所以缺省值要保证它在 client 放弃之前返回：不传 `timeout` 且是「等结果」（没有 `action`）时，serve 追加 `--timeout 30`。agent 想等更久就传更大的 `timeout`，或者收到退出码 6 后再调一次。`status`、`cancel` 与列表是单次请求，不加缺省，仍按 server 的 `timeout`。
- 这是 serve 唯一不同于 CLI 缺省的一处。它不改变命令的语义，只是 serve 帮调用方填了一个 CLI 用户在命令行里会自己写的 `--timeout`。
- `input_required` 的任务照旧：via 不回答，停止等待，退出码 1，`next: via tasks <provider> <ID> --cancel`，对应 `via_tasks` 的 `action: "cancel"`。

## 备选方案

- **把 serve 的 `via_call` 缺省设为 detach，失败再同步重试**：见上，重复副作用与两次往返。
- **给所有 `via_call` 加一个 serve 的缺省 `timeout`（例如 45 秒）**：会截断配置了更长 `timeout` 的慢 server 的同步调用，而这些调用不是任务、被截断后什么也找不回。只对 `via_tasks` 的等待设缺省，因为那里「超时」的含义是明确的（任务继续跑，随时可以回来取）。
- **一个 `via_task` 工具，另加 `via_task_wait`、`via_task_cancel`**：为任务拆三个工具，定义约多 400 字节，换来的只是 `action` 一个枚举。
- **把 skills 并入 `via_resources`**：技能的核对、`files:` 行、候选歧义都是 `via skills` 自己的行为，不是资源的读取；也会让一个工具的描述变成「资源、模板、补全或技能」。
- **补全做成 `via_complete`**：见上。
- **用 MCP 的进度通知把 `progress:` 行实时发给 client**：能让长调用看起来在动，但 serve 现在捕获输出、一次返回，改成流式是另一个方向的改动；退出码 6 加 `via_tasks` 已经能覆盖长任务。
- **在 serve 里回答 `input_required`**：需要 elicitation 的往返，ADR 0018 已决定非交互一律拒绝。

## 后果

- 工具从七个变成九个：`tools/list` 约 4.6 KB（约 1,150 token，原来约 730），`instructions` 约 0.7 KB；测试把上限从 3.6 KB 放宽到 4.8 KB。增加的部分里约七成是两个新工具的定义，其余是已有工具上的新参数。没有长任务、技能、补全需求的 agent 为此多付约 420 token；需要时可以在 client 里只放行用得到的工具。
- ADR 0016 的「七个工具」改为本篇的九个；其余（实现即 CLI、结果形态、参数不能变成选项、不暴露的命令、防递归、工具列表固定）不变。ADR 0020 与 0021 里「`via serve` 不新增元工具」的句子已被取代，以本篇为准。
- 渲染没有新格式：新工具的输出与对应的命令逐字相同，测试对每个新工具与 CLI 输出做等价比较，并用快照钉住工具定义与 `instructions` 的文字。
- 新参数 `detach`、`timeout`、`complete`、`template`、`action` 都是可选的，不传时已有工具的行为与之前完全相同。
- `timeout` 是正数秒；`via_tasks` 对 `status`、`cancel`、列表传 `timeout` 时只影响向 server 提问的时限。
