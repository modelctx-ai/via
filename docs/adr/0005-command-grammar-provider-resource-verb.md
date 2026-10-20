# 0005. 命令形态为 `mx <provider> <resource>:<verb>`

- 状态：已接受
- 日期：2026-10-20

## 背景

早期草案用 `mx <provider>.<tool>` 加单独的 `mx ls` 浏览。问题是 MCP 原始工具名风格各异（`create_issue`、`issue_read`、`notion-create-pages`），直接作为命令既不整齐，也不利于逐级发现。

## 决策

- 命令按 provider → 资源 → 动作三级组织：`mx linear issue:create`。
- 每一级前缀本身是一条浏览命令：`mx`、`mx linear`、`mx linear issue`。不需要单独的 `ls`。
- 资源与动作用冒号连接，冒号标明「这是一个工具」，其后全部是参数。
- 原始工具名始终可作为别名调用。
- 拆分不出资源或动作的工具作为叶子工具：`mx notion search`。

## 备选方案

- **`mx linear issue create`（全用空格）**：与 `gh` 更像，但无法区分 create 是动作还是位置参数。
- **`mx linear.create_issue`**：直接使用原始名，不需要拆分规则，但浏览层级不清晰，命名风格不统一。
- **把 domain 放进路径**：见 [ADR 0006](0006-domain-is-a-view.md)。

## 后果

- 与 `gh issue create`、`kubectl get pods`、`heroku apps:create` 同构，模型几乎不需要说明就会用。
- `mx <provider>` 一级每个资源一行、动作内联，是最省 token 的发现步骤。
- 需要一套确定性的拆分规则和动词表（[naming.md](../spec/naming.md)），动词表改动会改变规范写法，必须纳入版本与 CHANGELOG 管理。
- 内置子命令名成为保留字，与之重名的 provider 需要改名。
