# via 文档

## 索引

### 概览

- [愿景与定位](overview/vision.md)：要解决的问题、目标、非目标、设计原则
- [架构](overview/architecture.md)：CLI、daemon、MCP server 三层与调用链路
- [术语表](overview/glossary.md)：provider、资源、动作、叶子工具、游标等

### 规范（实现必须遵循）

| 文档 | 内容 |
| --- | --- |
| [cli.md](spec/cli.md) | 命令语法、内置子命令、全局选项、工具引用写法、名称解析 |
| [naming.md](spec/naming.md) | 原始工具名拆成 `资源:动作` 的规则与稳定性约定 |
| [discovery.md](spec/discovery.md) | 目录构建、缓存、浏览视图、搜索排序 |
| [arguments.md](spec/arguments.md) | schema 到命令行参数的映射、校验、危险操作、调用过程 |
| [output.md](spec/output.md) | 渲染流程、输出格式、截断游标、错误与退出码 |
| [config.md](spec/config.md) | 配置来源与合并、字段参考、凭证引用 |
| [auth.md](spec/auth.md) | 鉴权方式、OAuth、调用时的鉴权行为 |
| [daemon.md](spec/daemon.md) | daemon 生命周期、CLI 与 daemon 的协议、并发、无 daemon 模式 |
| [security.md](spec/security.md) | 安全边界、威胁与缓解 |

### 指南

- [快速上手](guides/getting-started.md)
- [与 agent 框架集成](guides/agent-integration.md)：`via doctor`、`via prompt`、迁移路径、并存期注意事项
- [组合用法](guides/recipes.md)：管道、batch、heredoc、跨 provider
- Provider 示例：[GitHub](guides/providers/github.md) · [Linear](guides/providers/linear.md) · [Notion](guides/providers/notion.md) · [Cloudflare](guides/providers/cloudflare.md) · [网关类 server](guides/providers/gateways.md)

### 开发

- [实现说明](development/implementation.md)：技术栈、依赖、代码结构、启动速度
- [测试与评测](development/testing.md)：测试分层、token 基准、agent 评测、性能目标
- [数据文件](development/data-files.md)：`data/` 下各文件的格式

### 规划与决策

- [路线图](roadmap.md)
- [待定问题](open-questions.md)
- [架构决策记录（ADR）](adr/README.md)

## 文档约定

- **规范优先**：`spec/` 是唯一的行为依据；指南和 README 里的示例与规范冲突时，以规范为准，并修正示例。
- **措辞**：规范中「必须 / 不得」是硬性要求，「应当 / 不应」是默认要求（偏离需说明理由），「可以」是可选行为。
- **示例**：命令输出示例表达的是意图，具体列宽与措辞以快照测试为准。
- **上游事实**：引用真实 MCP server 的工具名、URL、鉴权方式时注明来源；这些会随上游版本变化，via 运行时一律以 `tools/list` 为准。
- **决策**：「为什么这样做」写进 ADR，规范里只写「是什么」，并链接到对应 ADR。
- **术语**：首次出现的术语链接到[术语表](overview/glossary.md)。
