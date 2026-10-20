# 参数映射与调用

工具的 `inputSchema` 在运行时映射成命令行参数，不生成代码（[ADR 0008](../adr/0008-dynamic-dispatch-no-codegen.md)）；本地先做 JSON Schema 校验，不合法的调用不会发到上游。

## 映射规则

| schema 类型 | 命令行写法 | 说明 |
| --- | --- | --- |
| string / number / integer | `--name value` 或 `--name=value` | 按 schema 转换类型；enum 在帮助里列出可选值并校验 |
| boolean | `--flag` / `--no-flag` | — |
| 标量数组 | `--tag a --tag b` 或 `--tag '["a","b"]'` | 重复传参，或整体写 JSON 数组；不用逗号分隔，避免值内含逗号时歧义 |
| object | `--filter.state open` 或 `--filter '{"state":"open"}'` | 点号路径逐层赋值，或整体写 JSON 对象 |
| 对象数组 | `--pages '[{…}]'` 或 `--pages @pages.json` | 只能整体写 JSON |
| 复杂结构 | `--args '{…}'`、`--args @file.json`、`--args -` | 整个参数对象写成 JSON；`--args` 作为基础，其余参数在其上覆盖 |
| 唯一必填的 string 参数 | 位置参数 `via exa web:search "rust mcp"` | 仅当恰好一个必填参数且其类型为 string 时启用 |

### 参数名

- 同时接受 snake_case、camelCase 和 kebab-case，统一写成 kebab 即可：`--issue-number` 对应 `issue_number`，`--pull-number` 对应 `pullNumber`。
- 帮助、签名、报错中一律显示 kebab-case。
- 归一化后两个参数同名时，两者都必须用原名指定，并在 `-h` 中提示。

### 从文件或 stdin 读取

- 任何参数值以 `@` 开头时从文件读取，值为 `-` 时从 stdin 读取（同一次调用只能有一个参数读 stdin）。
- string 类型按原文传入；object 和 array 类型按 JSON 解析。
- 字面量以 `@` 开头时写 `@@` 转义。
- 适合长描述、代码、复杂对象：`--body @bug.md`、`--code - <<'JS' … JS`、`--pages @pages.json`。

### JSON 输入

需要 JSON 的场景分四种，处理方式不同：

| 场景 | 写法 | 处理 |
| --- | --- | --- |
| 整个参数对象是 JSON | `--args '{…}'`、`--args @args.json`、`--args -`；脚本用 `via call <provider>/<resource>:<verb> --args …`；批量用 `via batch` 的 JSONL | 作为参数对象的基础 |
| object / array 类型的参数 | `--filter '{"state":"open"}'`、`--labels '["bug","p1"]'`、`--pages @pages.json` | 按 JSON 解析 |
| string 类型、但内容是 JSON 文本的参数 | `--query '{"bool":{…}}'`、`--query @query.json` | **不解析**，按原文作为字符串传入 |
| schema 宽松的参数（未声明 `type`，或 object 未声明 `properties` 且允许任意字段） | `--payload '{…}'`、`--count 3`、`--name acme` | 值是合法 JSON 时按 JSON 解析，否则按字符串传入 |

规则：

