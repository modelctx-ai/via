# 测试夹具

| 目录 | 内容 |
| --- | --- |
| `tools/` | 常见 server 的 `tools/list` 结果，文件名即 provider 别名 |
| `other/` | 边缘样本：网关元工具（`aster`）与用来覆盖资源拆分的 `acme-*` |
| `splits/` | 每个样本的拆分结果基线（`原始名 → 规范写法`），由快照测试维护；`npm run split-diff` 对照当前规则列出差异 |
| `results.ts` | 渲染测试用的 `tools/call` 返回值 |
| `mcp/` | 用官方 SDK server 端写的模拟 MCP server（`mock-server.mjs` 定义工具，`stdio-server.mjs` 经 stdio 运行；HTTP 版在 `test/helpers/client.ts`），供 `client/` 测试使用 |

## 来源与可信度

- `github`、`notion`、`cloudflare`：工具名取自实际连接的 server 在 2026 年 10 月的 `tools/list`。描述和参数是按工具用途改写、精简过的。
- `linear`、`playwright`、`exa`、`filesystem`、`slack`、`puppeteer`、`context7`、`tavily`、`sqlite`、`postgres`：工具名依据各 server 公开的工具列表整理，参数为常见写法，**不保证与当前版本逐字一致**。
- `gmail`、`google-drive`、`acme-*`、`aster`：为覆盖某种形态而虚构的样本，工具名只是合理的命名。

这些快照只用来固定拆分与索引的行为，不代表各 server 的真实接口。需要时请按实际 `tools/list` 替换，并用 `npm run split-diff` 查看差异。
