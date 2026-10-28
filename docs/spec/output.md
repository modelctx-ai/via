# 输出与退出码

所有工具共用一套渲染规则，不为单个工具写模板。数据写 stdout，元信息写 stderr：`| jq` 拿到的是干净数据，agent 仍能看到提示。

编码：输出一律是 UTF-8，换行是 `\n`，各平台一致（Windows 上也不写 `\r\n`；终端交互时 Node 直接写宽字符，不受控制台代码页影响，管道和重定向的读取方按各自的编码解码，见 [快速上手](../guides/getting-started.md#windows)）。

## 渲染流程

1. **选数据源**：`isError` 为真时走[错误路径](#错误)；否则优先取 `structuredContent`，其次尝试把 text 内容解析为 JSON，都不行就按原文处理。多个 content 块依次渲染：单行文本和媒体路径紧挨着输出，结构化内容（表格、对象）前后各空一行。`structuredContent` 与 text 里只是重复它的 JSON 文本不再重复渲染。工具声明了 `outputSchema` 时先校验 `structuredContent`，不匹配只在 stderr 警告（[arguments.md](arguments.md#输出校验)）。
2. **清理**：去掉 null、空字符串、空数组、空对象；按噪声字段表去掉 `node_id`、`_links`、`*_api_url` 之类字段。噪声表见 `data/noise.json`，可按 server 用 `noise` 配置追加。
3. **按形状渲染**：
   - 字段一致的对象数组 → 对齐的表格，最多 6 列，优先选 name、title、id、number、state、url 等字段，其余列在元信息行注明「+N cols (-o json)」；
   - 单个对象（含只有一个元素的数组）→ `key: value` 逐行输出，嵌套对象缩进两格；多行字符串缩进成块；嵌套的一致对象数组在缩进后同样渲染为表格，只有单个字段的对象数组（`[{name: bug}]`）合并为 `bug, p1`；
   - 纯文本 → 原样输出。

   表格里缺失的单元格显示 `-`；单元格里的数组用 `, ` 连接，对象取 `data/columns.json` 中 `labelKeys` 指定的字段代表它，换行折成空格。至少两行且至少一半的字段在半数以上的行里出现，才算「字段一致」。选列规则放在 `data/columns.json`（[数据文件](../development/data-files.md#columnsjson)）。
4. **限长**：单元格超过 80 字符截断并加 `…`；总输出超过预算（默认 8 KB，可按 server 用 `budget` 配置）时按整行截断，完整结果存入游标。单行本身就超过预算时，这一行会被拆成多段分页输出。
5. **媒体**：图片、音频、二进制资源写入缓存目录，只打印文件路径；resource link 只打印 URI。
6. **脱敏**：已解析的凭证值精确匹配替换为 `***`（JSON 转义后的写法同样替换）。实现上在清理和截断**之前**先对数据脱敏，避免单元格截断留下半个凭证，输出前再对成品整体扫一遍；写入游标的内容已经脱敏。脱敏**保持结构**，规则见下文[脱敏的范围](#脱敏的范围)。

宽度计算必须按显示宽度（中日韩字符双宽）对齐。

### 脱敏的范围

凭证可能很短或很常见（测试用的 `x`、`1`、`true`，或 `json`、`text` 这样的词）。把它们当作子串在整份输出里替换，会改写 `type` 之类渲染要靠它分派的字段、JSON 的键、`error:` / `next:` 标签、文件路径，让结果无法解析（曾经的表现：daemon 模式下 `blockPieces is not a function`）。所以脱敏分两档，按「这段文字是内容还是结构」区分，**不按凭证长度放行**：

| 对象 | 规则 |
| --- | --- |
| **内容**：server 返回的字符串值（`text`、`uri`、`name`、`description`、`structuredContent` 里的任何字符串、上游错误文本、进度消息）；用户在命令行给出并被回显的值（`(got …)`、`--dry-run` 的 `args`） | 任何长度的凭证，出现在字符串值的任何位置，都替换为 `***` |
| **结构**：对象的键；协议字段 `type`、`mimeType`、`role`、`audience`、`lastModified`；base64 载荷 `data`、`blob`；数字、布尔、null；via 自己写的文字（`error:`、`next:`、`usage:`、元信息行、JSON 信封的字段名与 `details` 里的 `rule`、`path`、`expected`）；保存下来的文件路径 | 只在凭证**不短于 8 个字符**时才扫描并替换；更短的凭证不会改写这些位置 |

后果与取舍：

- 8 个字符以上的凭证在成品的每一行都会被扫一遍，所以它不会出现在任何地方。8 个字符以下的凭证只在「内容」里替换，宁可让一段普通文字变成 `a *** b`，也不放过它；而结构保持原样，JSON 输出仍是合法 JSON，键与协议字段不变。
- `structuredContent` 和 `_meta` 里的字段哪怕叫 `type`、`text`，也是 server 的数据，按内容处理。协议字段的豁免只适用于 MCP 结果自己的 `content` 块、`resource`、资源与 prompt 列表项、prompt 消息。
- 数字与布尔值不是字符串，不替换（`{"count": 1}` 在凭证为 `1` 时保持不变）。
- 事先已知是内容的字符串先脱敏、后拼接：`--dry-run` 的参数、上游错误文本、`(got …)`；拼好之后的整段文字只做 8 字符以上的扫描。daemon 持有、本进程不知道的短凭证因此无法在本地拼好的校验文字里被找出（`(got …)` 回显的是用户自己刚输入的值）。
- JSON 输出（`-o json`、`batch` 的记录、错误信封）一律先逐个字符串脱敏、再序列化，不对序列化后的文本做替换。
- 保存的文件（图片、音频、二进制资源）的路径由 via 生成，不脱敏；资源链接的 URI 是 server 的内容，要脱敏。

## MCP 资源与 prompt

`via resources`、`via read`、`via prompts`（[cli.md](cli.md#mcp-资源与-prompt-命令)）不另立格式，把结果换成工具结果的形状后走上面同一条流水线，所以预算、游标、媒体落盘、脱敏和 `-o text|json|raw`、`--full` 的含义都不变：

- **资源内容**：每个内容相当于一个内嵌资源块。文本按 `text` 渲染（内容是 JSON 时被清理和整形，与工具结果一致；`-o raw` 输出 server 发来的原文），二进制 `blob` 按[媒体规则](#渲染流程)写入缓存目录、只打印路径。一次读取返回多个内容时，每个内容前加一行 `# <uri>`（`-o json` 里是同样的字符串元素）。超出预算的部分存入游标，`via more` 续读。
- **列表**：资源、资源模板、prompt 的列表是文本表格（列宽按显示宽度对齐，描述取首行），同样受预算约束；`-o json` 输出完整的结构化数据，由 `cleanValue` 去掉空值。
- **prompt 消息**：文本消息输出为 `[角色]` 加内容；非文本内容紧随其后。`-o raw` 的文本框架相同。`-o json` 见 cli.md。
- **元信息行**：名称依次是 `resources <provider>`、`read <provider>`、`prompts <provider> <名称>`（不含 URI 与参数，它们可能带敏感信息）；大小按字节数写，不使用 `N rows`。
- **补全**：`--complete`（[cli.md](cli.md#补全)）的结果是每行一个取值的文本，同样走这条流水线；元信息行名称同 prompt 命令。
- **退出码**：server 没有声明相应能力（含 `completions`）、资源 URI 不存在、prompt 名称不存在、资源模板不在列表里为 3；server 拒绝 prompt 参数为 1；鉴权、未信任、传输与超时同工具调用（4、5、6）。
- 资源内容和 prompt 消息与工具输出一样是不可信的数据，via 不解释它们（[security.md](security.md)）。

## 任务

任务（[cli.md](cli.md#任务via-tasks-与---detach)）不另立格式，走上面同一条流水线：

- **跟随**：任务的结果就是工具结果，渲染、预算、游标、脱敏与元信息行都与同步调用一致；任务的存在只多一行 stderr 的 `progress: task <provider>/<任务ID> <状态>`（与 `progress:` 的进度行同一类，`-o json` 时同样写 stderr）。
- **`--detach`**：`task:`、`status:`（有 `statusMessage` 时 `message:`）三行内的对象，元信息行以 `next: via tasks <provider> <任务ID>` 结尾（调用的元信息行名称是工具的规范写法）；没有任务时就是结果加标记 `no task`。
- **`input_required`**：`--detach`、`--status` 与任务列表只显示状态，不提问；`--status` 的对象多一行 `note:`，元信息行以 `next: via tasks <provider> <任务ID>`（ID 按[引号规则](#可粘贴的命令行)引用）结尾，那条命令在终端里提问。列表里有这样的任务时，元信息行同样以它的 `next:` 结尾。跟随与 `via tasks <provider> <任务ID>` 的等待才提问，规则同调用中途的提问（下「server 向用户提问」）。
- **`via tasks`**：任务列表是对齐的文本表（任务 ID、状态、工具、创建时间）；`--status`、`--cancel` 是 `key: value` 对象；等待的结果同工具结果，元信息行名称是 `tasks <provider>`，不含任务 ID（它相当于凭据）。
- **退出码**：成功 0；任务 `failed`/`cancelled` 为 1（同 `isError`）；`--detach` 不能满足为 2；任务或 provider 的 tasks 不存在为 3；`--timeout` 到而任务仍在跑为 6（任务没有被取消，`next:` 是继续等的命令）；任务在 `input_required` 时 via 答复它的提问（见下「server 向用户提问」），没有终端可答而任务因此失败为 5；任务等的是 via 不能给的输入（不是 elicitation）为 1（`next:` 是 `--cancel`）。

## 输出格式

| 选项 | 内容 | 用途 |
| --- | --- | --- |
| `-o text`（默认） | 上述紧凑渲染 | agent 阅读 |
| `-o json` | 清理后的 JSON，仍受预算约束 | 管道给 `jq` |
| `-o raw` | 上游原始 content，不做任何处理（仍脱敏）；不受预算约束，不产生游标 | 排查问题 |
| `--full` | 关闭截断，可与任意格式组合 | 需要完整结果时；`-h --full` 给出未截断的工具描述（[arguments.md](arguments.md#帮助)） |

浏览视图（`via`、`via <provider>`、`via <provider> <resource>`）与 `via find` 是 via 自己生成的目录，不经过上面的渲染流水线（没有预算与游标），但同样接受 `-o`：

- `-o json` 输出目录的 JSON（字段见 [discovery.md](discovery.md#浏览视图)，全部来自预构建缓存，不读 schema），stdout 只有 JSON；文本视图末尾的 `→` 提示与「没有命中」的说明改写 stderr，`noteCanonical` 的元信息行（`· gh issue`）照旧在 stderr。字符串（描述、名字、枚举值）是 server 的内容，按[内容档](#脱敏的范围)脱敏后再序列化。`via servers -o json` 同理（[cli.md](cli.md#内置子命令)）。
- `-o raw` 是上游原始 content，目录没有上游原文可给，退出码 2（`error: -o raw applies to a tool call: a listing has no upstream text to show`，`next:` 是同一条命令加 `-o json`），而不是悄悄输出文本。

## 元信息行

成功调用后在 stderr 输出一行，以 `·` 开头，字段以 ` · ` 分隔：

```text
· <规范写法> · <耗时> · <行数或字节数> [· +N cols (-o json)] [· <标记>…] [· next: <命令>]
```

- 耗时不足 1 秒写 `318ms`，否则写 `1.8s`。
- 结果是列表（表格、数组）且未截断时写 `N rows`；其他情况写字节数，`k` 以 1024 为单位（`8.0k`，小于 1024 时写原始数字）；被截断时写 `已显示/总计 bytes`。
- 标记有 `unvalidated`（[arguments.md](arguments.md#schema-不可靠时)）、`--detach` 时 server 没有建任务的 `no task`（[cli.md](cli.md#任务via-tasks-与---detach)）和 `via batch` 的 `line N`（[cli.md](cli.md#via-batch)），排在 `+N cols` 之后、`next:` 之前，`unvalidated` 在前。`via batch` 另在最后输出一行 `· batch · …` 汇总。
- 警告（如 `outputSchema` 不匹配）写在元信息行之前，每条一行 `warning: …`。与结果无关的运行时警告（如刷新后的 OAuth 登录存不下来，[auth.md](auth.md#刷新)）在发生时同样写一行 `warning: …` 到 stderr，每个会话只提示一次。

示例：

```console
$ via github issue:list --owner acme --repo api
number  title                    state  labels   updated
12      Support OAuth DCR        open   auth     2026-10-18
11      Group inference too eag… open   catalog  2026-10-17
9       Windows named pipes      open   daemon   2026-10-12
· github issue:list · 318ms · 3 rows · +7 cols (-o json)

$ via exa web:search "rust mcp"
title                          url                                   score
Rust MCP SDK                   github.com/modelcontextprotocol/rus…  0.91
…
· exa web:search · 612ms · 8.0k/38.2k bytes · next: via more c7f2
```

元信息行固定以 `·` 开头，避免与工具内容混淆（[security.md](security.md)）。

## 游标

- 被截断的完整结果存在用户缓存目录（权限 0700，文件 0600，内容已脱敏），保存 30 分钟后按 TTL 清理。daemon 模式与进程内模式用同一个目录，daemon 空闲退出不会让游标提前失效。
- `via more <游标>` 从截断处继续，格式与首段一致（表格的表头在每一段重复）；仍有剩余时元信息行给出新的游标。元信息行里的 `shown/total bytes` 中 `shown` 是到本段为止累计已显示的字节数。
- 游标是不透明字符串（4 位十六进制起，冲突时变长的随机串），不得编码凭证或参数原文。
- 游标不存在或已过期：退出码 3，提示 `next: rerun the original command`。

## 错误

错误一律写 stderr，第一行是原因，后面跟下一步（agent 能执行的命令，或明说要转告用户的事，见下面的判定表）：

```console
error: linear requires auth
next: ask the user to run this in a terminal: via auth login linear
```

- `isError` 结果：上游错误文本经清理、脱敏后输出，退出码 1，`next:` 指向该工具的 `-h`。「清理」指去掉终端转义序列和控制字符（保留换行与制表符），并受预算约束，`--full` 时不截断。
- 传输与上游错误（退出码 6）：第一行写原因，如 `cannot start playwright: …`、`github did not answer within 60s`、`lost the connection to exa`；`next:` 按下面的判定表写。网络错误只写 scheme 与主机（URL 的路径和查询串可能带凭证）；上游回显的文本经脱敏、清理、折成一行并限长 300 字符。`exclusive: true` 的 stdio server 启动失败时原因后追加「可能与 agent 框架中仍在运行的同名 server 冲突」（命令不存在时除外）。
- **`next:` 写给谁**：一个 `next:` 要么是 agent 自己能执行的命令，要么是 agent 做不了、得转告用户的事。后者必须一眼看出来，不能写成 agent 会去试的命令（`via doctor` 对一个没安装的程序只会把同一句话再说一遍）。口径与 elicitation、`via trust` 已有的一致：

  | 情形 | 谁处理 | `next:` |
  | --- | --- | --- |
  | stdio 命令不存在（`ENOENT`） | 用户 | `ask the user: <程序名> is not installed (needed by <provider>)` |
  | stdio 命令不可执行（`EACCES`） | 用户 | `ask the user: <程序名> is not executable by this user (needed by <provider>); its permissions need fixing` |
  | 命令路径的某一段不是目录（`ENOTDIR`） | 用户 | `ask the user: <程序名> cannot be found: a part of its path is not a directory (needed by <provider>)` |
  | 项目级配置未信任（退出码 5） | 用户，在终端里 | `ask the user to run this in a terminal: via trust <路径>` |
  | OAuth server 需要登录（没有登录记录、登录失效，或 401/403 且 `auth: oauth`），以及 `auth: none` 却收到 401 | 用户，在终端里 | `ask the user to run this in a terminal: via auth login <provider>` |
  | bearer / headers 凭证被拒（401/403） | 用户 | `ask the user: the credentials of <provider> were refused; check servers.<name>.auth in the via config (…)`（`auth login` 对静态凭证没有用） |
  | 凭证引用解析失败（`env:` 变量没设、`file:` 不存在或为空、`keychain:` 没有条目或读不出、`cmd:` 程序不在 PATH 或失败、引用写法有误） | 用户 | `ask the user: export EXA_KEY=<value>, or point the reference at another source (file:, keychain:)`（设变量、放文件、登录钥匙串、装程序都是人的事） |
  | 沙箱程序不存在（`sandbox.command` 找不到，退出码 6） | 用户 | `ask the user: srt is not installed (needed by sandbox.enabled in the via config)`（[config.md](config.md#sandbox)） |
  | 在沙箱里运行时，沙箱的代理拒绝连接 server（`CONNECT` 回 403：主机不在 `allowedDomains` 里；退出码 6，原因写 `the sandbox's proxy refused <origin> (HTTP 403)`） | 用户 | `ask the user: add <主机> to sandbox.policy.network.allowedDomains in the via config`（[config.md](config.md#sandbox)） |
  | 其他情形下 HTTPS 代理拒绝建立隧道（`CONNECT` 回 200 以外的状态；退出码 6，原因写 `the proxy did not connect to <origin> (HTTP <状态>)`） | 用户 | `ask the user: the proxy did not let via reach <origin> (HTTP <状态>); check the proxy, or list <主机> in NO_PROXY` |
  | 子命令被 `commands` 禁止（退出码 5） | agent 换别的命令 | `via help`（列出还能用的命令）；其他错误的 `next:` 指向被禁止的命令时不输出 |
  | 超时 | 重试 | `rerun with a larger --timeout` |
  | 进程启动后退出、连接断开、HTTP 5xx、网络不可达 | 可能是暂时的 | `via doctor`；`via doctor` 自己的结果里改为 `via daemon logs <provider>`（不再指回自己），`commands` 禁止或隐藏了 `via daemon` 时不写 |

  程序名来自用户自己的配置，回显前脱敏、清理控制字符、折成一行（同上一条）。`-o json` 的 `error.next` 是同一个字符串。凭证引用解析失败（`CredentialError`）的 `next:` 是各情形自己的说明，统一加 `ask the user: ` 前缀（`ask the user: export NOT_SET=<value>, …`），说明里不含凭证值，`via doctor` 里该 server 的 `next:` 与 `-o json` 的 `error.next` 相同；没有说明时 OAuth server 用 `auth login` 的写法，其余写 `ask the user: fix the credential reference in servers.<name>.auth of the via config`。
- 参数错误附 usage（[arguments.md](arguments.md#校验与报错)）；找不到附 did you mean（[discovery.md](discovery.md#找不到时)）。
- `-o json` 时错误同样写 stderr，格式为 `{"error": {"code": <退出码>, "message": "…", "next": "…", "details": [...]}}`。参数校验失败时 `details` 中每条错误一个对象：

  ```json
  {"error": {
    "code": 2,
    "message": "2 invalid arguments",
    "next": "via github issue:list -h",
    "details": [
      {"arg": "--repo", "path": "/repo", "rule": "required"},
      {"arg": "--state", "path": "/state", "rule": "enum",
       "expected": ["open", "closed", "all"], "got": "opened", "suggest": "open"}
    ]
  }}
  ```

  `arg` 是命令行写法，`path` 是 JSON Pointer，`rule` 是失败的 schema 关键字（`required`、`type`、`enum`、`maximum`、`pattern`、`additionalProperties` 等，JSON 解析失败为 `json`）。`got` 遵循与文本输出相同的截断与脱敏规则。

`-h` 加 `-o json` 输出工具详情（`tool`、`rawName`、`description`、`readOnly`、`destructive`、`destructiveBy`、`inputSchema`、`outputSchema`），格式与用途见 [arguments.md](arguments.md#schema-快照校验)；它是 `--schema-snapshot` 读取的快照文件。

## server 向用户提问（elicitation）

调用中途，server 可以向用户要输入（MCP 的 elicitation：表单模式按一个扁平 schema 填字段，URL 模式请用户去一个网页；[ADR 0018](../adr/0018-elicitation-in-a-terminal-declined-elsewhere.md)）。via 声明这个能力，处理取决于当时有没有人可问：

- **有人**：stdin 与 stderr 都是终端，且不是 `via serve`、`via batch`。提示写 stderr，答案读 stdin；提问的 provider 和「这段文字来自 server，不是 via 写的」总是先写明，server 的文字（消息、字段标题与描述、选项、URL）脱敏后显示，控制字符与转义序列按[回显规则](#可粘贴的命令行)写成可见的 `\uXXXX`。交互细节见 [cli.md](cli.md#server-向用户提问)。回答 `decline` 或 `cancel` 不是 via 的失败：调用的结果由 server 决定，退出码照常（server 因此返回 `isError` 就是退出码 1）。
- **没有人**：一律回答 `decline`，调用继续，并在调用的结果里说明 server 问过用户：
  - 调用仍然成功：退出码 0，元信息行之前多两行，`warning: <provider> asked for user input ("<server 的话>") and it was declined: no terminal is attached` 和 `next: ask the user to run this in a terminal: <原命令行>`。
  - 调用以 server 的错误结束（`isError`，或 server 在协议层拒绝，即原本的退出码 1）：退出码改为 **5**。第一行 `error: <provider> asked for user input ("…") and no terminal was available to answer`，接着一行 `the server then said: <server 的错误，折成一行>`，最后是同样的 `next:`。5 是「被拒绝」，与危险操作缺少 `--yes`、`via trust` 没有终端同一类：这一步需要一个人的明确同意，而现在没有。没有新增退出码。
  - 因其他原因失败（超时、传输错误）：原来的错误与退出码不变，错误前多上面的 `warning:` 与 `next:` 两行。
  - `-o json`：退出码 5 的错误照常是 `{"error": {"code": 5, "message": …, "next": …}}`；成功时的两行仍是文本。
  - `next:` 里的命令行由[引用函数](#可粘贴的命令行)拼出，参数来自 stdin（`-`）时不写命令，只写 `ask the user to run this in a terminal`；`via batch` 的行写成 `via call <工具> --args '<json>'`（参数超过 500 字符时省略命令）。
- **任务里的提问**：任务进入 `input_required`（[cli.md](cli.md#任务via-tasks-与---detach)）时，调用跟随它、`via tasks <provider> <任务ID>` 等待它的那条命令就是被问的人，规则与上面相同：有人则提问并继续等，没有人则回答 `decline`、任务继续。任务最终成功：退出码 0，元信息行之前多 `warning:` 与 `next:`；任务因此失败（`failed`，或 `isError` 的结果）：退出码 5，`next:` 同上；调用跟随的任务，`next:` 里是原命令行，`via tasks` 没有原命令可写，`next:` 只写 `ask the user to run this in a terminal`。`--detach`、`--status` 与列表不提问。
- server 的文字用 `"…"` 引起来、折成一行并限长 120 字符；它不能制造一行 `next:` 或移动光标。
- 答案与问题的内容不进日志、不进游标（[security.md](security.md#elicitation)）。

## 可粘贴的命令行

via 打印的命令行是给人和 agent 复制粘贴的：`next:` 提示（含元信息行里的 `next:`）、浏览视图末尾的 `→ via …` 提示、`did you mean:` 与 `candidates:` 列表、`usage:` 行和 `-h` 的调用示例、`alias:` 行，以及 `via trust` 显示的 stdio 命令行。这些命令行里夹着不是 via 写的文字：server 提供的名字（原始工具名、prompt 名、参数名）、枚举值、默认值、URI，和用户输入（拼错的名字、文件路径）。任何一处没有引用，粘贴就可能展开变量、执行命令或多出一行（[apify/mcpc#450](https://github.com/apify/mcpc/pull/450) 修的就是这类问题：工具名里缺少反斜杠转义，粘贴提示的命令会被执行）。

规则：

1. **只有 via 自己写的字面词可以不加引号地进入命令行**（`via`、子命令、`-h`、`--out`）。其余每一个词都经 `src/render/shell.ts` 的同一组函数（`shellQuote`、`shellArg`、`shellWords`）处理，不在别处手写引号。
2. **原样可用的词**：以字母、数字（任何文字）、`_ . / -` 开头，后面只有字母、数字（任何文字）和 `_ . / : + = @ -`（Windows 上还有 `\`，以及不在词首的 `~`：8.3 短文件名如 `C:\Users\RUNNER~1\…` 很常见，词中的 `~` 在 PowerShell 与 `cmd.exe` 里都没有含义；POSIX 上 bash 会展开 `=` 或 `:` 之后的 `~`，所以不放行）。这些字符在 POSIX shell、PowerShell 和 `cmd.exe` 里都没有特殊含义（`@` 与 `=` 不能在词首：PowerShell 的展开写法和 zsh 的命令名展开）。其他字符一律要引用，包括 `~`（Windows 上只限词首）、`% , # * ? ! $ { }` 与空白。
3. **其余的词按运行平台引用**：
   - POSIX：整词放进单引号，词里的 `'` 写成 `'\''`。单引号里没有任何展开（`$`、反引号、`\`、`!` 都是字面字符）。词里有 `'`，同时还有 shell 会当作语法的字符（`; & | < > ( ) { } $` 与反引号）时不引用：PowerShell 在 Linux 与 macOS 上对 `'\''` 的理解不同，那些字符会在它那里生效。
   - Windows：PowerShell 与 `cmd.exe` 都认双引号，词里没有 `"`、`$`、反引号、`%`、`!`，且不以反斜杠结尾（它会转义收尾的引号）时用双引号；否则在词里没有 `cmd.exe` 的语法字符（`" % & | < > ^ ( )`）时用 PowerShell 的单引号（`'` 写成 `''`），`cmd.exe` 不认单引号，最坏把它拆成几段，但不会执行任何东西；再否则不引用。含花引号（U+2018 到 U+201F）的词一律不引用：PowerShell 把它们当引号。
   - 空串写成 `""`，各 shell 一致。
4. **不能安全引用的词不进入命令行**，换成 `<占位符>`（`<query>`、`<path>`、`<file>`、`<name>`）。占位符粘贴后是 shell 的语法错误（`<` 是重定向），不会执行；命令照常出现，提示的是「这里要你填」。不能安全引用的有：含控制字符（包括换行、制表、NUL、ESC）、行与段分隔符、双向文本控制符、零宽字符的词，以及规则 3 里列出的情形。
5. **位置参数不以 `-` 开头**：`via find <query>`、`via prompt --out <file>`、`via auth login <provider>` 里来自外部的值以 `-` 开头时，会被 via 当成选项（`--yes` 是全局选项），所以同样换成占位符。
6. **引用的是整个词，不是片段**：`via find` 的查询写成一个词（多个空白分隔的词合并为一个，`via find 'github issue read'`）；工具引用与 prompt 名按词引用（`via prompts github 'review code' -h`）。
7. **回显在消息里的文字不是命令**（`error: no such tool: …`、`unknown option …`、参数校验里的参数名与 `got`、元信息行的名字）：换行与控制字符写成可见的转义（`\n`、`\u001b`），不会多出一行 `next:`，也不会移动光标。
8. **显示用、没法引用的命令词**（`via trust` 列出的 stdio 命令行里含控制字符的参数）写成双引号字符串，其中 `" $ \` ! % \ '`、控制字符与花引号都是 `\uXXXX` 转义：用于阅读，粘贴也不会执行任何东西。

`usage:` 行是语法说明，不是可以直接粘贴的命令：`[ ]` 表示可选，`<str>` 是占位，`a|b|c` 是枚举，粘贴到 shell 里 `|` 和 `<` 会被解释。但其中来自 server 的词仍遵守上面的规则：不能原样使用的参数名（两个参数归一化后同名时用原名，原名里可以有任何字符）按规则 3 引用，不能引用的写成 `--<name>`；枚举值与默认值里的换行写成转义。`-h` 里的 `example:` 行（[arguments.md](arguments.md#调用示例)）是可以粘贴的命令，全部遵守规则 1 到 5。

不在保证范围内：csh 与 tcsh（单引号里的 `!` 仍触发历史展开）；终端或编辑器自己对粘贴内容的处理；batch 文件里的 `%`。每个平台上 via 只按自己运行的平台引用，从 Linux 容器里复制到 Windows 的命令不保证。

## 浏览与搜索里没有拿到目录的 provider

`via`、`via find`、`via prompt` 并行向全部 server 要目录，个别 provider 拿不到时命令不失败（退出码 0），而是把它标出来（[discovery.md](discovery.md#浏览视图)）。状态只有五个：`ok`、`needs auth`、`starting`、`failed`、`untrusted`；这里约定它们在 stderr 与退出码上的表现。

- **`starting`**（等待到点，没有确定性失败）和 **`failed`**（确定性失败）不混用：`starting` 稍后重试即可，`failed` 要看一眼。agent 读到 `starting` 不应当放弃这个 provider。
- `via` 的状态列：`failed · <原因首行>`、`starting · retry in a moment`（进程内模式是 `starting · via sync <provider>`）。`failed` 的原因是上游错误文本，按「内容」档脱敏，去掉 `cannot start <provider>:` 前缀，折成一行，最多 80 个字符。
- `via` 第一行汇总里每种状态一段 `N <状态> (名字…)`，顺序固定：`needs auth`、`starting`、`failed`、`untrusted`。
- `via find` 的 stderr 分两行警告，某一类没有就不出现，各自的退出码影响为零：`warning: N provider(s) still starting: <名字…> (<提示>)` 与 `warning: N provider(s) could not be searched: <名字…> (see via, via doctor)`。`N provider` 单数时不加 `s`；名字按字母序。
- `via prompt` 的 `Providers:` 行照常列出这两类 provider。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含 `--dry-run`） |
| 1 | 工具返回 `isError` |
| 2 | 参数或用法错误；`--schema-snapshot` 比较出不兼容的变化（不发调用，[arguments.md](arguments.md#schema-快照校验)） |
| 3 | 工具或 server 不存在 |
| 4 | 需要鉴权或鉴权失败 |
| 5 | 被拒绝：deny 规则命中，子命令被 `commands` 禁止（[cli.md](cli.md#被配置限制的子命令)），危险操作缺少 `--yes`，项目级配置未经 `via trust` 确认（`via trust` 本身没有得到确认时同样是 5），或 server 向用户提问而没有终端可答、调用因此失败（[elicitation](#server-向用户提问elicitation)） |
| 6 | 上游、传输错误或超时 |
| 7 | via 内部错误 |
