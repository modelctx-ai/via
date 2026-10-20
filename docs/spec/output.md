# 输出与退出码

所有工具共用一套渲染规则，不为单个工具写模板。数据写 stdout，元信息写 stderr：`| jq` 拿到的是干净数据，agent 仍能看到提示。

## 渲染流程

1. **选数据源**：`isError` 为真时走[错误路径](#错误)；否则优先取 `structuredContent`，其次尝试把 text 内容解析为 JSON，都不行就按原文处理。多个 content 块依次渲染：单行文本和媒体路径紧挨着输出，结构化内容（表格、对象）前后各空一行。`structuredContent` 与 text 里只是重复它的 JSON 文本不再重复渲染。工具声明了 `outputSchema` 时先校验 `structuredContent`，不匹配只在 stderr 警告（[arguments.md](arguments.md#输出校验)）。
2. **清理**：去掉 null、空字符串、空数组、空对象；按噪声字段表去掉 `node_id`、`_links`、`*_api_url` 之类字段。噪声表见 `data/noise.json`，可按 server 用 `noise` 配置追加。
3. **按形状渲染**：
   - 字段一致的对象数组 → 对齐的表格，最多 6 列，优先选 name、title、id、number、state、url 等字段，其余列在元信息行注明「+N cols (-o json)」；
   - 单个对象（含只有一个元素的数组）→ `key: value` 逐行输出，嵌套对象缩进两格；多行字符串缩进成块；嵌套的一致对象数组在缩进后同样渲染为表格，只有单个字段的对象数组（`[{name: bug}]`）合并为 `bug, p1`；
   - 纯文本 → 原样输出。

   表格里缺失的单元格显示 `-`；单元格里的数组用 `, ` 连接，对象取 `data/columns.json` 中 `labelKeys` 指定的字段代表它，换行折成空格。至少两行且至少一半的字段在半数以上的行里出现，才算「字段一致」。选列规则放在 `data/columns.json`（[数据文件](../development/data-files.md#columnsjson)）。
4. **限长**：单元格超过 80 字符截断并加 `…`；总输出超过预算（默认 8 KB，可按 server 用 `budget` 配置）时按整行截断，完整结果存入游标。单行本身就超过预算时，这一行会被拆成多段分页输出。
5. **媒体**：图片、音频、二进制资源写入缓存目录，只打印文件路径；resource link 只打印 URI。
6. **脱敏**：已解析的凭证值精确匹配替换为 `***`（JSON 转义后的写法同样替换）。实现上在清理和截断**之前**先对数据脱敏，避免单元格截断留下半个凭证，输出前再对成品整体扫一遍；写入游标的内容已经脱敏。

宽度计算必须按显示宽度（中日韩字符双宽）对齐。

## 输出格式

| 选项 | 内容 | 用途 |
| --- | --- | --- |
| `-o text`（默认） | 上述紧凑渲染 | agent 阅读 |
| `-o json` | 清理后的 JSON，仍受预算约束 | 管道给 `jq` |
| `-o raw` | 上游原始 content，不做任何处理（仍脱敏）；不受预算约束，不产生游标 | 排查问题 |
| `--full` | 关闭截断，可与任意格式组合 | 需要完整结果时 |

## 元信息行

成功调用后在 stderr 输出一行，以 `·` 开头，字段以 ` · ` 分隔：

```text
· <规范写法> · <耗时> · <行数或字节数> [· +N cols (-o json)] [· <标记>…] [· next: <命令>]
```

- 耗时不足 1 秒写 `318ms`，否则写 `1.8s`。
- 结果是列表（表格、数组）且未截断时写 `N rows`；其他情况写字节数，`k` 以 1024 为单位（`8.0k`，小于 1024 时写原始数字）；被截断时写 `已显示/总计 bytes`。
- 标记目前只有 `unvalidated`（[arguments.md](arguments.md#schema-不可靠时)），排在 `+N cols` 之后、`next:` 之前。
- 警告（如 `outputSchema` 不匹配）写在元信息行之前，每条一行 `warning: …`。

示例：

```console
$ via github issue:list --owner acme --repo api
number  title                    state  labels   updated
12      Support OAuth DCR        open   auth     2026-10-18
11      Group inference too eag… open   catalog  2026-10-17
9       Windows named pipes      open   daemon   2026-10-12
· github issue:list · 318ms · 3 rows · +7 cols (-o json)

$ via exa web:search "rust mcp"
title                          url                                   score
Rust MCP SDK                   github.com/modelcontextprotocol/rus…  0.91
…
· exa web:search · 612ms · 8.0k/38.2k bytes · next: via more c7f2
```

元信息行固定以 `·` 开头，避免与工具内容混淆（[security.md](security.md)）。

## 游标

- 被截断的完整结果由 daemon 保存 30 分钟；进程内模式下存在用户缓存目录（权限 0700），按 TTL 清理。
- `via more <游标>` 从截断处继续，格式与首段一致（表格的表头在每一段重复）；仍有剩余时元信息行给出新的游标。元信息行里的 `shown/total bytes` 中 `shown` 是到本段为止累计已显示的字节数。
- 游标是不透明字符串（4 位十六进制起，冲突时变长的随机串），不得编码凭证或参数原文。
- 游标不存在或已过期：退出码 3，提示 `next: rerun the original command`。

## 错误

错误一律写 stderr，第一行是原因，后面跟可执行的下一步：

```console
error: linear requires auth
next: via auth login linear
```

- `isError` 结果：上游错误文本经清理、脱敏后输出，退出码 1，`next:` 指向该工具的 `-h`。「清理」指去掉终端转义序列和控制字符（保留换行与制表符），并受预算约束，`--full` 时不截断。
- 传输与上游错误（退出码 6）：第一行写原因，如 `cannot start playwright: …`、`github did not answer within 60s`、`lost the connection to exa`；`next:` 超时时为 `rerun with a larger --timeout`，其余为 `via doctor`。网络错误只写 scheme 与主机（URL 的路径和查询串可能带凭证）；上游回显的文本经脱敏、清理、折成一行并限长 300 字符。`exclusive: true` 的 stdio server 启动失败时原因后追加「可能与 agent 框架中仍在运行的同名 server 冲突」（命令不存在时除外）。
- 参数错误附 usage（[arguments.md](arguments.md#校验与报错)）；找不到附 did you mean（[discovery.md](discovery.md#找不到时)）。
- `-o json` 时错误同样写 stderr，格式为 `{"error": {"code": <退出码>, "message": "…", "next": "…", "details": [...]}}`。参数校验失败时 `details` 中每条错误一个对象：

  ```json
  {"error": {
    "code": 2,
    "message": "2 invalid arguments",
    "next": "via github issue:list -h",
    "details": [
      {"arg": "--repo", "path": "/repo", "rule": "required"},
      {"arg": "--state", "path": "/state", "rule": "enum",
       "expected": ["open", "closed", "all"], "got": "opened", "suggest": "open"}
    ]
  }}
  ```

  `arg` 是命令行写法，`path` 是 JSON Pointer，`rule` 是失败的 schema 关键字（`required`、`type`、`enum`、`maximum`、`pattern`、`additionalProperties` 等，JSON 解析失败为 `json`）。`got` 遵循与文本输出相同的截断与脱敏规则。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含 `--dry-run`） |
| 1 | 工具返回 `isError` |
| 2 | 参数或用法错误 |
| 3 | 工具或 server 不存在 |
| 4 | 需要鉴权或鉴权失败 |
| 5 | 被拒绝：deny 规则命中，危险操作缺少 `--yes`，或项目级配置未经 `via trust` 确认（`via trust` 本身没有得到确认时同样是 5） |
| 6 | 上游、传输错误或超时 |
| 7 | via 内部错误 |
