# 工具名拆分

规范名由 provider、资源、动作三部分组成，写作 `linear issue:create`。本文规定如何把 MCP 原始工具名确定性地拆成 `资源:动作`。

## 规则

按顺序执行：

1. **切词**：按 `_`、`-`、`.` 和驼峰切词，统一小写。
2. **去 provider 词**：去掉与 provider 名（及其别名）相同的词，不论在开头还是结尾（`linear_create_issue`、`web_search_exa`）。
3. **找动作**：
   - 首词在动词表中则取首词；
   - 否则末词在动词表中则取末词，兼容 `issue_create` 这类写法；
   - 首尾都不是动词时，取第一个出现的动词（`calendar_list_events` → `calendar-event:list`）；
   - 用 `or`、`and` 连接的多个动词合并为复合动作（`create_or_update_file` → `file:create-or-update`）。
4. **组资源**：剩余的词用 `-` 连接作为资源，末词单数化，相邻重复词去重（单数化之后比较）。
5. **叶子工具**：拆不出资源或动作的，作为叶子工具，名字转为 kebab-case，在 `mx <provider>` 的最后一行列出。
6. **冲突**：两个工具拆出相同的 `资源:动作` 时，两者都退回为叶子工具，避免歧义。

动词表放在 `data/verbs.json`（格式见[数据文件](../development/data-files.md#verbsjson)），至少包括 get、list、create、update、delete、search、send、run、fetch、read、write、add、remove、merge、trigger、query、move、duplicate、restore、cancel、navigate、click。

### 单数化

只做确定性的英文规则，不查词典：

| 规则 | 示例 |
| --- | --- |
| `-ies` → `-y` | `entries` → `entry` |
| `-sses`、`-shes`、`-ches`、`-xes` → 去 `es` | `branches` → `branch` |
| 其余以 `s` 结尾且不以 `ss`、`us`、`is` 结尾的去 `s` | `issues` → `issue`、`logs` → `log` |
| 例外表 | `data`、`news`、`series`、`status` 等不变，例外表放在 `data/verbs.json` 的 `singularExceptions` |

## 示例

| 原始工具名 | provider | 规范写法 |
| --- | --- | --- |
| `create_issue` | linear | `linear issue:create` |
| `linear_list_issues` | linear | `linear issue:list` |
| `list_my_issues` | linear | `linear my-issue:list` |
| `issue_read` | github | `github issue:read` |
| `get_pull_request_comments` | github | `github pull-request-comment:get` |
| `create_or_update_file` | github | `github file:create-or-update` |
| `actions_run_trigger` | github | `github action-run:trigger` |
| `get_job_logs` | github | `github job-log:get` |
| `notion-create-pages` | notion | `notion page:create` |
| `notion-calendar-list-events` | notion | `notion calendar-event:list` |
| `notion-search` | notion | `notion search`（叶子） |
| `web_search_exa` | exa | `exa web:search` |
| `browser_navigate` | playwright | `playwright browser:navigate` |
| `sequentialthinking` | sequential-thinking | `sequential-thinking sequentialthinking`（叶子） |

拆分结果的更多真实案例见 [Provider 指南](../guides/providers/)。

## 稳定性约定

- 拆分结果是**视图**；原始名永远是有效别名，不会因规则调整而失效。
- 动词表、单数化例外表的改动会改变规范写法，因此：
  - 必须随版本发布，不得在补丁版本中删除动词；
  - 必须在 `CHANGELOG.md` 中单独列出受影响的规范写法；
  - 实现应当提供一个离线检查，对测试集中的真实 server 输出拆分结果的差异。
- 用户可以在配置中对单个工具指定规范写法（`servers.<name>.rename`，见 [config.md](config.md)），优先级高于规则。