- 是否解析由 schema 决定，不由值的外观决定。只有 schema 不允许字符串的位置才会把 `{…}`、`[…]` 当作 JSON；允许字符串的位置一律原样传入，避免把用户想传的 JSON 文本意外改成对象。
- schema 同时允许 string 和 object/array（如 `type: ["string", "object"]`）时，值以 `{` 或 `[` 开头且能解析为 JSON 才按 JSON 处理，否则按字符串。需要强制原样传入时，用 `--args` 整体给出。
- 根对象允许任意字段（未声明 `properties`，或 `additionalProperties` 不为 `false`）时，未声明的 `--key value` 不报错，值按上一条「schema 宽松」的规则处理；`-h` 中提示「accepts extra fields」。
- JSON 解析失败时退出码 2，报错指出参数名和出错位置，并提示可以改用 `@文件`。
- 合并顺序：先取 `--args`，再按命令行顺序应用其余参数；同一路径后写的覆盖先写的，对象之间做深合并。例如 `--filter '{"state":"open","label":"bug"}' --filter.state closed` 的结果是 `{"state":"closed","label":"bug"}`。
- 帮助中 object、array 参数显示为 `--filter <json>`，有声明字段的 object 额外列出 `--filter.<field>` 写法。
- `via batch` 每行的 `args` 就是这里的 `--args` 基础对象，没有命令行参数可叠加，也不展开 `@文件` 与 `-`（[cli.md](cli.md#via-batch)）。
- `--dry-run` 打印合并后的完整参数 JSON，用于确认最终发给上游的内容。
- shell 中内联 JSON 用单引号包裹；内容较长或带单引号时，用 `@文件` 或 heredoc（`--args - <<'JSON' … JSON`）。

### anyOf / oneOf 自动补齐

schema 中的 anyOf/oneOf 分支能由已给出的字段唯一确定时，自动补齐该分支里只有一个可选值（`const` 或单值 `enum`）的字段。例如 Notion `parent` 的分支由 `page_id` 确定后，自动补上 `type: "page_id"`。无法唯一确定分支时不补齐，报错并列出可选分支。

### 与全局选项重名

工具参数与全局选项重名时（例如参数名为 `full`、`yes`、`timeout`），用 `--p.full` 显式指定为工具参数；不加前缀时按全局选项处理。

## 帮助

`via <provider> <resource>:<verb> -h` 由 schema 渲染：

```console
$ via github issue:read -h
usage: via github issue:read --owner <str> --repo <str> --issue-number <num>
         --method get|get_comments|get_sub_issues|get_parent|get_labels
         [--page <num>] [--per-page <num>]

Get issue details
  --method   get: Get issue details · get_comments: Get issue comments · …
alias: issue_read · read-only
```

- 必填参数在前，显示类型、默认值、enum 可选值和截断后的描述。
- usage 行超过 120 列时按 80 列折行，续行缩进 9 格，每个参数不拆开；错误信息里的 usage 最多列出 8 个可选参数，其余写成 `[…]`，完整列表见 `-h`。
- 类型写法：string `<str>`、number/integer `<num>`、object/array `<json>`、boolean 只写开关；enum 直接写 `a|b|c`（超过 60 个字符时退回类型，完整列表放在参数行）。与全局选项重名的参数显示为 `--p.<name>`。
- 参数行只列有描述、默认值或需要说明的参数；多行描述压成一行，列表项以 ` · ` 连接，放不下时以 ` · …` 结尾。标量数组注明「repeat the flag or pass a JSON array」。
- 末尾显示原始名、只读或危险标记。

## 校验与报错

所有调用在发往上游之前，都必须用该工具的 `inputSchema` 做本地校验。命令行参数、`--args`、`@文件`、`via call`、`via batch` 走同一条路径，没有绕过校验的入口（`--no-validate` 除外，见下文）。

### 校验流程

1. **解析**：把命令行参数、`--args`、文件内容按[合并顺序](#json-输入)合成一个参数对象。
2. **类型转换**：按 schema 把命令行上的字符串转成目标类型，如 `--count 3` 转为数字 `3`、`--draft` 转为 `true`。转换只按 schema 声明进行，不猜测。
3. **补齐**：执行 [anyOf / oneOf 自动补齐](#anyof--oneof-自动补齐)。schema 中的 `default` 不由 via 填入，交给上游处理，避免与上游的默认值不一致。
4. **校验**：用 JSON Schema 校验合并后的完整对象，一次收集所有错误，不在第一个错误处停下。
5. **发送**：校验通过后才发往上游。

### 校验范围

- **覆盖**：必填字段、类型、enum 与 const、数值范围、字符串长度与正则、数组长度、嵌套对象与数组元素、anyOf / oneOf / allOf、`additionalProperties`。
- **草案版本**：按 schema 中 `$schema` 声明的版本校验，未声明时按 JSON Schema 2020-12（MCP 规范规定的默认方言）。没有 `$schema` 且无法按 2020-12 编译的旧式 schema（如数组形式的 `items`）退回 draft-07 再试一次；声明 draft-04/06/07 的按 draft-07 校验，2019-09 按 2019-09。
- **`format`**（如 `date-time`、`uri`、`email`）：校验不通过时只在 stderr 给出警告，不阻止调用。各 server 对 format 的理解并不一致，以上游为准。
- **`$ref`**：只解析 schema 内部的引用；指向外部 URL 的引用不下载，相关部分跳过校验并给出警告（`<规范写法>: external $ref <url> is not downloaded; that part is not validated`）。

### 报错

校验失败时退出码为 2，报错写到 stderr。目标是让 agent 读一次报错就能改对：每条错误都说清是哪个参数、要求是什么、实际传了什么。

只有一个错误时，一行说明，后面跟 usage：

```console
$ via github issue:list --owner acme
error: --repo is required
usage: via github issue:list --owner <str> --repo <str> [--state open|closed|all] [--per-page <num>] [--title <str>]
```

有多个错误时一次全部列出，每个参数一行：

```console
$ via github issue:list --owner acme --state opened --per-page 500 --titel x
error: 4 invalid arguments
  --repo       required
  --state      must be one of: open, closed, all (got "opened"; did you mean "open"?)
  --per-page   must be <= 100 (got 500)
  --titel      unknown argument; did you mean --title?
usage: via github issue:list --owner <str> --repo <str> [--state open|closed|all] [--per-page <num>] [--title <str>]
next: via github issue:list -h
```

各类错误的固定说法：

| 失败类型 | 提示 |
| --- | --- |
| 缺少必填 | `--repo  required` |
| 类型不符 | `--count  must be a number (got "abc")` |
| 枚举 / const | `--state  must be one of: open, closed, all (got "opened"; did you mean "open"?)` |
| 数值范围 | `--per-page  must be <= 100 (got 500)` |
| 字符串长度 | `--title  must be at most 256 characters (got 300)` |
| 正则 | `--id  must match ^[A-Z]+-\d+$ (got "eng123")` |
| 数组长度 | `--labels  must have at most 10 items (got 12)` |
| 数组元素 | `--labels[1]  must be a string (got 3)` |
| 嵌套字段 | `--filter.state  must be one of: open, closed (got "x")` |
| 未知参数 | `--titel  unknown argument; did you mean --title?` |
| anyOf / oneOf 不匹配 | `--parent  must provide one of: page_id, database_id, data_source_id` |
| JSON 解析失败 | `--filter  invalid JSON at 1:18: unexpected "}"; consider @file` |
| 文件读取失败 | `--body  cannot read @bug.md: no such file` |
| `format` 不符（仅警告） | `warning: --due should be a date-time (got "tomorrow")` |
| 缺少参数值 | `--state  requires a value` |
| 参数名归一化后有歧义 | `--per-page  ambiguous; use one of the original names: per_page, perPage` |
| 多余的位置参数 | `foo  unexpected argument; pass values as --name value`（唯一的位置参数之后再出现则提示加引号） |
| stdin 被重复读取 | `--name  cannot read stdin: another argument already reads it (only one per call)` |
| oneOf 同时匹配多个分支 | `--v  must provide only one of: a, b` |

规则：

- 参数名一律用 kebab-case 的命令行写法（`--filter.state`、`--labels[1]`），而不是 JSON Pointer；参数来自 `--args` 时同样换算成这种写法。
- `(got …)` 中的值超过 40 个字符时截断；值命中已解析的凭证时显示为 `***`。
- 有更接近的合法值时附 did you mean（枚举值、参数名都适用），最多给一个。
- anyOf / oneOf 无法匹配时，列出各分支需要的字段，而不是逐条罗列每个分支的失败原因。
- 未知参数在根对象允许任意字段时不报错（见 [JSON 输入](#json-输入)）。
- 只有一个错误时，`error:` 行写成 `<参数> <说明>`（`--repo is required`、`unknown argument --titel; did you mean --title?`），不带 `next:`；有多个错误时写 `N invalid arguments`，逐行列出并附 `next: via <规范写法> -h`。
- 错误顺序：解析阶段的错误（JSON、文件、缺少参数值）、必填、取值错误（按 schema 字段顺序）、未知参数。同一个参数有多条取值错误时合并成一行，用 `; ` 连接。
- JSON 解析失败的位置是 `行:列`；来自文件或 stdin 时写成 `invalid JSON at 3:9 in @p.json: unexpected "}"`，不再提示 `consider @file`。
- anyOf / oneOf 的各分支用「区别于其他分支的必填字段」代表（只有一个可选值的字段如 `type` 不算）；分支不是对象时列出类型名（`must provide one of: string, integer (got true)`）。
- 已被 `--no-validate` 跳过校验时，仍报告 JSON、文件和 stdin 错误，但不再报告未知参数。
- 重复的数组参数（`--tag a --tag b`）从该参数在命令行上的第一次出现起重新累积，覆盖 `--args` 中的同名值；整体 JSON 数组写法覆盖此前的累积。boolean 参数后面紧跟 `true` / `false` 时当作它的值。
- 错误信息使用英文。模型对英文 CLI 报错最熟悉，也方便在 issue 和日志中搜索。
- `-o json` 时报错为结构化 JSON，格式见 [output.md](output.md#错误)。

上游返回的参数错误（本地校验通过、上游拒绝）原样输出上游的错误文本，退出码 1，并在 stderr 提示「schema 与 server 行为不一致」，便于判断是哪一侧的问题。判断规则：结果 `isError` 且文本里出现 `invalid arguments`、`missing … parameter`、`must be`、`unknown argument` 之类的措辞，或上游以 JSON-RPC `InvalidParams`（-32602）拒绝时，在 `next:` 之前加一行 `note: the local schema accepted these arguments but the server rejected them; the tool schema and the server disagree (try --no-validate to rule the schema out)`。`-o json` 时错误对象的格式固定，不加这一行。

### schema 不可靠时

本地校验是为了尽早发现错误，上游才是最终裁判。schema 本身有问题时，via 不应当挡住本来能成功的调用：

| 情况 | 处理 |
| --- | --- |
| 本地缓存的 schema 已过期（server 刚升级） | 校验失败且缓存超过 5 分钟时，先刷新该 server 的 `tools/list` 再校验一次；仍失败才报错 |
| schema 无法编译（语法错误、不支持的关键字） | 跳过本地校验直接发送，stderr 给出一次警告（`schema of <规范写法> cannot be compiled (<原因>); local validation skipped`），并记录在 `via servers` 中 |
| schema 写错，导致合法调用被拒 | 用户可以加 `--no-validate` 跳过本地校验；元信息行标注 `unvalidated` |
| 上游返回参数错误，而本地校验通过 | 原样输出上游错误（退出码 1），并在 stderr 提示 schema 与 server 行为不一致 |

`--no-validate` 只跳过 schema 校验，危险操作的 `--yes` 确认和 `deny` 规则照常生效。

### 输出校验

工具声明了 `outputSchema` 时，用它校验返回的 `structuredContent`。不匹配时照常渲染，只在 stderr 给出警告，不改变退出码。

警告写成 `<tool> result does not match its outputSchema: items[0].id must be string`，最多 3 条，其余合并为一行计数；返回值可能含敏感内容，警告里不引用值，也不检查 `format`。`outputSchema` 无法编译时静默跳过。

## 危险操作

- 工具 annotations 中 `destructiveHint: true` 的工具需要 `--yes` 才会执行；缺少时退出码为 5，并说明原因：

  ```console
  error: gh file:delete is destructive and was not run
  next: rerun with --yes to confirm
  ```
- 可在配置中按 server 设置 `confirm: never` 关闭这一检查。
- `readOnlyHint` 在帮助和资源视图中标注，方便 agent 判断。
- `--dry-run` 只打印解析结果：规范写法、目标 server、最终参数（凭证打码），不发起调用，退出码 0。
- 配置中的 `deny` 规则命中的工具在浏览和 `find` 结果中不可见，直接调用也会被拒绝，退出码 5。

## 调用过程

- 上游的 progress 通知输出到 stderr，不污染 stdout，每条一行：`progress: 1/2 halfway`（没有 total 时只写进度值）。进度是尽力而为的提示，到达顺序不保证先于结果。
- 默认超时 60 秒，可按 server 配置或用 `--timeout` 覆盖；超时退出码 6。
- 只对 `readOnlyHint: true` 的工具在超时或连接错误时自动重试一次；其余工具失败即返回，避免重复写入。
