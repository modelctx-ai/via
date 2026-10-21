# 发现：目录、浏览与搜索

provider 就是配置里的 server，按名字原样列出，不做分类：模型自己知道 `github` 是做什么的，把推断出来的分组写进视图只会多一层可能与实际不符的间接（[ADR 0014](../adr/0014-drop-the-domain-view.md)）。

## 目录构建流程

1. **拉取**：对每个 server 调用 `tools/list`（分页拉全）。
2. **确定 provider**：取 server 别名（或配置中的 `alias`），统一为小写 kebab-case；与内置子命令重名时必须改名。
3. **拆分工具名**：每个工具拆成 `资源:动作`，拆不开的作为叶子工具（[naming.md](naming.md)）。
4. **建索引**：provider、资源、动作、原始名、描述、参数名分词后建倒排索引，供 `via find` 使用。
5. **过滤**：`deny` 规则命中的工具从视图和索引中移除（[config.md](config.md#deny)）。

### 缓存

- 缓存键：server 定义的哈希（命令、参数、URL、相关 env 名，不含凭证值）+ 身份（鉴权主体的稳定标识，无法获得时用凭证引用本身的哈希）。
- 位置：用户缓存目录下的 `catalog/`，权限 0700。
- TTL 默认 24 小时；daemon 在线时订阅 `notifications/tools/list_changed` 实时刷新：收到通知后重新拉取该 server 的 `tools/list`，同时更新 daemon 内存里的副本和这里的磁盘缓存，下一次浏览、`find` 或调用就能看到变化（[daemon.md](daemon.md#daemon-持有的状态)）。
- `via sync [provider]` 强制刷新。
- 进程内模式（0.1）下，缓存是 `tools/list` 的唯一来源：`via <provider>` 只读取、必要时只拉取该 provider；`via`、`via find`、`via prompt` 并行处理全部 server，单个 server 的拉取超时取 `min(server 的 timeout, 10 秒)`（`--timeout` 覆盖），拉起 stdio server 与握手的时间也算在内，所以卡在握手里的 server 不会拖住整条命令。拉取失败不中止：该 provider 仍然列出，标记 `needs auth`、`failed` 或 `untrusted`（[浏览视图](#via)）。
- 命中缓存时仍会在本地解析该 server 的凭证引用，缺失就按「需要鉴权」处理，并让输出脱敏知道这些值；不发起网络请求。未信任的项目级 server 不读缓存，也不拉取。
- 0.1 的「身份」只用凭证引用文本参与哈希（引用的值、字面量凭证都不会单独落盘；字面量只进入单向哈希），换一个引用即视为另一份缓存。缓存文件为 `catalog/<哈希>.json`（权限 0600），内容是 `fetchedAt`、原始 `tools/list` 结果，以及 server 在 `initialize` 里声明的能力 `features`（`{"resources": bool, "prompts": bool}`，用于浏览视图的 `also:` 行；没有这一项的旧文件照常读取，只是不显示该行，刷新一次后出现）。
- 经 daemon 时目录的读取、凭证检查和写缓存都在 daemon 里完成（与进程内模式写同一份 `catalog/` 文件）；CLI 只收到原始工具列表，拆分和索引仍在 CLI 侧计算。
- 校验失败且缓存超过 5 分钟时，刷新该 server 的缓存一次再校验（[arguments.md](arguments.md#schema-不可靠时)）。
- 缓存中保存原始 `tools/list` 结果；拆分与索引由它计算，规则升级无需清缓存：计算结果另存为预构建缓存（下节），规则一变它就失效并重新计算。
- 缓存文件的第一部分是 `version`、`fetchedAt` 和 `features`（有记录时），工具数组在其后、是文件的末尾；读取时只看前者判断新旧并取出能力声明，数组在有人用到工具定义（调用、参数校验、`-h`）时才解析。

### 预构建缓存

每个一次性的 `via`、`via find`、`via <provider>` 都要把原始 `tools/list` 重新拆分、建索引，冷进程里每个工具约 0.06 ms，几百个工具就是十几毫秒。因此 CLI 把计算结果存在同一目录：`catalog/<哈希>.view.json`（权限 0600，哈希与原始缓存文件相同），下次直接读取。它只是加速，输出必须与重新计算完全一致（快照测试与 `test/cli/view-cache.test.ts` 比较两者）。

文件分两部分，命令用多少读多少：

- **头**：可见工具数（`deny` 之后）。`via` 只需要这一项，不还原任何工具。
- **体**：可见工具的规范名、`resource`/`verb`、签名、描述、只读/破坏性提示、参数名，以及 `via find` 用的检索词频；是一个 JSON 字符串，第一次访问工具时才解析。工具定义（schema）不存：还原出来的工具在第一次读 `def` 时才去原始缓存里取，所以浏览不会解析任何 schema，调用只解析所涉 provider 的那一份。

只有下列各项都与本次一致才使用，否则按原样重新计算并写回（尽力而为，写不进去不影响命令）：

| 项 | 含义 |
| --- | --- |
| 规则指纹 | 构建时算出的「版本 + `data/*.json` + `src/catalog/` 的源码」哈希；从源码运行（测试）时取数据文件的哈希。改动词表、停用词表或命名代码，旧文件即作废 |
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

- 第一行：provider 数、可见工具数、异常状态（需要鉴权、连接失败）。
- 每个 provider 一行，按名字排序，第二列是可见工具数。
- 需要鉴权或连接失败的 provider 仍然列出，第二列写成状态：`needs auth`、`failed`、`untrusted`。

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
- 危险动作可以加标记（如 `delete!`），只读资源不加标记。
- server 声明了 MCP 资源或 prompt 时，叶子工具行之后多一行 `also: via resources <provider> · via prompts <provider>`（只列出声明了的）。这是 agent 发现这两类内容的唯一入口，所以 `via prompt` 的说明文本不需要提它们。
- 最后一行提示下一步：`→ via <provider> <resource> for signatures`。

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
- 第一列保持可直接复制的规范写法；工具的 `readOnlyHint` / `destructiveHint` 以 `[read-only]` / `[destructive]` 标在描述之后，两者都声明时只标 `[read-only]`（[arguments.md](arguments.md#危险操作)）。

## 搜索

`via find <查询>` 跨 provider 搜索，排序规则沿用 Asterlane 的做法并增加多词检索：

1. 规范写法完全匹配；
2. 规范写法前缀匹配；
3. 规范写法包含查询；
4. 多词查询按 BM25 对名称、描述、参数名打分，名称命中权重最高；
5. 空查询按规范写法顺序列出全部工具。

1–3 是三个层级，所有命中它们的工具排在只命中 BM25 的工具之前；同一层级内按 BM25 分数、再按规范写法排序，保证结果确定。查询大小写不敏感，`/` 视同空格、`_` 视同 `-`，所以 `github/issue:read` 与 `github issue:read` 等价；省略 provider 的 `issue:read` 同样算完全匹配。BM25 比较时，查询词与索引词都先单数化，`issues` 能命中 `issue`；描述中的停用词（`data/stopwords.json`）不进索引。

结果默认 10 条，每条一行，格式同资源视图但带 provider 前缀，大多数情况下 `find` 之后就能直接调用，省掉一次 `-h`。

### 同义词扩展（默认开启，确定性）

agent 的查询是自然语言（「删除工单」「合并 PR」），用词常与工具名不同。第 4 级的 BM25 因此在查询侧做数据驱动的扩展（[ADR 0011](../adr/0011-find-synonym-expansion-and-optional-embeddings.md)），不调用模型、不联网，规则在 `data/synonyms.json`（[格式](../development/data-files.md#synonymsjson)）：

- **同义组**：动词（`remove`/`delete`/`destroy`/`drop`…，`get`/`fetch`/`retrieve`/`read`…，`find`/`search`/`query`/`lookup`…）和资源（`issue`/`ticket`、`pr`/`pull request`/`merge request`、`repo`/`repository`…）各列一批等价词；组内成员可以是多词短语，查询里出现短语时整体匹配。
- **词形还原**：单数化之外，按数据文件里的后缀规则（`ing`、`ed`、`ion`…）为查询词生成可能的原形（`creating` → `create`、`running` → `run`），只有在索引词表里确实存在的才采用，所以猜错无副作用。
- **计分**：每个查询词的得分取「词本身」与「它的最佳替代词」中较高者；替代词按权重打折（动词 0.35，资源 0.6，词形还原 0.8），并且其 IDF 不超过它所代表的查询词，所以带原词的工具总是排在只带同义词的工具之前，罕见缩写（`pr`）也压不过它代表的常见词（`pull request`）。已经出现在查询里的词不会再作为替代词重复计分。
- **口语填充词**（`i`、`want`、`please`…）在查询侧丢弃，除非查询只剩它们。
- **不变的部分**：第 1–3 级的规范写法匹配、并列规则（同层级按分数、再按规范写法）、空查询都不变；同义词只改变第 4 级的分数，不会让工具越过规范写法命中的工具，也不影响任何规范名。

效果用 `npm run eval:search` 衡量：`test/fixtures/search/eval.json` 是 98 条自然语言查询到期望规范名的集合（调参用），`heldout.json` 是之后另写、从未用于调参的 30 条，对 `test/fixtures/tools/` 的 15 个 server 报告 recall@1、recall@5 与 MRR；回归测试断言不低于词法基线，并锁定实测下限。

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

按段（provider、资源、动作分别）计算编辑距离，给出至多 3 个 did you mean；仍无结果时提示 `via find <关键词>`。退出码 3。
