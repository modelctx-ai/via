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
```

最后三行不属于 `provider → 资源 → 动作` 的层级：MCP 资源按 URI 寻址，URI 自带冒号（`file:///a.txt`），不能放进以冒号标明工具的语法里，所以它们是独立的内置子命令（[ADR 0010](../adr/0010-mcp-resources-prompts-and-roots.md)）。文档里的「MCP 资源」与工具名拆出的「资源（resource）」不是一回事，见[术语表](../overview/glossary.md)。

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
| `via auth login <provider> [--manual]`<br>`via auth status [<provider>]`<br>`via auth logout <provider>` | OAuth 登录、状态、登出；`login --manual` 用于无头环境（[auth.md](auth.md)） |
| `via trust [路径] [--dry-run]`、`via trust <路径> --yes` | 显示并信任项目级配置文件；`--list` 列出记录，`--revoke <路径>` 撤销（[security.md](security.md#via-trust)） |
| `via sync [provider]` | 强制刷新工具目录缓存 |
| `via doctor` | 检查连接与鉴权，检测各框架挂载的 MCP 并输出关闭提示 |
| `via prompt [--out <文件> \| --check <文件>] [--replace]` | 生成给 agent 的说明与 provider 列表；`--out` 只刷新带标记的块，`--check` 比对是否过期 |
| `via resources <provider>` | 列出 MCP 资源与资源模板（[见下](#mcp-资源与-prompt-命令)） |
| `via read <provider> <uri>` | 读取一个 MCP 资源 |
| `via prompts <provider> [<名称> [参数]]` | 列出 MCP prompt；带名称时取该 prompt，参数写法同工具 |
| `via daemon status\|stop\|run` | 管理后台进程；`run` 供内部拉起使用（[daemon.md](daemon.md)） |
| `via serve` | 以 stdio MCP server 运行，向没有 shell 的 agent 暴露元工具（[见下](#via-serve)） |

内置子命令名是保留字，大小写不敏感，不接受前缀。provider 别名与之重名时（例如某个 server 叫 `find`），必须在配置里用 `alias` 改名，`via servers` 给出告警，该 server 在改名前不出现在任何视图里。

0.1 只实现 `find`、`call`、`more`、`servers`、`sync`、`doctor`、`prompt`；`batch`、`trust`、`auth`、`daemon` 自 0.2 起可用，`resources`、`read`、`prompts` 自 0.3 起可用，`serve` 自 0.4 起可用（[路线图](../roadmap.md)）。`prompt`（给 agent 的说明）与 `prompts`（server 提供的 prompt）是两个命令；`via prompt` 带了 provider 时报用法错误并提示 `via prompts <provider>`。

各命令的细节：

- `via call`：`<provider>/<ref>` 按与命令行形式相同的规则解析（provider 与资源接受唯一前缀，原始名可用）；其后的参数交给工具参数解析器，`--args`、`@文件`、`-`（stdin）均可用。
- `via find`：没有命中时输出 `no tools match "<查询>"`；个别 provider 无法连接时照常搜索其余的，并在 stderr 警告哪些没有被搜索。用户配置了 `search.semantic` 时，stderr 可能多一行 `· semantic …` 元信息行（退回词法排序的原因，或第一次补全 embedding 缓存），退出码不变（[discovery.md](discovery.md#embedding-检索可选默认关闭)）。
- `via more`：只读游标，不加载配置和目录。游标先向已经在运行的 daemon 要（不会为此拉起 daemon），再看缓存目录（[daemon.md](daemon.md#daemon-持有的状态)）。
- `via daemon`：
  - `status`：不拉起 daemon，只询问正在运行的。输出一行概况、socket 路径和各会话（server 名、传输、`running (pid N)` / `connected` / `stopped`、目录中的工具数、调用数、空闲时间或在途数）；不含 URL、参数、凭证。socket 上没有 daemon 应答时（包括连得上却完不成握手，例如令牌不符，或 Windows 上收尾中的 daemon 的管道还被别的连接占着），再看 daemon 进程记录（[daemon.md](daemon.md#进程记录)）：有不在监听的 daemon 进程时每个一行，`daemon: starting · pid N`（还没绑定 socket）、`daemon: stopping · pid N · finishing requests in flight`（已收到 `shutdown`、删掉 socket，在处理在途请求）或 `daemon: not reachable · pid N`（socket 被删或被替换，几秒内自行退出），再加 `socket:` 一行；一个都没有才输出 `daemon: not running` 加 `socket:` 一行（完不成握手而又没有记录时，照旧报告连不上的原因）。有 daemon 应答而旁边还有别的 daemon 进程（例如上一个仍在收尾）时，概况之后追加 `also: stopping · pid N · …`。`VIA_NO_DAEMON` 打开时输出 `daemon: disabled (VIA_NO_DAEMON)`，退出码都是 0。`-o json` 输出 `{"running": true, …}`（字段同协议的 `status`）或 `{"running": false, "socket": …}`，有其他 daemon 进程时带 `processes: [{ pid, state }]`（`state` 为 `starting`、`running`、`stopping`）。
  - `stop`：结束这个 socket 的所有 daemon 进程，返回时它们都已退出。先向应答的 daemon 发 `shutdown`，给在途请求 5 秒处理完；仍未结束就发 `shutdown`（`force`），让它放弃在途请求（关闭会话、停止 stdio 子进程）立即退出。socket 上不应答的 daemon 进程（进程记录里的 `starting`、`stopping`）收到 `SIGTERM`，同样立即退出（Windows 上 `SIGTERM` 即结束进程，它的 stdio 子进程不随之结束，见 [daemon.md](daemon.md#windows)）。全部退出后输出 `daemon: stopped (pid N[, M…])`，放弃过在途请求时追加 `, requests in flight abandoned`；这些请求的 CLI 按「连接中断」处理（只读请求在进程内重做，其余以退出码 6 报告可能已执行）。没有 daemon 时输出 `daemon: not running`，退出码 0。某个进程 5 秒后仍未退出时退出码 7，`next: kill <pid>`。`-o json` 输出 `{"running": false, "pid"?: N, "stopped": [N, …], "abandoned"?: true}`。
  - `run`：前台运行 daemon，由 CLI 分离拉起，也可手动运行。选项 `--socket <路径>`、`--idle-timeout <秒>`（缺省取配置的 `daemon.idleTimeout`）；已有 daemon 在这个 socket 上应答时输出 `daemon: already running on <路径>` 并以 0 退出。收到 SIGTERM/SIGINT/SIGHUP 时正常退出。
- `via servers`：每个 server 一行，依次为 provider、传输方式（HTTP 只写 scheme 与主机，stdio 只写命令）、鉴权方式及凭证引用是否可解析（只写引用，不写值）、来源文件、备注（`disabled`、`untrusted`、框架间冲突、保留名冲突）；之后列出配置诊断。不连接任何 server，也不执行 `cmd:` 凭证引用（[config.md](config.md#凭证引用)）。`untrusted` 的备注附 `via trust <路径>`（多个文件待确认时为 `via trust`）。配置里有 error 级诊断时照常显示，不中止。
- `via trust`：显示并记录对项目级配置文件的信任，也能列出、撤销记录；细节、确认方式和退出码见 [security.md](security.md#via-trust)。它读取配置但不连接 server，配置里有 error 级诊断时照常工作（不执行任何工具）。确认默认在终端里完成；`--yes` 只在带显式路径并设置 `VIA_ALLOW_NONINTERACTIVE_TRUST=1` 时有效。
- `via auth`：`login <provider> [--manual]`、`status [<provider>]`、`logout <provider>`，只用于 `auth: oauth` 的 HTTP server（provider 接受唯一前缀）。provider 未配置为 OAuth 退出码 2，并提示把 `servers.<name>.auth` 设为 `oauth`；项目级配置里未信任的 server 退出码 5（登录会把授权发往仓库指定的地址）。`login` 的等待时间默认 300 秒，`--timeout <秒>` 覆盖。其余行为见 [auth.md](auth.md#oauth)。
- `via sync`：向各 server（或指定的 provider）重新拉取 `tools/list` 并更新缓存，每个 provider 一行（`gh  14 tools` 或 `linear  needs auth: …`）；有失败时退出码取其中最大的，并在 stderr 提示 `next: via doctor`。
- `via doctor`：对每个 server 实时探测（不读缓存，成功后更新缓存），再输出检测结果；退出码取各项问题中最高的一个（见[退出码](output.md#退出码)）。
- `via prompt`：输出一段带标记的说明块，`<!-- via:begin … -->` 到 `<!-- via:end -->` 之间是说明本身与 provider 列表（按字母序，[agent-integration.md](../guides/agent-integration.md#via-prompt给-agent-的说明)）。
  - `--out <文件>`：路径相对当前目录。文件不存在时创建；已有标记块时只替换两个标记之间的内容，标记之外不动（输出 `· updated the via block in <文件> · N bytes`）；没有标记时追加到末尾、前面空一行（输出 `· appended to <文件> · N bytes`）；创建时输出 `· wrote <文件> · N bytes`。标记不成对或出现多对时拒绝，退出码 5，并提示手工修——位置猜错会写坏用户自己的文字。
  - `--check <文件>`：只比对不写入。块与当前输出一致时退出码 0，stderr 输出 `· <文件> is up to date`；没有标记块或内容过期时退出码 1，`next:` 为 `via prompt --out <文件>`；标记不可用退出码 5。
  - `--replace`：整份文件只留这个块（0.3 之前的 `--out` 行为），目标文件已存在时需要 `--yes`（退出码 5）。
  - `--out` 与 `--check` 不能同时给，`--replace` 必须配 `--out`，否则退出码 2。

### MCP 资源与 prompt 命令

这三个命令只读：MCP 协议里列出和读取资源、列出和取 prompt 都没有副作用，所以没有 `--yes`、`--dry-run` 的含义，`deny` 也不适用（它匹配工具引用，见 [security.md](security.md#边界说明)）。第二个参数是 provider，解析规则同其他命令（唯一前缀、大小写与 `-`/`_` 宽松，输入不是规范写法时 stderr 打印 `· resources <provider>`）。结果走通用的[渲染流水线](output.md#mcp-资源与-prompt)：预算、游标、媒体落盘、脱敏、元信息行都与工具调用一致，元信息行里的名称是 `resources <provider>`、`read <provider>`、`prompts <provider> <名称>`。

- `via resources <provider>`：每个资源一行（URI、MIME 类型或 `-`、名称、描述的首行），之后是 `templates:` 与每个资源模板一行（RFC 6570 的 `uriTemplate`），最后一行 `→ via read <provider> <uri>`。分页拉全。`-o json` 输出 `{"resources": […], "templates": […]}`。没有任何条目时输出 `(no resources)`。
- `via read <provider> <uri>`：`<uri>` 原样发给 server，不拆分、不展开模板——资源模板里的 `{占位符}` 由调用方自己替换。有且只有两个参数。读取返回的每个内容：文本按文本结果渲染（内容是 JSON 时与工具结果一样被清理和整形，要原文用 `-o raw`），二进制 `blob` 写入缓存目录、只打印路径；一次返回多个内容时，每个前面加一行 `# <uri>`。
- `via prompts <provider>`：每个 prompt 一行（名称、参数签名、描述的首行），最后一行 `→ via prompts <provider> <名称> -h for usage`。
- `via prompts <provider> <名称> [参数…]`：名称按与工具相同的宽松规则匹配（原样、`-`/`_` 与大小写宽松、唯一前缀）；找不到时给出 did you mean（退出码 3），有歧义时列出候选。prompt 的参数是一组具名字符串，via 把它们当作只有字符串属性的工具 schema，复用工具的参数解析：`--名称 值`（名称按 kebab-case 书写）、`--args`、`@文件`、`-`（stdin）、唯一必填参数的位置写法、本地校验与 `-h`、`--no-validate`、校验报错与退出码 2（[arguments.md](arguments.md)）。`-h` 写在名称之后时显示这个 prompt 的用法，不含工具才有的 `alias` 与危险性标记行。结果的每条消息输出为 `[角色]` 一行加内容；非文本内容（图片、音频、嵌入资源、资源链接）紧随其后按[媒体规则](output.md#渲染流程)处理。`-o json` 输出 `{"description"?, "messages": [{"role", "content"}]}`，二进制内容只描述（`type`、`mimeType`），不内联。server 用 `-32602` 拒绝参数时退出码 1，信息取自 server。

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

### 配置错误

配置里有 error 级诊断（例如 `deny` 的正则无效）时，除 `via doctor` 与 `via servers`（它们展示诊断）和不读配置的 `via more` 外，所有命令都不执行，退出码 2：

```console
$ via github
error: invalid configuration: ~/.config/via/config.yaml: deny[0]: invalid regular expression "(unclosed" (…); the rule was ignored
next: via doctor
```

因为无效的 `deny` 规则意味着本应隐藏的工具会可见，这里宁可停下，也不带着缺失的规则继续运行（[config.md](config.md#校验与诊断)）。

### via serve

`via serve` 在 stdin/stdout 上运行一个 MCP server（只有 stdio 传输，不监听端口），供没有 shell 的 agent 在框架里当作普通 stdio server 登记，例如 `{"command": "via", "args": ["serve"]}`。stdin 关闭时退出；不接受参数，带参数时报用法错误（退出码 2）。设计理由见 [ADR 0016](../adr/0016-via-serve-meta-tools-over-stdio.md)。

- **能力**：只声明 `tools`。工具列表固定为下表七个，不随目录变化，不发 `tools/list_changed`。`initialize` 的 `instructions` 说明怎么用这些工具，以及输出里的 CLI 写法与工具的对应关系。
- **每次调用就是一次 CLI 命令**：按下表拼出命令行，在 `via serve` 进程里执行（环境变量、工作目录、用户目录与 `via serve` 进程相同；stdin 为空，不交互，`interactive` 为假），捕获 stdout 与 stderr。daemon、缓存、凭证解析、`deny`、危险操作确认、本地校验、渲染、预算、游标、脱敏与元信息行都与命令行完全相同；`via serve` 自己不连接任何 MCP server。

| 工具 | 参数 | 执行的命令 |
| --- | --- | --- |
| `via_browse` | `path`：省略或空串、`<provider>`、`<provider> <resource>`、`<provider> <resource>:<verb>`（按空白分词，至多三个词） | `via [path…]`；有带 `:` 的词时追加 `-h`，即该工具的用法 |
| `via_find` | `query`（必填）、`limit`（正整数） | `via find <query> [-n <limit>]` |
| `via_call` | `tool`（必填，单字符串引用）、`args`（对象）、`yes`（布尔） | `via call <tool> --args <args 的 JSON，缺省 {}> [--yes]` |
| `via_more` | `cursor`（必填） | `via more <cursor>` |
| `via_resources` | `provider`（必填） | `via resources <provider>` |
| `via_read` | `provider`、`uri`（必填） | `via read <provider> <uri>` |
| `via_prompts` | `provider`（必填）、`name`、`args`（字符串值的对象，需要 `name`） | `via prompts <provider>`；有 `name` 时 `via prompts <provider> <name> [--args <json>]` |

- **结果**：stdout 非空时是第一段文本，stderr（元信息行、警告、错误与 `next:` 提示）非空时是下一段文本，两者都空时是一段空文本；`structuredContent` 为 `{"exitCode": <退出码>}`；退出码非 0 时 `isError: true`。提示保持 CLI 写法，例如 `next: via gh issue:read -h` 对应 `via_browse` 的 `path: "gh issue:read"`。
- **参数检查**：在拼命令行之前进行，失败时不运行任何命令，结果是 `error: <原因>` 一行，退出码 2：
  - 必填参数缺失或为空、类型不对（字符串参数不是字符串，`args` 不是对象，`yes` 不是布尔，`limit` 不是正整数）；
  - 字符串参数以 `-` 开头（它会成为一个全局选项或命令选项，例如 `--yes`、`-o raw`）。工具参数在 `args` 的 JSON 里，不受这条限制；
  - `via_browse` 的第一个词是内置子命令名（`"trust"` 会变成 `via trust`），`path` 超过三个词；
  - `via_prompts` 给了 `args` 而没有 `name`。
- **不提供**：`trust`、`auth`、`daemon`、`prompt`、`sync`、`batch`、`doctor`、`servers` 没有对应的工具。`via trust` 与 `via auth login` 必须由人在终端里完成。
- **工具定义的大小**：七个工具的 `tools/list` 结果约 2.9 KB（约 730 token，按 4 字节一 token），`instructions` 约 0.6 KB；测试限制前者不超过 3.6 KB。
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
| `-h`, `--help` | 帮助；放在工具引用后时显示该工具用法 |

全局选项可以出现在命令行的任何位置，包括工具参数之间；via 先取走它们，剩下的参数按原有顺序交给工具参数解析器。`-o`、`--timeout` 的值写在下一个参数里，或用 `-o=json`、`--timeout=5`。值不合法时退出码 2。

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
