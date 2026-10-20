# via

把 MCP server 的工具变成 agent 可以按需发现、按需调用的命令行。

**MCP 做提供方协议，CLI 做消费方接口。** agent 框架不再挂载 MCP，也不再把成百上千个工具的 schema 塞进上下文；需要工具时，agent 在 shell 里用 `via` 逐级发现、查看用法、调用，鉴权和输出格式由 via 统一处理。

> **状态：设计阶段。** 仓库目前只有设计文档，还没有可运行的代码。文档即规范，实现以 [`docs/spec/`](docs/spec/) 为准。

## 为什么需要 via

- **上下文被 schema 占满**：框架接入 MCP 时会预先注入所有工具定义，server 一多，任务还没开始就占掉几万 token。
- **鉴权各配一遍**：每个框架各自保存 server 地址和凭证，轮换一次要改所有地方。
- **输出冗长**：工具返回的原始 JSON 键名逐行重复，截断和翻页各家各做。

via 的做法：作为一个独立的 MCP client，只读引用各框架已有的 MCP 配置，按 server 自动注入凭证，以 `provider → 资源 → 动作` 的命令形态暴露工具，并用一套统一模板渲染输出。

## 先看一眼

```console
$ via
9 providers · 214 tools · 1 needs auth (linear)
code     github · sentry
search   exa · context7
project  linear
browser  playwright
→ via <provider> to browse · via find <query> to search

$ via linear
issue     create · get · list · update · archive
comment   create · list
project   create · get · list · update
→ via linear <resource> for signatures

$ via linear issue:create --team ENG --title "Support OAuth DCR"
id: ENG-123
url: https://linear.app/acme/issue/ENG-123
state: Backlog
```

中间结果可以直接在 shell 里流转，不经过模型上下文：

```bash
title=$(via github issue:read --owner acme --repo api --issue-number 42 --method get -o json | jq -r .title)
via linear issue:create --team ENG --title "$title" --description "From acme/api#42"
```

## 核心设计

| | |
| --- | --- |
| 零注入 | agent 上下文里只有一段 100–300 token 的使用说明（`via prompt` 生成） |
| 不碰原配置 | 只读引用 Claude Code、Cursor、Codex、VS Code 等框架的 MCP 配置，从不写入 |
| 统一鉴权 | 凭证按 server 绑定，支持 env、文件、系统钥匙串、命令和 OAuth，调用时自动注入 |
| 启发式发现 | 命令即目录：`via` → `via <provider>` → `via <provider> <resource>` → `-h`，配合 `via find` |
| 统一紧凑输出 | 表格化、去噪、截断游标、stdout 与 stderr 分离、语义化退出码 |
| 薄 | 不生成代码，运行时按 `tools/list` 动态分发；常驻 daemon 按需拉起、空闲退出 |

## 文档

| 想了解 | 去看 |
| --- | --- |
| 为什么做、做什么、不做什么 | [愿景与定位](docs/overview/vision.md) |
| 整体怎么组成 | [架构](docs/overview/architecture.md) |
| 命令怎么写 | [命令规范](docs/spec/cli.md) |
| GitHub、Linear、Notion、Cloudflare 怎么用 | [Provider 指南](docs/guides/providers/) |
| 怎么接入现有 agent 框架 | [与 agent 框架集成](docs/guides/agent-integration.md) |
| 怎么参与实现 | [实现说明](docs/development/implementation.md)、[CONTRIBUTING](CONTRIBUTING.md) |
| 为什么这样决定 | [架构决策记录](docs/adr/) |

完整索引见 [docs/README.md](docs/README.md)。

## 与网关的关系

via 不是网关。它与 agent 以同一用户运行，解决的是「方便」和「省上下文」，不提供凭证隔离。团队、多 agent 或生产环境需要权限隔离和审计时，可以在 via 背后再接一个网关（例如 [Asterlane](https://github.com/komiyoo/asterlane)），via 把它当作普通的 MCP server 使用。详见 [网关类 server](docs/guides/providers/gateways.md)。

## 路线图

0.1 先做进程内直连和核心命令，用 token 基准和 agent 评测证明「不注入 schema、按需发现」既省 token 又不降低成功率；之后加 daemon 与 OAuth，再做扩展。详见 [路线图](docs/roadmap.md)。

## 许可

[Apache License 2.0](LICENSE)
