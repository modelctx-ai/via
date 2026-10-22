# 命令规范

命令按 provider → 资源 → 动作三级组织，形如 `via linear issue:create`。每一级前缀本身就是一条合法的浏览命令，敲到哪一级就看到哪一级的内容；冒号标明「这是一个工具」，它后面的都是参数。设计理由见 [ADR 0005](../adr/0005-command-grammar-provider-resource-verb.md)。

## 语法

```text
via                                       状态 + 每个 provider 一行，带工具数
via <provider> [--all]                    该 provider 的资源，动作内联列出
via <provider> <resource>                 该资源下每个动作一行，带参数签名
via <provider> <resource>:<verb> -h       用法
via <provider> <resource>:<verb> [参数]   调用
via <provider> <tool>                     调用无法拆分的叶子工具
via resources <provider>                  列出该 server 的 MCP 资源与资源模板
via read <provider> <uri>                 读取一个 MCP 资源
via prompts <provider> [<名称> [参数]]    列出 MCP prompt；带名称时取该 prompt
via skills <provider> [<名称> [<文件>]]   列出 MCP 技能；带名称时读 SKILL.md，再带文件时读该附属文件
via tasks <provider> [<任务ID>]           列出任务；带任务 ID 时等它结束并输出结果（`--status`、`--cancel`）
via <provider> <工具> … --detach          调用工具，任务一创建就返回任务 ID
via <provider> -h                         provider 视图，前面加上 server 的自述（instructions、description）
```

中间三行不属于 `provider → 资源 → 动作` 的层级：MCP 资源按 URI 寻址，URI 自带冒号（`file:///a.txt`），不能放进以冒号标明工具的语法里，所以它们是独立的内置子命令（[ADR 0010](../adr/0010-mcp-resources-prompts-and-roots.md)）。文档里的「MCP 资源」与工具名拆出的「资源（resource）」不是一回事，见[术语表](../overview/glossary.md)。

