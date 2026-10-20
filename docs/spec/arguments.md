# 参数映射与调用

工具的 `inputSchema` 在运行时映射成命令行参数，不生成代码（[ADR 0008](../adr/0008-dynamic-dispatch-no-codegen.md)）；本地先做 JSON Schema 校验，不合法的调用不会发到上游。

## 映射规则

| schema 类型 | 命令行写法 | 说明 |
| --- | --- | --- |
| string / number / integer | `--name value` 或 `--name=value` | 按 schema 转换类型；enum 在帮助里列出可选值并校验 |
| boolean | `--flag` / `--no-flag` | — |
| 标量数组 | `--tag a --tag b` | 重复传参；不用逗号分隔，避免值内含逗号时歧义 |
| object | `--filter.state open` | 点号路径逐层赋值 |
| 复杂结构 | `--args '{…}'`、`--args @file.json`、`--args -` | `--args` 作为基础，其余参数在其上覆盖 |
| 唯一必填的 string 参数 | 位置参数 `mx exa web:search "rust mcp"` | 仅当恰好一个必填参数且其类型为 string 时启用 |

### 参数名

- 同时接受 snake_case、camelCase 和 kebab-case，统一写成 kebab 即可：`--issue-number` 对应 `issue_number`，`--pull-number` 对应 `pullNumber`。
- 帮助、签名、报错中一律显示 kebab-case。
- 归一化后两个参数同名时，两者都必须用原名指定，并在 `-h` 中提示。

### 从文件或 stdin 读取

- 任何参数值以 `@` 开头时从文件读取，值为 `-` 时从 stdin 读取（同一次调用只能有一个参数读 stdin）。
- string 类型按原文传入；object 和 array 类型按 JSON 解析。
- 字面量以 `@` 开头时写 `@@` 转义。
- 适合长描述、代码、复杂对象：`--body @bug.md`、`--code - <<'JS' … JS`、`--pages @pages.json`。

### anyOf / oneOf 自动补齐

schema 中的 anyOf/oneOf 分支能由已给出的字段唯一确定时，自动补齐该分支里只有一个可选值（`const` 或单值 `enum`）的字段。例如 Notion `parent` 的分支由 `page_id` 确定后，自动补上 `type: "page_id"`。无法唯一确定分支时不补齐，报错并列出可选分支。

### 与全局选项重名

工具参数与全局选项重名时（例如参数名为 `full`、`yes`、`timeout`），用 `--p.full` 显式指定为工具参数；不加前缀时按全局选项处理。

## 帮助

`mx <provider> <resource>:<verb> -h` 由 schema 渲染：

```console
$ mx github issue:read -h
usage: mx github issue:read --owner <str> --repo <str> --issue-number <num>
         --method get|get_comments|get_sub_issues|get_parent|get_labels
         [--page <num>] [--per-page <num>]

Get issue details
  --method   get: Get issue details · get_comments: Get issue comments · …
alias: issue_read · read-only
```

- 必填参数在前，显示类型、默认值、enum 可选值和截断后的描述。
- 末尾显示原始名、只读或危险标记。

## 校验与报错

校验失败时退出码为 2，一次列出所有问题，并附上 usage：

```console
error: missing required --repo; --state must be one of open, closed, all
usage: mx github issue:list --owner <str> --repo <str> [--state open|closed|all]
```

未知参数报错并给出最接近的参数名。

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
