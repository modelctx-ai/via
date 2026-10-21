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
4. **组资源**：剩余的词逐词单数化后用 `-` 连接作为资源，相邻重复词去重（单数化之后比较）。修饰词同样用单数，所以 `actions_run_trigger` 的资源是 `action-run`，而不是 `actions-run`。
5. **叶子工具**：拆不出资源或动作的，作为叶子工具，名字转为 kebab-case，在 `via <provider>` 的最后一行列出。
6. **冲突**：两个工具拆出相同的 `资源:动作` 时，两者都退回为叶子工具，避免歧义。
7. **叶子与资源同名**：叶子工具的名字与某个资源相同时，资源保留这个名字，叶子改用原始名的 kebab-case（`acme_search` 去掉 provider 词后是 `search`，改为 `acme-search`）。原始名本身就是这个名字时（`search` 与拆成 `search:batch` 的 `batch_search`），叶子没有别的名字可用，于是**资源让出名字**：该资源下的工具全部按规则 6 退回为叶子工具（`batch-search`），叶子保留 `search`。退回后若又出现同名，按本条再处理一次，直到没有冲突。用户 `rename` 到该资源的工具不退回，资源随之保留。

动词表放在 `data/verbs.json`（格式见[数据文件](../development/data-files.md#verbsjson)），至少包括 get、list、create、update、delete、search、send、run、fetch、read、write、add、remove、merge、trigger、query、move、duplicate、restore、cancel、navigate、click。

### 单数化

只做确定性的英文规则，不查词典：

| 规则 | 示例 |
| --- | --- |
| `-ies` → `-y` | `entries` → `entry` |
| `-sses`、`-shes`、`-ches`、`-xes` → 去 `es` | `branches` → `branch` |
| 其余以 `s` 结尾且不以 `ss`、`us`、`is` 结尾的去 `s` | `issues` → `issue`、`logs` → `log` |
| 长度不超过 2 的词不变 | `os`、`ps` |
| 例外表 | `data`、`news`、`series`、`status` 等不变，例外表放在 `data/verbs.json` 的 `singularExceptions` |
| 不规则复数 | 通用规则处理不了的复数形式，如 `statuses` → `status`、`caches` → `cache`，放在 `data/verbs.json` 的 `singularIrregular` |

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
