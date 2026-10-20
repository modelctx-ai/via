# Provider 指南

这些示例展示常用 MCP server 在 via 下怎么发现和调用。它们覆盖了三种典型形态：

| 形态 | 代表 | 特点 |
| --- | --- | --- |
| 合并式工具 | [GitHub](github.md) | 工具多，同一资源的多种读写合并为一个工具，用 `method` 枚举参数区分 |
| 细粒度资源型工具 | [Linear](linear.md)、[Notion](notion.md) | 一个工具一个动作，拆分后就是 `issue:create`、`page:create` |
| 代码模式 | [Cloudflare](cloudflare.md) | 只有少数几个工具，靠提交代码完成一切，全部是叶子工具 |

另见 [网关类 server](gateways.md)：网关对 via 来说就是普通 server。

## 接入与鉴权一览

| provider | 传输 | 鉴权方式 | via 配置 |
| --- | --- | --- | --- |
| github | 远程 HTTP `https://api.githubcopilot.com/mcp/` | PAT。远程 OAuth 需要客户端事先注册 GitHub App，第三方客户端用 PAT 最直接 | `auth: { bearer: "keychain:via/github" }` |
| linear | 远程 HTTP `https://mcp.linear.app/mcp` | OAuth 2.1 动态客户端注册；也接受 API key 作为 bearer | `auth: oauth`，再 `via auth login linear` |
| notion | 远程 HTTP `https://mcp.notion.com/mcp` | OAuth | `auth: oauth`，再 `via auth login notion` |
| cloudflare | 远程 HTTP | OAuth | `auth: oauth`，再 `via auth login cloudflare` |

## 关于工具名

工具名取自各 server 在 2026 年 10 月公开的工具列表（Notion 与 Cloudflare 取自实际连接的 `tools/list`），上游会改名或合并工具。via 运行时一律以 `tools/list` 为准，示例中的参数以 `-h` 输出为准。

新增 provider 示例时请注明来源与时间，并在 [naming.md](../../spec/naming.md) 的示例表中补充有代表性的拆分案例。
