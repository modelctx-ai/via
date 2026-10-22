# 数据文件

规则类内容放在 `data/` 下，打包时内联，用户配置可以覆盖。以下格式是草案，实现时以 JSON Schema（放在 `data/schema/`）为准；`verbs`、`stopwords`、`noise`、`columns`、`synonyms` 的 schema 已经提供，测试会逐个校验。

## verbs.json

动词表与单数化例外，供[工具名拆分](../spec/naming.md)使用。

```json
{
  "version": 2,
  "verbs": [
    "get", "list", "create", "update", "delete", "search", "send", "run",
    "fetch", "read", "write", "add", "remove", "merge", "trigger", "query",
    "move", "duplicate", "restore", "cancel", "navigate", "click",
    "push", "call", "describe", "batch", "enable", "disable", "fork",
    "resolve", "unresolve", "edit", "modify", "append", "download", "upload",
    "install", "close"
  ],
  "conjunctions": ["or", "and"],
  "singularExceptions": ["data", "news", "series", "status", "analytics"],
  "singularIrregular": { "statuses": "status", "caches": "cache" }
}
```

- `version` 每次改动加一；改动必须写进 `CHANGELOG.md`，并列出受影响的规范写法。
- `singularExceptions`：原样保留的词；`singularIrregular`：通用单数化规则处理不了的「复数 → 单数」。
- 动词表的取舍：收入**通用的动作词**（几乎不作名词用、不特属于某类 server），并要求在全部夹具（`tools/` 与 `other/`）上逐词试过，只让原来的叶子变成 `资源:动作`、不改变任何已有的规范名、新拆出的资源里没有 `to`、`for` 之类的连接词；既是常用名词又是动词的词（`post`、`type`、`check`、`request`）会把「名词_动作」错拆，没有反例样本前不收。`npm run split-stats` 统计夹具上退回叶子工具的比例与原因（[bench/results/0.4-split.md](../../bench/results/0.4-split.md)），给取舍提供依据。
- 动词表的改动用 `npm run split-diff` 离线检查：用当前规则重新拆分 `test/fixtures/` 里的真实 `tools/list` 快照，与 `test/fixtures/splits/` 中入库的基线对比，列出规范写法的变化；确认后加 `--update` 更新基线。

## stopwords.json

