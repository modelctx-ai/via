# 发现：目录、分域、浏览与搜索

域是推断出来的浏览视图，可以随规则调整，不进入名称（[ADR 0006](../adr/0006-domain-is-a-view.md)）。这是和 Asterlane 的关键区别：Asterlane 的域由管理员配置，可以写进名称；mx 的域靠推断，写进名称就会不稳定。

## 目录构建流程

1. **拉取**：对每个 server 调用 `tools/list`（分页拉全）。
2. **确定 provider**：取 server 别名（或配置中的 `alias`），统一为小写 kebab-case；与内置子命令重名时必须改名。
3. **拆分工具名**：每个工具拆成 `资源:动作`，拆不开的作为叶子工具（[naming.md](naming.md)）。
4. **推断域**：配置中的 `domain` → 内置分类表 → 启发式打分 → 置信度不足则归入 `other`。
5. **建索引**：provider、资源、动作、原始名、描述、参数名分词后建倒排索引，供 `mx find` 使用。
6. **过滤**：`deny` 规则命中的工具从视图和索引中移除（[config.md](config.md#deny)）。

### 缓存

- 缓存键：server 定义的哈希（命令、参数、URL、相关 env 名，不含凭证值）+ 身份（鉴权主体的稳定标识，无法获得时用凭证引用本身的哈希）。
- 位置：用户缓存目录下的 `catalog/`，权限 0700。
- TTL 默认 24 小时；daemon 在线时订阅 `notifications/tools/list_changed` 实时刷新。
- `mx sync [provider]` 强制刷新。
- 缓存中保存原始 `tools/list` 结果；拆分、分域、索引在加载时重新计算，因此规则升级无需清缓存。

## 分域

优先级从高到低：

1. 配置中 `servers.<name>.domain`，或顶层 `domains` 自定义的成员关系；
2. 内置分类表（`data/domains.json`）；
3. 启发式打分；
4. 都不满足时归入 `other`。

### 内置分类表

精度最高，同时作为启发式词典的校准样本：

| 域 | server |
| --- | --- |
| `code` | github、gitlab、sentry |
| `search` | exa、tavily、brave-search、context7 |
| `browser` | playwright、puppeteer、chrome-devtools |
| `data` | postgres、sqlite、bigquery |
| `docs` | notion、confluence、google-drive |
| `project` | linear、jira、asana |
| `comm` | slack、gmail |
| `fs` | filesystem |
| `cloud` | cloudflare |

匹配依据：server 别名、包名、URL 主机名，任一命中即可。

### 启发式分域

分类表覆盖不到的 server，用确定性的打分规则推断域，不调用模型。因为域不进入规范名，分错了只影响浏览，不影响调用。

**信号来源**，权重从高到低：

1. **参数名**：区分度最高。`owner` + `repo` 指向 code，`sql` 指向 data，`selector` 指向 browser，`channel` 指向 comm。
2. **资源名**：拆分出的资源，如 `pull-request`、`sprint`、`bucket`。
3. **server 身份**：别名、包名（如 `@modelcontextprotocol/server-postgres`）、URL 主机名、`initialize` 返回的 `serverInfo.name` 和 `instructions`。
4. **工具描述**：分词后参与打分，权重最低，因为描述里常有泛用词。

**打分规则**：

- 每个域在词典（`data/domain-lexicon.json`）中有一组关键词及权重。权重按区分度计算：只在一个域出现的词权重高，在多个域都常见的词（search、query、file）权重低。
- 对一个 server，把所有工具的信号词按「词典权重 × 信号来源权重」累加，得到每个域的分数，再归一化为置信度。
- 最高分超过阈值，且至少是第二名的 1.5 倍时，判定为该域；两个域分数接近时，server 同时列在这两个域下；都不够时归入 `other`。阈值和倍数在真实 server 上调参，作为数据文件中的参数，不写死在代码里。

**按资源拆分**：大而杂的 server（例如同时提供邮件、网盘、日历的办公套件）按资源分别打分。各资源的域明显不同时，这个 provider 同时出现在多个域下，并注明相关资源，例如 comm 一行显示 `workspace (mail)`，docs 一行显示 `workspace (drive)`。

**词典怎么来**：仓库提供离线脚本，用分类表中已知域的 server 的工具列表作为样本，统计每个词在各域的出现情况，生成词典权重。新增分类表条目后重新生成即可，不手工维护词典。

**可解释、可覆盖**：

```console
$ mx servers --why acme-ops
acme-ops → ops (heuristic, 0.82)
  ops   12.4   deployment, cluster, pod, logs
  data   3.1   query, table
  next: set servers.acme-ops.domain in ~/.config/mx/config.yaml to override
```

判断不对时在配置里写 `domain:` 覆盖，或用顶层 `domains:` 自定义域并指定成员。

## 浏览视图

每一级都应当控制在一屏以内，并在末尾提示下一步命令。

### `mx`

```console
$ mx
9 providers · 214 tools · 1 needs auth (linear)
code     github · sentry
search   exa · context7
project  linear
browser  playwright
→ mx <provider> to browse · mx find <query> to search
```

- 第一行：provider 数、可见工具数、异常状态（需要鉴权、连接失败）。
- 可见 provider 不超过 6 个时不分域，直接每行一个 provider 并标注域。
- 需要鉴权或连接失败的 provider 仍然列出，并带标记。

### `mx <provider>`

```console
$ mx github
issue          read · write · list · search
pull-request   read · create · list · merge
file           create-or-update · push · delete
commit         get · list
… 14 more · mx github --all
```

- 每个资源一行，动作内联，按资源名排序。
- 叶子工具在最后一行：`tools: search · fetch`。
- 资源行数超过一屏（默认 20 行）时截断，提示 `--all`。
- 危险动作可以加标记（如 `delete!`），只读资源不加标记。

### `mx <provider> <resource>`

```console
$ mx github issue
issue:read     owner, repo, issue-number, method       Get issue details
issue:write    owner, repo, method, [title], [body]     Create or update issue
issue:list     owner, repo, [state], [labels]          List issues
issue:search   query, [owner], [repo]                  Search issues
→ mx github issue:<verb> -h for usage
```

- 每个工具一行：动作、签名、截断到 60 字符的描述。
- 签名中必填参数在前，可选参数加方括号，参数名统一为 kebab-case。

## 搜索

`mx find <查询>` 跨 provider 搜索，排序规则沿用 Asterlane 的做法并增加多词检索：

1. 规范写法完全匹配；
2. 规范写法前缀匹配；
3. 规范写法包含查询；
4. 多词查询按 BM25 对名称、描述、参数名打分，名称命中权重最高；
5. 空查询按规范写法顺序列出全部工具。

结果默认 10 条，每条一行，格式同资源视图但带 provider 前缀，大多数情况下 `find` 之后就能直接调用，省掉一次 `-h`。`--domain` 只在该域内搜索。语义检索作为后续可选项，不进 MVP。

## 找不到时

按段（provider、资源、动作分别）计算编辑距离，给出至多 3 个 did you mean；仍无结果时提示 `mx find <关键词>`。退出码 3。
