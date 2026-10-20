# 数据文件

规则类内容放在 `data/` 下，打包时内联，用户配置可以覆盖。以下格式是草案，实现时以 JSON Schema（放在 `data/schema/`）为准；`verbs`、`domains`、`domain-lexicon`、`noise`、`columns` 的 schema 已经提供，测试会逐个校验。

## verbs.json

动词表与单数化例外，供[工具名拆分](../spec/naming.md)使用。

```json
{
  "version": 1,
  "verbs": [
    "get", "list", "create", "update", "delete", "search", "send", "run",
    "fetch", "read", "write", "add", "remove", "merge", "trigger", "query",
    "move", "duplicate", "restore", "cancel", "navigate", "click",
    "push", "call", "describe", "batch", "enable", "disable", "fork",
    "resolve", "unresolve"
  ],
  "conjunctions": ["or", "and"],
  "singularExceptions": ["data", "news", "series", "status", "analytics"],
  "singularIrregular": { "statuses": "status", "caches": "cache" }
}
```

- `version` 每次改动加一；改动必须写进 `CHANGELOG.md`，并列出受影响的规范写法。
- `singularExceptions`：原样保留的词；`singularIrregular`：通用单数化规则处理不了的「复数 → 单数」。
- 动词表的改动用 `npm run split-diff` 离线检查：用当前规则重新拆分 `test/fixtures/` 里的真实 `tools/list` 快照，与 `test/fixtures/splits/` 中入库的基线对比，列出规范写法的变化；确认后加 `--update` 更新基线。

## domains.json

内置分类表与分域参数，供[分域](../spec/discovery.md#分域)使用。

```json
{
  "version": 1,
  "domains": {
    "code":    { "servers": ["github", "gitlab", "sentry"] },
    "search":  { "servers": ["exa", "tavily", "brave-search", "context7"] },
    "browser": { "servers": ["playwright", "puppeteer", "chrome-devtools"] },
    "data":    { "servers": ["postgres", "sqlite", "bigquery"] },
    "docs":    { "servers": ["notion", "confluence", "google-drive"] },
    "project": { "servers": ["linear", "jira", "asana"] },
    "comm":    { "servers": ["slack", "gmail"] },
    "fs":      { "servers": ["filesystem"] },
    "cloud":   { "servers": ["cloudflare"] }
  },
  "match": ["alias", "package", "host"],
  "heuristic": {
    "threshold": 0.5,
    "leadRatio": 1.5,
    "signalWeights": { "param": 4, "resource": 3, "identity": 2, "description": 1 },
    "minScore": 10,
    "stopwords": ["the", "and", "with"],
    "flatBelowProviders": 6
  }
}
```

- `servers` 中的条目按 `match` 列出的依据匹配：server 别名（整体相等）、包名（按词切分后连续包含）、URL 主机名（按词切分后连续包含）。
- `heuristic` 中的数值是初始值，在真实 server 上调参后更新。
- `minScore`：所有域的原始得分之和低于它时不下结论，归入 `other`，避免一两个弱信号就给出判定。
- `stopwords`：打分时忽略的泛用英文词，只作用于工具描述；动词表里的词在描述中同样被忽略。

## domain-lexicon.json

分域词典，**由脚本生成，不手工编辑**：

```bash
npm run lexicon    # 等价于对 test/fixtures/tools/ 运行 scripts/build-lexicon.ts，写入 data/domain-lexicon.json
```

脚本只统计文件名（即 provider 别名）能在分类表中查到域的快照；`test/fixtures/other/` 下是分类表之外的样本，不参与生成。

```json
{
  "version": 1,
  "generatedFrom": "test/fixtures/tools/@sha256:<快照内容哈希前 12 位>",
  "terms": {
    "repo":     { "code": 0.92 },
    "sql":      { "data": 0.95 },
    "selector": { "browser": 0.9 },
    "channel":  { "comm": 0.88 },
    "query":    { "data": 0.3, "search": 0.3 }
  }
}
```

- 词来自三处：参数名、拆分出的资源名、工具描述（去掉停用词和动词）。描述里的词至少要在同一个域的两个工具里出现才算数。
- 权重 = 该词在某个域的出现频率（含该词的工具占该域工具的比例）占它在所有域出现频率之和的份额，所以只出现在一个域的词权重接近 1，到处都有的词权重很低；最高权重低于 0.4 的词不收录。
- 每个词只保留权重不低于 0.4 的域。

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
  "disableHint": "运行命令 MCP: List Servers，选中 server 后停止或禁用",
  "verifiedAt": null,
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
| `disableHint` | `via doctor` 显示的关闭方法 |
| `verifiedAt` | 最近一次按该框架实际安装版本核对的时间（`YYYY-MM`）；从未核对过时为 `null`，表示条目依据文档编写 |
| `notes` | 可选，已知的缺口，如暂不读取的位置 |

同一框架的多个配置文件中，`project` 级覆盖 `user` 级（整条 server 定义替换，不做字段合并），这不算冲突。各框架 server 条目的写法差异（`type`/`transport`、`url`/`serverUrl`、Codex 的 `bearer_token_env_var` 等）由统一的规范化代码处理，不放在数据文件里；见 [config.md](../spec/config.md#框架配置的规范化)。

各框架的路径和字段名会随版本变化，新增或更新条目时必须按实际版本核对并更新 `verifiedAt`。
