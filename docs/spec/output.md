# 输出与退出码

所有工具共用一套渲染规则，不为单个工具写模板。数据写 stdout，元信息写 stderr：`| jq` 拿到的是干净数据，agent 仍能看到提示。

## 渲染流程

1. **选数据源**：`isError` 为真时走[错误路径](#错误)；否则优先取 `structuredContent`，其次尝试把 text 内容解析为 JSON，都不行就按原文处理。多个 content 块依次渲染。
2. **清理**：去掉 null、空字符串、空数组、空对象；按噪声字段表去掉 `node_id`、`_links`、`*_api_url` 之类字段。噪声表见 `data/noise.json`，可按 server 用 `noise` 配置追加。
3. **按形状渲染**：
   - 字段一致的对象数组 → 对齐的表格，最多 6 列，优先选 name、title、id、number、state、url 等字段，其余列在元信息行注明「+N cols (-o json)」；
   - 单个对象 → `key: value` 逐行输出，嵌套对象缩进两格；
   - 纯文本 → 原样输出。
4. **限长**：单元格超过 80 字符截断并加 `…`；总输出超过预算（默认 8 KB，可按 server 用 `budget` 配置）时截断，完整结果存入游标。
5. **媒体**：图片、音频、二进制资源写入缓存目录，只打印文件路径；resource link 只打印 URI。
6. **脱敏**：已解析的凭证值精确匹配替换为 `***`。

宽度计算必须按显示宽度（中日韩字符双宽）对齐。

## 输出格式

| 选项 | 内容 | 用途 |
| --- | --- | --- |
| `-o text`（默认） | 上述紧凑渲染 | agent 阅读 |
| `-o json` | 清理后的 JSON，仍受预算约束 | 管道给 `jq` |
| `-o raw` | 上游原始 content，不做任何处理（仍脱敏） | 排查问题 |
| `--full` | 关闭截断，可与任意格式组合 | 需要完整结果时 |

## 元信息行

成功调用后在 stderr 输出一行，以 `·` 开头，字段以 ` · ` 分隔：

```text
· <规范写法> · <耗时> · <行数或字节数> [· +N cols (-o json)] [· next: <命令>]
```

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
- `via more <游标>` 从截断处继续，格式与首段一致；仍有剩余时元信息行给出新的游标。
- 游标是不透明字符串，不得编码凭证或参数原文。

## 错误

错误一律写 stderr，第一行是原因，后面跟可执行的下一步：

```console
error: linear requires auth
next: via auth login linear
```

- `isError` 结果：上游错误文本经清理、脱敏后输出，退出码 1。
- 参数错误附 usage（[arguments.md](arguments.md#校验与报错)）；找不到附 did you mean（[discovery.md](discovery.md#找不到时)）。
- `-o json` 时错误同样写 stderr，格式为 `{"error": {"code": <退出码>, "message": "…", "next": "…"}}`。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（含 `--dry-run`） |
| 1 | 工具返回 `isError` |
| 2 | 参数或用法错误 |
| 3 | 工具或 server 不存在 |
| 4 | 需要鉴权或鉴权失败 |
| 5 | 被拒绝：deny 规则命中，或危险操作缺少 `--yes` |
| 6 | 上游、传输错误或超时 |
| 7 | via 内部错误 |