各级视图的输出格式见 [discovery.md](discovery.md#浏览视图)。

### 解析顺序

1. 第一个参数先匹配内置子命令；匹配不上则按 provider 解析。
2. provider 之后的第一个参数：
   - 含 `:` → 工具引用，其后全部是工具参数；
   - 不含 `:` 且匹配某个资源 → 浏览该资源；
   - 不含 `:` 且匹配某个叶子工具或原始名 → 调用该工具；
   - 目录里资源与叶子工具不会同名（[naming.md](naming.md) 规则 7）：同名时叶子改用原始名；原始名也相同时资源让出名字。所以 provider 视图 `tools:` 行列出的每个名字都能直接调用。
3. 都匹配不上时，不执行任何调用，输出候选或 did you mean，退出码 3。

## 为什么是这种形状

- **与模型熟悉的 CLI 同构**：`gh issue create`、`kubectl get pods`、`heroku apps:create` 都是这种层级，模型见得最多。
- **前缀即目录**：不需要单独的 `ls`，逐级补全就是逐级发现。
- **资源与动作用冒号连接**：`via linear issue create "标题"` 里分不清 create 是动作还是位置参数；`issue:create` 一眼可知是工具。
- **不引入分类层**：provider 就是配置里的 server，直接按名字列出。给它们套一层推断出来的分类（曾经的「域」）既不稳定也不必要，见 [ADR 0014](../adr/0014-drop-the-domain-view.md)。

## 内置子命令

| 命令 | 作用 |
| --- | --- |
| `via find <查询> [-n 10]` | 跨 provider 搜索工具，每条结果带参数签名 |
| `via call <provider>/<resource>:<verb> --args '{…}'` | 显式调用，参数为 JSON、`@文件` 或 `-`（stdin），供脚本使用 |
| `via more <游标>` | 续读被截断的结果 |
| `via batch [--concurrency <n>]` | 从 stdin 读 JSONL，并发调用，结果按输入顺序输出（[见下](#via-batch)） |
| `via servers` | 列出 server、来源文件、传输方式、鉴权状态与备注 |
| `via auth login <provider> [--manual]`<br>`via auth status [<provider>]`<br>`via auth logout <provider>` | OAuth 登录、状态、登出；`login --manual` 用于无头环境；`grant: client_credentials` 的 server 不需要登录，`login` 只验证凭据（[auth.md](auth.md)） |
| `via trust [路径] [--dry-run]`、`via trust <路径> --yes` | 显示并信任项目级配置文件；`--list` 列出记录，`--revoke <路径>` 撤销（[security.md](security.md#via-trust)） |
| `via sync [provider]` | 强制刷新工具目录缓存 |
| `via doctor` | 检查连接与鉴权，检测各框架挂载的 MCP 并输出关闭提示 |
| `via prompt [--skill] [--out <文件> \| --check <文件>] [--replace]` | 生成给 agent 的说明与 provider 列表；`--out` 只刷新带标记的块，`--check` 比对是否过期；`--skill` 改为输出整份 `SKILL.md` |
| `via resources <provider>` | 列出 MCP 资源与资源模板（[见下](#mcp-资源与-prompt-命令)） |
| `via read <provider> <uri>` | 读取一个 MCP 资源 |
| `via prompts <provider> [<名称> [参数]]` | 列出 MCP prompt；带名称时取该 prompt，参数写法同工具 |
| `via skills <provider> [<名称> [<文件>]]` | 列出 MCP 技能（`2026-07-28` 的 Skills 扩展）；带名称时读 `SKILL.md`，再带文件时读该附属文件，内容按 server 发布的清单核对后才输出（[见下](#技能via-skills)） |
| `via tasks <provider> [<任务ID>] [--status \| --cancel]` | 列出任务；带任务 ID 时等它结束并像工具调用一样输出结果，`--status` 只看状态，`--cancel` 取消（[见下](#任务via-tasks-与---detach)） |
| `via daemon status\|stop\|run\|logs` | 管理后台进程；`run` 供内部拉起使用；`logs` 查看日志（[daemon.md](daemon.md)） |
| `via serve` | 以 stdio MCP server 运行，向没有 shell 的 agent 暴露元工具（[见下](#via-serve)） |

内置子命令名是保留字，大小写不敏感，不接受前缀。provider 别名与之重名时（例如某个 server 叫 `find`），必须在配置里用 `alias` 改名，`via servers` 给出告警，该 server 在改名前不出现在任何视图里。

0.1 只实现 `find`、`call`、`more`、`servers`、`sync`、`doctor`、`prompt`；`batch`、`trust`、`auth`、`daemon` 自 0.2 起可用，`resources`、`read`、`prompts` 自 0.3 起可用，`serve`、`skills`、`tasks` 自 0.4 起可用（[路线图](../roadmap.md)）。`prompt`（给 agent 的说明）与 `prompts`（server 提供的 prompt）是两个命令；`via prompt` 带了 provider 时报用法错误并提示 `via prompts <provider>`。

各命令的细节：

- `via call`：`<provider>/<ref>` 按与命令行形式相同的规则解析（provider 与资源接受唯一前缀，原始名可用）；其后的参数交给工具参数解析器，`--args`、`@文件`、`-`（stdin）均可用。
- `via find`：没有命中时输出 `no tools match "<查询>"`；个别 provider 无法连接时照常搜索其余的，并在 stderr 警告哪些没有被搜索。用户配置了 `search.semantic` 时，stderr 可能多一行 `· semantic …` 元信息行（退回词法排序的原因，或第一次补全 embedding 缓存），退出码不变（[discovery.md](discovery.md#embedding-检索可选默认关闭)）。
- `via more`：只读游标，不加载配置和目录。游标先向已经在运行的 daemon 要（不会为此拉起 daemon），再看缓存目录（[daemon.md](daemon.md#daemon-持有的状态)）。
- `via daemon`：
  - `status`：不拉起 daemon，只询问正在运行的。输出一行概况、socket 路径和各会话（server 名、传输、`running (pid N)` / `connected` / `stopped`、目录中的工具数、调用数、空闲时间或在途数）；不含 URL、参数、凭证。socket 上没有 daemon 应答时（包括连得上却完不成握手，例如令牌不符，或 Windows 上收尾中的 daemon 的管道还被别的连接占着），再看 daemon 进程记录（[daemon.md](daemon.md#进程记录)）：有不在监听的 daemon 进程时每个一行，`daemon: starting · pid N`（还没绑定 socket）、`daemon: stopping · pid N · finishing requests in flight`（已收到 `shutdown`、删掉 socket，在处理在途请求）或 `daemon: not reachable · pid N`（socket 被删或被替换，几秒内自行退出），再加 `socket:` 一行；一个都没有才输出 `daemon: not running` 加 `socket:` 一行（完不成握手而又没有记录时，照旧报告连不上的原因）。有 daemon 应答而旁边还有别的 daemon 进程（例如上一个仍在收尾）时，概况之后追加 `also: stopping · pid N · …`。`VIA_NO_DAEMON` 打开时输出 `daemon: disabled (VIA_NO_DAEMON)`，退出码都是 0。`-o json` 输出 `{"running": true, …}`（字段同协议的 `status`）或 `{"running": false, "socket": …}`，有其他 daemon 进程时带 `processes: [{ pid, state }]`（`state` 为 `starting`、`running`、`stopping`）。
  - `stop`：结束这个 socket 的所有 daemon 进程，返回时它们都已退出。先向应答的 daemon 发 `shutdown`，给在途请求 5 秒处理完；仍未结束就发 `shutdown`（`force`），让它放弃在途请求（关闭会话、停止 stdio 子进程）立即退出。socket 上不应答的 daemon 进程（进程记录里的 `starting`、`stopping`）收到 `SIGTERM`，同样立即退出（Windows 上 `SIGTERM` 即结束进程，它的 stdio 子进程不随之结束，见 [daemon.md](daemon.md#windows)）。全部退出后输出 `daemon: stopped (pid N[, M…])`，放弃过在途请求时追加 `, requests in flight abandoned`；这些请求的 CLI 按「连接中断」处理（只读请求在进程内重做，其余以退出码 6 报告可能已执行）。没有 daemon 时输出 `daemon: not running`，退出码 0。某个进程 5 秒后仍未退出时退出码 7，`next: kill <pid>`。`-o json` 输出 `{"running": false, "pid"?: N, "stopped": [N, …], "abandoned"?: true}`。
  - `logs [<provider>] [-n <行数>] [--follow|-f] [--since <时长>]`：打印日志（[daemon.md](daemon.md#日志)）。不带 provider 是 daemon 自己的日志（`logs/daemon.log`），带 provider（与其他命令同样的唯一前缀、大小写宽松规则，找不到退出码 3 并给出候选）是该 server 的日志（stdio 子进程的 stderr、连接与协议事件、每次调用一行）。读文件，所以 daemon 没运行时、`VIA_NO_DAEMON=1` 下都能用（后者只有 server 的日志）。先输出最后 `-n` 行（默认 50，`-n 0` 一行不输出，常与 `--follow` 同用），从旧到新，轮转出的副本（`.1` 至 `.3`）也算在内；`--since` 只保留这段时间之内的行，时长写 `30s`、`10m`、`2h`、`1d`，可以连写（`1h30m`），无法解析或为 0 时退出码 2。`--follow` 在输出之后继续等新行（每 250 毫秒查看一次文件，跟随轮转，文件还不存在时等它出现），直到被 `Ctrl-C`（或 `SIGTERM`）中断，退出码 0。内容在写入时已脱敏，输出时控制字符再转义一遍；日志不存在时 stderr 写 `· no log yet for <provider> · <路径>`，stdout 为空，退出码 0。`-o json` 输出 JSON Lines：`{"time": "<ISO>", "source": "event|error|stderr", "text": "…"}`。
  - `run`：前台运行 daemon，由 CLI 分离拉起，也可手动运行。选项 `--socket <路径>`、`--idle-timeout <秒>`（缺省取配置的 `daemon.idleTimeout`）；已有 daemon 在这个 socket 上应答时输出 `daemon: already running on <路径>` 并以 0 退出。收到 SIGTERM/SIGINT/SIGHUP 时正常退出。
- `via servers`：每个 server 一行，依次为 provider、传输方式（HTTP 只写 scheme 与主机，stdio 只写命令）、协议（上次拉取目录时协商出的 MCP 协议版本和连接是否有状态，如 `2026-07-28 stateless`、`2025-11-25 stateful`；固定了版本的加 `(pinned)`，还没有记录时只有固定的版本，什么都没有写 `-`）、鉴权方式及凭证引用是否可解析（只写引用，不写值）、来源文件、备注（`disabled`、`untrusted`、框架间冲突、保留名冲突）；之后列出配置诊断。不连接任何 server（协议一列读的是目录缓存，缓存过期或被清掉后回到 `-`），也不执行 `cmd:` 凭证引用（[config.md](config.md#凭证引用)）。`untrusted` 的备注附 `via trust <路径>`（多个文件待确认时为 `via trust`）。配置里有 error 级诊断时照常显示，不中止。
- `via trust`：显示并记录对项目级配置文件的信任，也能列出、撤销记录；细节、确认方式和退出码见 [security.md](security.md#via-trust)。它读取配置但不连接 server，配置里有 error 级诊断时照常工作（不执行任何工具）。确认默认在终端里完成；`--yes` 只在带显式路径并设置 `VIA_ALLOW_NONINTERACTIVE_TRUST=1` 时有效。
- `via auth`：`login <provider> [--manual]`、`status [<provider>]`、`logout <provider>`，只用于 `auth: oauth` 的 HTTP server（provider 接受唯一前缀）。provider 未配置为 OAuth 退出码 2，并提示把 `servers.<name>.auth` 设为 `oauth`；项目级配置里未信任的 server 退出码 5（登录会把授权发往仓库指定的地址）。`login` 的等待时间默认 300 秒，`--timeout <秒>` 覆盖。其余行为见 [auth.md](auth.md#oauth)。
- `via sync`：向各 server（或指定的 provider）重新拉取 `tools/list` 并更新缓存，每个 provider 一行（`gh  14 tools` 或 `linear  needs auth: …`）；有失败时退出码取其中最大的，并在 stderr 提示 `next: via doctor`。
- `via doctor`：对每个 server 实时探测（不读缓存，成功后更新缓存），再输出检测结果；探测成功的 server 各占一行，写出这次协商出的协议版本与连接是否有状态（`github: MCP 2026-07-28 stateless`，固定了的加 `(pinned)`；之后一节 `proxy` 显示生效的代理（[config.md](config.md#代理)），紧接着一行 `logs` 写出日志目录和它占的空间（[daemon.md](daemon.md#日志)），[agent-integration.md](../guides/agent-integration.md#via-doctor检测与关闭提示)）；固定的版本 server 不支持时是连接失败，退出码 6；退出码取各项问题中最高的一个（见[退出码](output.md#退出码)）。
- `via prompt`：输出一段带标记的说明块，`<!-- via:begin … -->` 到 `<!-- via:end -->` 之间是说明本身与 provider 列表（按字母序，[agent-integration.md](../guides/agent-integration.md#via-prompt给-agent-的说明)）。
  - `--out <文件>`：路径相对当前目录。文件不存在时创建；已有标记块时只替换两个标记之间的内容，标记之外不动（输出 `· updated the via block in <文件> · N bytes`）；没有标记时追加到末尾、前面空一行（输出 `· appended to <文件> · N bytes`）；创建时输出 `· wrote <文件> · N bytes`。标记不成对或出现多对时拒绝，退出码 5，并提示手工修——位置猜错会写坏用户自己的文字。
  - `--check <文件>`：只比对不写入。块与当前输出一致时退出码 0，stderr 输出 `· <文件> is up to date`；没有标记块或内容过期时退出码 1，`next:` 为 `via prompt --out <文件>`；标记不可用退出码 5。
  - `--replace`：整份文件只留这个块（0.3 之前的 `--out` 行为），目标文件已存在时需要 `--yes`（退出码 5）。
  - `--out` 与 `--check` 不能同时给，`--replace` 必须配 `--out`，否则退出码 2。
  - `--skill`：不输出带标记的块，改为输出一份完整的 `SKILL.md`，供按技能目录加载说明的 agent 使用（[agent-integration.md](../guides/agent-integration.md#skillmd)）。内容是 YAML frontmatter（`name: via`、`description`、`allowed-tools: Bash(via:*)`）、一行生成标记 `<!-- generated by `via prompt --skill`; edits here are lost on refresh -->`，以及与标记块完全相同的正文（同一段文字，由同一个函数生成，不另写一份；没有 `via:begin`/`via:end` 标记）。`name` 固定为 `via`，框架通常要求它与存放目录同名（`…/via/SKILL.md`）。默认打印到 stdout；`--out`、`--check` 的路径由用户给出，via 不去找任何框架的技能目录，也不写框架的配置（[ADR 0003](../adr/0003-read-only-framework-configs.md)），不创建缺少的目录（目录不存在时退出码 2，`next: mkdir -p <目录>`）。因为 `SKILL.md` 是整份文件、不是嵌在用户文档里的一块，`--out` 与 `--check` 的语义随之不同：
    - 判断「是不是 via 写的」：frontmatter 里有 `name: via`，并且有上面那行生成标记。
    - `--out <文件>`：文件不存在（或只有空白）时创建，stderr 输出 `· wrote <文件> · N bytes`；是 via 写的文件时整份重写，输出 `· updated <文件> · N bytes`；是别的文件（用户自己写的技能，或同名的别的内容）时拒绝，退出码 5，`next: rerun with --yes to replace it`，加 `--yes` 才整份覆盖。不做拼接，也没有标记不成对的问题。
    - `--check <文件>`：整份内容与当前输出一致时退出码 0，stderr 输出 `· <文件> is up to date`；文件不存在或内容过期时退出码 1，`next:` 为 `via prompt --skill --out <文件>`；文件不是 via 写的时退出码 5（不拿别人的文件当作过期）。
    - `--replace` 与 `--skill` 同用时退出码 2：技能文件本来就整份写入。
    - 文件内容在 `--check` 里按忽略末尾空白的全文比较；provider 列表也在其中，所以增删 server 之后同样会过期。

### MCP 资源与 prompt 命令

这三个命令只读：MCP 协议里列出和读取资源、列出和取 prompt 都没有副作用，所以没有 `--yes`、`--dry-run` 的含义，`deny` 也不适用（它匹配工具引用，见 [security.md](security.md#边界说明)）。第二个参数是 provider，解析规则同其他命令（唯一前缀、大小写与 `-`/`_` 宽松，输入不是规范写法时 stderr 打印 `· resources <provider>`）。结果走通用的[渲染流水线](output.md#mcp-资源与-prompt)：预算、游标、媒体落盘、脱敏、元信息行都与工具调用一致，元信息行里的名称是 `resources <provider>`、`read <provider>`、`prompts <provider> <名称>`。

- `via resources <provider>`：每个资源一行（URI、MIME 类型或 `-`、名称、描述的首行），之后是 `templates:` 与每个资源模板一行（RFC 6570 的 `uriTemplate`），最后一行 `→ via read <provider> <uri>`。分页拉全。`-o json` 输出 `{"resources": […], "templates": […]}`。没有任何条目时输出 `(no resources)`。
- `via read <provider> <uri>`：`<uri>` 原样发给 server，不拆分、不展开模板——资源模板里的 `{占位符}` 由调用方自己替换。有且只有两个参数。读取返回的每个内容：文本按文本结果渲染（内容是 JSON 时与工具结果一样被清理和整形，要原文用 `-o raw`），二进制 `blob` 写入缓存目录、只打印路径；一次返回多个内容时，每个前面加一行 `# <uri>`。
- `via prompts <provider>`：每个 prompt 一行（名称、参数签名、描述的首行），最后一行 `→ via prompts <provider> <名称> -h for usage`。
- `via prompts <provider> <名称> [参数…]`：名称按与工具相同的宽松规则匹配（原样、`-`/`_` 与大小写宽松、唯一前缀）；找不到时给出 did you mean（退出码 3），有歧义时列出候选。prompt 的参数是一组具名字符串，via 把它们当作只有字符串属性的工具 schema，复用工具的参数解析：`--名称 值`（名称按 kebab-case 书写）、`--args`、`@文件`、`-`（stdin）、唯一必填参数的位置写法、本地校验与 `-h`、`--no-validate`、校验报错与退出码 2（[arguments.md](arguments.md)）。`-h` 写在名称之后时显示这个 prompt 的用法，不含工具才有的 `alias` 与危险性标记行。结果的每条消息输出为 `[角色]` 一行加内容；非文本内容（图片、音频、嵌入资源、资源链接）紧随其后按[媒体规则](output.md#渲染流程)处理。`-o json` 输出 `{"description"?, "messages": [{"role", "content"}]}`，二进制内容只描述（`type`、`mimeType`），不内联。server 用 `-32602` 拒绝参数时退出码 1，信息取自 server。

#### 补全

`--complete <参数>` 调用 `completion/complete`，列出 server 为某个 prompt 参数或资源模板变量建议的取值。它是全局选项，所以参数恰好叫 `complete` 时写 `--p.complete`（[arguments.md](arguments.md)）；用在其他命令上退出码 2，不会被静默忽略。

```console
$ via prompts gh review --code 'x = 1' --lang py --complete lang
python
pytorch
· prompts gh review · 120ms · 15 bytes

$ via resources gh 'file:///project/logs/{date}.log' --complete date
2026-10-18
2026-10-19
2026-10-20
(3 of 40 shown; more match, type more of the value)
```

- **形式**：`via prompts <provider> <名称> [--<参数> <值>…] --complete <参数>`，或 `via resources <provider> <uri模板> [--<变量> <值>…] --complete <变量>`。要补全的那个参数已经写出的值就是前缀（没写则为空串）；其余写出的参数作为 `context.arguments` 一并发送。参数按工具的写法解析（`--名称 值`、`@文件`、`-`、kebab-case），但不做必填校验：补全发生在写完之前。`<uri模板>` 必须是 `via resources <provider>` 列出的某个 `uriTemplate`（逐字相同，含花括号，命令行里要加引号）；变量名取自模板里的 RFC 6570 表达式（`{date}`、`{+path}`、`{/a,b*}` 的 `date`、`path`、`a`、`b`）。
- **输出**：server 给的取值，保持它的顺序，每行一个（换行等控制字符写成可见的转义），走通用的[渲染流水线](output.md#mcp-资源与-prompt)；没有建议时输出 `(no suggestions)`；server 说还有更多（`hasMore` 为真或 `total` 大于已给出的个数）时最后一行是 `(N of TOTAL shown; more match, type more of the value)`。`-o json` 输出 `{"values": […], "total"?, "hasMore"?}`。via 不缓存、不排序、不过滤 server 的建议；元信息行里的名称与 prompt 命令相同（`prompts <provider> <名称>`、`resources <provider>`）。
- **发现**：不自动发请求。`-h` 不会为了列出取值去连接 server；目录缓存里记着 server 声明了 `completions` 能力时，prompt 的 `-h` 在用法之后多一行 `complete: --complete <argument> lists the values the server suggests for it`（只在该 prompt 有参数时）。
- **错误**：参数不是这个 prompt 或模板的（`--complete nope`）退出码 2，列出可用的参数，`next:` 指向 `-h`；`via prompts <provider> --complete x` 缺名称退出码 2；模板不在列表里退出码 3，`next: via resources <provider>`；server 没有声明 `completions` 能力时不发请求，退出码 3（`error: gh does not offer MCP argument completion`，`next: via gh`）。
- **不做**：不对工具参数补全（MCP 的补全只覆盖 prompt 与资源模板）；`via serve` 里补全是 `via_prompts` 的 `complete` 与 `via_resources` 的 `template` + `complete`（[见下](#via-serve)）。

server 没有在 `initialize` 里声明相应能力（`resources`、`prompts`）时不发请求，退出码 3：

```console
$ via resources gh
error: gh does not offer MCP resources
next: via gh
```

URI 不存在（server 回 `-32002`，或把它当作 `-32602`）时同样退出码 3，`next: via resources <provider>`：

```console
$ via read fs file:///project/missing.txt
error: no such resource: file:///project/missing.txt (Resource not found: file:///project/missing.txt)
next: via resources fs
```

### 技能（`via skills`）

MCP 的 Skills 扩展（`io.modelcontextprotocol/skills`，只存在于 `2026-07-28`）让 server 发布「技能」：一个目录，至少有带 YAML frontmatter 的 `SKILL.md`，可以有附属文件。`skills/list` 与 `skills/get` 返回条目，内容用普通的 `resources/read` 取。命令只读，像 `via resources` 一样没有 `--yes`、`--dry-run`，`deny` 不适用；第二个参数是 provider，元信息行里的名称是 `skills <provider>`。设计理由见 [ADR 0020](../adr/0020-tasks-and-skills-commands.md)。

```console
$ via skills gh
refunds       3 files  Handle refund requests step by step.
acme/billing  1 file   Acme billing.
beta/billing  1 file   Beta billing.
dyn           dynamic  A skill without a manifest.
→ via skills gh <name> to read a skill · <name> <file> for one of its files

$ via skills gh refunds
---
name: refunds
description: Handle refund requests step by step.
---
# Refunds
Read references/FORMS.md first.
· skills gh · 41ms · 114 bytes
files: references/FORMS.md · assets/pixel.png  (via skills gh refunds <file>)
```

- **列表**：每个技能一行（名称、文件数或 `dynamic`、描述的首行）；两个技能同名时这两行改写成路径（`acme/billing`）。`-o json` 输出服务端发布的条目（`uri`、`frontmatter`、`resources` 清单）。条目缺 `SKILL.md` 的 URI、`name`、`description` 或清单时扩展不允许使用，via 把它们去掉并警告一次（`warning: 1 skill entry of gh ignored…`）。没有技能时输出 `(no skills)`。
- **读取**：`<名称>` 先按名称或路径逐字匹配，再宽松匹配（大小写、`-`/`_`），再取唯一前缀；也接受技能的 URI（`SKILL.md` 或其目录）。两个技能同名（或前缀对应多个）时不挑一个：退出码 3，`candidates:` 列出路径。列表里找不到的名称再试约定的 `skill://<名称>/SKILL.md`（列表可以不完整），仍没有时退出码 3 并给 did you mean。`<文件>` 是相对技能目录的名字（`references/FORMS.md`，开头的 `./` 和 `/` 忽略）或清单里的完整 URI；含 `..` 的退出码 2；清单完整时不在清单里的文件不是这个技能的文件，不发请求，退出码 3 并列出可用的文件。内容按 `via read` 的方式输出（文本、JSON 内容的整形、二进制写入缓存目录只打印路径，`-o raw` 取原文，预算与游标照常）。读 `SKILL.md` 且技能还有别的文件时，stderr 在元信息行之后多一行 `files: …`（最多 8 个，其余 `… N more`），stdout 保持纯内容，可以直接 `> SKILL.md`。`-o json` 输出 `{skill: {uri, name, description, files}, file: {uri, mimeType, text}, verified}`。
- **核对**：每次读取先 `skills/get` 取最新的条目，再 `resources/read` 取文件，比较字节数与 `sha256:`（文本按 UTF-8，`blob` 按解码后的字节）。大小或摘要不符、文件不在清单里、server 没有返回内容：**拒绝**，不输出任何内容，退出码 6，`error: refused skill://x/SKILL.md: its sha256 differs from the manifest's (…); nothing was printed`，`next: via skills <provider>`（重新取清单）。清单是 `"dynamic"` 时没有可核对的东西，照常输出并在 stderr 警告 `could not be checked`，`-o json` 里 `verified` 为 false。核对在会话层（daemon 里的会话也一样）对 server 发来的原字节进行，之后才脱敏和渲染，所以内容里恰好有凭证值时是被替换，不是被拒绝。**不核对** `SKILL.md` 自己的 frontmatter 与条目是否一致（需要 YAML 解析）。
- **没有技能**：server 的协议版本不是 `2026-07-28`，或它没有声明 `io.modelcontextprotocol/skills`，不发 `skills/*` 请求，退出码 3：`error: gh does not offer MCP skills: it speaks MCP 2025-11-25; skills need 2026-07-28 and the io.modelcontextprotocol/skills extension`（或 `…: it did not declare the io.modelcontextprotocol/skills extension`），`next: via gh`。server 声明扩展时，provider 视图的 `also:` 行多一项 `via skills <provider>`（[discovery.md](discovery.md#via-provider)）。
- 技能内容与工具输出一样是不可信的数据，via 不解释它们、不把它们写进任何框架的技能目录（[ADR 0003](../adr/0003-read-only-framework-configs.md)）；要保存就 `via skills gh refunds > SKILL.md`。

### 任务（`via tasks` 与 `--detach`）

MCP 的 tasks 让一次 `tools/call` 变成一个可以事后查询的长任务。两代协议各有一种：`2025-11-25` 的核心协议（实验性，client 用 `task` 参数要求建任务）和 `2026-07-28` 的 `io.modelcontextprotocol/tasks` 扩展（server 自己决定，没有任务列表）。via 把它们收成同一套用法；设计理由、两代协议的对照见 [ADR 0020](../adr/0020-tasks-and-skills-commands.md)。

**调用默认跟随到结果。** 不需要任何选项：

```console
$ via gh report:generate --ms 3000
progress: task gh/job/1 working
report ready after 3000ms
· gh report:generate · 3.1s · 25 bytes
```

- 什么时候有任务：`2026-07-28` 由 server 决定（via 在每个请求里声明扩展）；`2025-11-25` 只有工具声明 `execution.taskSupport: required` 且 server 声明了 `tasks.requests.tools.call` 时 via 才带 `task` 去要，`optional` 的工具照旧同步调用。任务一出现，via 把它记下来并在 stderr 写一行 `progress: task <provider>/<任务ID> <状态>`，然后按 server 建议的间隔（100 毫秒到 5 秒，缺省 1 秒）轮询，结束后输出与同步调用完全一致：`completed` 时是工具结果（2025 用 `tasks/result`，2026 取 `tasks/get` 里内联的 `result`），`failed` 与 `cancelled` 像 `isError` 的工具结果一样输出（退出码 1，`next:` 指向该工具的 `-h`）。`--dry-run`、`--yes`、`deny`、本地校验不受影响。
- **受 `--timeout` 约束**（缺省为 server 的 `timeout`，整次调用的预算）。超时**不取消任务**，退出码 6：`error: still running as task gh/job/1 after 30s; it was not cancelled`，`next: via tasks gh job/1`。同一个命令继续等；之后可以再加 `--timeout`。
- 任务进入 `input_required`（server 要 client 回答问题）：via 把问题当作调用中途的提问来处理（[下](#server-向用户提问)），答完继续跟随到结果。有终端就在 stderr 提问、把答案交给 server；没有终端（agent 经 shell、`via batch`、`via serve`）就回答 `decline`，任务照常继续，调用的结果里说明 server 问过用户（成功是退出码 0 加 `warning:` 与 `next:`；任务因此失败是退出码 5，见 [output.md](output.md#server-向用户提问elicitation)）。用户作答的时间计入 `--timeout`。两代协议的做法见 [ADR 0020](../adr/0020-tasks-and-skills-commands.md)：`2025-11-25` 调 `tasks/result`（它一直阻塞到任务结束，server 的 `elicitation/create` 请求沿同一条连接来到 client）；`2026-07-28` 从 `tasks/get` 的 `inputRequests` 读出问题，用 `tasks/update`（`inputResponses`）回答，再继续轮询。只有 elicitation 会被回答：任务等的是别的请求（例如 sampling，via 不声明它），或状态是 `input_required` 却没有可答的请求时，via 不回答、停止等待，退出码 1：`error: task gh/job/1 is waiting for input (sampling/createMessage), which via cannot give`，`next: via tasks gh job/1 --cancel`。
- 读只读工具超时的自动重试（[arguments.md](arguments.md#调用过程)）在任务创建之后不再发生：重发会把任务跑两遍。

**`--detach`**（全局选项）：任务创建后立即返回。

```console
$ via gh --detach report:generate --ms 3000
task: gh/job/1
status: working
progress: task gh/job/1 working        （stderr）
· gh report:generate · 40ms · 32 bytes · next: via tasks gh job/1
```

- `task:` 是**带 provider 前缀**的任务 ID，`<provider>/<server 给的 ID>`（ID 可能自带 `/`，所以只在第一个 `/` 处拆）；`-o json` 是 `{"task", "status", "message"?}`。`next:` 用两词写法，ID 按[引号规则](output.md#可粘贴的命令行)引用。
- `2026-07-28` 的 server 可以不建任务而直接回结果（任务太短，或不想建）：这时输出结果本身，元信息行多一个标记 `no task`，退出码 0。
- 不能满足时不发请求，退出码 2，`next: rerun without --detach`：`2025-11-25` 的 server 没有声明 `tasks.requests.tools.call`（`cannot detach: gh did not declare support for tasks on tool calls`），或工具的 `execution.taskSupport` 不是 `optional`/`required`（缺省是 `forbidden`）；`2026-07-28` 的 server 没有声明扩展（`cannot detach: gh did not declare the io.modelcontextprotocol/tasks extension`）。它不会悄悄改成同步调用：`--detach` 的意图就是不阻塞。
- `--detach` 从不提问：任务这时就算已经在 `input_required`，也只是照常输出 `task:` 与 `status:`（`status: input_required`），`next:` 的 `via tasks <provider> <任务ID>` 就是回答它的命令。
- `--detach` 用在没有工具调用的命令上（浏览视图、`find`、`tasks` 等）退出码 2。`via batch --detach` 对每一行生效。工具有一个叫 `detach` 的参数时写 `--p.detach`。

**`via tasks`**（只作用于已存在的任务，没有 `--yes`/`--dry-run`，`deny` 不适用；元信息行的名称是 `tasks <provider>`，不含任务 ID）：

```console
$ via tasks gh
gh/job/1  working    gh report:generate  2026-10-22T03:14:00.000Z
gh/job/2  completed  gh report:generate  2026-10-22T03:12:10.000Z
(this server keeps no task list; these are the tasks via started)
$ via tasks gh job/1                       等任务结束，输出工具结果（同一行也可写成 gh/job/1）
$ via tasks gh job/1 --status              不等待：task、status、message、error、created、updated 逐行输出（`input_required` 时多一行 note，元信息行以 `next: via tasks gh job/1` 结尾，那条命令在终端里提问）
$ via tasks gh job/1 --cancel              请求取消，输出取消后的状态
```

- **提供者与任务 ID**：`via tasks <provider> <任务ID>` 或 `via tasks <provider>/<任务ID>`（只有一个参数且含 `/` 时，第一个 `/` 之前是 provider）。第二个参数以 `-` 开头是未知选项；`--status` 与 `--cancel` 互斥，都需要任务 ID（退出码 2）。
- **列表**：server 保留任务列表（`2025-11-25` 且声明了 `tasks.list`）时取自 server，并按 ID 补上 via 记录里的工具名；否则取自 via 自己的记录（下），对最近的 20 个各问一次 server 要当前状态。server 已不认识的标 `expired`，并从记录里删掉；暂时问不到的在最近一次已知状态后加 `?`。每行：带前缀的任务 ID、状态、工具（不知道写 `-`）、创建时间。没有任务时输出 `(no tasks)`；取自记录时最后一行说明 `this server keeps no task list; these are the tasks via started`。`-o json` 输出 `{"source": "server"|"record", "tasks": [{"id", "ref", "status", "tool"?, "created"?, "message"?}]}`。 列表里有 `input_required` 的任务时，元信息行以 `next: via tasks <provider> <任务ID>` 结尾（第一个这样的任务），列表本身不提问。
- **等待**（缺省）：等到 `completed`、`failed`、`cancelled` 或 `--timeout`，输出与调用相同（规则同上，超时同样不取消）。任务在 `input_required`：像调用一样提问或拒绝（同上；`via tasks` 没有可重复的原命令，所以拒绝时的 `next:` 只写 `ask the user to run this in a terminal`），然后继续等。
- **取消**：2025 的 `tasks/cancel` 返回任务；2026 的扩展只回执，取消是协作式的，via 取消后再取一次状态。状态是 `cancelled` 时输出它；仍是 `working` 时同样输出，并多一行 `note: cancellation requested; the server still reports the task as running`（退出码 0，之后用 `--status` 再看）；任务已经 `completed` 或 `failed` 时退出码 1：`gh/job/2 was not cancelled: it already completed`。
- **未知任务**（server 没有、已过期）：退出码 3，`error: no such task: job/1 (it may have expired)`，`next: via tasks gh`。server 没有声明 tasks（2025 的 `tasks` 能力，2026 的扩展）：退出码 3，不发请求，`gh does not offer MCP tasks: …`，`next: via gh`。
- **via 的记录**：用户缓存目录下 `tasks/<server 哈希>/<ID 的哈希>.json`（权限 0600，目录 0700；哈希同[目录缓存键](discovery.md#缓存)，所以记录绑定 server 的定义，改别名不丢）。内容是 `{version, id, tool（规范写法的工具引用）, createdAt, status}`，**不含参数与结果**。任务一创建就由 CLI 写入（daemon 通过 `task` 事件告知，进程内模式直接得到），所以被中断的跟随也找得回；状态在 `via tasks` 与调用结束时更新。每个 server 最多 50 个、最长 30 天，写入时清理。它是缓存：删掉只失去列表，已知 ID 的命令照常工作；任务 ID 在扩展里相当于访问任务的凭据，记录因此与其他缓存同样按用户私有数据对待（[security.md](security.md)）。

任务 ID 与任务里的文字（`statusMessage`、`error`）是 server 的数据：脱敏、控制字符写成可见转义，规则同其他输出。`via serve` 里任务由 `via_call` 的 `detach` 与 `timeout`、`via_tasks` 提供（[见下](#via-serve)，[ADR 0024](../adr/0024-via-serve-tasks-skills-and-completion.md)）。

### 配置错误

配置里有 error 级诊断（例如 `deny` 的正则无效）时，除 `via doctor` 与 `via servers`（它们展示诊断）和不读配置的 `via more` 外，所有命令都不执行，退出码 2：

```console
$ via github
error: invalid configuration: ~/.config/via/config.yaml: deny[0]: invalid regular expression "(unclosed" (…); the rule was ignored
next: via doctor
```

因为无效的 `deny` 规则意味着本应隐藏的工具会可见，这里宁可停下，也不带着缺失的规则继续运行（[config.md](config.md#校验与诊断)）。

### server 向用户提问

工具调用中途，server 可以向用户要输入（elicitation，[ADR 0018](../adr/0018-elicitation-in-a-terminal-declined-elsewhere.md)）；调用跟随的任务、`via tasks <provider> <任务ID>` 等待的任务进入 `input_required` 时同样（[任务](#任务via-tasks-与---detach)）。没有终端时一律拒绝并在调用的结果里说明（退出码与 `next:` 见 [output.md](output.md#server-向用户提问elicitation)）；这里是有终端时的交互。终端 = stdin 与 stderr 都是 TTY，且不是 `via serve`、`via batch`、`--args -` 读走了 stdin 的调用。提示写 stderr，答案读 stdin：

```console
$ via ask elicit-form
? ask asks for your input (3 fields; an empty answer takes the default shown in brackets). The text below comes from the server, not from via. You have 58s (the --timeout of this call).
  | Tell me about yourself
1/3 Name (name) - text, 2 to 12 characters, required: Ann
2/3 Count (count) - integer, 1 to 10 [3]: 11
  ! at most 10
2/3 Count (count) - integer, 1 to 10 [3]:
    1) red (Red)
    2) green (Green)
3/3 Color (color) - one of the choices [green]: 1

answers for ask:
  name: Ann
  count: 3
  color: red
Send these answers to ask? [y]es / [n]o (decline) / [c]ancel: y
form answered: accept {"name":"Ann","count":3,"color":"red"}
```

- **表单**：按 schema 的顺序逐字段提问，支持字符串（`minLength`、`maxLength`、`format` 的 `email`、`uri`、`date`、`date-time`）、`number`、`integer`（`minimum`、`maximum`）、`boolean`（`y/yes/true/1`，`n/no/false/0`）、单选枚举（`enum`+`enumNames`，或 `oneOf`/`anyOf` 的 `const`+`title`；按序号、值或标题选）和多选（`array` 的 `items` 是枚举，逗号分隔，`minItems`/`maxItems`）。空行取 `default`；没有默认值的可选字段留空就是不回答；必填字段不接受空行。校验不过就说明原因并重问，同一问题最多 4 次，之后按 `cancel`。包含对象、嵌套数组或超过 50 个字段的 schema 无法逐字段提问，整个请求按 `decline`，并说明原因。
- **最后一问没有默认值**：`y` 发送答案，`n` 拒绝（`decline`），`c` 取消（`cancel`）。空行或输入结束不会被当成同意。输入结束（`Ctrl-D`）时各字段取默认值或留空，最后一问连续 4 次没有有效回答、重试用尽，都按 `cancel`；`Ctrl-C` 照常结束整条命令。
- **URL 模式**：先显示 server 的话、完整 URL 和主机名（IDN 以 punycode 显示），再问是否打开。只打开 `http` 与 `https`；其他 scheme、带用户名密码的 URL 不询问，直接 `decline` 并说明。同意后用平台的打开命令（与 `via auth login` 相同，Windows 用 `rundll32`，不经 `cmd.exe`；SSH 会话、无显示器时不尝试，只提示用户自己打开地址）打开，`accept` 只表示用户同意去做，via 不检查他是否做完。`2025-11-25` 的 `URLElicitationRequired` 错误（server 不等、要求用户先完成再重试）同样处理，用户在页面上完成后按回车，via 把调用再发一次。
- **时间**：用户作答的时间计入调用的 `--timeout`，提示里显示剩余秒数，到点按 `cancel`。
- **粘贴与提前输入**：一次粘贴多行时，后面的行留给后面的问题。
- 终端里输入的答案只发给提问的 server，不写盘、不进日志、不进 `next:`。

### via serve

`via serve` 在 stdin/stdout 上运行一个 MCP server（只有 stdio 传输，不监听端口），供没有 shell 的 agent 在框架里当作普通 stdio server 登记，例如 `{"command": "via", "args": ["serve"]}`。stdin 关闭时退出；不接受参数，带参数时报用法错误（退出码 2）。设计理由见 [ADR 0016](../adr/0016-via-serve-meta-tools-over-stdio.md)，任务、技能与补全的工具见 [ADR 0024](../adr/0024-via-serve-tasks-skills-and-completion.md)。

- **能力**：只声明 `tools`。工具列表固定为下表九个，不随目录变化，不发 `tools/list_changed`。`initialize` 的 `instructions` 说明怎么用这些工具，以及输出里的 CLI 写法与工具的对应关系。
- **每次调用就是一次 CLI 命令**：按下表拼出命令行，在 `via serve` 进程里执行（环境变量、工作目录、用户目录与 `via serve` 进程相同；stdin 为空，不交互，`interactive` 为假），捕获 stdout 与 stderr。daemon、缓存、凭证解析、`deny`、危险操作确认、本地校验、渲染、预算、游标、脱敏与元信息行都与命令行完全相同；`via serve` 自己不连接任何 MCP server。

| 工具 | 参数 | 执行的命令 |
| --- | --- | --- |
| `via_browse` | `path`：省略或空串、`<provider>`、`<provider> <resource>`、`<provider> <resource>:<verb>`（按空白分词，至多三个词） | `via [path…]`；有带 `:` 的词时追加 `-h`，即该工具的用法 |
| `via_find` | `query`（必填）、`limit`（正整数） | `via find <query> [-n <limit>]` |
| `via_call` | `tool`（必填，单字符串引用）、`args`（对象）、`yes`（布尔）、`detach`（布尔）、`timeout`（正数，秒） | `via call <tool> --args <args 的 JSON，缺省 {}> [--yes] [--detach] [--timeout <秒>]` |
| `via_more` | `cursor`（必填） | `via more <cursor>` |
| `via_resources` | `provider`（必填）、`template`、`args`（字符串值的对象）、`complete`（`template` 与 `complete` 同时给，`args` 需要 `template`） | `via resources <provider>`；有 `template` 时 `via resources <provider> <template> [--args <json>] --complete <complete>` |
| `via_read` | `provider`、`uri`（必填） | `via read <provider> <uri>` |
| `via_prompts` | `provider`（必填）、`name`、`args`（字符串值的对象，需要 `name`）、`complete`（需要 `name`） | `via prompts <provider>`；有 `name` 时 `via prompts <provider> <name> [--args <json>] [--complete <complete>]` |
| `via_skills` | `provider`（必填）、`name`、`file`（需要 `name`） | `via skills <provider> [<name> [<file>]]` |
| `via_tasks` | `provider`、`task`（至少一个）、`action`（`status` 或 `cancel`，需要 `task`）、`timeout`（正数，秒） | `via tasks <provider>`（只有 `provider`）；`via tasks <task>` 或 `via tasks <provider> <task>`，加 `--status` 或 `--cancel`；等结果时（没有 `action`）加 `--timeout`，缺省 30 |

- **结果**：stdout 非空时是第一段文本，stderr（元信息行、警告、错误与 `next:` 提示）非空时是下一段文本，两者都空时是一段空文本；`structuredContent` 为 `{"exitCode": <退出码>}`；退出码非 0 时 `isError: true`。提示保持 CLI 写法，例如 `next: via gh issue:read -h` 对应 `via_browse` 的 `path: "gh issue:read"`。
- **参数检查**：在拼命令行之前进行，失败时不运行任何命令，结果是 `error: <原因>` 一行，退出码 2：
  - 必填参数缺失或为空、类型不对（字符串参数不是字符串，`args` 不是对象，`yes` 不是布尔，`limit` 不是正整数）；
  - 字符串参数以 `-` 开头（它会成为一个全局选项或命令选项，例如 `--yes`、`-o raw`）。工具参数在 `args` 的 JSON 里，不受这条限制；
  - `via_browse` 的第一个词是内置子命令名（`"trust"` 会变成 `via trust`），`path` 超过三个词；
  - `via_prompts` 给了 `args` 或 `complete` 而没有 `name`；`via_resources` 给了 `complete` 或 `args` 而没有 `template`，或给了 `template` 而没有 `complete`；`via_skills` 给了 `file` 而没有 `name`；
  - `via_tasks` 既没有 `provider` 也没有 `task`，有 `action` 而没有 `task`，`action` 不是 `status` 或 `cancel`，只有 `task` 而它不是 `<provider>/<id>` 的写法（第一个 `/` 前至少一个字符）；
  - `detach` 不是布尔，`timeout` 不是正数。
- **不提供**：`trust`、`auth`、`daemon`、`prompt`、`sync`、`batch`、`doctor`、`servers` 没有对应的工具。`via trust` 与 `via auth login` 必须由人在终端里完成。`via_browse` 的第一个词是 `skills` 或 `tasks` 时同样拒绝。
- **任务与超时**：
  - `detach` 不是缺省：`--detach` 在 server 或工具不支持任务时是错误（退出码 2），绝大多数调用不是任务，所以只有 agent 显式传 `detach: true` 时才加。不满足时的错误与 `next: rerun without --detach` 与命令行相同。
  - `via_call` 不传 `timeout` 时等待与命令行一致（server 的 `timeout`，缺省 60 秒）；传了就是 `--timeout`。任务超时不被取消，退出码 6，`next: via tasks <provider> <ID>` 对应 `via_tasks`。
  - `via_tasks` 等结果（没有 `action`）且没有 `timeout` 时，serve 追加 `--timeout 30`，这是 serve 唯一不同于命令行缺省的一处：许多 client 给一次工具调用约 60 秒，缺省的 60 秒会赶在 client 放弃的同一刻，结果与任务 ID 都丢；到点时退出码 6、任务继续，再调一次即可。`status`、`cancel` 与列表是单次请求，不加缺省。
  - 任务进入 `input_required` 时与命令行没有终端时相同（[任务](#任务via-tasks-与---detach)、[ADR 0018](../adr/0018-elicitation-in-a-terminal-declined-elsewhere.md)）：elicitation 回答 `decline`，任务继续，结果里的 `next:` 请用户在终端里运行；等的不是 elicitation 时退出码 1，`next: via tasks <provider> <ID> --cancel` 对应 `action: "cancel"`。
- **工具定义的大小**：九个工具的 `tools/list` 结果约 4.6 KB（约 1,150 token，按 4 字节一 token），`instructions` 约 0.7 KB；测试限制前者不超过 4.8 KB，并用快照钉住所有定义与 `instructions` 的文字（`test/cli/__snapshots__/serve-tools.txt`、`serve-instructions.txt`）。
- **框架配置里的 `via serve`**：登记了 `via serve` 的框架配置会被 via 自己读到，这样的条目不进入目录（[config.md](config.md#校验与诊断)）。

### via batch

`via batch` 从 stdin 读 JSON Lines，每个非空行是一次调用，并发执行，结果按输入顺序输出。每一行走与 `via call` 完全相同的路径（解析、`deny`、危险操作确认、本地校验与一次 schema 刷新、调用、只读重试、渲染），没有绕过任何检查的入口。

#### 输入格式

每行一个 JSON 对象：

```json
{"tool": "linear/issue:get", "args": {"id": "ENG-123"}}
```

- `tool`（必填）：单字符串形式的工具引用 `<provider>/<resource>:<verb>`，解析规则与 `via call` 相同（唯一前缀、大小写与 `-`/`_` 宽松、原始名可用）。
- `args`（可选，默认 `{}`）：参数对象，键是 schema 里的参数原名，值直接是 JSON。它与 `--args '{…}'` 走同一条路径：做补齐与本地校验，但没有 `@文件`、`-`、`--flag` 这类命令行写法，字符串 `"@a.md"` 或 `"-"` 原样传给上游。校验报错仍用命令行写法指出参数（`--repo  required`），`-o json` 的 `details` 带 JSON Pointer。
- 其他字段一律报错，避免 `arg` 这类拼写错误被静默忽略。
- 空行（只含空白）跳过，但仍占行号；识别 `\r\n` 与开头的 BOM。**行号**是该行在输入中的位置，用于定位错误。
- 一行无法解析（不是合法 JSON、不是对象、缺 `tool`、有未知字段、`args` 不是对象、`tool` 不含 `/`）时，该行失败，退出码 2，其余行照常执行。JSON 语法错误只报位置和出错字符，不回显该行内容。
- 没有任何非空行（含空输入）时，不执行任何调用，退出码 2：`error: no calls on stdin`。空输入多半是管道出了问题，静默成功会让 agent 误以为事情已经做完。

#### 执行

- 各行并发执行。同一 server 上的并发不超过它的 `concurrency`（[config.md](config.md#serversname)），超出的排队；另有全局上限 `--concurrency <n>`（默认 16，正整数），限制同时在途的行数，无论它们属于哪些 server。
- 单条失败（解析、找不到、`deny`、危险操作、校验、上游、传输、超时）只影响该行，不中止其他行。
- 每个 provider 的工具列表在整批中只取一次；校验失败后「缓存超过 5 分钟则刷新一次」的规则（[arguments.md](arguments.md#schema-不可靠时)）也是每个 provider 整批一次，而不是每行一次。
- 全局选项对整批生效：`--yes` 确认所有危险工具；`--dry-run` 对每一行只打印将要发出的调用（格式见 [`--dry-run` 的输出](#--dry-run-的输出)），不发起调用；`--no-validate`、`--timeout`、`--full`、`-o` 同理。没有 `--yes` 时，危险工具所在的行以退出码 5 失败，其余行不受影响，`next:` 写 `rerun only this line with: via batch --yes`，因为重跑整批会让已成功的行再执行一遍。
- 批量不是事务：没有回滚，也不保证幂等。已发出的写入调用不会因为后面的行失败而撤销。

#### 输出（text，默认）

结果按输入顺序输出；第 N 行的结果在前面所有行都已输出后立即输出，不等整批结束。每行的输出与单次调用一致，次序固定：该行的 `progress:` 与 `warning:` 行（stderr），数据（stdout），元信息行或错误（stderr）。因此各行的数据之间由元信息行分隔：

```console
$ printf '%s\n' \
    '{"tool":"gh/issue:read","args":{"owner":"acme","repo":"api","issue_number":1,"method":"get"}}' \
    '{"tool":"gh/issue:rea"}' \
    '{"tool":"gh/echo-text","args":{"message":"after"}}' | via batch
number: 1
title: Support OAuth DCR
state: open
· gh issue:read · 318ms · 47 bytes · line 1
error: line 2: no such tool: issue:rea
did you mean: gh issue:read
next: via gh issue:read -h
echo: after
· gh echo-text · 52ms · 12 bytes · line 3
· batch · 3 calls · 2 ok · 1 failed · 401ms
```

- 成功行的元信息行与单次调用相同，在标记位置多一个 `line N`（排在 `unvalidated` 之后、`next:` 之前）。
- 失败行没有数据；错误报告与单次调用相同（原因、补充行、`next:`），只是原因行写成 `error: line N: …`。
- 最后一行 `· batch · N calls · K ok [· M failed] · <耗时>` 汇总整批，写 stderr。
- 元信息行在 stderr，所以只捕获 stdout 时各行的数据无法按行拆开；需要程序化处理时用 `-o json`。
- `-o raw` 的框架与 text 相同，每行的数据是上游原始内容。

#### 输出（`-o json`）

stdout 每行一个 JSON 记录（JSONL），与输入的非空行一一对应、顺序一致：

```json
{"line":1,"tool":"gh/issue:read","ok":true,"exitCode":0,"elapsedMs":318,"result":{"number":1,"title":"Support OAuth DCR","state":"open"}}
{"line":2,"ok":false,"exitCode":3,"error":{"code":3,"message":"no such tool: nothing-like-it","next":"via find gh nothing-like-it"}}
```

| 字段 | 含义 |
| --- | --- |
| `line` | 输入中的行号 |
| `tool` | 规范的单字符串写法；该行在解析出工具之前就失败时省略 |
| `ok` / `exitCode` | 该行是否成功，以及该行的退出码（[退出码](output.md#退出码)） |
| `elapsedMs` | 上游调用耗时，仅调用返回时有 |
| `result` | 成功时清理后的结果，与单次 `-o json` 的 stdout 是同一个值（没有内容时为 `null`；`--dry-run` 时是 dry-run 对象） |
| `error` | 失败时的 `{code, message, next?, details?}`，与单次 `-o json` 的 stderr 里 `error` 对象相同 |
| `truncated`、`next` | 结果超过输出预算时：没有 `result`，`truncated` 为 `true`，`next` 是 `via more <游标>`；加 `--full` 则不截断。被截断的 JSON 不是合法 JSON，所以不会把半截结果塞进记录 |
| `warnings` | 警告（如 `outputSchema` 不匹配），有才出现 |
| `unvalidated` | 以 `--no-validate` 跳过校验时为 `true` |

`-o json` 时错误和警告都在记录里，不再写 stderr；stderr 只有 `progress:` 行和最后的汇总行。

#### 退出码

整体退出码取各行退出码中**数值最大**的（全部成功为 0），与 `via sync`、`via doctor` 一致。例如一行被 `deny`（5）、一行上游错误（1）时整体为 5。需要逐行判断时看每一行的退出码（`-o json` 的 `exitCode`，或 text 下的错误行）。批量本身的失败——配置有 error 级诊断、选项非法、没有输入——退出码为 2，且不执行任何调用。

## 全局选项

| 选项 | 作用 |
| --- | --- |
| `-o text\|json\|raw` | 输出格式（[output.md](output.md#输出格式)） |
| `--full` | 关闭截断 |
| `--all` | 浏览视图不截断条目 |
| `--yes` | 确认执行危险工具 |
| `--dry-run` | 只解析并打印将要发出的调用，不执行（输出格式见下） |
| `--no-validate` | 跳过本地 schema 校验（[arguments.md](arguments.md#schema-不可靠时)）；`--yes` 与 `deny` 照常生效 |
| `--timeout <秒>` | 覆盖本次调用的超时 |
| `--schema-snapshot <文件>` | 调用工具或查看其用法之前，把工具当前的 `inputSchema`/`outputSchema` 与保存的快照比较；不兼容时不发调用，退出码 2（[arguments.md](arguments.md#schema-快照校验)） |
| `--schema-mode compatible\|strict` | 快照比较的松紧，默认 `compatible` |
| `--detach` | 工具调用在 server 建出任务后立即返回任务 ID，不等结果（[任务](#任务via-tasks-与---detach)）；只用于工具调用（含 `via call`、`via batch`） |
| `--complete <参数>` | 向 server 要这个 prompt 或资源模板参数的取值建议（[补全](#补全)），只用于 `via prompts <provider> <名称>` 与 `via resources <provider> <模板>` |
| `-h`, `--help` | 帮助；放在工具引用后时显示该工具用法，加 `-o json` 时输出工具详情（也就是快照文件的格式）；放在 provider 后时在 provider 视图前显示 server 的自述（[discovery.md](discovery.md#server-自述)） |

全局选项可以出现在命令行的任何位置，包括工具参数之间；via 先取走它们，剩下的参数按原有顺序交给工具参数解析器。`-o`、`--timeout`、`--schema-snapshot`、`--schema-mode`、`--complete` 的值写在下一个参数里，或用 `-o=json`、`--timeout=5`、`--schema-snapshot=a.json`、`--complete=lang`。值不合法时退出码 2。`--schema-snapshot` 只对工具调用（含 `via call`）和工具的 `-h` 有意义；用在浏览视图、`find`、`batch` 等没有单个工具可比的命令上时退出码 2，不会静默忽略（一次没有执行的检查不能看起来像通过了）。

工具参数与全局选项重名时，用 `--p.<参数名>` 指定为工具参数（[arguments.md](arguments.md)）；`--p.` 开头的参数不会被当作全局选项。

### `--dry-run` 的输出

校验照常进行，通过后在 stdout 输出规范写法、原始名、目标 server（HTTP 只写 scheme 与主机）和最终参数；已解析的凭证值打码。不发起调用，退出码 0。`deny` 命中仍然退出码 5；危险工具缺少 `--yes` 时不报错，而是多一行 `requires: --yes (destructive tool)`。`-o json` 时输出同样字段的 JSON 对象（`dryRun`、`tool`、`rawName`、`server`、`transport`、`args`，可选 `requires`）。

```console
$ via gh issue_write --owner acme --repo api --title "T" --dry-run
dry run: nothing was sent
tool: gh issue:write
raw name: issue_write
server: gh (http https://api.example.com)
args:
  {
    "owner": "acme",
    "repo": "api",
    "title": "T"
  }
```

## 工具引用的写法

- **命令行**：`linear issue:create`，provider 与工具是两个参数。
- **单字符串形式**：`linear/issue:create`，用于 `via call`、`via batch`、`deny` 规则和日志。
- **原始名作为别名**：原始 MCP 工具名始终可用，`via linear create_issue` 等价于 `via linear issue:create`。拆分规则调整时，旧写法不会失效。
- **输入宽松**：大小写不敏感，`-` 与 `_` 等价；provider 和资源接受唯一前缀。
- **歧义与缺失**：有歧义时不执行，列出候选；找不到时给出至多 3 个 did you mean。
- **输出严格**：所有输出一律使用规范写法；输入使用了别名或前缀时，在 stderr 元信息行中打印规范写法。调用的元信息行本来就以规范写法开头；浏览视图和 `-h` 没有耗时等字段，只在 stderr 输出一行 `· <规范写法>`（如 `via G ISS` 输出 `· gh issue`），输入已是规范写法时不输出。

## 典型会话

```console
$ via
9 providers · 214 tools · 1 needs auth (linear)
code     github · sentry
search   exa · context7
project  linear
browser  playwright
→ via <provider> to browse · via find <query> to search

$ via linear
issue     create · get · list · update · archive
comment   create · list
project   create · get · list · update
cycle     get · list
team      list
→ via linear <resource> for signatures

$ via linear issue
issue:create    team, title, [description], [priority]   Create an issue
issue:get       id                                       Get an issue
issue:list      [team], [state], [assignee]              List issues
→ via linear issue:<verb> -h for usage

$ via linear issue:create --team ENG --title "Support OAuth DCR"
id: ENG-123
url: https://linear.app/acme/issue/ENG-123
state: Backlog
```

`via linear` 这一级是最省 token 的发现步骤：每个资源一行、动作内联，一个 provider 的全部能力通常只占几行。
