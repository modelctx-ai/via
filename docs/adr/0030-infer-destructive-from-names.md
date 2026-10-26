# 0030. 没有声明破坏性注解的工具按名字推断，并允许用户点名要求确认

- 状态：已接受
- 日期：2026-10-26

## 背景

via 只在工具 annotations 里 `destructiveHint: true` 时要求 `--yes`。实际使用中很多 server 不写任何注解（一个有 35 个工具的 HTTP server，没有一个带 `readOnlyHint` 或 `destructiveHint`）：`delete_secrets`（描述写明不可撤销）、`delete_topics` 这类工具不加 `--yes` 就执行，`--dry-run` 也没有 `requires:` 行。`via prompt` 生成的说明同时告诉 agent「Destructive tools need `--yes`」，给了它虚假的安全感。用户也没有办法让某个工具必须确认：`confirm` 只有 `destructive`（默认）与 `never`。

MCP 规范里 `destructiveHint` 的默认值是 `true`（只在 `readOnlyHint` 为 false 时有意义），这个问题在规范层面有答案，via 目前没有采用。

## 决策

1. **推断**（[arguments.md](../spec/arguments.md#危险操作)）：工具不是只读（`readOnlyHint` 不是 `true`）且没有声明 `destructiveHint` 时，把**原始名**切词（复用 `tokenize`），任一词在 `data/destructive.json` 的词表里就按破坏性处理，需要 `--yes`。显式声明永远优先：`destructiveHint: false` 与 `readOnlyHint: true` 不推断。用原始名而不是规范写法，结果就不随动词表、单数化、`rename`、重名降级而变。
2. **不冒充声明**：目录里记 `destructiveBy`（`server`、`inferred`、`config`）。文本视图标 `[destructive?]` 而不是 `[destructive]`，`-h` 写 `destructive? (inferred from the name; needs --yes)`，`-o json` 里 `destructive` 仍是布尔值（旧消费者不受影响），多一个 `destructiveBy`。错误信息写明是推断的，`next:` 照旧 `rerun with --yes to confirm`。
3. **配置**（[config.md](../spec/config.md#confirm)）：`servers.<name>.confirm` 在 `destructive`、`never` 之外接受 `{ tools, except }`，两个正则列表，匹配写法与 `deny` 完全相同（四种写法、同样的正则安全检查和长度上限）。`tools` 点名要求确认，`except` 豁免（server 声明的也可以），同时命中按 `tools`。项目配置只能收紧：`tools` 生效，`confirm: never` 与 `except` 被忽略并告警。
4. **词表**，保守，一个词只在「名字里出现它几乎总是数据丢失或权限收回」时才收：

   | 词 | 理由 | 已知误报 |
   | --- | --- | --- |
   | `delete` | 最常见的删除动词 | `delete_draft` 一类可恢复的删除也会要求确认 |
   | `remove` | 移除成员、文件、条目；常不可撤销 | `remove_label` 之类可以立刻加回的也会要求确认，用 `except` 豁免 |
   | `destroy` | 同 `delete`，语气更重 | 极少 |
   | `drop` | 删表、删库、丢弃 | `drop_down` 作为界面控件名时误报（整词匹配，`dropdown`、`dropbox` 不命中） |
   | `purge` | 永久清除 | 极少 |
   | `erase` | 擦除数据 | 极少 |
   | `wipe` | 清空 | 极少 |
   | `revoke` | 收回令牌、授权、权限；多数需要重新授予 | `revoke_session` 这类自己的会话也会要求确认 |
   | `truncate` | 清空表、截断数据 | 极少 |
   | `prune` | 清理历史、对象（`git prune`、`docker prune`） | 极少 |

   不收的词与原因：`clear`、`reset`、`close`、`archive`、`cancel`、`disable`、`kill`、`terminate`、`uninstall`、`overwrite`、`replace` 在不同 server 里既可能是破坏性动作也可能是日常操作（`clear_notifications`、`reset_password`、`close_issue`），收进来会让只读或可恢复的工具大面积要 `--yes`；`archive` 通常可恢复。需要时由用户在 `confirm.tools` 里点名。
5. `--dry-run`、`via batch`、`via serve` 本来就与 `via call` 走同一条路径（`executeCall`），判断相同，测试覆盖。`via prompt` 与 `via serve` 的说明改为如实描述：「Tools marked destructive (declared by the server, or inferred from names like delete) need `--yes`」。

## 备选方案

- **直接采用 MCP 的默认值（没声明就算破坏性）**：规范上最正确，但对不写注解的 server，所有工具包括 `list_*`、`get_*` 都要 `--yes`。`--yes` 就失去意义：agent 会学到「永远带 `--yes`」，也就不再是一道确认；脚本里每个读操作也要带。已经声明了 `readOnlyHint: true` 的 server 不受影响，受影响的恰恰是不写注解的那一类。via 的目标之一是让 agent 少走弯路，这个代价比误放过一部分写操作大，所以没有采用。
- **按描述里的词（`no undo`、`irreversible`）推断**：描述是自然语言、会被翻译、会被提示注入利用，也不稳定；名字更短、更确定，推断可重复。
- **只给配置，不推断**：不改变默认行为，不写配置的用户仍然没有保护，而问题恰恰出在默认。
- **把词表写在代码里**：违反「规则类内容放 `data/`」的约定，用户难以审查。

## 后果

- 没有注解的 server 上，名字含这些词的工具开始要 `--yes`：这是行为变化，写进 `CHANGELOG.md`。不含这些词的破坏性工具（`archive_*`、`overwrite_*`）仍不受保护，用 `confirm.tools` 补。推断只是对名字的猜测，不是安全边界（[security.md](../spec/security.md)）。
- 误报的代价是多带一次 `--yes`，由 `confirm.except` 豁免，而不是改词表。
- 目录预构建缓存多记两个标记位；缓存键里的规则指纹覆盖 `data/destructive.json`，词表改动后旧缓存自动失效。
- `confirm: never` 现在只关闭 server 声明的和推断的检查，`confirm.tools` 点名的仍要确认。项目配置里的 `confirm: never` 以前会生效，现在被忽略并告警，因为它让仓库替用户去掉一道确认。
