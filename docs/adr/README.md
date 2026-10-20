# 架构决策记录（ADR）

记录「为什么这样做」。规范文档只写「是什么」，并链接到这里。

## 索引

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-mcp-for-providers-cli-for-consumers.md) | MCP 做提供方协议，CLI 做消费方接口 | 已接受 |
| [0002](0002-standalone-client-not-gateway.md) | via 是独立的 MCP client，不是网关 | 已接受 |
| [0003](0003-read-only-framework-configs.md) | 只读引用框架配置，不接管、不写入 | 已接受 |
| [0004](0004-typescript.md) | 使用 TypeScript 实现 | 已接受 |
| [0005](0005-command-grammar-provider-resource-verb.md) | 命令形态为 `via <provider> <resource>:<verb>` | 已接受 |
| [0006](0006-domain-is-a-view.md) | 域只是浏览视图，不进入命令路径和规范名 | 已接受 |
| [0007](0007-no-gateway-specific-adaptation.md) | 不对任何网关做专门适配 | 已接受 |
| [0008](0008-dynamic-dispatch-no-codegen.md) | 运行时动态分发，不生成代码 | 已接受 |
| [0009](0009-project-name-via.md) | 项目名与命令名为 via | 已接受 |
| [0010](0010-mcp-resources-prompts-and-roots.md) | 提供 MCP resources、prompts 与 roots，且不进入工具语法 | 已接受 |
| [0011](0011-windows-pipe-name-and-batch-files.md) | Windows：管道名由令牌派生，批处理文件拒绝而不转义 | 已接受 |

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
