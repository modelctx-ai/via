# 参数映射与调用

工具的 `inputSchema` 在运行时映射成命令行参数，不生成代码（[ADR 0008](../adr/0008-dynamic-dispatch-no-codegen.md)）；本地先做 JSON Schema 校验，不合法的调用不会发到上游。

`via prompts <provider> <名称>` 的参数（MCP prompt 的参数是一组具名字符串）也走这套解析：via 把 `arguments` 转成只有 `string` 属性的 object schema（`required: true` 的进必填，`additionalProperties: false`），所以映射、`-h`、校验与报错都与工具一致，只是没有危险操作确认和 `outputSchema` 校验（[cli.md](cli.md#mcp-资源与-prompt-命令)）。

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
- 文件和 stdin 的内容按 UTF-8 解码，开头的 UTF-8 BOM 被忽略，带 BOM 的 UTF-16（PowerShell 5.1 的 `>` 与 `Out-File` 的默认输出）转成文本；没有 BOM 的其他编码不猜测。
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

工具参数与全局选项重名时（例如参数名为 `full`、`yes`、`timeout`、`schema-snapshot`），用 `--p.full` 显式指定为工具参数；不加前缀时按全局选项处理。

## 帮助

`via <provider> <resource>:<verb> -h` 由 schema 渲染：

```console
$ via github issue:read -h
usage: via github issue:read --owner <str> --repo <str> --issue-number <num>
         --method get|get_comments|get_sub_issues|get_parent|get_labels
         [--page <num>] [--per-page <num>]

Get issue details
  --method   get: Get issue details · get_comments: Get issue comments · …
example: via github issue:read --owner text --repo text --issue-number 1 --method get
alias: issue_read · read-only
```

- 必填参数在前，显示类型、默认值、enum 可选值和截断后的描述。
- usage 行超过 120 列时按 80 列折行，续行缩进 9 格，每个参数不拆开；错误信息里的 usage 最多列出 8 个可选参数，其余写成 `[…]`，完整列表见 `-h`。
- 类型写法：string `<str>`、number/integer `<num>`、object/array `<json>`、boolean 只写开关；enum 直接写 `a|b|c`（超过 60 个字符时退回类型，完整列表放在参数行）。与全局选项重名的参数显示为 `--p.<name>`。
- 参数行只列有描述、默认值或需要说明的参数；多行描述压成一行，列表项以 ` · ` 连接，放不下时以 ` · …` 结尾。标量数组注明「repeat the flag or pass a JSON array」。
- 末尾显示原始名、只读或危险标记；其上一行是[调用示例](#调用示例)。

### 调用示例

`-h` 在 `alias:` 行之前给出一行 `example:`，是按 `inputSchema` 生成、可以直接粘贴运行的调用（`via prompts <provider> <名称> -h` 同样有，写的是 prompt 的参数）。agent 读了它就知道嵌套对象、对象数组、tuple 该怎么写，不必再去翻映射规则；这行文字会进入 agent 的上下文，所以只给一条、尽量短（上例约 25 个 token）。错误信息里的 `usage:` 不带它。

- **选哪些参数**：所有必填参数，之后补可选参数，直到共 3 个；必填参数已有 3 个以上时只写必填。可选参数的值是空容器（`'{}'`、`'[]'`，没有教学意义），或补上它会让整行超过 200 个字符时，跳过。没有参数的工具不显示。必填参数连一个可写的值都没有，或只写必填就超过 400 个字符时，整行不显示。
- **取什么值**：`enum`/`const` 的第一个值；其次 `examples` 的第一个、`default`（长度超过 60 字符的不用；boolean 不用 `default`，直接写开关）；都没有时按类型生成：string 写 `text`（有 `format` 时写该格式的合法值：`date-time`、`date`、`time`、`email`、`uri`、`hostname`、`ipv4`），integer/number 取 `minimum`（`exclusiveMinimum` 加 1；不超过 `maximum`，默认 1），boolean 写 `--flag`。
- **写成什么形态**，与[映射规则](#映射规则)一致：
  - 声明了字段的 object：点号路径，只写必填字段（没有必填字段时写第一个声明的字段），最多嵌套 3 层：`--filter.state open --filter.range.from 2026-01-15`；
  - 标量数组：重复的 flag 写一项：`--tag text`；
  - 对象数组、tuple（`prefixItems`，或数组形式的 `items`）、没有声明字段的 object：整体写 JSON，用引号包住：`--pages '[{"title":"text"}]'`、`--point '[1,1]'`；
  - nullable（`type: ["string", "null"]`、`anyOf`/`oneOf` 带 `null` 分支）：写非 null 分支的值，`anyOf`/`oneOf` 取第一个非 null 分支；
  - 本地 `$ref` 展开，对象字段最多展开 4 层，到顶的数组写 `[]`、对象写 `{}`，自引用的 schema 不会无限展开；
  - 值以 `-` 开头时写成 `--name=-5`（否则会被当成选项）。
- **安全**：整行是一条可粘贴的命令，每个词都遵循[可粘贴的命令行](output.md#可粘贴的命令行)的引用规则，值来自 server 的 schema 也不例外：`enum`/`default`/`examples` 里的值没有安全写法（含换行、控制字符，或引号加 shell 语法字符），或以 `@` 开头（会被读成文件）、等于 `-`（会被读成 stdin）时，换用下一个候选值，最终退回按类型生成的值；一个参数的所有可选值都不能写，则跳过它（必填时整行不显示）。参数名按[参数名](#参数名)的规则写；没有安全写法的原名（归一化后同名时保留的原名）加引号，不能引用的参数跳过。
- **Windows**：PowerShell 与 `cmd.exe` 没有共同的、能带双引号的写法（[output.md](output.md#可粘贴的命令行)），所以需要 JSON 的参数（对象数组、tuple）在 Windows 上不写进示例；必填时整行不显示，改用 `--args @文件`。
- 示例是为了展示写法，不保证业务上有意义（`text`、`1`）；但它按同一个解析器和校验器检查：测试对夹具里全部工具的示例逐条解析并校验，必须通过。

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

## schema 快照校验

上游改了工具的 schema（加了必填参数、改了类型、去掉了输出字段），依赖旧写法的脚本和 CI 会在运行时才以难懂的方式失败。`--schema-snapshot` 让它们在发调用之前就发现：把工具**当前**的 `inputSchema`、`outputSchema` 与保存下来的快照比较，不兼容就不发调用。

```console
$ via github issue:read -h -o json > issue-read.snapshot.json      # 保存快照
$ via github issue:read --owner acme --repo api --issue-number 1 --method get \
      --schema-snapshot issue-read.snapshot.json                    # 兼容才会真的调用
```

**快照文件**是 `-h -o json` 的输出（工具详情），也接受 MCP 的工具对象本身（有 `inputSchema`/`outputSchema` 的 `tools/list` 条目）。详情是一个 JSON 对象：

| 字段 | 内容 |
| --- | --- |
| `tool` | 规范写法，如 `github issue:read` |
| `rawName` | 原始名 |
| `description` | 工具描述（有则写） |
| `readOnly`、`destructive` | 为真时才写 |
| `inputSchema` | 输入 schema；工具没有声明时为 `{"type": "object"}` |
| `outputSchema` | 输出 schema（有则写） |

文件里有 `rawName`（或 `name`）时必须与要调用的工具一致，否则是用法错误（拿错了文件）。输出经脱敏后写出，格式 2 空格缩进。

**选项**（全局选项，[cli.md](cli.md#全局选项)）：`--schema-snapshot <文件>`；`--schema-mode compatible|strict`，默认 `compatible`。选项名带 `snapshot` 而不是 `--schema`，是因为 `schema` 是常见的工具参数名（Notion 的 `notion-create-database`、各种 SQL 与结构化输出工具），全局选项会把它们抢走（只能写成 `--p.schema`），这会让原本能用的调用静默改变含义。

**适用范围**：工具调用（`via <provider> <工具> …`、`via call`）和工具的 `-h`；`--dry-run` 先检查再打印。检查发生在参数解析之前，所以快照不兼容时看到的是快照的报告，而不是参数错误。`via batch`、浏览视图、`find` 等没有单个工具可比的命令带上它时退出码 2。

**用的是现在的 schema**：本地缓存的 `tools/list` 超过 5 分钟（[schema 不可靠时](#schema-不可靠时)用的同一个阈值）时，先向 server 刷新再比较，因为目的就是发现 server 现在给出的是什么。刷新失败时用缓存比较，并在 stderr 写 `warning: could not refresh the tool list of <server>; the snapshot was compared with the cached schema`。刷新后工具已不存在：退出码 3，`gh stat:get is no longer offered by gh`。

### 兼容档（`compatible`）

判断标准：照快照写的调用和读结果的代码，在现在的 schema 下是否还成立。注释、描述、`default`、`examples` 等不影响调用的关键字不参与比较；`$ref` 先展开，`anyOf`/`oneOf` 按其类型集合与声明的字段比较，嵌套的 object 与数组元素逐层比较（最多 6 层）。

| 变化 | 输入（调用） | 输出（结果） |
| --- | --- | --- |
| 新增字段 / 参数 | 可选：兼容；必填：**不兼容** | 兼容 |
| 去掉字段 / 参数 | **不兼容** | 必填字段：**不兼容**；可选字段：兼容 |
| 可选 ↔ 必填 | 可选变必填：**不兼容**；必填变可选：兼容 | 必填变可选：**不兼容**；可选变必填：兼容 |
| 类型变化 | 现在的类型集合包含过去的（`string` → `string\|null`，`integer` → `number`）：兼容，否则**不兼容** | 现在的类型集合包含于过去的（`string\|null` → `string`）：兼容，否则**不兼容** |
| `enum` / `const` | 取值只增不减：兼容；去掉旧值、或原本不限定现在限定了取值：**不兼容** | 现在的取值都在过去列出的范围内：兼容；出现新值：**不兼容** |
| `outputSchema` | 新增：兼容；去掉：**不兼容** | — |
| `inputSchema` 去掉 | 无参数可比，兼容 | — |

输入侧的「去掉」包括可选参数：照旧写法调用的人还在传它，via 自己的解析器对封闭的 schema 也会报未知参数。

### 严格档（`strict`）

`inputSchema` 与 `outputSchema` 逐字相等：对象的键序、`required` 里的顺序不计，其余（包括描述、`default`、新增的可选参数）任何差异都是不兼容。工具的 `description`（不在这两个 schema 里）不参与。报告里的路径是 schema 内部的路径（`properties.loud`、`properties.owner.type`、`required`），最多收集 40 处，报告列出前 8 条。

### 结果

- **兼容**：照常继续（调用，或显示用法）。有兼容的变化时 stderr 一行 `warning: gh echo-text changed compatibly since the snapshot: --loud new optional parameter; …`（最多列 3 条，其余计数）。
- **不兼容**：不发调用，stdout 为空，退出码 **2**，stderr：

  ```console
  error: gh echo-text: 2 breaking changes against issue.snapshot.json (compatible); nothing was sent
    input   --lang     new required parameter
    output  count      required field removed
    (1 more change that is compatible)
  next: via gh echo-text -h -o json
  ```

  `input` 一列的路径是命令行写法（`--filter.state`、`--pages[].title`），`output` 一列是字段路径（`owner.login`、`items[].id`）。最多列出 8 条，其余写成 `… N more`。`next:` 是重新生成快照的命令，确认变化是预期的之后用它更新文件。`-o json` 时同输出规范的错误对象，`details` 里每条不兼容的变化一个对象：`{"side": "input", "path": "--lang", "rule": "added", "message": "new required parameter"}`，`rule` 取 `added`、`removed`、`required`、`optional`、`type`、`enum`、`schema`（整个 schema 出现或消失）、`differs`（严格档）。
- **快照本身有问题**：文件读不了、不是 JSON、不是工具快照、属于另一个工具、`--schema-mode` 不是这两个值：退出码 2，说明原因，`next:` 同样是重新保存快照的命令。

**为什么是退出码 2**：[输出规范](output.md#退出码)里 2 是「参数或用法错误」，也就是本地在发出之前就判定「这条调用不能这样发」，且重试不会变好；快照不兼容正是这一类（调用写法与工具现状不符，要改的是调用或快照）。6（上游、传输错误）会被 agent 和脚本当作可重试的暂时故障，1 只用于工具自己返回 `isError`，5 是被拒绝，都不合适，所以没有新增退出码。需要区分「用法错误」与「快照不兼容」的脚本，看 `-o json` 的错误里的 `details`（有 `side`/`rule`）。

## 危险操作

- 工具 annotations 中 `destructiveHint: true` 的工具需要 `--yes` 才会执行；缺少时退出码为 5，并说明原因：

  ```console
  error: gh file:delete is destructive and was not run
  next: rerun with --yes to confirm
  ```
- `readOnlyHint: true` 的工具不算破坏性，即使同时声明了 `destructiveHint: true`：MCP 规定 `destructiveHint` 只在 `readOnlyHint` 为 false 时有意义。这样的工具按只读处理：不需要 `--yes`，帮助与视图只标 `read-only`，超时或连接错误后照常自动重试一次（见下文「调用过程」）。
- 可在配置中按 server 设置 `confirm: never` 关闭这一检查。
- `readOnlyHint` 在帮助和资源视图中标注，方便 agent 判断。
- `--dry-run` 只打印解析结果：规范写法、目标 server、最终参数（凭证打码），不发起调用，退出码 0。
- 配置中的 `deny` 规则命中的工具在浏览和 `find` 结果中不可见，直接调用也会被拒绝，退出码 5。

## 调用过程

- 上游的 progress 通知输出到 stderr，不污染 stdout，每条一行：`progress: 1/2 halfway`（没有 total 时只写进度值）。进度是尽力而为的提示，到达顺序不保证先于结果。
- 默认超时 60 秒，可按 server 配置或用 `--timeout` 覆盖；超时退出码 6。超时是整次调用的预算：等待并发名额（`concurrency`）、等待会话建立（冷启动的 stdio server、HTTP 握手）和请求本身都算在内，所以 `--timeout 5` 的调用不会因为 server 卡在握手里而等满 server 自己的连接超时。建立会话的那次握手本身最多持续 server 的 `timeout`，调用放弃等待时它不随之中止，daemon 里的下一次调用可以直接用上它。等不到会话时报 `timed out after <秒>s connecting to <provider>`，排队或请求超时报 `<provider> did not answer within <秒>s`。
- 只对 `readOnlyHint: true` 的工具在超时或连接错误时自动重试一次；其余工具失败即返回，避免重复写入。调用已经变成任务之后不再重试（会跑两遍）。
- server 把调用变成任务时（或工具要求以任务运行），整个过程仍在同一个预算内：via 跟随任务到结果，`--detach` 则在任务创建后返回任务 ID（[cli.md](cli.md#任务via-tasks-与---detach)）。`--detach` 与 `--complete` 一样是全局选项，工具参数同名时写 `--p.detach`。
