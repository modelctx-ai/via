# 0016. `via serve`：以 stdio MCP server 暴露七个元工具

- 状态：已接受
- 日期：2026-10-21

## 背景

via 的前提是 agent 有 shell（[ADR 0001](0001-mcp-for-providers-cli-for-consumers.md)）。没有 shell 的 agent（Claude Desktop、多数 IDE 的聊天面板、托管型 agent）只能挂 MCP，于是又回到「所有工具 schema 预先注入」。[愿景](../overview/vision.md#适用边界)里对这类场景的建议是「仍需 MCP；可考虑网关的懒加载元工具」，[待定问题](../open-questions.md)里留着「是否做 `via serve`」，顾虑是与网关的角色重叠（[ADR 0002](0002-standalone-client-not-gateway.md)）。

这些 agent 能挂的 MCP server 本来就在 via 的目录里。只要 via 自己以 MCP server 的身份出现，暴露少量固定的元工具，它们就能用上同样的按需发现，上下文里只多几个工具定义，而不是全部 server 的 schema。

约束：

- 不能变成网关：不监听网络端口，不做多用户、按 key 的权限划分和审计（ADR 0002）。
- 不能出现第二套语义：命名、参数解析、`deny`、危险操作确认、脱敏、渲染、截断与游标必须与 CLI 完全一致，否则规范要写两遍、测试要做两套。
- 不能绕过人的确认：`via trust`、`via auth login` 这类需要人在终端里完成的操作不能交给模型。
- 框架配置里登记的 `via serve` 会被 via 自己读到（[ADR 0003](0003-read-only-framework-configs.md)），不能递归拉起自己。

## 决策

新增内置子命令 `via serve`：以 **stdio** 传输运行一个 MCP server，生命周期跟随父进程（stdin 关闭即退出）。它只暴露七个工具，覆盖 CLI 的浏览、搜索、调用、续读与 MCP 资源和 prompt 命令：

| 工具 | 参数 | 等价的命令 |
| --- | --- | --- |
| `via_browse` | `path`（可选）：`""`、`<provider>`、`<provider> <resource>` 或 `<provider> <resource>:<verb>` | `via [path…]`；指向单个动作时等价于 `via <provider> <resource>:<verb> -h` |
| `via_find` | `query`（必填） | `via find <query>` |
| `via_call` | `tool`（必填，单字符串引用 `<provider>/<resource>:<verb>`）、`args`（对象，可选）、`yes`（布尔，可选） | `via call <tool> --args <json> [--yes]` |
| `via_more` | `cursor`（必填） | `via more <cursor>` |
| `via_resources` | `provider`（必填） | `via resources <provider>` |
| `via_read` | `provider`、`uri`（必填） | `via read <provider> <uri>` |
| `via_prompts` | `provider`（必填）、`name`（可选）、`args`（字符串值的对象，需要 `name`） | `via prompts <provider> [<name> --args <json>]` |

- **实现即 CLI**：每次工具调用都在进程内执行一次 CLI 命令（`run(argv, env)`，与测试驱动 CLI 的方式相同），捕获 stdout 与 stderr。daemon、缓存、凭证解析、脱敏全部照旧，`via serve` 自身不持有 MCP 会话。
- **结果**：stdout 作为第一段文本；stderr（元信息行、警告、错误与 `next:` 提示）非空时作为第二段文本；退出码非 0 时 `isError: true`，并在 `structuredContent.exitCode` 里给出退出码（[output.md](../spec/output.md) 的取值）。
- **提示语法**：`next:` 提示保持 CLI 的写法；server 在 `initialize` 的 `instructions` 里说明对应关系（`via <provider>` → `via_browse`，`via call` → `via_call`，以此类推）。不为 serve 改写提示文本，避免两套输出。
- **参数不能变成选项**：每个字符串参数成为命令行里的一个词，以 `-` 开头的值一律拒绝（否则 `query: "--yes"` 会被当成全局选项）；`via_browse` 的第一个词是内置子命令名时拒绝（否则 `path: "trust"` 会运行 `via trust`）。工具参数整体以 JSON 交给 `--args`，其中的字符串不受影响。这些拒绝的结果与 CLI 的用法错误相同：退出码 2，不运行任何命令。
- **不暴露的能力**：`trust`、`auth`、`daemon`、`prompt`、`sync`、`batch`、`doctor`、`servers`。前几个需要人在终端里完成或会改变本机状态；`batch` 在 MCP 里由客户端并发调用 `via_call` 代替；诊断类命令给人看，不给模型。以后需要时追加工具，不改变已有工具的语义。
- **危险操作**：`via_call` 的 `yes` 与 CLI 的 `--yes` 等价，由 agent 决定是否传；`deny` 规则对 serve 同样生效。这与 agent 在 shell 里能做的事一致，不更宽也不更窄。
- **工作目录**：项目级配置与 roots 按 `via serve` 进程的工作目录（父进程拉起它时的目录）计算，信任规则不变：未经 `via trust` 的项目级 server 不出现。
- **防递归**：读取框架配置时，命令行是 via 自己的 `serve` 的条目（`serve` 之前的某个词是 `via`、`via.exe`、`via.cmd`、`via.js` 之类的入口，或 `@modelctx-ai/via` 包名）不进入目录，`via servers` 列出一条 info 级诊断。这是预期的配置（用户就是这样把 via 接进框架的），所以不在 `via doctor` 里告警。
- **保留名**：`serve` 加入内置子命令，名为 `serve` 的 provider 需要用 `alias` 改名（[cli.md](../spec/cli.md#内置子命令)）。
- **工具列表固定**：七个工具的定义不随目录变化，`tools/list_changed` 从不发出；目录的变化体现在 `via_browse` 的输出里。

## 备选方案

- **透传所有下游工具（聚合代理）**：等于又把全部 schema 注入上下文，而且是网关的职责（ADR 0002）。
- **单个 `via` 工具，参数是命令行字符串**：定义最小，模型也认得 CLI 语法；但参数需要 shell 风格分词，引号与转义在 JSON 里再套一层，出错时难以说清是哪一层的问题，也让「不暴露的子命令」只能靠黑名单。有类型的工具更容易校验，也更容易在客户端的权限界面里逐个放行。
- **只给四个工具（浏览、搜索、调用、续读），resources 与 prompts 以后再加**：定义少约 300 token，但 0.3 已经把 MCP 资源和 prompt 做成 CLI 命令，serve 缺了它们，没有 shell 的 agent 就用不到这部分能力。
- **把 resources、prompts 映射成 MCP 原生的 resources、prompts**：要把下游的 URI 与名字改写成 via 的命名空间并处理订阅，也会让 serve 声明 `tools` 之外的能力；以工具形式提供与 CLI 一一对应，更简单。
- **HTTP 传输**：需要监听端口、鉴权调用方，正是网关该做的事。
- **为 serve 单独实现渲染（例如返回结构化 JSON）**：两套输出格式会分叉；需要 JSON 的场景以后可以在 `via_call` 上加 `output: "json"`，仍走 CLI 的 `-o json`。

## 后果

- 没有 shell 的 agent 也能按需发现工具。七个工具定义约 730 token（`tools/list` 结果按 4 字节一 token 估算），`instructions` 约 150 token；对照 0.1 token 基准里原生注入的每轮约 11,455 token。
- serve 不引入新的输出格式、错误码或命名规则；cli.md 新增 `via serve` 一节，config.md 补充防递归的诊断，agent-integration.md 新增「没有 shell 的 agent」一节，愿景的适用边界表随之更新，`open-questions.md` 移除该条。
- 每次工具调用都新建一次 CLI 运行（加载配置、目录缓存），耗时与一次 CLI 调用相近但省去进程启动；stdio server 的会话由 daemon 复用，与 CLI 相同。
- `serve` 成为保留字，影响恰好名为 `serve` 的 server（需要 `alias`）；CHANGELOG 写明。
- 安全边界与 CLI 相同：serve 不比 shell 里的 agent 多拿到任何能力，也不提供隔离；需要隔离与审计时仍然在 via 背后接网关。
