# Notion

Notion 的工具名形如 `notion-create-pages`，去掉 provider 前缀后正常拆分；`notion-search` 和 `notion-fetch` 只有动作，作为叶子工具；`notion-calendar-list-events` 的动词在中间，按「首尾都不是动词时取第一个动词」的规则拆成 `calendar-event:list`。

## 接入

```yaml
servers:
  notion:
    url: https://mcp.notion.com/mcp
    auth: oauth            # 然后执行 via auth login notion
```

## 浏览

```console
$ via notion
page             create · update · move · duplicate · delete · restore
data-source      query · update
database         create
comment          create · get
view             create · update
calendar-event   list · create · update · cancel
user             get
team             get
tools: search · fetch
```

## 调用

```bash
# 叶子工具，唯一必填参数写成位置参数
via notion search "Q3 roadmap"
via notion fetch https://www.notion.so/acme/Q3-roadmap-195de922

# pages 是对象数组，从文件读；parent 用点号路径指定
via notion page:create --parent.page_id 195de9221179449fab8075a27c979105 --pages @pages.json

# 嵌套很深的参数直接用 heredoc 传 JSON
via notion data-source:query --data - <<'JSON'
{"data_source_urls": ["collection://f336d0bc-b841-465b-8045-024475c079dd"],
 "query": "SELECT * FROM \"collection://f336d0bc-b841-465b-8045-024475c079dd\" WHERE Status = ?",
 "params": ["In Progress"]}
JSON
```

## 拆分与参数要点

| 原始工具名 | 规范写法 |
| --- | --- |
| `notion-create-pages` | `page:create` |
| `notion-query-data-sources` | `data-source:query` |
| `notion-get-comments` | `comment:get` |
| `notion-calendar-list-events` | `calendar-event:list` |
| `notion-search` | `search`（叶子） |
| `notion-fetch` | `fetch`（叶子） |

Notion 的 `parent` 是 anyOf 结构（page_id、database_id、data_source_id 等分支）。传了 `--parent.page_id` 就能唯一确定分支，via 自动补上该分支里只有一个可选值的 `type` 字段，用户不必手写（[arguments.md](../../spec/arguments.md#anyof--oneof-自动补齐)）。

来源：实际连接的 Notion MCP server 的 `tools/list`（2026-10）。
