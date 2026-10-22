# 0021. server 自述只在 `via <provider> -h` 里显示；补全用 `--complete` 显式查询

- 状态：已接受
- 日期：2026-10-21

## 背景

路线图 e9 留下两个问题（原来在 [待定问题](../open-questions.md) 里）：

1. server 在握手里给出 `instructions`，`serverInfo` 里有 `description` 与 `websiteUrl`。有的 server 靠它们说明工具之间的用法约束（「先 `search` 再 `fetch`」），放进 `via <provider>` 视图或 `via find` 的检索能帮 agent 选对工具。但它们占 token（`instructions` 有的上千字），内容由 server 控制，是提示注入最直接的入口：一段写进默认视图的文字，会出现在 agent 每一次浏览里。
2. `completion/complete` 能为 prompt 参数和资源模板变量建议取值。via 的命令是一次一命令、没有交互式输入框，补全放在哪里、什么时候发请求，要先定。

约束：

- 浏览命令不连接 server，冷启动是核心指标（[实现说明](../development/implementation.md#启动速度)）。
- 输出要严格、可复现（[output.md](../spec/output.md)）；发现逻辑默认是确定性的（[ADR 0011](0011-find-synonym-expansion-and-optional-embeddings.md)）。
- server 的文字是数据，不是 via 的说明；脱敏、控制字符与伪造行的规则同工具输出（[security.md](../spec/security.md)）。
- 不为特定 server 适配（[ADR 0007](0007-no-gateway-specific-adaptation.md)）。

## 决策

**server 自述只出现在 `via <provider> -h`**，放在 provider 视图之前：`instructions`、`serverInfo.description`、`websiteUrl`，加 `title` 与 `version`。不进默认的 provider 视图、资源视图、`via find` 的索引与结果、`via prompt` 的说明，也不影响排序。要用的 agent 主动问，不用的不付 token；`-h` 本来就是「这个东西怎么用」的位置。

- 每段文字先脱敏、再截到 500 个字符（按码点），被截断时说明原长。写进缓存之前就这样处理，缓存里没有未脱敏的原文，也不会因截断留下半个凭证。
- 整块标明来自 server（`from the server (its own text, not via's):`），每行缩进，除换行与制表外的控制字符、双向控制符、零宽字符写成可见的 `\uXXXX`。这样它不能伪造 `next:`、`error:`、`·` 或 `→` 行，也不能移动光标。
- 存放：目录缓存旁的 `catalog/<哈希>.info.json`，与目录同一个 TTL，随每次拉取目录写入（in-process 与 daemon 都写）。分开存放，是因为每条浏览命令都读主文件，而自述只有 `-h` 读，且内容由 server 控制。旧缓存没有它时 `-h` 刷新一次。
- via 不解释这些文字，也不据此改变行为。

**补全用显式的 `--complete <参数>`**：`via prompts <provider> <名称> [--参数 值…] --complete <参数>` 与 `via resources <provider> <uri模板> [--变量 值…] --complete <变量>`。要补全的参数已经写出的值就是前缀，其余参数作为 `context`；结果是每行一个取值，保持 server 的顺序。

- 做成全局选项，这样参数恰好叫 `complete` 时有现成的 `--p.complete` 转义（[arguments.md](../spec/arguments.md)），用在别的命令上是用法错误而不是被忽略。
- 不自动发请求：`-h` 不为列出取值而连接 server。目录缓存记着 server 声明了 `completions` 能力时，prompt 的 `-h` 多一行提示（`features.completions`，缓存里的可缺省新字段）。
- 不做必填校验：补全发生在命令写完之前。
- 范围只有 prompt 参数和资源模板变量（协议只覆盖这两种引用）；不为工具参数补全。
- `via serve` 不新增元工具：集合固定为七个（[ADR 0016](0016-via-serve-meta-tools-over-stdio.md)），`via_prompts` 的 `args` 已经能表达同样的参数；需要补全的 agent 有 shell 时用命令行。

## 备选方案

- **自述放进 `via <provider>` 视图**：每次浏览都付 token，并把 server 控制的文字放到 agent 最先看到的位置。拒绝。
- **自述放进 `find` 的检索文本**：改变排序，让 server 能通过措辞影响自己工具的排名（对所有 server 一视同仁也一样），也破坏「检索只看工具名与描述」的可解释性。拒绝。
- **不显示自述**：丢掉 server 想传达的使用约束。`-h` 是低成本的折中。
- **自述存进主缓存文件**：要改 `FILE_HEAD` 的前缀解析，而且自述里任意的花括号会破坏它；还会让每条浏览命令多读多解析一段自己用不到的文字。
- **在 prompt 的 `-h` 里自动列出每个参数的建议值**：每个参数一次请求，`-h` 变成网络操作、输出随 server 状态变化；`-h` 应当是稳定的说明。
- **独立的内置子命令 `via complete`**：又一个保留字，要重复 provider、prompt、参数的整套写法；`--complete` 复用了 prompt 与模板已有的写法，只多一个选项。
- **在资源模板上用 `via read <uri模板> --complete`**：`read` 是读取一个具体的 URI，不展开模板（[cli.md](../spec/cli.md#mcp-资源与-prompt-命令)）；模板在 `via resources` 的列表里，补全跟着它走。

## 后果

- `via <provider> -h` 的输出多了自述块，token 只在这条命令上增加（最多约 130 token）。
- 每次拉取目录多写一个很小的 `.info.json`；`ServerFeatures` 多一个可缺省的 `completions`；daemon 协议多一个 `complete` 请求；`McpClient` 多 `complete` 与 `info`。
- `--complete` 成为需要 `--p.` 前缀的参数名（同 `--full`、`--yes`、`--schema-snapshot`）。
- 补全的建议值是 server 的内容，按内容档脱敏并把控制字符写成可见转义。
