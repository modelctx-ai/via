# 配置

via 读取各框架的 MCP 配置但从不写入（[ADR 0003](../adr/0003-read-only-framework-configs.md)）；凭证在 via 自己的覆盖层里按 server 绑定，调用时自动注入。框架侧不做任何鉴权。

## 配置来源与合并顺序

后者覆盖前者：

1. **框架配置（只读）**：每次加载时读取，不做快照，框架那边改了这边自动生效。默认探测的框架与路径由 `data/frameworks/` 描述（[数据文件](../development/data-files.md#frameworks)），按探测顺序为 Claude Code、Claude Desktop、Cursor、Codex、VS Code、Devin Desktop、Windsurf、Gemini CLI、Antigravity、GitHub Copilot CLI、Amp。路径与字段按各框架官方文档核对，条目的 `verifiedAt` 和 `sources` 记录核对日期与依据。
2. **用户配置**：`~/.config/via/config.yaml`（遵循 `XDG_CONFIG_HOME`，macOS 上同样如此；Windows 为 `%APPDATA%\via\config.yaml`）。补充凭证、覆盖定义、新增 server。
3. **项目配置**：当前目录向上查找的第一个 `.via.yaml`。其中的 stdio 命令和 HTTP 端点首次使用需 `via trust`（[security.md](security.md#项目级配置的信任)）。
4. **命令行参数**。

合并规则：

- 以 server 名为键逐字段深合并，优先级高的来源覆盖低的。
- 不同框架配置中出现同名但定义不同的 server 时，按 `sources` 中的顺序取第一份，并在 `via servers` 里标出冲突。
- 框架配置中的 `env`、`headers` 原样继承，包括其中的明文值；`via doctor` 对明文值告警。
- 同一框架的项目级配置整条覆盖它的用户级配置（框架自己的优先级），这不算冲突；只有不同框架之间才记录冲突。冲突项记在 server 的 `conflicts` 里，列出被忽略的来源；内容完全相同的重复定义不算冲突。
- 覆盖层只写了部分字段时只改这些字段：`env`、`headers`、`rename` 按键合并，`args` 整体替换，`noise` 追加去重，其余标量字段后者覆盖。覆盖层给出的传输方式与来源不同（对 HTTP server 写了 `command`，或对 stdio server 写了 `url`）时，整体替换传输定义，不继承另一种传输的字段。
- `deny` 取各层的并集（项目配置只能追加，不能撤销用户配置的规则）；`domains` 按域名逐项覆盖；`output.*`、`daemon.*` 逐字段覆盖；`search.semantic` 只读用户配置与命令行覆盖，整段替换而不是逐字段合并（见下文）。
- 覆盖层里没有任何来源定义的 server（只有 `timeout` 之类设置，没有 `command` 或 `url`）被忽略并给出告警，通常是框架那边已经删掉了它。

`sources` 的细节：

- `auto` 按 `data/frameworks/` 的注册顺序探测全部框架，文件不存在是正常情况，不产生诊断；列表里显式写出的框架或文件不存在时给出告警。
- 列表项先按框架 id 匹配；不是 id 的按文件路径处理（必须含 `/`、`.` 或 `~`，否则按拼错的 id 告警）。相对路径相对于写下它的配置文件所在目录（命令行覆盖则相对于当前目录）。
- 按路径给出的文件没有 `pointer` 信息，依次尝试 `/mcpServers`、`/servers`、`/mcp_servers`，格式按扩展名判断（`.toml`、`.yaml`/`.yml`、`.jsonc`，其余按 JSON）。
- 项目配置里列出的文件按项目级处理（stdio 命令需信任），用户配置和命令行里列出的按用户级处理。
- 多层都写了 `sources` 时，优先级最高的一层生效，不做合并。

## 配置示例

```yaml
sources: auto              # 或显式列出：[claude-code, cursor, ./tools/mcp.json]
servers:
  github:
    url: https://api.githubcopilot.com/mcp/
    auth: { bearer: "keychain:via/github" }
    domain: code
  exa:                     # 定义来自 Cursor 配置，这里只补凭证
    env: { EXA_API_KEY: "env:EXA_KEY" }
  linear:
    auth: oauth            # via auth login linear
  aster:                   # 网关也只是普通 HTTP server
    url: http://127.0.0.1:3721/mcp
    auth: { bearer: "env:ASTERLANE_KEY" }
  playwright:
    exclusive: true        # 独占资源，与框架实例冲突时给出提示
  filesystem:
    roots: ["."]           # 告诉 server 可以在当前目录里工作（默认不声明）
  find:                    # 与内置子命令重名，必须改名
    alias: finder
deny: ["^github/.*:delete$"]  # 正则，匹配 provider/资源:动作，deny 优先
domains:
  research: [exa, context7]
```

## 字段参考

### 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sources` | `auto` \| `false` \| 列表 | `auto` | 要读取的框架配置。`auto` 探测全部已知框架；列表项可以是框架 id 或文件路径；`false` 只用 via 自己的配置 |
| `servers` | 映射 | `{}` | 以 server 名为键的定义与覆盖，见下表 |
| `deny` | 正则列表 | `[]` | 匹配单字符串形式的工具引用（`provider/资源:动作`），也匹配原始名形式（`provider/原始名`） |
| `domains` | 映射 | `{}` | 自定义域及其成员 provider，优先级高于推断 |
| `output.budget` | 字节数 | `8192` | 默认输出预算 |
| `output.cellWidth` | 字符数 | `80` | 表格单元格截断宽度 |
| `daemon.idleTimeout` | 秒 | `600` | daemon 空闲退出时间 |
| `daemon.serverIdleTimeout` | 秒 | `300` | 单个 stdio server 空闲停止时间 |
| `search.semantic` | 映射 \| `false` | 未设置 | `via find` 的可选 embedding 检索，**只在用户配置里生效**，见[下文](#searchsemantic) |

### `search.semantic`

`via find` 的可选 embedding 检索（[discovery.md](discovery.md#embedding-检索可选默认关闭)，[ADR 0011](../adr/0011-find-synonym-expansion-and-optional-embeddings.md)）。默认关闭；它会把工具描述与每次查询发往 `url`，所以只在用户配置（和命令行覆盖）里读取：

```yaml
search:
  semantic:
    provider: openai-compatible
    url: https://api.openai.com/v1
    model: text-embedding-3-small
    auth: { bearer: "env:OPENAI_API_KEY" }
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `provider` | `openai-compatible` | `openai-compatible` | 目前只有 OpenAI 兼容的 `/embeddings` 接口 |
| `url` | 字符串 | 必填 | 基础地址（`…/v1`，请求发往 `<url>/embeddings`）或完整的 `…/embeddings` 地址。必须是 https；`localhost`、`127.0.0.0/8`、`::1` 允许 http（本机 Ollama、vLLM 等）。不允许内嵌用户名或密码 |
| `model` | 字符串 | 必填 | 模型名，原样放进请求 |
| `auth` | `none` \| `{ bearer }` \| `{ headers }` | `none` | 与 server 的 `auth` 同形（[auth.md](auth.md)），值是凭证引用；不支持 `oauth`。字面量凭证加载时告警 |
| `timeout` | 秒 | `3` | 缓存已完整时，整个语义步骤（只剩查询要 embedding）的期限 |
| `indexTimeout` | 秒 | `30` | 有工具还没有 embedding（首次、目录变了）时的期限 |
| `dimensions` | 正整数 | 不传 | 作为 `dimensions` 发给端点（支持缩短向量的模型）；也参与缓存键 |

- `search.semantic: false` 显式关闭（命令行覆盖可以用它临时关掉用户配置里的设置）。
- 项目配置里出现 `search.semantic` 时被忽略并给出告警（`search-forbidden`）：它会把工具描述与查询发往仓库指定的主机（[security.md](security.md#embedding-检索的数据外流)）。框架配置没有 `search` 字段，不读取。
- `url` 为 http 且不是回环地址、含内嵌凭证、缺少 `url` 或 `model`、`provider` 不是 `openai-compatible`、`auth` 是 `oauth`，都是 `invalid-field` 错误（与其他字段错误一样，命令拒绝执行，退出码 2），整段 `search.semantic` 被忽略。
- 凭证引用在 `find` 需要请求端点时才解析；解析失败不让 `find` 失败，只退回词法排序并在 stderr 说明缺哪一项，不含值。

### `servers.<name>`

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `command`、`args`、`env`、`cwd` | stdio | 进程启动参数；`env` 的值可以是凭证引用 |
| `url`、`headers` | HTTP | Streamable HTTP 端点；`headers` 的值可以是凭证引用 |
| `auth` | 全部 | 鉴权方式，见 [auth.md](auth.md)；`oauth` 只适用于 HTTP，可写成 `{ oauth: { scopes: [...], clientId: … } }` |
| `alias` | 全部 | provider 名；默认取 server 名 |
| `domain` | 全部 | 指定域，跳过推断 |
| `rename` | 全部 | 单个工具的规范写法覆盖，如 `{ list_my_issues: "issue:list-mine" }` |
| `disabled` | 全部 | `true` 时对 via 隐藏这个 server（不影响框架） |
| `exclusive` | stdio | 独占资源；启动失败时提示可能与框架实例冲突 |
| `confirm` | 全部 | `destructive`（默认）或 `never` |
| `timeout` | 全部 | 调用超时，秒，默认 60 |
| `concurrency` | 全部 | 同一 server 的并发上限，默认 4；`via batch` 同样遵守，超出的排队 |
| `budget` | 全部 | 覆盖输出预算 |
| `noise` | 全部 | 追加的噪声字段名或通配 |
| `roots` | 全部 | 声明给 server 的 roots，见下 |

#### `roots`

路径或 `file://` URI 的列表，告诉 server 它可以在哪些目录里工作（MCP 的 `roots` 能力；filesystem 一类 server 靠它确定可访问的目录。决策见 [ADR 0010](../adr/0010-mcp-resources-prompts-and-roots.md)）。

- **默认没有**：不写或写 `[]` 时 via 不声明 `roots` 能力，server 无从得知任何本机目录。要让 server 看到当前目录写 `roots: ["."]`，这是明确的授权，via 不替用户做这个决定。
- 路径中的 `~` 展开为家目录，相对路径相对于**运行 `via` 的当前目录**（与 stdio 的 `cwd` 一致），都转成绝对 `file://` URI；`file://` URI 原样使用。其他 scheme 的 URI 是 error 级诊断（`servers.<name>.roots[0]: expected a path or file:// URI`）。每个 root 的名字取路径的末段。
- 声明时 `listChanged` 为 `false`：一个会话的 roots 在它的一生里不变。daemon 里 roots 参与会话键，相对路径依赖调用目录时不同目录使用不同的会话（[daemon.md](daemon.md#环境与工作目录)）。
- 合并时整体替换，不按元素合并。项目配置设置**非空**的 `roots` 要求 `via trust`（它改变 server 的访问边界），写 `[]`（收窄）不需要；`via trust` 会显示 roots（[security.md](security.md#项目级配置的信任)）。
- 给 HTTP server 配 `roots` 时，加载时有一条 `warning`：这些本地路径会发往远端服务。

### stdio 子进程的环境

子进程不继承 via 的全部环境变量，避免 shell 里其他 server 的令牌泄给每个子进程。环境由两部分合并而成，后者覆盖前者：

1. 基础环境：`PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`TERM`、`TMPDIR`、`LANG`、`LANGUAGE`、`TZ`、`LC_*`、`XDG_*`、代理与证书变量（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`，不分大小写，以及 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`SSL_CERT_DIR`、`REQUESTS_CA_BUNDLE`）；Windows 上改用 `SYSTEMROOT`、`APPDATA`、`USERPROFILE` 等系统变量；
2. 该 server 的 `env`（凭证引用解析后的值）。

## 框架配置的规范化

各框架对同一件事的写法不同，读取时统一成 `ServerConfig`（对所有 server 一视同仁，不为特定 server 或网关写适配，[ADR 0007](../adr/0007-no-gateway-specific-adaptation.md)）：

| 内容 | 接受的写法 |
| --- | --- |
| 传输方式 | `type` 或 `transport`：`stdio`、`local` 为 stdio；`http`、`streamable-http`、`streamableHttp`、`remote` 为 Streamable HTTP；`sse`（旧版 HTTP+SSE）按 HTTP 处理并告警；缺省时有 `command` 为 stdio、有 URL 为 HTTP；其他取值报错并跳过该 server |
| URL | `url`、`serverUrl`、`httpUrl` |
| 请求头 | `headers`，或 Codex 的 `http_headers`；Codex 的 `env_http_headers`（头名 → 环境变量名）转成 `env:` 引用 |
| 鉴权 | Codex 的 `bearer_token_env_var` 转成 `auth: { bearer: "env:NAME" }` |
| 环境变量 | `env`；Codex 的 `env_vars`（要透传的变量名列表，元素可以是名称或 `{ name, source }`，`source = "remote"` 的项告警并忽略）转成 `env:` 引用 |
| 变量引用 | `env`、`headers` 的值整体为 `${NAME}` 或 `${env:NAME}` 时转成 `env:NAME`；框架的数据文件声明 `dollarVariables`（Gemini CLI）时，整体为 `$NAME` 也转成 `env:NAME`；其他位置或夹在文本中的 `${…}`（如 `${workspaceFolder}`）via 不展开，原样保留并给出告警 |

框架自己的开关（`disabled`、`enabled`）不继承：在框架里关掉一个 server 正是迁移到 via 的步骤（[集成](../guides/agent-integration.md)），via 里的 `disabled` 只由 via 自己的配置决定。框架配置里的辅助命令（如 `headersHelper`、Codex 的 `http_headers_helper`）既不执行也不继承。

## 校验与诊断

- 用户配置、项目配置和命令行覆盖按「字段参考」校验类型，错误带完整路径，例如 `servers.github.timeout: expected number`、`servers.github.concurrency: expected positive integer`。出错的字段被忽略（使用默认值），其余字段照常生效；同时写了 `command` 和 `url` 的 server 整条忽略。
- 未知字段只告警，用来发现拼写错误（`timout`）。
- 文件不存在、无法读取或无法解析时跳过该文件并给出诊断，不影响其他来源。诊断信息不引用文件内容，避免泄露凭证。
- `deny` 中无效的正则被忽略并报错（其余规则照常编译）。因为无效的 deny 规则意味着本应隐藏的工具会可见，诊断为 error 级，调用方应当停下来让用户修复，而不是继续运行：CLI 对任何带 error 级诊断的配置都拒绝执行命令（`via doctor`、`via servers` 除外，它们负责展示诊断），退出码 2（[cli.md](cli.md#配置错误)）。
- `deny` 中会让 via 卡死的正则（嵌套量词等，见「deny」的正则安全）同样被忽略，诊断为 error 级 `unsafe-deny`，处理方式与无效正则相同。
- 加载结果同时返回全部诊断，供 `via doctor` 和 `via servers` 展示；诊断分 `error`、`warning`、`info` 三级。

## 凭证引用

配置里只写引用，不写明文：

| 写法 | 含义 |
| --- | --- |
| `env:NAME` | 读取环境变量 |
| `file:~/.secrets/x` | 读取文件内容并去掉首尾空白 |
| `keychain:service/account` | 读取系统钥匙串（macOS Keychain、Linux Secret Service、Windows Credential Manager） |
| `cmd:op read op://dev/exa/key` | 执行命令，取去掉首尾空白的 stdout；只允许出现在用户配置中，详见下文 |

- 凭证引用可以出现在 `env`、`headers` 的值以及 `auth.bearer` 中。
- 不以上述前缀开头的值视为字面量；出现在用户或项目配置中的字面量凭证，`via doctor` 告警。`auth.bearer`、`auth.headers` 中的字面量在加载时就告警。
- `env:` 的变量未设置或为空、`file:` 的文件不存在或为空、`keychain:` 无此条目，都是凭证缺失（退出码 4），错误信息只说明缺哪一项，不含任何解析出的值。`file:` 的相对路径相对于当前目录。
- 钥匙串模块是原生库，首次用到 `keychain:` 时才加载。加载失败（该平台没有预编译模块、单文件可执行里被替换成了不可用的文件、没有 Secret Service 的 Linux 服务器）与钥匙串本身读不出来一样，是凭证缺失（退出码 4）：`error: cannot read the system keychain: <原因>`，`next:` 提示改用 `env:` 或 `file:`。单文件可执行版本内嵌的是自己那个平台的模块；`NAPI_RS_NATIVE_LIBRARY_PATH` 指向某个 `.node` 文件时改为加载它（napi-rs 的通用约定）。OAuth 的存储在这种情况下退回文件（[auth.md](auth.md#存储)）。
- `cmd:` 出现在项目配置或项目级、框架级配置里时，加载阶段就拒绝：该 server 的定义整条被忽略并报错（`cmd-forbidden`，[security.md](security.md#项目级配置的信任)）。`via trust` 不能放行 `cmd:`。
- `cmd:` 的执行方式（[security.md](security.md#cmd-凭证)）：
  - 命令行按空白分词，不经 shell。`'…'` 内按字面处理；`"…"` 内只有 `\"` 与 `\\` 是转义；引号外 `\` 转义下一个字符；不展开 `$VAR`、`~`、通配符，管道与重定向无效。命令为空或引号未闭合是无效引用（退出码 4）。
  - 命令继承 via 的环境变量，在当前目录运行；超时 30 秒，stdout 上限 64 KiB。
  - 命令未找到、非零退出、被信号终止、超时、stdout 为空，都是凭证缺失（退出码 4）。错误信息只说明程序名与原因，**不含命令的 stdout 与 stderr**，`next:` 提示手工运行该命令排查。
  - 结果按引用原文缓存在解析器的内存里，默认 10 分钟（失败不缓存），同一引用并发解析只运行一次。进程内模式下解析器只活到命令结束，因此每条 `cmd:` 引用每次 `via` 调用最多运行一次；daemon 持有同一个解析器，缓存随之跨调用生效，到期后下次调用重新运行。来源检查先于缓存：来源不是用户配置时每次都拒绝，缓存里的值不会交给它。
  - `via servers` 不执行 `cmd:`（它不连接任何 server，且助手可能很慢或要求指纹确认），不把 `cmd:` 引用算作缺失；`via doctor` 和真正使用 server 时才执行。
- 配置里写的字面量值长度不足 8 个字符时不进入脱敏列表，避免把 `1`、`on` 之类的短值（它们多半是开关而不是凭证）在输出里全部替换成 `***`。`env:`、`file:`、`keychain:`、`cmd:` 解析出的值不论长短都进入脱敏列表；短值只在输出的内容部分替换，不改写结构（[脱敏的范围](output.md#脱敏的范围)）。
- 解析结果只存在于 daemon（或进程内模式下的当前进程）内存中，不写盘。

## deny

- 正则在单字符串形式上匹配，例如 `^github/.*:delete$`、`^notion/page:(delete|move)$`。一条规则对每个工具匹配三种写法，任一命中即 deny：
  1. 当前规范写法 `provider/资源:动作`（`rename` 之后的写法，有 `alias` 时 provider 是别名）；
  2. 原始名写法 `provider/原始名`（如 `^github/delete_file$`）；
  3. 默认规范写法：命名规则对原始名拆分的结果（[naming.md](naming.md)），不含 `rename`，也不含重名时降级为叶子工具的调整。

  所以无论规则是按默认写法、原始名还是 `rename` 后的写法写的，用户或项目配置用 `rename` 改名都不会让规则失效。写法都是 JavaScript 正则、区分大小写、不隐含锚定，没有标志位。
- `provider` 是 CLI 上用的名字（有 `alias` 时是别名），不是 `servers` 下的键。
- 命中的工具在浏览、`find`、未命中时的候选提示中都不可见，直接调用退出码 5（用任何写法：规范写法、原始名、`via call`、唯一前缀，带不带 `--yes` 都一样；`--dry-run` 同样拒绝）。deny 先于 `--yes` 检查：被 deny 的危险工具报的是 deny，而不是缺少 `--yes`。
- 各层取并集，顺序为用户配置、项目配置、命令行；相同的规则只算一条。项目配置和命令行只能追加规则，不能撤销用户配置的规则（没有「取消 deny」的写法，`deny: []` 什么也不改变），项目配置也不能通过重定义 server、改别名或 `rename` 绕过（规则对 `rename` 前后的写法都生效，见上）。
- **正则安全**：项目配置可以追加 deny 规则，所以规则不能让 via 卡死。V8 的正则没有超时，加载配置时对每条规则做静态检查，下列写法与无效正则一样被拒绝（忽略该规则，诊断为 error 级 `unsafe-deny`，CLI 停止执行，不会在缺少这条规则的情况下继续）：
  - 长度超过 200 个字符；
  - 反向引用（`\1`、`\k<name>`）；
  - 被重复的分组（后跟 `*`、`+`、`{n,}` 或 `{n,m}` 且 m > 1）里含有开放量词（`*`、`+`、`{n,}`），即嵌套量词，如 `(a+)+`、`(\w+\s?)*`；
  - 被重复的分组里的候选分支不是互不为前缀的纯字面量，如 `(a|a)*`、`(a|aa)+`、`(\d|\d\d)+`（`(delete|remove)` 这类没有被重复的分组不受限）；
  - 整条正则里开放量词超过 3 个。

  规则只在**有界的输入**上匹配：每个被匹配的写法（见上）不超过 256 个字符，更长的工具名无法检查，按 deny 处理（隐藏，直接调用退出码 5）。常见写法（`^github/.*:delete$`、`^notion/page:(delete|move)$`、`_(delete|remove)s?$`）都能通过检查。
- `deny` 不是字符串列表（包括只写 `deny:` 而没有值）视为类型错误，与无效正则一样是 error 级诊断，CLI 停止执行（见「校验与诊断」）。用户配置和项目配置文件本身无法解析同样是 error 级诊断。
- 项目配置的 `deny` 在未信任时同样生效：它只会让更多工具不可见。
- deny 只在 via 一侧生效；需要不可绕过的限制时使用上游的只读端点或网关（见 [security.md](security.md)）。
