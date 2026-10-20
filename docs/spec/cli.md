# 命令规范

命令按 provider → 资源 → 动作三级组织，形如 `via linear issue:create`。每一级前缀本身就是一条合法的浏览命令，敲到哪一级就看到哪一级的内容；冒号标明「这是一个工具」，它后面的都是参数。设计理由见 [ADR 0005](../adr/0005-command-grammar-provider-resource-verb.md)。

## 语法

```text
via                                       状态 + 按域分组列出 provider
via <provider> [--all]                    该 provider 的资源，动作内联列出
via <provider> <resource>                 该资源下每个动作一行，带参数签名
via <provider> <resource>:<verb> -h       用法
via <provider> <resource>:<verb> [参数]   调用
via <provider> <tool>                     调用无法拆分的叶子工具
```

各级视图的输出格式见 [discovery.md](discovery.md#浏览视图)。

### 解析顺序

1. 第一个参数先匹配内置子命令；匹配不上则按 provider 解析。
2. provider 之后的第一个参数：
   - 含 `:` → 工具引用，其后全部是工具参数；
   - 不含 `:` 且匹配某个资源 → 浏览该资源；
   - 不含 `:` 且匹配某个叶子工具或原始名 → 调用该工具；
   - 资源与叶子工具同名时，资源优先，叶子工具通过原始名调用。
3. 都匹配不上时，不执行任何调用，输出候选或 did you mean，退出码 3。

## 为什么是这种形状

- **与模型熟悉的 CLI 同构**：`gh issue create`、`kubectl get pods`、`heroku apps:create` 都是这种层级，模型见得最多。
- **前缀即目录**：不需要单独的 `ls`，逐级补全就是逐级发现。
- **资源与动作用冒号连接**：`via linear issue create "标题"` 里分不清 create 是动作还是位置参数；`issue:create` 一眼可知是工具。
- **域不进命令路径**：域是推断出来的，写进路径会让命令不稳定，域名也可能与 provider 重名（[ADR 0006](../adr/0006-domain-is-a-view.md)）。域只用于 `via` 顶层的分组展示和 `via find --domain` 过滤。

## 内置子命令

| 命令 | 作用 |
| --- | --- |
| `via find <查询> [--domain <域>] [-n 10]` | 跨 provider 搜索工具，每条结果带参数签名 |
| `via call <provider>/<resource>:<verb> --args '{…}'` | 显式调用，参数为 JSON、`@文件` 或 `-`（stdin），供脚本使用 |
| `via more <游标>` | 续读被截断的结果 |
| `via batch` | 从 stdin 读 JSONL，并发调用，结果按输入顺序输出 |
| `via servers [--why <provider>]` | 列出 server、来源文件、传输方式、鉴权状态、域的判定依据 |
| `via auth login\|status\|logout <provider>` | 鉴权管理（[auth.md](auth.md)） |
| `via trust [路径]` | 信任项目级配置（[security.md](security.md)） |
| `via sync [provider]` | 强制刷新工具目录缓存 |
| `via doctor` | 检查连接与鉴权，检测各框架挂载的 MCP 并输出关闭提示 |
| `via prompt [--out <文件>]` | 生成给 agent 的说明与域摘要 |
| `via daemon status\|stop\|run` | 管理后台进程；`run` 供内部拉起使用 |

内置子命令名是保留字。provider 别名与之重名时（例如某个 server 叫 `find`），必须在配置里用 `alias` 改名，`via servers` 给出告警。

### via batch 输入格式

每行一个 JSON 对象：

```json
{"tool": "linear/issue:get", "args": {"id": "ENG-123"}}
```

- 结果按输入顺序输出，每条结果之间以元信息行分隔；`-o json` 时每行一个 JSON 结果（JSONL）。
- 单条失败不影响其他条目，整体退出码取所有条目中最大的非零值。
- 并发上限遵循各 server 的 `concurrency` 配置。

## 全局选项

| 选项 | 作用 |
| --- | --- |
| `-o text\|json\|raw` | 输出格式（[output.md](output.md#输出格式)） |
| `--full` | 关闭截断 |
| `--all` | 浏览视图不截断条目 |
| `--yes` | 确认执行危险工具 |
| `--dry-run` | 只解析并打印将要发出的调用，不执行 |
| `--no-validate` | 跳过本地 schema 校验（[arguments.md](arguments.md#schema-不可靠时)）；`--yes` 与 `deny` 照常生效 |
| `--timeout <秒>` | 覆盖本次调用的超时 |
| `-h`, `--help` | 帮助；放在工具引用后时显示该工具用法 |

工具参数与全局选项重名时，用 `--p.<参数名>` 指定为工具参数（[arguments.md](arguments.md)）。

## 工具引用的写法

- **命令行**：`linear issue:create`，provider 与工具是两个参数。
- **单字符串形式**：`linear/issue:create`，用于 `via call`、`via batch`、`deny` 规则和日志。
- **原始名作为别名**：原始 MCP 工具名始终可用，`via linear create_issue` 等价于 `via linear issue:create`。拆分规则调整时，旧写法不会失效。
- **输入宽松**：大小写不敏感，`-` 与 `_` 等价；provider 和资源接受唯一前缀。
- **歧义与缺失**：有歧义时不执行，列出候选；找不到时给出至多 3 个 did you mean。
- **输出严格**：所有输出一律使用规范写法；输入使用了别名或前缀时，在 stderr 元信息行中打印规范写法。

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
