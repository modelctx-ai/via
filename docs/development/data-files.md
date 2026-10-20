# 数据文件

规则类内容放在 `data/` 下，打包时内联，用户配置可以覆盖。以下格式是草案，实现时以 JSON Schema（放在 `data/schema/`）为准。

## verbs.json

动词表与单数化例外，供[工具名拆分](../spec/naming.md)使用。

```json
{
  "version": 1,
  "verbs": [
    "get", "list", "create", "update", "delete", "search", "send", "run",
    "fetch", "read", "write", "add", "remove", "merge", "trigger", "query",
    "move", "duplicate", "restore", "cancel", "navigate", "click"
  ],
  "conjunctions": ["or", "and"],
  "singularExceptions": ["data", "news", "series", "status", "analytics"]
}
```

- `version` 每次改动加一；改动必须写进 `CHANGELOG.md`，并列出受影响的规范写法。

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
    "flatBelowProviders": 6
  }
}
```

- `servers` 中的条目按 `match` 列出的依据匹配：server 别名、包名（npm、PyPI、容器镜像名）、URL 主机名。
- `heuristic` 中的数值是初始值，在真实 server 上调参后更新。

## domain-lexicon.json

分域词典，**由脚本生成，不手工编辑**：

```bash
node scripts/build-lexicon.js test/fixtures/tools/ > data/domain-lexicon.json
```

```json
{
  "version": 1,
  "generatedFrom": "test/fixtures/tools/@<commit>",
  "terms": {
    "repo":     { "code": 0.92 },
    "sql":      { "data": 0.95 },
    "selector": { "browser": 0.9 },
    "channel":  { "comm": 0.88 },
    "query":    { "data": 0.3, "search": 0.3 }
  }
}
```

## noise.json

渲染时默认去掉的字段，供[输出](../spec/output.md#渲染流程)使用。

```json
{
  "version": 1,
  "fields": ["node_id", "_links", "*_api_url", "*_url_template", "gravatar_id"],
  "keep": ["url", "html_url"]
}
```

- 支持 `*` 通配；`keep` 优先于 `fields`。

## frameworks

`data/frameworks/<id>.json`，每个 agent 框架一个文件，描述如何只读解析它的 MCP 配置，以及如何关闭注入。供[配置](../spec/config.md)与 [`mx doctor`](../guides/agent-integration.md) 使用。

```json
{
  "id": "claude-code",
  "name": "Claude Code",
  "configs": [
    { "path": "~/.claude.json", "format": "json", "pointer": "/mcpServers", "scope": "user" },
    { "path": ".mcp.json", "format": "json", "pointer": "/mcpServers", "scope": "project" }
  ],
  "disableHint": "启动时用 --strict-mcp-config 加载空配置，或在 /mcp 中逐个禁用",
  "verifiedAt": "2026-10"
}
```

| 字段 | 说明 |
| --- | --- |
| `configs[].path` | 配置文件路径；`~` 为用户目录，相对路径为项目目录 |
| `configs[].format` | `json`、`jsonc`、`toml`、`yaml` |
| `configs[].pointer` | server 映射在文件中的位置（JSON Pointer），如 Codex 为 `/mcp_servers`，VS Code 为 `/servers` |
| `configs[].scope` | `user` 或 `project`；`project` 级的 stdio 命令受[信任规则](../spec/security.md#项目级配置的信任)约束 |
| `disableHint` | `mx doctor` 显示的关闭方法 |
| `verifiedAt` | 最近一次按该框架实际版本核对的时间 |

各框架的路径和字段名会随版本变化，新增或更新条目时必须按实际版本核对并更新 `verifiedAt`。
