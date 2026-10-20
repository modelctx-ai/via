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
| `via auth login\|status\|logout <provider>` | 鉴权管理；`login --manual` 用于无头环境（[auth.md](auth.md)） |
| `via trust [路径] [--yes] [--dry-run]` | 显示并信任项目级配置文件；`--list` 列出记录，`--revoke <路径>` 撤销（[security.md](security.md#via-trust)） |
| `via sync [provider]` | 强制刷新工具目录缓存 |
| `via doctor` | 检查连接与鉴权，检测各框架挂载的 MCP 并输出关闭提示 |
| `via prompt [--out <文件>]` | 生成给 agent 的说明与域摘要 |
| `via daemon status\|stop\|run` | 管理后台进程；`run` 供内部拉起使用 |

内置子命令名是保留字，大小写不敏感，不接受前缀。provider 别名与之重名时（例如某个 server 叫 `find`），必须在配置里用 `alias` 改名，`via servers` 给出告警，该 server 在改名前不出现在任何视图里。

0.1 只实现 `find`、`call`、`more`、`servers`、`sync`、`doctor`、`prompt`；`batch`、`auth`、`daemon` 先保留名字，执行时退出码为 2，说明 `… is not available until 0.2`（[路线图](../roadmap.md)）。`trust` 随 0.2 实现。

各命令的细节：

- `via call`：`<provider>/<ref>` 按与命令行形式相同的规则解析（provider 与资源接受唯一前缀，原始名可用）；其后的参数交给工具参数解析器，`--args`、`@文件`、`-`（stdin）均可用。
- `via find`：没有命中时输出 `no tools match "<查询>"`；个别 provider 无法连接时照常搜索其余的，并在 stderr 警告哪些没有被搜索。
- `via more`：只读游标，不加载配置和目录。
- `via servers`：每个 server 一行，依次为 provider、传输方式（HTTP 只写 scheme 与主机，stdio 只写命令）、鉴权方式及凭证引用是否可解析（只写引用，不写值）、来源文件、备注（`disabled`、`untrusted`、框架间冲突、保留名冲突）；之后列出配置诊断。不连接任何 server，也不执行 `cmd:` 凭证引用（[config.md](config.md#凭证引用)）。`untrusted` 的备注附 `via trust <路径>`（多个文件待确认时为 `via trust`）。配置里有 error 级诊断时照常显示，不中止。
- `via trust`：显示并记录对项目级配置文件的信任，也能列出、撤销记录；细节、确认方式和退出码见 [security.md](security.md#via-trust)。它读取配置但不连接 server，配置里有 error 级诊断时照常工作（不执行任何工具）。
- `via sync`：向各 server（或指定的 provider）重新拉取 `tools/list` 并更新缓存，每个 provider 一行（`gh  14 tools` 或 `linear  needs auth: …`）；有失败时退出码取其中最大的，并在 stderr 提示 `next: via doctor`。
- `via doctor`：对每个 server 实时探测（不读缓存，成功后更新缓存），再输出检测结果；退出码取各项问题中最高的一个（见[退出码](output.md#退出码)）。
- `via prompt --out <文件>`：路径相对当前目录；目标文件已存在时需要 `--yes` 才会覆盖（退出码 5），避免覆盖用户自己写的 AGENTS.md。成功后在 stderr 输出 `· wrote <文件> · N bytes`。

### 配置错误

配置里有 error 级诊断（例如 `deny` 的正则无效）时，除 `via doctor` 与 `via servers`（它们展示诊断）和不读配置的 `via more` 外，所有命令都不执行，退出码 2：

```console
$ via github
error: invalid configuration: ~/.config/via/config.yaml: deny[0]: invalid regular expression "(unclosed" (…); the rule was ignored
next: via doctor
```

因为无效的 `deny` 规则意味着本应隐藏的工具会可见，这里宁可停下，也不带着缺失的规则继续运行（[config.md](config.md#校验与诊断)）。

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
