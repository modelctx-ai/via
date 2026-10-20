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
- **草案版本**：按 schema 中 `$schema` 声明的版本校验，未声明时按 MCP 规范规定的默认版本。
- **`format`**（如 `date-time`、`uri`、`email`）：校验不通过时只在 stderr 给出警告，不阻止调用。各 server 对 format 的理解并不一致，以上游为准。
- **`$ref`**：只解析 schema 内部的引用；指向外部 URL 的引用不下载，相关部分跳过校验并给出警告。

### 报错

校验失败时退出码为 2，一次列出所有问题，并附上 usage：

```console
error: missing required --repo; --state must be one of open, closed, all
usage: via github issue:list --owner <str> --repo <str> [--state open|closed|all]
```

- 报错中的参数名一律用 kebab-case 和命令行写法（`--filter.state`），而不是 JSON Pointer。
- 未知参数报错并给出最接近的参数名；根对象允许任意字段时例外（见 [JSON 输入](#json-输入)）。
- anyOf / oneOf 无法匹配时，列出各分支需要的字段，而不是逐条罗列每个分支的失败原因。

### schema 不可靠时

本地校验是为了尽早发现错误，上游才是最终裁判。schema 本身有问题时，via 不应当挡住本来能成功的调用：

| 情况 | 处理 |
| --- | --- |
| 本地缓存的 schema 已过期（server 刚升级） | 校验失败且缓存超过 5 分钟时，先刷新该 server 的 `tools/list` 再校验一次；仍失败才报错 |
| schema 无法编译（语法错误、不支持的关键字） | 跳过本地校验直接发送，stderr 给出一次警告，并记录在 `via servers` 中 |
| schema 写错，导致合法调用被拒 | 用户可以加 `--no-validate` 跳过本地校验；元信息行标注 `unvalidated` |
| 上游返回参数错误，而本地校验通过 | 原样输出上游错误（退出码 1），并在 stderr 提示 schema 与 server 行为不一致 |

`--no-validate` 只跳过 schema 校验，危险操作的 `--yes` 确认和 `deny` 规则照常生效。

### 输出校验

工具声明了 `outputSchema` 时，用它校验返回的 `structuredContent`。不匹配时照常渲染，只在 stderr 给出警告，不改变退出码。

## 危险操作

- 工具 annotations 中 `destructiveHint: true` 的工具需要 `--yes` 才会执行；缺少时退出码为 5，并说明原因。
- 可在配置中按 server 设置 `confirm: never` 关闭这一检查。
- `readOnlyHint` 在帮助和资源视图中标注，方便 agent 判断。
- `--dry-run` 只打印解析结果：规范写法、目标 server、最终参数（凭证打码），不发起调用，退出码 0。
- 配置中的 `deny` 规则命中的工具在浏览和 `find` 结果中不可见，直接调用也会被拒绝，退出码 5。

## 调用过程

- 上游的 progress 通知输出到 stderr，不污染 stdout。
- 默认超时 60 秒，可按 server 配置或用 `--timeout` 覆盖；超时退出码 6。
- 只对 `readOnlyHint: true` 的工具在超时或连接错误时自动重试一次；其余工具失败即返回，避免重复写入。
