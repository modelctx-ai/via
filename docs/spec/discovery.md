# 发现：目录、浏览与搜索

provider 就是配置里的 server，按名字原样列出，不做分类：模型自己知道 `github` 是做什么的，把推断出来的分组写进视图只会多一层可能与实际不符的间接（[ADR 0014](../adr/0014-drop-the-domain-view.md)）。

## 目录构建流程

1. **拉取**：对每个 server 调用 `tools/list`（分页拉全）。
2. **确定 provider**：取 server 别名（或配置中的 `alias`），统一为小写 kebab-case；与内置子命令重名时必须改名。
3. **拆分工具名**：每个工具拆成 `资源:动作`，拆不开的作为叶子工具（[naming.md](naming.md)）。
4. **建索引**：provider、资源、动作、原始名、描述、参数名分词后建倒排索引，供 `via find` 使用。
5. **过滤**：`deny` 规则命中的工具从视图和索引中移除（[config.md](config.md#deny)）。

### 缓存

- 缓存键：server 定义的哈希（命令、参数、`cwd`、URL，以及 `env` 与 `headers` 的名和写法）+ 身份（鉴权主体的稳定标识，无法获得时用凭证引用本身的哈希）。
- 位置：用户缓存目录下的 `catalog/`，权限 0700。
- TTL 默认 24 小时；无状态协议（`2026-07-28`）的 server 可以在 `tools/list` 结果里给出 `ttlMs`，取与 24 小时中较短者（`ttlMs` 为 `0` 或缺省视为没有给出提示，沿用 24 小时；提示随缓存保存，所以进程内模式和 daemon 一致）。daemon 在线时订阅 `notifications/tools/list_changed`（无状态协议里是 `subscriptions/listen` 流上的同名事件）实时刷新：收到通知后重新拉取该 server 的 `tools/list`，同时更新 daemon 内存里的副本和这里的磁盘缓存，下一次浏览、`find` 或调用就能看到变化（[daemon.md](daemon.md#daemon-持有的状态)）。
- `via sync [provider]` 强制刷新。
- 进程内模式（0.1）下，缓存是 `tools/list` 的唯一来源：`via <provider>` 只读取、必要时只拉取该 provider，等待上限是 server 的 `timeout`（`--timeout` 覆盖）。拉取失败不中止：该 provider 仍然列出，标记 `needs auth`、`starting`、`failed` 或 `untrusted`（[浏览视图](#via)）。
- **发现类命令的等待**：`via`、`via find`、`via prompt` 并行处理全部 server，单个 server 的等待上限独立于调用的 `timeout`，拉起 stdio server 与握手的时间也算在内，所以卡在握手里的 server 不会拖住整条命令。等到点还没有结果、也没有确定性失败的 provider 标记为 `starting`，不阻塞其他 provider。`--timeout` 在两种模式下都覆盖这里的等待。
  - **经 daemon**：默认 3 秒（`discovery.wait`，[config.md](config.md#discovery)；不超过该 server 的 `timeout`）。到点后 CLI 照常打印，daemon 不放弃：它以 server 的 `timeout`（给了 `--timeout` 则以它）为上限继续连接、拉取，成功后写入磁盘缓存和内存副本，下一条命令直接命中。拉取期间到达的、针对同一 server 的请求（另一条 `via`、`via find`、`via sync`）加入同一次拉取，不会再起一个进程。确定性失败（见[浏览视图](#via)）立刻返回，不等到点。daemon 的 `list` 请求为此带 `waitMs`（[daemon.md](daemon.md#cli-与-daemon-的协议)）。
  - **进程内模式**（`VIA_NO_DAEMON=1`，或 daemon 不可用而回退）：没有后台，到点的拉取会被放弃，子进程随命令结束，缓存仍是空的，再等 3 秒不会让下一条命令受益。所以上限保持 `min(server 的 timeout, 10 秒)`，不压到 3 秒：10 秒是「慢 server 拖住整条命令」与「正常的冷启动（`npx` 首次下载）被误判」之间的老折中，压低只会让进程内模式下几乎每个冷启动都落在 `starting`，而又没有谁去完成它。到点的仍标 `starting`（没有确定性失败），行末写 `via sync <provider>`，因为 `via sync` 等 server 的整个 `timeout` 并写缓存。
  - `via sync` 不是发现类命令：并行拉取，每个 server 等它的 `timeout`（`--timeout` 覆盖），不受上面两个上限限制，因为它的用途就是把慢 server 预热进缓存（[getting-started.md](../guides/getting-started.md)）。
  - `via prompt` 的 `Providers:` 行照常列出 `starting`、`failed` 的 provider：名字来自配置，不依赖目录。
- 命中缓存时仍会在本地解析该 server 的凭证引用，缺失就按「需要鉴权」处理，并让输出脱敏知道这些值；不发起网络请求。未信任的项目级 server 不读缓存，也不拉取。
- `env`、`headers` 的值按配置里的写法参与哈希：凭证引用（`env:`、`file:`、`keychain:`、`cmd:`）只用引用文本，不解析、不落盘它指向的值；字面量用值本身，且只进入单向哈希（同命令、同 env 名而值不同的两个 server——比如用 `MODE` 或 `FS_ROOT` 切换数据集——因此各有各的缓存文件，不会互相覆盖目录）。`catalog/<哈希>.info.json` 与 `.view.json` 沿用同一个哈希。更改键的组成时，旧文件因键不同而自然失效，不需要迁移。
- 0.1 的「身份」只用凭证引用文本参与哈希（引用的值、字面量凭证都不会单独落盘；字面量只进入单向哈希），换一个引用即视为另一份缓存。缓存文件为 `catalog/<哈希>.json`（权限 0600），内容是 `fetchedAt`、原始 `tools/list` 结果，以及 server 在 `initialize` 里声明的能力 `features`（`{"resources": bool, "prompts": bool, "completions": bool, "skills": bool}`，`resources`、`prompts`、`skills` 用于浏览视图的 `also:` 行，`completions` 只用于 prompt `-h` 里的补全提示（[cli.md](cli.md#补全)）；没有这一项的旧文件照常读取，只是不显示该行，刷新一次后出现）、拉取时协商出的协议 `protocol`（`{"version": "2026-07-28", "stateful": false}`，`via servers` 不连接就能显示它，stdio server 据此跳过协议探测，[daemon.md](daemon.md#协议版本与无状态连接)）和 server 给的 `ttlMs`（有的话）；这两项同样可以缺省。缓存键包含 `protocolVersion`（固定了版本时）。
- 经 daemon 时目录的读取、凭证检查和写缓存都在 daemon 里完成（与进程内模式写同一份 `catalog/` 文件）；CLI 只收到原始工具列表，拆分和索引仍在 CLI 侧计算。
- 校验失败且缓存超过 5 分钟时，刷新该 server 的缓存一次再校验（[arguments.md](arguments.md#schema-不可靠时)）。
- 缓存中保存原始 `tools/list` 结果；拆分与索引由它计算，规则升级无需清缓存：计算结果另存为预构建缓存（下节），规则一变它就失效并重新计算。
- server 的自述（`serverInfo` 的 `name`、`title`、`version`、`description`、`websiteUrl` 与 `instructions`，见[server 自述](#server-自述)）存在旁边的 `catalog/<哈希>.info.json`（权限 0600，`{"version", "fetchedAt", "info"}`），与目录同一个 TTL，随每次拉取目录一起写入，只有 `via <provider> -h` 读它。单独存放是因为它很少被读到、内容又由 server 控制：每条浏览命令都读的主文件不解析它。`description` 与 `instructions` 在写入前先脱敏、再截到 500 个字符，超出时记下原长（`descriptionChars`、`instructionsChars`）。
- 缓存文件的第一部分是 `version`、`fetchedAt`、`ttlMs`、`protocol` 和 `features`（有记录时，按这个顺序），工具数组在其后、是文件的末尾；读取时只看前者判断新旧并取出能力声明，数组在有人用到工具定义（调用、参数校验、`-h`）时才解析。

### 预构建缓存

每个一次性的 `via`、`via find`、`via <provider>` 都要把原始 `tools/list` 重新拆分、建索引，冷进程里每个工具约 0.06 ms，几百个工具就是十几毫秒。因此 CLI 把计算结果存在同一目录：`catalog/<哈希>.<名字哈希>.view.json`（权限 0600；第一个哈希与原始缓存文件相同，第二个是 provider 名的短哈希，所以同一个 server 以两个名字出现——比如在两个 agent 框架的配置里——时各有各的文件，不会每次运行都互相覆盖），下次直接读取。早先的写法 `catalog/<哈希>.view.json` 不再读取，写入新文件时顺手删除；刷新或清除某个 server 的缓存时，它的所有预构建文件一并删除。它只是加速，输出必须与重新计算完全一致（快照测试与 `test/cli/view-cache.test.ts` 比较两者）。

文件分两部分，命令用多少读多少：

- **头**：可见工具数（`deny` 之后）。`via` 只需要这一项，不还原任何工具。
- **体**：可见工具的规范名、`resource`/`verb`、`deny` 也会匹配的默认写法与叶子写法、签名（每个参数的名字、是否必填，以及[签名里的类型与枚举](#via-provider-resource)：`usage:` 行写 `<num>`、`get|list` 的那部分，建库时从各参数的 schema 读出）、描述、只读/破坏性提示、参数名、[调用示例](#搜索)，以及 `via find` 用的检索词频；是一个 JSON 字符串，第一次访问工具时才解析。工具定义（schema）不存：还原出来的工具在第一次读 `def` 时才去原始缓存里取，所以浏览不会解析任何 schema，调用只解析所涉 provider 的那一份。
  - **调用示例只在需要时写入**：它要读整份 schema 并加载生成示例的代码，而浏览（`via`、`via <provider>`、`via <provider> <resource>`）用不到，所以由浏览建出的文件不含示例（头里的 `ex` 为 0），第一个需要示例的 `via find`（没有 `--brief`）把该 provider 的文件带着示例重写一次（`ex` 为 1），之后的 `find` 与浏览都不再读 schema。示例按运行平台的引用规则写成（[Windows 分支](arguments.md#调用示例)），文件记下是哪一类（`win` 或 `posix`），另一类的文件视为未命中。

只有下列各项都与本次一致才使用，否则按原样重新计算并写回（尽力而为，写不进去不影响命令）：

| 项 | 含义 |
| --- | --- |
| 规则指纹 | 构建时算出的「版本 + `data/*.json` + `src/catalog/` 的源码」哈希；从源码运行（测试）时取数据文件的哈希。改动词表、停用词表或命名代码，旧文件即作废（文件布局变化另有 `v` 版本号，从源码运行时靠它作废旧文件） |
| 原始列表 | 该列表的 `fetchedAt`（任何重新拉取都会变）与原始缓存文件的文本长度；列表不是读自缓存文件时比较工具个数 |
| 其他构建输入 | provider 名、别名、`rename`、`deny`（正则的源码与标志） |

文件里是工具名、参数名、描述和检索词，与原始缓存同一类内容；不含任何凭证值（字面量或引用）。经 daemon 时，CLI 在请求里带上预构建缓存对应的 `fetchedAt`，daemon 的列表恰好是这一份就不再传输整份列表（[daemon.md](daemon.md#cli-与-daemon-的协议)）。

## 浏览视图

每一级都应当控制在一屏以内，并在末尾提示下一步命令。

### `via`

```console
$ via
9 providers · 214 tools · 1 needs auth (linear)
github      42 tools
sentry       8 tools
exa         12 tools
context7     6 tools
linear      needs auth
playwright  21 tools
→ via <provider> to browse · via find <query> to search
```

- 第一行：provider 数、可见工具数、异常状态，按 `needs auth`、`starting`、`failed`、`untrusted` 的顺序，每种带 provider 名：`9 providers · 214 tools · 1 starting (slow) · 1 failed (dead)`。
- 每个 provider 一行，按名字排序，第二列是可见工具数。
- 没有拿到目录的 provider 仍然列出，第二列写成状态，状态名固定为下面五个之一（代码里是导出的联合类型 `ProviderStatus`，`-o json` 的 `status` 字段用同样的名字，`ok` 表示有目录）：

| 状态 | 含义 | 第二列 |
| --- | --- | --- |
| `needs auth` | 没有凭证，或 server 拒绝了凭证（退出码 4） | `needs auth` |
| `starting` | 等待到点，但没有确定性失败：server 还在启动（`npx`、`uvx` 首次下载），或连接超时。daemon 仍在后台连接 | `starting · retry in a moment`；进程内模式没有后台，写 `starting · via sync <provider>` |
| `failed` | 确定性失败：子进程退出、命令不存在或不可执行（`ENOENT`、`EACCES`）、握手被拒、HTTP 错误、连接被拒 | `failed · <原因首行>` |
| `untrusted` | 未信任的项目级 server，没有启动也没有发请求 | `untrusted` |

- `failed` 的原因取错误信息的第一行：去掉 `cannot start <provider>:` 前缀（行首已经是 provider 名），按「内容」档脱敏（[output.md](output.md#脱敏的范围)），折成一行，控制字符、双向控制符与零宽字符写成 `\uXXXX`，超过 80 个字符截断并以 `…` 结尾。完整信息见 `via doctor`。
- `starting` 的意思是「稍后重试」：agent 读到它不应放弃这个 provider。`failed` 才是需要人看一眼的问题。超时一律归为 `starting`（连接超时、请求超时），不论是 daemon 里的还是进程内的；只有明确的失败才是 `failed`。
- **`-o json`**：`{"providers": [{"provider", "tools", "status"}]}`，顺序同文本。`status` 为 `ok`、`needs auth`、`starting`、`failed`、`untrusted`（与上表同名；目录有新的状态时在这里追加同名字符串，`ok` 不变）；`tools` 是可见工具数，状态不是 `ok` 时没有目录可数，为 `0`。字段全部来自[预构建缓存](#预构建缓存)的头，不读 schema。末尾的 `→` 提示与「没有配置任何 server」的说明写 stderr，stdout 只有 JSON。

### `via <provider>`

```console
$ via github
issue          read · write · list · search
pull-request   read · create · list · merge
file           create-or-update · push · delete
commit         get · list
… 14 more · via github --all
```

- 每个资源一行，动作内联，按资源名排序；一行内的动作按 `tools/list` 中的先后顺序排列。
- 叶子工具在资源行之后：`tools: search · fetch`，按 `tools/list` 顺序，超过 12 个时截断并提示 `--all`。
- 资源行数超过一屏（默认 20 行）时截断，提示 `… N more · via <provider> --all`，位于叶子工具行之前。
- 需要 `--yes` 的动作加标记（如 `delete!`），不区分来源（server 声明的、推断的、配置要求的；区分在资源视图与 `-h` 里），只读资源不加标记。
- server 声明了 MCP 资源、prompt 或技能（`2026-07-28` 且声明了 `io.modelcontextprotocol/skills`）时，叶子工具行之后多一行 `also: via resources <provider> · via prompts <provider> · via skills <provider>`（只列出声明了的）。这是 agent 发现这几类内容的唯一入口，所以 `via prompt` 的说明文本不需要提它们。
- 最后一行提示下一步：`→ via <provider> <resource> for signatures`。
- **`-o json`**：`{"provider", "resources": [{"name", "verbs": [...]}], "tools": [...], "also": {"resources", "prompts", "skills"}}`。`resources` 与 `verbs` 的顺序同文本，`tools` 是叶子工具名，`also` 是三个布尔值（server 是否声明了这类内容，与文本的 `also:` 行同源）。JSON 是完整的：文本视图为一屏而做的截断（`… N more`、`--all`）不适用，也没有 `!` 标记（危险与否在资源视图的 `destructive` 字段里）。`→` 提示写 stderr。

### server 自述

server 在握手里给出的 `instructions`、`serverInfo.description`、`websiteUrl`（还有 `title` 与 `version`）有时说明了工具之间的用法约束，但它们占 token，而且内容由 server 控制，是提示注入的入口。决定（[ADR 0021](../adr/0021-server-self-description-and-completion.md)）：

- **只出现在 `via <provider> -h`**，在 provider 视图之前，不进默认的 `via <provider>`、`via <provider> <resource>`、`via find` 的索引与结果、`via prompt` 的说明，也不影响搜索排序。要用的 agent 主动问，不用的不付 token。
- 格式：先是一行标签 `from the server (its own text, not via's):`，之后每行缩进两格，依次是 `name:`（`title` 或 `name`，加 `version`）、`description:`、`website:`、`instructions:`；一行放得下的写在标签后，多行的缩进四格成块。从来没有任何一行从第 0 列开始，所以这些文字不能伪造 `next:`、`error:`、`·` 或 `→` 行。server 什么都没给时只有 `name`；连 `name` 也没有时写 `(it published no description or instructions)`。
- 处理：先按「内容」档脱敏（[output.md](output.md#脱敏的范围)，写缓存之前就脱敏，截断不会留下半个凭证）；再截到 500 个字符（按码点，不拆代理对），被截断时加一行 `(instructions cut at 500 of 1832 characters)`；除换行与制表外的控制字符、双向控制符与零宽字符写成可见的 `\uXXXX`（`\r\n` 归一为 `\n`）。
- 数据来源是缓存里的 `info.json`；没有（旧缓存，或写不进缓存）时 `-h` 向 server 刷新一次，失败时 stderr 警告 `could not ask <provider> what it says about itself`，仍显示 provider 视图。`-o json` 输出 `{"provider", "server": {…}}`（字段同上，已脱敏，不含 provider 视图）。
- **`via <provider> -h --all`**：在自述与 provider 视图（此时不截断）之后，空一行，列出该 provider 全部可见工具的 `usage:` 行（与 `<资源>:<动作> -h` 的第一块相同，不含参数描述，按 `tools/list` 的顺序，长的照常折行），给上下文预算大的 agent 用一次往返换掉 N 次 `-h`。这是浏览视图里唯一读 schema 的命令（解析该 provider 的原始列表）。`-o json` 时输出工具详情的数组，每项就是那个工具的 `-h -o json`（`tool`、`rawName`、`description`、`readOnly`、`destructive`、`inputSchema`、`outputSchema`，[output.md](output.md#错误)），不含自述。没有 `--all` 时行为不变。
- 它是 server 的数据，不是 via 的说明：via 不解释它，也不据此改变任何行为（[security.md](security.md)）。

### `via <provider> <resource>`

```console
$ via github issue
issue:read     owner, repo, issue-number, method       Get issue details
issue:write    owner, repo, method, [title], [body]     Create or update issue
issue:list     owner, repo, [state], [labels]          List issues
issue:search   query, [owner], [repo]                  Search issues
→ via github issue:<verb> -h for usage
```

- 每个工具一行：动作、签名、截断到 60 字符的描述（取描述的第一个非空行）。
- 签名中必填参数在前，可选参数加方括号，参数名统一为 kebab-case；各组内按 schema 中 `properties` 的顺序。
- 签名最多显示 6 个参数，必填参数一个不省略，其余可选参数以 `…` 表示，完整参数用 `-h` 查看。
- **类型与枚举**（让 `find` 或这一屏之后不必再 `-h`）：参数名之后写 schema 声明的类型，口径与 `-h` 的 `usage:` 行一致（`<str>`、`<num>`、`<json>`、枚举）：
  - 枚举（`enum`、`const`，或全是常量的 `anyOf`/`oneOf`，值都是字符串、数字或布尔，且 `a|b` 连起来不超过 60 个字符）写 `method=get|get_comments`，可选的写 `[state=open|closed]`；
  - 数字（`integer`、`number`）写 `issue-number:num`；对象写 `filter:json`；几种类型并列写 `id:str|num`（顺序同 schema）；
  - 数组：元素是标量（string、number、integer、boolean）的写元素类型加 `[]`：`todo-ids:str[]`、`ns:num[]`、`flags:bool[]`，元素有几种标量时加括号 `x:(str|num)[]`，可空的数组（`array | null`）同样。不写 `:json`，因为这类参数既可以重复传参（`--todo-ids a --todo-ids b`）、也可以整体写 JSON，`:json` 只提示后一种。不用 `str…`：`…` 在签名里已表示「还有参数」；`[str]` 会与可选参数的方括号混在一起（`[todo-ids:[str]]`）。`str[]` 与 `usage:` 行的 `<str[]>` 是同一个写法，只比 `json` 多一个字符，超过 60 列时照常退回不带类型的写法。对象数组、tuple、嵌套数组和没有声明元素类型的数组仍写 `labels:json`；
  - 布尔：可选的写 `[draft?]`（给了就是开），必填的写 `force:bool`（`?` 在这里表示「可选」，所以必填的不用）；
  - 普通字符串，以及 schema 没说类型的参数，只写名字：`owner` 就是 `owner:str`，不重复；
  - 引用在本地的 `$ref` 照常展开。枚举值里的换行与控制字符写成可见的 `\uXXXX`。
  - 整个签名（含括号与 `…`）超过 60 列时退回不带类型的写法，所有参数仍照原规则显示；所以同一屏里的行可以两种写法并存。必填参数一个不省略的规则不变。
  - 类型来自[预构建缓存](#预构建缓存)，浏览仍然不读 schema。
- **`-o json`**：数组，每项 `{"ref", "provider", "resource", "verb", "rawName", "signature": {"required": [...], "optional": [...]}, "description", "readOnly", "destructive"}`。`ref` 是规范写法（`gh issue:read`），`signature` 是**完整**的参数名（kebab-case，必填在前，不受 6 个的限制，也不带类型），`description` 是完整的描述文字，`readOnly`/`destructive` 是布尔（两者都声明时 `destructive` 为假，同 `[read-only]` 的规则）；`destructive` 为真时多一个字段 `destructiveBy`：`server`（声明了 `destructiveHint`）、`inferred`（server 没声明，via 按原始名里的词推断）、`config`（`confirm.tools`），为假时不出现。三种来源的 `destructive` 都是 `true`，只读 `destructive` 的消费者不受影响。字符串按「内容」档脱敏（[output.md](output.md#脱敏的范围)）。`→` 提示写 stderr。叶子工具（`via find` 的结果里可能有，资源视图里的同名叶子也在内，排在数组末尾）的 `resource` 与 `verb` 为 `null`。
- **同名的叶子工具**：叶子工具的名字单数化之后（逐词，规则同[单数化](naming.md#单数化)）等于这个资源名时，它排在资源自己的工具之后，同样一行（`secrets` 之于资源 `secret`）。列出一个资源的工具常常是个叶子（`secrets` 列出，`secret:delete` 删除），它没有动词，不在任何资源下，不写这一行就看不到。这一行没有 `:`，第一列照样可以直接复制（`via todos secrets`）。叶子被资源挤到原始名时（`acme-search` 之于资源 `search`），按拆分时的叶子名比较，显示现在的名字。这只是提示：资源与叶子在命名上仍是两个名字，解析不变。
- 第一列保持可直接复制的规范写法；工具的 `readOnlyHint` / `destructiveHint` 以 `[read-only]` / `[destructive]` 标在描述之后，两者都声明时只标 `[read-only]`；via 推断的标 `[destructive?]`，`confirm.tools` 要求的标 `[confirm]`（[arguments.md](arguments.md#危险操作)）。

## 搜索

`via find <查询>` 跨 provider 搜索，排序规则沿用 Asterlane 的做法并增加多词检索：

1. 规范写法完全匹配；
2. 规范写法前缀匹配；
3. 规范写法包含查询；
4. 多词查询按 BM25 对名称、描述、参数名打分，名称命中权重最高；provider 名按下面的[范围规则](#provider-名与资源词相同)处理，名称完全由查询词组成的工具另加分；
5. 空查询按规范写法顺序列出全部工具。

1–3 是三个层级，所有命中它们的工具排在只命中 BM25 的工具之前；同一层级内按 BM25 分数、再按规范写法排序，保证结果确定。查询大小写不敏感，`/` 视同空格、`_` 视同 `-`，所以 `github/issue:read` 与 `github issue:read` 等价；省略 provider 的 `issue:read` 同样算完全匹配。BM25 比较时，查询词与索引词都先单数化，`issues` 能命中 `issue`；描述中的停用词（`data/stopwords.json`）不进索引。

### provider 名与资源词相同

server 常以它所操作的资源的复数命名（`jobs` 的工具 `create_job`、`jobs`、`close_jobs`），这时每个工具的规范写法都带 provider 前缀，单数化后与查询里的资源词（`job`）相同。若 provider 名照常进名称字段，这个词对该 provider 的每个工具都命中，idf 被压平，名称权重最高也就失去了区分作用，只在描述里多提了几次这个词的工具会排到真正叫这个名字的工具前面（实测：`list jobs` 的第 1 名是 `jobs issues`，叶子 `jobs` 第 6）。所以 BM25 这一级有两条规则，都是通用的，不针对任何 server：

- **provider 名是范围，不是词**：provider 名的词（单数化后；`google-drive` 是 `google`、`drive`）不进该 provider 工具的名称字段索引，工具原始名里的 provider 前缀或后缀也不进（`jobs_create_job` 只索引 `create`、`job`）；但工具自己的规范名或原始名里另外含有这个词时照常索引（资源 `job:create`、叶子 `jobs`、`list_acme_accounts` 里的 `acme`）。查询词若等于某个 provider 名的词，该 provider 的所有工具各得一份相同的加分（名称字段命中，idf 取「这个 provider 的工具数」），所以 `github create issue` 仍偏向 github，同时这个词照常按工具自己的名称、描述、参数名计分。文档长度仍计入 provider 名的词，长度归一化不变。
- **名称被查询覆盖**：工具原始名的每个词（去掉开头的 provider 名；末尾的 provider 名保留，因为它是品牌还是资源——`close_jobs` 对 `jobs`——由拆分规则决定，而这条规则不能依赖拆分）都在查询里（或是查询词的同义词 / 词形还原结果）时，每个词在 BM25 分数上加 `0.3 + 0.25 × ln(1 + (N − df + 0.5) / (df + 0.5))`，其中 `N` 是工具总数，`df` 是原始名里有这个词的工具数。第一项不随 `df` 变化：同一个 server 里叫这个词的工具越多，第二项越小，而单个 server 里资源词几乎出现在所有描述里，文档 idf 接近 0，只靠第二项压不过描述里提到该词的工具。`list jobs` 覆盖叶子 `jobs`，`create job` 覆盖 `create_job`（不论拆成 `job:create` 还是别的写法），不覆盖 `create_topic`。加分只在第 4 级内改变分数，不跨越第 1–3 级；它只看原始名，所以工具是叶子还是 `resource:verb`、动词表怎样变，都不改变谁得到加分（`rename` 也不影响）。

结果默认 10 条，每条一行，格式同资源视图（含[类型与枚举](#via-provider-resource)）但带 provider 前缀；每条下面缩进两格带一行 `example:`，就是 `-h` 会给的那一行（同一个函数生成，遵守[调用示例](arguments.md#调用示例)的全部规则，包括 Windows 分支），所以大多数情况下 `find` 之后就能直接调用，省掉一次 `-h`。没有示例的工具（没有参数，或必填参数写不出安全的值）不带这一行。

```console
$ via find "read issue"
gh issue:read   owner, repo, issue-number:num, method=get|get_comments  Get issue details [read-only]
  example: via gh issue:read --owner text --repo text --issue-number 1 --method get
```

- `--brief` 去掉 `example:` 行，回到每条一行。
- `-o json` 输出资源视图那样的数组（[字段](#via-provider-resource)），每项多一个 `example`（命令，不含 `example:` 标签；没有示例时不出现），`--brief` 时没有这个字段。`-o raw` 退出码 2。
- 代价：十条结果多约 10 行，平均每行约 70 个字符（约 18 个 token），一次 `find` 多约 170 个 token；省的是一次 `-h` 往返。示例来自[预构建缓存](#预构建缓存)，缓存里已有时不读 schema，不影响冷启动；第一个不带 `--brief` 的 `find` 在缓存刷新后要把各 provider 的示例补进去（读一次 schema，每次刷新一次；实测 1,000 个工具、50 个 provider 约多 100 ms，浏览命令不受影响）。

有 provider 没有拿到目录时，结果照常输出（退出码 0），stderr 分两行警告，因为这两种情况的处理不同（`starting` 稍后重试，其余需要看一眼）：

```text
warning: 1 provider still starting: slow (retry in a moment)
warning: 1 provider could not be searched: dead (see via, via doctor)
```

`still starting` 一行列出 `starting` 的 provider，括号里经 daemon 时是 `retry in a moment`，进程内模式是 `no daemon keeps connecting: via sync <provider…>`；`could not be searched` 一行列出其余的（`needs auth`、`failed`、`untrusted`）。某一类没有时不出现那一行；provider 名按字母序，复数按个数（`1 provider`、`2 providers`）。

### 同义词扩展（默认开启，确定性）

agent 的查询是自然语言（「删除工单」「合并 PR」），用词常与工具名不同。第 4 级的 BM25 因此在查询侧做数据驱动的扩展（[ADR 0011](../adr/0011-find-synonym-expansion-and-optional-embeddings.md)），不调用模型、不联网，规则在 `data/synonyms.json`（[格式](../development/data-files.md#synonymsjson)）：

- **同义组**：动词（`remove`/`delete`/`destroy`/`drop`…，`get`/`fetch`/`retrieve`/`read`…，`find`/`search`/`query`/`lookup`…）和资源（`issue`/`ticket`、`pr`/`pull request`/`merge request`、`repo`/`repository`…）各列一批等价词；组内成员可以是多词短语，查询里出现短语时整体匹配。
- **词形还原**：单数化之外，按数据文件里的后缀规则（`ing`、`ed`、`ion`…）为查询词生成可能的原形（`creating` → `create`、`running` → `run`），只有在索引词表里确实存在的才采用，所以猜错无副作用。
- **计分**：每个查询词的得分取「词本身」与「它的最佳替代词」中较高者；替代词按权重打折（动词 0.35，资源 0.6，词形还原 0.8），并且其 IDF 不超过它所代表的查询词，所以带原词的工具总是排在只带同义词的工具之前，罕见缩写（`pr`）也压不过它代表的常见词（`pull request`）。已经出现在查询里的词不会再作为替代词重复计分。
- **口语填充词**（`i`、`want`、`please`…）在查询侧丢弃，除非查询只剩它们。
- **不变的部分**：第 1–3 级的规范写法匹配、并列规则（同层级按分数、再按规范写法）、空查询都不变；同义词只改变第 4 级的分数，不会让工具越过规范写法命中的工具，也不影响任何规范名。

效果用 `npm run eval:search` 衡量：`test/fixtures/search/eval.json` 是 98 条自然语言查询到期望规范名的集合（调参用），`heldout.json` 是之后另写、从未用于调参的 30 条，对 `test/fixtures/tools/` 的 15 个 server 报告 recall@1、recall@5 与 MRR；回归测试断言不低于词法基线，并锁定实测下限。`provider-scope.json` 是 12 条 provider 名等于资源复数的查询（[范围规则](#provider-名与资源词相同)），在 15 个 server 之外再加虚构的 `test/fixtures/other/jobs.json` 上评测，要求全部排第 1。

### embedding 检索（可选，默认关闭）

在用户配置里设置 `search.semantic` 后，`via find` 额外用 embedding 与 BM25 融合排序（[config.md](config.md#searchsemantic)）。它调用第三方模型，是对「发现逻辑确定性」的唯一例外，所以有以下限制：

- **范围**：只作用于 `via find <非空查询>`；`via`、`via <provider>`、`via sync` 等不触碰它。
- **embedding 的内容**：`<provider> <资源:动作>: <描述前 600 字符> (parameters: <参数名>)`，被 `deny` 隐藏的工具不在目录里，因此不会发出；查询原文也会发往端点（[security.md](security.md#embedding-检索的数据外流)）。
- **缓存**：用户缓存目录下 `embeddings/<端点+模型+维度的哈希>.bin`（目录 0700、文件 0600，原子替换），内容是按文本哈希索引的单位向量；只含哈希与浮点数，不含端点、凭证或文本。目录里某个工具的文本变了，只重新请求这一个；超过 20,000 条时丢弃本次未用到的。
- **请求**：`POST <url>/embeddings`（`url` 已以 `/embeddings` 结尾则原样使用），JSON `{ model, input: [文本…], encoding_format: "float", dimensions? }`，每批 64 条、至多 4 批并行；响应取 `data[].embedding`（按 `index` 排序）。不跟随重定向。
- **融合**：第 1–3 级仍在最前；第 4 级用 RRF（`1/(60+排名)` 之和）融合 BM25 排名与语义排名（余弦相似度前 `max(3×条数, 30)` 名），同分按规范写法排序。同一份缓存、同一个查询，结果相同。仅语义命中的工具也会出现在第 4 级。
- **超时与退回**：缓存已完整时整个语义步骤的期限是 `timeout`（默认 3 秒）；有工具要补 embedding 时是 `indexTimeout`（默认 30 秒）。期限内没完成（超时、网络错误、HTTP 错误、凭证缺失、响应格式不对、仍有工具没有 embedding）就整体退回词法排序——不会用残缺的向量排名——已经取得的向量照常写入缓存，下一次 `find` 接着补。退回时在 stderr 追加一行 `· semantic unavailable: <原因> · lexical results`，退出码不变；原因只含状态码或错误码，不含响应体、请求头和端点。第一次补全缓存时输出 `· semantic · embedded <N> tools (cached)`。
- **daemon**：目录的拆分和索引在 CLI 侧计算，embedding 也在 CLI 进程内完成并走磁盘缓存，daemon 不持有它们；用 daemon 与否结果相同。
- **冷启动**：实现是独立分块，只在配置了 `search.semantic` 的 `find` 里加载；关闭时零开销。

## 找不到时

按段（provider、资源、动作分别）计算编辑距离，给出至多 3 个 did you mean；仍无结果时提示 `via find <关键词>`。退出码 3。`next:` 指向第一个候选的 `-h`。

**资源与动作找不到**时（`资源:动作`，或 `list-todos` 这样的「动词-名词」写法：按[拆分规则](naming.md)解析成 `资源:动作`，之后同样处理），候选按下面的顺序排，取前 3 个；第 1 项不为空时只给第 1 项，笔误就回答它想写的那个：

1. 资源下与输入的动作只差一个笔误的动作（`issue:raed` → `issue:read`）。输入的动作本身是动词表里的动词时（`get`、`set`）是另一个动作，不是笔误，不进这一项；
2. 单数化之后名字等于这个资源的**叶子工具**（`todo:list`、`todo:get`、`todos:list`、`list-todos` 都指向叶子 `todos`）：列出对象的工具常常是个没有动词的叶子，编辑距离够不着它；
3. 资源下的其他动作，按 `tools/list` 的顺序，标了 `destructiveHint` 的排在最后；
4. 资源不存在时，才用按段编辑距离近的 `资源:动作`。只靠拼写相近、或者只共享 provider 词的名字不会排到资源词相同的候选前面。

输入里的资源词先单数化再比较（`secrets:list` 与 `secret:list` 一样）。资源之后多出的词（`via todos secret list`）同样先列出这个叶子工具（[cli.md](cli.md#资源之后的词)）。

**provider 找不到**时不指向 `via find`：provider 总数很少（几个到十几个），直接列出来比再跑一条命令便宜，而 agent 常把 server 叫 `gh` 写成 `github`，编辑距离够不着：

```console
$ via github issue:read --owner acme --repo api --issue-number 1 --method get
error: no such provider: github
providers: el · fs · gh · slow
next: via
```

- `providers:` 一行按字母序列出全部 provider（每个词按[可粘贴的命令行](output.md#可粘贴的命令行)引用），超过 12 个时只列前 12 个，后面写 `… N more · via`。有 did you mean 时它在 `providers:` 之前（`did you mean: gh`）。
- `next:` 是 `via <最接近的 provider>`（有 did you mean 时；内置子命令的近似拼写如 `via sevrers` 同理）或 `via`，两者都是立刻能运行、能看到下一步的命令；不再是 `via find <输入>`。
- 没有配置任何 server 时仍是 `error: no such provider: gh (no servers are configured)`，`next: via servers`。输入的名字作为文本回显（控制字符写成转义），不会进入 `next:`。
- 资源与工具找不到的规则不变（did you mean 或 `via find <provider> <词>`）。资源之后多出的词见 [cli.md](cli.md#资源之后的词)。
