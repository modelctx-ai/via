# 0031. MCP Apps 里只给界面调用的工具（`visibility` 不含 `"model"`）不进入目录

- 状态：已接受
- 日期：2026-10-27

## 背景

GitHub 的远程 MCP server 列出 47 个工具，其中 `ui_get` 带 `_meta.ui.visibility: ["app"]`，其余带界面的工具是 `["model", "app"]`。Claude Code 只给模型 46 个工具；via 列出全部 47 个：`via github` 有 `ui:get`，`via find` 可能返回它，agent 也能调用它。

这个字段来自 MCP Apps 扩展（`io.modelcontextprotocol/ui`，规范版本 2026-01-26）：`"model"` 表示工具对 agent 可见、可由 agent 调用，`"app"` 表示只能由这个 server 自己的界面（app）调用；缺省为 `["model", "app"]`。规范要求宿主在 `visibility` 不含 `"model"` 时**不得**把工具放进 agent 的工具列表。规范也要求 server 先看客户端是否声明了这个扩展再注册带界面的工具，但实际的 server 不看：via 没有声明扩展，仍然收到 `ui_get`。对 agent 来说 via 就是宿主，目录就是 agent 的工具列表。

## 决策

1. 目录构建时，在拆分工具名**之前**去掉 `_meta.ui.visibility` 是数组而不含 `"model"` 的工具（[discovery.md](../spec/discovery.md#目录构建流程) 第 1 步），如同 server 没有列出它：视图、`via find` 的索引、`via serve` 里都没有它，按规范写法或原始名调用都是 `no such tool`（退出码 3），它也不参与重名处理，不会让别的工具降级为叶子工具。
2. 只读 `_meta.ui.visibility` 这一项。缺省、不是数组、或 `_meta` 不是对象时按默认值保留工具。这是协议扩展的规则，对所有 server 一样，不是对某个 server 的适配（[ADR 0007](0007-no-gateway-specific-adaptation.md)）。
3. 原始 `tools/list` 缓存照样保存这些工具；`via sync`、`via doctor`、`via daemon status` 的工具数按 server 列出的数目计，与被 `deny` 的工具相同。过滤代码在 `src/catalog/`，规则指纹覆盖它，升级后旧的预构建文件自动作废。
4. via 不声明 MCP Apps 扩展，也不渲染界面；`ui://` 资源仍是普通资源，`via resources`、`via read` 照常可用。

## 备选方案

- **列出但加标记**（如 `[app-only]`）：违反规范的「不得放进 agent 的工具列表」；这类工具是给 server 的界面用的（`ui_get` 返回界面资源），列出来只会让 agent 读到用不上的条目、试着调用它。
- **当作 `deny` 处理**：`deny` 是用户的决定，命中时退出码 5，并提示被哪条规则拒绝；这里是协议规则，用户没有写过任何规则，提示「被拒绝」会误导。「找不到」与 Claude Code 的表现一致。
- **配置开关，允许列出**：目前没有需求；需要时再加，默认值不变。
- **声明扩展，让 server 换成纯文本的工具**：via 没有界面可以渲染，声明了就是谎报能力。

## 后果

- `via github` 显示 46 个工具，与 Claude Code 一致。按名字调用 `ui_get` 的脚本现在得到退出码 3：这是行为变化，写进 `CHANGELOG.md`。
- 从源码运行时（测试、开发）规则指纹只含数据文件，过滤上线前建出的预构建文件要等原始列表刷新（`via sync`）才重建；构建出的 `via` 不受影响。
- 以后 MCP Apps 若给 `visibility` 加新的取值，只要不含 `"model"` 就按同样的规则去掉。
