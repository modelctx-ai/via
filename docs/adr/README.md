# 架构决策记录（ADR）

记录「为什么这样做」。规范文档只写「是什么」，并链接到这里。

## 索引

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-mcp-for-providers-cli-for-consumers.md) | MCP 做提供方协议，CLI 做消费方接口 | 已接受 |
| [0002](0002-standalone-client-not-gateway.md) | via 是独立的 MCP client，不是网关 | 已接受 |
| [0003](0003-read-only-framework-configs.md) | 只读引用框架配置，不接管、不写入 | 已接受 |
| [0004](0004-typescript.md) | 使用 TypeScript 实现 | 已接受（单文件可执行一项见 0023） |
| [0005](0005-command-grammar-provider-resource-verb.md) | 命令形态为 `via <provider> <resource>:<verb>` | 已接受 |
| [0006](0006-domain-is-a-view.md) | 域只是浏览视图，不进入命令路径和规范名 | 被 ADR-0014 取代 |
| [0007](0007-no-gateway-specific-adaptation.md) | 不对任何网关做专门适配 | 已接受 |
| [0008](0008-dynamic-dispatch-no-codegen.md) | 运行时动态分发，不生成代码 | 已接受 |
| [0009](0009-project-name-via.md) | 项目名与命令名为 via | 已接受（npm 包名见 0015） |
| [0010](0010-mcp-resources-prompts-and-roots.md) | 提供 MCP resources、prompts 与 roots，且不进入工具语法 | 已接受 |
| [0011](0011-find-synonym-expansion-and-optional-embeddings.md) | `via find` 默认用确定性同义词扩展，embedding 检索是用户显式开启的可选项 | 已接受 |
| [0012](0012-windows-pipe-name-and-batch-files.md) | Windows：管道名由令牌派生，批处理文件拒绝而不转义 | 已接受 |
| [0013](0013-agent-instructions-are-a-marked-block.md) | agent 说明以标记块注入，而不是覆盖整份文件 | 已接受 |
| [0014](0014-drop-the-domain-view.md) | 去掉「域」：provider 按名字列出，不做分类 | 已接受 |
| [0015](0015-npm-scope-modelctx-ai.md) | npm 包名为 `@modelctx-ai/via` | 已接受 |
| [0016](0016-via-serve-meta-tools-over-stdio.md) | `via serve`：以 stdio MCP server 暴露七个元工具，每次调用就是一次 CLI 命令 | 已接受（工具集合由 0024 扩展） |
| [0017](0017-protocol-versions-newest-first-with-fallback.md) | MCP 协议版本：新版本优先，自动回退，可以固定 | 已接受 |
| [0018](0018-elicitation-in-a-terminal-declined-elsewhere.md) | elicitation：终端里交互回答，其他情形一律拒绝并说明 | 已接受 |
| [0019](0019-oauth-client-identity-and-credentials.md) | OAuth 客户端身份与凭据：CIMD、固定回调端口、client credentials、绑定授权服务器 | 已接受 |
| [0020](0020-tasks-and-skills-commands.md) | tasks 与 Skills：两个内置子命令 `via tasks`、`via skills`，像 resources 与 prompts 一样按 provider 取用 | 已接受 |
| [0021](0021-server-self-description-and-completion.md) | server 自述只在 `via <provider> -h` 里显示；补全用 `--complete` 显式查询 | 已接受 |
| [0022](0022-per-server-logs-rotated-and-redacted.md) | 日志：按 server 分文件，按大小轮转，写盘前脱敏，不挡调用 | 已接受 |
| [0023](0023-npm-is-the-only-distribution-channel.md) | npm 是唯一的分发渠道：不做 Homebrew、单文件可执行与签名公证 | 已接受 |
| [0024](0024-via-serve-tasks-skills-and-completion.md) | `via serve` 暴露任务、技能与补全：两个新元工具，其余是已有工具的可选参数；不默认 detach | 已接受 |
| [0025](0025-pin-the-authorization-server-in-config.md) | 在配置里钉住授权服务器：`auth.oauth.issuer` | 已接受 |
| [0026](0026-sandbox-stdio-server-processes.md) | 用进程级沙箱包裹 daemon 派生的 stdio server 子进程（`sandbox`，默认关闭，srt 可选依赖） | 被 ADR-0027 取代 |
| [0027](0027-run-via-inside-a-sandbox-program.md) | 可选地把整个 via 放进沙箱程序里运行（`sandbox`，默认关闭，裸 `via` 等价于 `srt via`，不依赖 srt 的包） | 已接受 |
| [0028](0028-restrict-and-hide-subcommands.md) | 在配置里禁止、只允许、隐藏或只显示某些子命令（`commands`） | 已接受 |
| [0030](0030-infer-destructive-from-names.md) | 没有声明破坏性注解的工具按名字推断，并允许用户点名要求确认 | 已接受 |

## 流程

- 推翻或替换已有决策时，先开 issue 讨论，再新增一篇 ADR，旧 ADR 的状态改为「被 ADR-xxxx 取代」，正文不改写。
- 编号递增，不复用。
- 状态取值：提议中、已接受、已废弃、被 ADR-xxxx 取代。

## 模板

```markdown
# NNNN. 标题

- 状态：提议中
- 日期：YYYY-MM-DD

## 背景

要解决什么问题，有哪些约束。

## 决策

我们决定……

## 备选方案

考虑过什么，为什么没选。

## 后果

带来的好处、代价和后续需要做的事。
```
