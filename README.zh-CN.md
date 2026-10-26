<div align="center">

<img src="docs/assets/logo.svg" width="96" height="96" alt="via logo">

# via

**每个 MCP server，都只隔一条命令。**

via 把任意 MCP server 的工具变成 agent 按需发现、按需调用的命令行，<br>
工具 schema 不再占用上下文窗口。

[![CI](https://github.com/modelctx-ai/via/actions/workflows/ci.yml/badge.svg)](https://github.com/modelctx-ai/via/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/modelctx-ai/via?color=blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](package.json)
[![npm](https://img.shields.io/npm/v/@modelctx-ai/via?color=f76b15&logo=npm)](https://www.npmjs.com/package/@modelctx-ai/via)
[![npm downloads](https://img.shields.io/npm/dm/@modelctx-ai/via?color=f76b15)](https://www.npmjs.com/package/@modelctx-ai/via)
[![GitHub stars](https://img.shields.io/github/stars/modelctx-ai/via?style=flat&logo=github&color=yellow)](https://github.com/modelctx-ai/via/stargazers)

[概览](#概览) · [安装](#安装) · [快速上手](#快速上手) · [文档](docs/README.md) · [基准](bench/results/0.4-tokens.md) · [路线图](docs/roadmap.md)

[English](README.md) | 简体中文

</div>

---

**MCP 做提供方协议，CLI 做消费方接口。** agent 框架不再挂载 MCP，也不再把成百上千个工具的 schema 塞进上下文；需要工具时，agent 在 shell 里用 `via` 逐级发现、查看用法、调用，鉴权和输出格式由 via 统一处理。

> [!NOTE]
> 0.3.1 已发布（`npm install -g @modelctx-ai/via`）。这个版本包含路线图 0.1–0.3：直连与 daemon、OAuth、`find`、`batch`、`trust`、resources/prompts、Windows。1.0 之前命令与输出可能调整，行为以 [`docs/spec/`](docs/spec/) 为准。

## 为什么需要 via

- 框架接入 MCP 时会预先注入所有工具定义，server 一多，任务还没开始就占掉几万 token。
- 每个框架各自保存 server 地址和凭证，轮换一次要改所有地方。
- 工具返回的原始 JSON 键名逐行重复，截断和翻页各家各做。

via 是一个独立的 MCP client：只读引用各框架已有的 MCP 配置，按 server 注入凭证，以 `provider → 资源 → 动作` 的命令形态暴露工具，并用一套统一规则渲染输出。agent 上下文里只剩一段约 200 token 的使用说明。

![via 的工作原理：agent 在 shell 里执行 via 并拿回紧凑输出；via CLI 把调用交给本机 daemon，daemon 读取框架 MCP 配置和凭证，经 stdio 或 HTTP 用 MCP 与各 server 通信](docs/assets/how-it-works.zh-CN.svg)

在 [token 基准](bench/results/0.4-tokens.md)的 9 个任务上（github、linear、notion、playwright、cloudflare 共 167 个工具），**via 消耗的 token 约为原生 MCP 注入方式的 4%**；同样经 shell 使用 MCP 的 mcp2cli 与 mcpc 在同一基准里分别约为 16% 和 15%。这些数字按脚本化的命令序列估算；节省几乎全部来自不注入工具定义，框架本身已做 schema 延迟加载时差距会小得多。真实模型的成功率评测（`npm run bench:eval`）尚未发布结果。

## 特性

- **上下文里没有 schema**：agent 只拿到 `via prompt` 生成的一段使用说明，需要时再逐级查找：`via` → `via <provider>` → `via <provider> <资源>` → `-h`。
- **复用已有配置**：读取 Claude Code、Claude Desktop、Cursor、Codex、VS Code、Gemini CLI、GitHub Copilot CLI、Devin Desktop / Windsurf、Antigravity、Amp 里的 MCP server；只读，从不写入。
- **凭证集中一处**：配置里只写引用（`keychain:`、`env:`、`file:`、`cmd:`）或由 via 自己完成 OAuth 授权；解析后的值在所有输出里显示为 `***`。
- **跨 server 搜索**：`via find "create issue"` 在所有 provider 里排序工具，带同义词扩展；默认是确定性的，除非你开启 `search.semantic`，否则不调用模型。
- **紧凑、可预期的输出**：所有 server 共用一套渲染规则，报错后附 `next:` 提示，截断输出可用游标续读，脚本里用 `-o json`。
- **为 shell 而生**：结果在工具之间用管道传递，不经过模型；`via batch` 一次并发发出多个调用。
- **安全护栏**：`deny` 规则隐藏工具，破坏性工具需要 `--yes`，项目级的命令与端点首次使用前需要 `via trust`。
- **快，且到处能跑**：缓存热时浏览约 80 ms；本机 daemon 在调用之间保持 MCP 会话；支持 macOS、Linux、Windows。

## 概览

```console
$ via
7 providers · 177 tools
code     github
search   context7 · exa
browser  playwright
docs     notion
project  linear
cloud    cloudflare
→ via <provider> to browse · via find <query> to search

$ via linear issue
issue:get     id                                                               Retrieve detailed information about an issue by ID. [read-only]
issue:list    [team], [state], [assignee], [label], [query], [limit], …        List issues in the user's Linear workspace. [read-only]
issue:create  title, team, [description], [priority], [assignee], [labels], …  Create a new Linear issue.
issue:update  id, [title], [description], [priority], [assignee], [labels], …  Update an existing Linear issue.
→ via linear issue:<verb> -h for usage

$ via linear issue:create --title "Rate limiter fails closed when Redis is down" --team Platform --priority 2
identifier: PLT-331
title: Rate limiter fails closed when Redis is down
priority:
  value: 2
  name: High
url: https://linear.app/acme/issue/PLT-331/rate-limiter-fails-closed-when-redis-is-down
status: Todo
…
· linear issue:create · 286ms · 568 bytes
```

中间结果可以直接在 shell 里流转，不经过模型上下文：

```bash
title=$(via github issue:read --method get --owner acme --repo api --issue-number 42 -o json | jq -r .title)
via linear issue:create --team ENG --title "$title" --description "From acme/api#42"
```

## 安装

需要 Node.js 20 或更新版本（推荐 22）。

```bash
npm install -g @modelctx-ai/via
via --version
```

via 只通过 npm 分发，没有 Homebrew formula，也没有预编译的可执行文件。各平台的说明（含 Windows）见[快速上手](docs/guides/getting-started.md#1-安装)。

开发 via 本身：`git clone https://github.com/modelctx-ai/via.git && cd via && npm ci && npm run build && npm link`。

## 快速上手

### 1. 检查现有配置

via 自动读取 Claude Code、Claude Desktop、Cursor、Codex、VS Code、Gemini CLI、GitHub Copilot CLI、Devin Desktop / Windsurf、Antigravity、Amp 里已经配好的 MCP server，不需要重新配置，也从不写入这些文件：

```bash
via doctor        # server 状态、仍在注入 schema 的框架与 token 估算、明文凭证告警
```

### 2. 补齐鉴权

OAuth 型 server 由 via 自己授权一次（不读取其他客户端存下的 token）；API key 写成凭证引用，放进 `~/.config/via/config.yaml`：

```bash
via auth login linear      # 配置里写 auth: oauth；无浏览器环境加 --manual
```

```yaml
servers:
  github:
    url: https://api.githubcopilot.com/mcp/
    auth: { bearer: 'keychain:via/github' } # 也可以是 env:、file:、cmd:
  exa: # 定义来自框架配置，这里只补凭证
    env: { EXA_API_KEY: 'env:EXA_KEY' }
deny: ['^github/.*:delete$'] # 不想让 agent 碰的工具
```

### 3. 发现与调用

```bash
via                                   # 所有 provider 及其工具数
via linear                            # 资源与动作
via linear issue                      # 每个动作的签名
via linear issue:create -h            # 参数用法
via find "create issue"               # 跨 provider 搜索
```

### 4. 交给 agent

把说明写进你已经在用的 AGENTS.md——via 只加一个带标记的块，文件其余部分不动——再按 `via doctor` 的提示在框架里关闭 MCP 注入（过渡期两边可以并存）：

```bash
via prompt --out AGENTS.md       # 写进块；文件里已有块时只刷新它
via prompt --check AGENTS.md     # 块过期时退出码 1，可放进 CI
via prompt --skill --out <目录>/via/SKILL.md   # 改写成 SKILL.md，给按技能目录加载说明的 agent
```

块里先说明 via 是什么，再要求 agent 需要外部工具时优先用 `via`，而不是它已经挂载的 MCP 工具。这份说明只维护一处：Claude Code 可以在 CLAUDE.md 里用 `@AGENTS.md` 引入，不必再攒一份。

没有 shell 的 agent（Claude Desktop、IDE 聊天面板）改为只挂一个 `via serve`，拿到九个元工具（`via_browse`、`via_find`、`via_call` 等，约 1,480 token），行为与命令行完全一致：

```json
{ "mcpServers": { "via": { "command": "via", "args": ["serve"] } } }
```

详细步骤见[快速上手](docs/guides/getting-started.md)与[与 agent 框架集成](docs/guides/agent-integration.md)。

## 常用命令

| 命令                                               | 作用                                                            |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `via` · `via <provider>` · `via <provider> <资源>` | 逐级浏览；`-h` 查看单个工具的用法                               |
| `via <provider> <资源>:<动作> [--参数 值]`         | 调用工具；`-o json` 输出 JSON，`--dry-run` 只打印将要发出的调用 |
| `via find <查询>`                                  | 跨 provider 搜索工具                                            |
| `via more <游标>`                                  | 续读被截断的输出                                                |
| `via batch`                                        | 从 stdin 读 JSON Lines，并发调用，按输入顺序输出                |
| `via resources` · `via read` · `via prompts`       | MCP resources 与 prompts                                        |
| `via auth login\|status\|logout`                   | OAuth 登录与状态                                                |
| `via trust`                                        | 放行项目级 `.via.yaml` 里的命令与端点                           |
| `via serve`                                        | 以 stdio MCP server 运行，向没有 shell 的 agent 提供九个元工具  |
| `via doctor` · `via servers` · `via sync`          | 诊断、server 列表、刷新工具缓存                                 |

语法、全局选项与退出码见[命令规范](docs/spec/cli.md)和[输出规范](docs/spec/output.md)；更多组合写法见[组合用法](docs/guides/recipes.md)。

## 安全须知

- via 不是网关：它与 agent 以同一用户运行，只能降低凭证意外暴露的概率，挡不住有意的读取。需要权限隔离和审计时，在 via 背后接一个网关（例如 [Asterlane](https://github.com/komiyoo/asterlane)），via 把它当作普通 MCP server。
- 配置里只存凭证引用；解析后的凭证值在所有输出中替换为 `***`。
- 标记为破坏性的工具（server 声明的，或 server 什么都没声明时按 `delete` 之类的名字推断的）需要 `--yes`；被 `deny` 规则匹配的工具不出现在列表里，也无法调用。
- 项目级配置（`.via.yaml`、仓库里的 `.mcp.json` 等）中的命令和端点首次使用前需要你在终端里执行 `via trust` 确认；不要让 agent 替你运行。

威胁模型见[安全模型](docs/spec/security.md)。

## 与其他方式对比

|  | 框架原生接入 MCP | 单 server 的 MCP 转 CLI 工具 | **via** |
| --- | --- | --- | --- |
| 上下文里的工具 schema | 全部，预先注入 | 无 | 无，只有约 200 token 的说明 |
| server | 每个框架各一份列表 | 每次调用指定一个端点 | 所有 server 汇成一个目录 |
| 跨 server 搜索 | — | — | `via find` |
| 凭证 | 每个框架各抄一份 | 每次调用传入 | 每个 server 一个引用 |
| 输出 | 原始 JSON，各家处理不同 | 因工具而异 | 一套渲染规则，带续读游标 |

与 mcpc、mcp2cli、mcporter、网关的具体区别见[愿景与定位](docs/overview/vision.md#与相近工具的区别)。

## 文档

| 想了解                                              | 去看                                                          |
| --------------------------------------------------- | ------------------------------------------------------------- |
| 为什么做、做什么、不做什么，与 mcpc、mcp2cli 等工具的区别 | [愿景与定位](docs/overview/vision.md)                         |
| 整体怎么组成                                        | [架构](docs/overview/architecture.md)                         |
| 配置字段与凭证引用                                  | [配置](docs/spec/config.md)、[鉴权](docs/spec/auth.md)        |
| GitHub、Linear、Notion、Cloudflare 怎么用           | [Provider 指南](docs/guides/providers/)                       |
| 接下来做什么                                        | [路线图](docs/roadmap.md)、[待定问题](docs/open-questions.md) |
| 为什么这样决定                                      | [架构决策记录](docs/adr/)                                     |

完整索引见 [docs/README.md](docs/README.md)。

## 参与贡献

现在最有用的贡献是来自真实 MCP server 与 agent 框架的反馈：某个 server 的工具拆分得别扭、某个框架的配置没被读到、某段输出 agent 读起来费劲，都欢迎[提 issue](https://github.com/modelctx-ai/via/issues/new/choose)。

```bash
npm ci
npm run typecheck
npm test
npm run build      # 产物在 dist/，入口 dist/via.js
```

`docs/spec/` 是规范：改变用户可见行为时，在同一个 PR 里同步更新规范和 `CHANGELOG.md`。流程与约定见 [CONTRIBUTING](CONTRIBUTING.md)，实现说明与测试分层见 [docs/development/](docs/development/implementation.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要提公开 issue。

如果 via 帮你省下了 token，点个 ⭐ 能让更多人找到它。

## Star 趋势

<a href="https://star-history.com/#modelctx-ai/via&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=modelctx-ai/via&type=Date&theme=dark">
    <img alt="modelctx-ai/via 的 star 趋势图" src="https://api.star-history.com/svg?repos=modelctx-ai/via&type=Date">
  </picture>
</a>

## 许可

[Apache License 2.0](LICENSE)