`via find` 建索引时，工具描述里要忽略的泛用英文词（[搜索](../spec/discovery.md#搜索)）。

```json
{
  "version": 1,
  "words": ["the", "and", "with", "about", "available"]
}
```

- 只作用于工具描述的索引，不影响名称与参数名：那些位置上的词都值得检索。
- 动词表里的词不需要写在这里：同一个词在多个工具里重复出现时，索引自然把它摊薄。
- 新增词时在 `test/data.test.ts` 的约束下保持单个小写词，且不要与动词表重复。

## noise.json

渲染时默认去掉的字段，供[输出](../spec/output.md#渲染流程)使用。

```json
{
  "version": 1,
  "fields": ["node_id", "_links", "*_api_url", "*_url_template", "gravatar_id"],
  "keep": ["url", "html_url"]
}
```

- 支持 `*` 通配；`keep` 优先于 `fields`，也优先于按 server 配置的 `noise` 追加项。

## columns.json

表格渲染时怎样选列，供[输出](../spec/output.md#渲染流程)使用。

```json
{
  "version": 1,
  "maxColumns": 6,
  "priority": ["name", "title", "id", "number", "state", "url"],
  "labelKeys": ["name", "title", "login", "label", "identifier", "key", "id"]
}
```

- `maxColumns`：一张表最多显示的列数。
- `priority`：列数超过上限时优先保留的字段名，靠前的优先；用完后按字段在对象中出现的顺序补满。
- `labelKeys`：对象出现在表格单元格里时，用其中第一个有标量值的字段代表它（如 `user` 显示为 `octocat`）；都没有则显示紧凑 JSON。

## synonyms.json

`via find` 的查询侧同义词扩展（[discovery.md](../spec/discovery.md#同义词扩展默认开启确定性)，[ADR 0011](../adr/0011-find-synonym-expansion-and-optional-embeddings.md)）。Schema 为 `data/schema/synonyms.schema.json`。

```json
{
  "version": 1,
  "weights": { "verb": 0.35, "resource": 0.6, "stem": 0.8 },
  "queryStopwords": ["i", "me", "my", "want", "please"],
  "verbs": [
    ["remove", "delete", "destroy", "drop", "erase", "trash"],
    ["get", "fetch", "retrieve", "read", "obtain", "load"],
    ["find", "search", "query", "lookup", "look up", "locate"]
  ],
  "resources": [
    ["issue", "ticket", "bug"],
    ["pr", "pull request", "merge request"],
    ["repo", "repository"]
  ],
  "suffixes": [
    { "suffix": "ing", "append": ["", "e"], "undouble": true },
    { "suffix": "ation", "append": ["ate", "e", ""] }
  ]
}
```

- `verbs`、`resources`：每个内层数组是一组**等价**词（团，不传递：一个词可以出现在多组里，扩展取各组的并集）。成员是小写词或空格分隔的短语；加载时逐词单数化，和索引词一致，所以写单数即可。
- `weights`：替代词相对原词的权重，都在 (0, 1]。`verb`、`resource` 是同义组的权重，`stem` 是词形还原的权重。权重在 fixture 评测上调参；改动后运行 `npm run eval:search`，指标不得下降。
- `queryStopwords`：查询侧丢弃的口语词，只在查询里还有其他词时生效。不得包含 `verbs.json` 里的动词（测试校验）。
- `suffixes`：词形还原。查询词以 `suffix` 结尾时，去掉后缀，再依次接上 `append` 里的每个尾巴（`""` 表示什么都不接）得到候选原形；`undouble` 为真时，词干以双写辅音结尾（`running` → `runn`）也尝试去掉一个。词干至少 3 个字符；候选只有在索引词表里存在时才采用。
- 组应当是通用英文与开发工具里的常识，不是为某个 server 写的补丁（[ADR 0007](../adr/0007-no-gateway-specific-adaptation.md)）。同义词只在查询侧生效，不影响规范名：改动这个文件**不会**改变任何 `provider resource:verb`，因此不需要写进 CHANGELOG 的「影响规范写法」，但仍写进 Unreleased，并附 `npm run eval:search` 前后对比。
- 两套评测集的写法：`test/fixtures/search/eval.json`（调参）与 `heldout.json`（只用来估计泛化，不拿它调参）里每条是 `{ "q": 自然语言查询, "group": direct|synonym|phrase, "expect": [可接受的规范写法…] }`，按最佳名次计分。

## frameworks

`data/frameworks/<id>.json`，每个 agent 框架一个文件，描述如何只读解析它的 MCP 配置，以及如何关闭注入。供[配置](../spec/config.md)与 [`via doctor`](../guides/agent-integration.md) 使用。Schema 为 `data/schema/framework.schema.json`；新增文件后还要在 `src/config/frameworks.ts` 的注册表中登记，注册表的顺序即 `sources: auto` 的探测顺序（决定同名冲突时谁优先）。

```json
{
  "id": "vscode",
  "name": "VS Code",
  "configs": [
    { "path": ".vscode/mcp.json", "format": "jsonc", "pointer": "/servers", "scope": "project" },
    { "path": "~/.config/Code/User/mcp.json", "format": "jsonc", "pointer": "/servers", "scope": "user", "platforms": ["linux"] },
    { "path": "%APPDATA%/Code/User/mcp.json", "format": "jsonc", "pointer": "/servers", "scope": "user", "platforms": ["win32"] }
  ],
  "disableHint": "运行命令 MCP: List Servers，选中 server 后选择 Disable",
  "verifiedAt": "2026-10-20",
  "sources": ["https://code.visualstudio.com/docs/agents/reference/mcp-configuration"],
  "notes": "只读取 mcp.json；旧版 settings.json 中的 mcp.servers 不读取。"
}
```

| 字段 | 说明 |
| --- | --- |
| `configs[].path` | 配置文件路径；`~` 为用户目录，`%NAME%` 为环境变量（变量未设置时跳过该条）；`scope` 为 `project` 时必须是相对路径，从当前目录向上查找，取最近的一份 |
| `configs[].format` | `json`、`jsonc`、`toml`、`yaml` |
| `configs[].pointer` | server 映射在文件中的位置（JSON Pointer），如 Codex 为 `/mcp_servers`，VS Code 为 `/servers`；目标不存在时视为没有 server，不算错误 |
| `configs[].scope` | `user` 或 `project`；`project` 级的 stdio 命令受[信任规则](../spec/security.md#项目级配置的信任)约束 |
| `configs[].platforms` | 可选，`linux`、`darwin`、`win32` 的子集；缺省表示所有平台。同一框架在不同系统上路径不同时，写成多条 |
| `configs[].dollarVariables` | 可选，`true` 表示该框架会展开值里的裸 `$NAME`（Gemini CLI），整值为 `$NAME` 时转成 `env:NAME`；其他框架里 `$NAME` 保持字面值。只在官方文档写明时才设置 |
| `disableHint` | `via doctor` 显示的关闭方法 |
| `verifiedAt` | 最近一次对照官方文档或源码核对的日期（`YYYY-MM-DD`）；从未核对过时为 `null`，表示条目依据文档编写，此时不得有 `sources` |
| `sources` | 可选，核对时依据的官方文档和源码链接（`https://`）；`verifiedAt` 不为 `null` 时必须填写 |
| `notes` | 可选，已知的缺口，如暂不读取的位置 |

同一框架的多个配置文件中，`project` 级覆盖 `user` 级（整条 server 定义替换，不做字段合并），这不算冲突。同一作用域内有多个文件时（如 Devin 的 `.devin/mcp_config.local.json` 与 `.devin/mcp_config.json`），列表里靠前的优先，所以优先级高的写在前面；同一文件的不同写法（Amp 的 `settings.json` 与 `settings.jsonc`）都列出，显式指定该框架时只要其中一个存在就不告警。各框架 server 条目的写法差异（`type`/`transport`、`url`/`serverUrl`、Codex 的 `bearer_token_env_var` 等）由统一的规范化代码处理，不放在数据文件里；见 [config.md](../spec/config.md#框架配置的规范化)。

各框架的路径和字段名会随版本变化（例如 Windsurf 在 2026-06 更名为 Devin Desktop 并迁移了配置路径），新增或更新条目时必须对照官方文档或源码核对，更新 `verifiedAt` 并在 `sources` 记录依据；官方文档没有写明的路径、字段不要凭社区经验写入，需要提及时放进 `notes` 并注明未核实。
