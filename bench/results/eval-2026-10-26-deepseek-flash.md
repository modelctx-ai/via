# agent 评测结果（2026-10-26）

由 `npm run bench:eval` 生成，方法见 [测试与评测](../../docs/development/testing.md#agent-评测) 和 [bench/README.md](../README.md)。成功与否完全由回放 server 的调用日志判定（每个任务的 `success` 块），不由模型自评。

## 环境

- 模型：deepseek-flash，effort medium
- 9 个任务 × 10 次，共 360 次运行；每次最多 25 轮，单次回复最多 16,000 输出 token
- via 0.3.1，Node.js v24.22.1
- 挂载的 server：github、linear、notion、playwright、cloudflare
- 对照：mcp2cli 3.8.0
- 对照：mcpc 0.7.0

mcp2cli 一列是同日第二次运行的结果。第一次运行里这一列访问本机回放时收到 HTTP 502，90 次全部失败，那一列已替换，不计入上表。native、via、mcpc 仍是第一次运行。四列都是 deepseek-flash、effort medium、每个任务 10 次。

## 总览

| condition | success | rate (95% CI) | input tok mean / median | output tok mean / median | total tok mean / median | turns mean / median | tool calls | error calls | wall s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 68/90 | 76% (66%–83%) | 128,205 / 111,436 | 2,336 / 1,945 | 130,541 / 113,294 | 7.1 / 6.0 | 9.9 | 5.2 | 31.0 |
| via | 66/90 | 73% (63%–81%) | 61,422 / 40,688 | 3,177 / 2,161 | 64,599 / 42,704 | 13.2 / 12.0 | 19.2 | 6.3 | 49.0 |
| mcp2cli | 67/90 | 74% (65%–82%) | 114,195 / 65,552 | 2,653 / 1,784 | 116,849 / 67,708 | 14.7 / 13.5 | 16.7 | 5.4 | 49.5 |
| mcpc | 68/90 | 76% (66%–83%) | 132,406 / 84,763 | 3,899 / 2,215 | 136,305 / 86,920 | 12.1 / 11.0 | 17.4 | 6.5 | 53.2 |

token 取自 API 返回的 `usage`，按轮累加；输入含缓存读写。错误调用 = 非零退出码、`isError`，或回放 server 没有对应返回值的调用。

## 门槛 1

**不成立**：via 的任务成功率不低于原生 MCP，且不低于 mcp2cli（[路线图](../../docs/roadmap.md#门槛)）。

| 对比 | via | 对照 | 结果 |
| --- | ---: | ---: | ---: |
| via vs native | 73% (66/90) | 76% (68/90) | 低于（区间重叠） |
| via vs mcp2cli | 73% (66/90) | 74% (67/90) | 低于（区间重叠） |

- some intervals overlap: at this sample size a difference in either direction is within noise; raise --trials for a firmer answer

### 与 mcpc 的对比（不属于门槛）

| 对比 | via | 对照 | 结果 |
| --- | ---: | ---: | ---: |
| via vs mcpc | 73% (66/90) | 76% (68/90) | 低于（区间重叠） |

## 各任务成功次数

| 任务 | native | via | mcp2cli | mcpc |
| --- | ---: | ---: | ---: | ---: |
| github-triage-bugs | 10/10 | 10/10 | 9/10 | 10/10 |
| github-find-code | 10/10 | 10/10 | 10/10 | 10/10 |
| github-pr-summary | 9/10 | 10/10 | 10/10 | 10/10 |
| linear-create-issue | 10/10 | 10/10 | 10/10 | 7/10 |
| linear-my-work | 3/10 | 4/10 | 7/10 | 7/10 |
| notion-update-doc | 0/10 | 0/10 | 0/10 | 0/10 |
| playwright-docs-search | 10/10 | 10/10 | 10/10 | 10/10 |
| cloudflare-dns-records | 6/10 | 2/10 | 2/10 | 4/10 |
| cross-issue-to-pr | 10/10 | 10/10 | 9/10 | 10/10 |

## 未成功的运行

| 条件 | 任务 | 第几次 | 结束状态 | 没通过的检查 |
| --- | ---: | ---: | ---: | ---: |
| mcpc | linear-create-issue | 1 | completed | called linear/create_issue {"title":{"$regex":"rate.?limiter"},"team":{"$oneOf":["Platform","PLT","a1b2c3d4-0000-4000-8000-000000000000"]},"description":{"$contains":"redis"},"priority":{"$oneOf":[2,1,"High"]},"assignee":{"$oneOf":["me","jdoe"]}} |
| native | notion-update-doc | 1 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| via | notion-update-doc | 1 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3) |
| mcp2cli | notion-update-doc | 1 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 5) |
| mcpc | notion-update-doc | 1 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| via | cloudflare-dns-records | 1 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}}；never called cloudflare/execute {"accountId":"5d3a8c1f0b9e4a7d8c6b5a4f3e2d1c0b"} (saw 1) |
| mcp2cli | cloudflare-dns-records | 1 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcpc | cloudflare-dns-records | 1 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcp2cli | linear-my-work | 2 | completed | called linear/list_my_issues {"state":{"$regex":"progress"}} |
| native | notion-update-doc | 2 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3) |
| via | notion-update-doc | 2 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3) |
| mcp2cli | notion-update-doc | 2 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| mcpc | notion-update-doc | 2 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| native | cloudflare-dns-records | 2 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| via | cloudflare-dns-records | 2 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcp2cli | cloudflare-dns-records | 2 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcpc | cloudflare-dns-records | 2 | completed | never called cloudflare/execute {"accountId":"5d3a8c1f0b9e4a7d8c6b5a4f3e2d1c0b"} (saw 1) |
| mcpc | linear-create-issue | 3 | max_turns |  |
| native | linear-my-work | 3 | completed | called linear/get_issue {"id":{"$oneOf":["PLT-300","PLT-328"]}}；at most 1× linear/update_issue {"id":{"$oneOf":["PLT-300","PLT-328"]},"state":{"$regex":"done"}} (saw 2)；never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 2) |
| via | linear-my-work | 3 | completed | never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| native | notion-update-doc | 3 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3) |
| via | notion-update-doc | 3 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 2)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcp2cli | notion-update-doc | 3 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcpc | notion-update-doc | 3 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcp2cli | cloudflare-dns-records | 3 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcpc | linear-create-issue | 4 | completed | called linear/create_issue {"title":{"$regex":"rate.?limiter"},"team":{"$oneOf":["Platform","PLT","a1b2c3d4-0000-4000-8000-000000000000"]},"description":{"$contains":"redis"},"priority":{"$oneOf":[2,1,"High"]},"assignee":{"$oneOf":["me","jdoe"]}} |
| native | linear-my-work | 4 | completed | called linear/get_issue {"id":{"$oneOf":["PLT-300","PLT-328"]}}；never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| via | linear-my-work | 4 | completed | called linear/list_my_issues {"state":{"$regex":"progress"}}；never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| mcp2cli | linear-my-work | 4 | completed | called linear/update_issue {"id":{"$oneOf":["PLT-300","PLT-328"]},"state":{"$regex":"done"}} |
| mcpc | linear-my-work | 4 | completed | never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| native | notion-update-doc | 4 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| via | notion-update-doc | 4 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 5)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcp2cli | notion-update-doc | 4 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| mcpc | notion-update-doc | 4 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 5) |
| mcpc | cloudflare-dns-records | 4 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| native | linear-my-work | 5 | completed | called linear/get_issue {"id":{"$oneOf":["PLT-300","PLT-328"]}}；called linear/update_issue {"id":{"$oneOf":["PLT-300","PLT-328"]},"state":{"$regex":"done"}}；never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 2) |
| via | linear-my-work | 5 | completed | never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| mcpc | linear-my-work | 5 | completed | called linear/list_my_issues {"state":{"$regex":"progress"}} |
| native | notion-update-doc | 5 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| via | notion-update-doc | 5 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 2)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcp2cli | notion-update-doc | 5 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 5) |
| mcpc | notion-update-doc | 5 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 6)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| native | cloudflare-dns-records | 5 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| via | cloudflare-dns-records | 5 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcp2cli | cloudflare-dns-records | 5 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcpc | cloudflare-dns-records | 5 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| via | linear-my-work | 6 | completed | called linear/list_my_issues {"state":{"$regex":"progress"}}；never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| native | notion-update-doc | 6 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| via | notion-update-doc | 6 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcp2cli | notion-update-doc | 6 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| mcpc | notion-update-doc | 6 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| native | cloudflare-dns-records | 6 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| via | cloudflare-dns-records | 6 | completed | never called cloudflare/execute {"accountId":"5d3a8c1f0b9e4a7d8c6b5a4f3e2d1c0b"} (saw 1) |
| mcp2cli | cloudflare-dns-records | 6 | max_turns | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}}；never called cloudflare/execute {"accountId":"5d3a8c1f0b9e4a7d8c6b5a4f3e2d1c0b"} (saw 1)；answer mentions 203.0.113.10；answer mentions docs.acme.test；answer mentions status.acme.test |
| native | linear-my-work | 7 | completed | never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| via | linear-my-work | 7 | completed | never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| native | notion-update-doc | 7 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 5) |
| via | notion-update-doc | 7 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 6)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcp2cli | notion-update-doc | 7 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| mcpc | notion-update-doc | 7 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 7) |
| via | cloudflare-dns-records | 7 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcp2cli | cloudflare-dns-records | 7 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| native | github-pr-summary | 8 | completed | answer mentions changes requested \| changes_requested |
| native | linear-my-work | 8 | completed | never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 2) |
| native | notion-update-doc | 8 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3) |
| via | notion-update-doc | 8 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 7) |
| mcp2cli | notion-update-doc | 8 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3) |
| mcpc | notion-update-doc | 8 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3) |
| via | cloudflare-dns-records | 8 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcp2cli | cloudflare-dns-records | 8 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcpc | cloudflare-dns-records | 8 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| native | linear-my-work | 9 | completed | never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| mcp2cli | linear-my-work | 9 | completed | called linear/list_my_issues {"state":{"$regex":"progress"}} |
| mcpc | linear-my-work | 9 | completed | called linear/list_my_issues {"state":{"$regex":"progress"}} |
| native | notion-update-doc | 9 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| via | notion-update-doc | 9 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 6)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcp2cli | notion-update-doc | 9 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| mcpc | notion-update-doc | 9 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 6) |
| via | cloudflare-dns-records | 9 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}}；never called cloudflare/execute {"accountId":"5d3a8c1f0b9e4a7d8c6b5a4f3e2d1c0b"} (saw 1) |
| mcp2cli | cloudflare-dns-records | 9 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcpc | cloudflare-dns-records | 9 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| mcp2cli | cross-issue-to-pr | 9 | max_turns |  |
| mcp2cli | github-triage-bugs | 10 | max_turns | called github/add_issue_comment {"owner":"acme","repo":"api","issue_number":214,"body":{"$containsAll":["log","redis"]}} |
| native | linear-my-work | 10 | completed | never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| via | linear-my-work | 10 | completed | called linear/list_my_issues {"state":{"$regex":"progress"}}；never called linear/update_issue {"id":{"$not":{"$oneOf":["PLT-300","PLT-328"]}}} (saw 1) |
| native | notion-update-doc | 10 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 3) |
| via | notion-update-doc | 10 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4)；never called notion/notion-update-page {"page_id":{"$not":{"$regex":"2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701"}}} (saw 1) |
| mcp2cli | notion-update-doc | 10 | completed | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 4) |
| mcpc | notion-update-doc | 10 | max_turns | at most 1× notion/notion-update-page {"page_id":{"$regex":"^2f1c9e4a-?7b6d-?4e3f-?a1b2-?c3d4e5f6a701$"},"command":{"$oneOf":["insert_content_after","replace_content_range","replace_content"]},"new_str":{"$containsAll":["tenant","public API docs"]}} (saw 7) |
| native | cloudflare-dns-records | 10 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |
| via | cloudflare-dns-records | 10 | completed | called cloudflare/execute {"accountId":"023e105f4ecef8ad9ca31a8372d0c353","code":{"$regex":"dns"}} |

## 这些数字说明什么

- 成功率是「完成任务」的比例，任务由回放 server 的调用日志判定：必需的调用（工具加参数子集）已被回放 server 回答、禁止的调用从未发出、写操作不超过规定次数，只读任务另查最终回答是否提到关键事实。判定标准见任务文件的 `success` 块。
- 返回值是合成数据，且同一工具的返回值不随参数变化（除非任务按参数区分）。它能检验「模型会不会找到并正确调用工具」，不能检验真实 server 的行为差异。
- 各条件共用同一份任务描述、同一段系统提示骨架（见 [bench/README.md](../README.md#系统提示)），差别只在各自的工具和说明文本。
- 样本量小时差异可能只是噪声；总览里给出 95% Wilson 区间，区间重叠就不要把差异当结论，增加 `--trials`。
- 模型的采样有随机性，同一组任务多跑几次的结果不会完全一样；不同模型的结论不能互相替代。
