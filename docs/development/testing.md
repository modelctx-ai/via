# 测试与评测

## 测试分层

| 层 | 内容 | 方式 |
| --- | --- | --- |
| 拆分与分域 | 真实 server 的 `tools/list` 快照 → 规范写法、域 | 快照测试；规则变更时输出差异 |
| 渲染 | 每种输出形状（表格、对象、文本、截断、媒体、错误） | vitest 快照，规则的任何变化在评审中显式可见 |
| 参数解析 | schema → 命令行参数的各条规则，含 anyOf 补齐、`@文件`、重名 | 单元测试 |
| 配置 | 每个框架的真实配置样例、合并顺序、凭证引用、信任 | fixture 测试 |
| 端到端 | 模拟 MCP server + CLI 全链路，含 daemon 与进程内模式 | 集成测试 |

### 模拟 server

用官方 SDK 的 server 端写一组测试 server，覆盖：

- 大目录（500 个工具）；
- structuredContent、`isError`、超长输出、图片等媒体内容；
- OAuth（含动态客户端注册与刷新）；
- `list_changed` 通知；
- 慢响应与超时、progress 通知；
- 带 `destructiveHint` / `readOnlyHint` 的工具。

### 安全相关测试

- 所有快照中不得出现测试凭证值，CI 中对快照做凭证值扫描。
- 项目级配置未信任时 stdio 命令不得执行。

## token 基准

对一组真实 server（github、playwright、linear、notion 等）计算并持续跟踪：

- **原生注入成本**：框架挂载这些 server 时每轮注入的 schema token；
- **via 成本**：`via prompt` 说明 + 完成一组典型任务时发现与调用产生的 token。

这是项目的核心指标，结果随版本记录。

## agent 评测

同一组任务分别让 agent 用原生 MCP 和用 via 完成，比较：

- 总 token；
- 任务成功率；
- 工具调用轮数与错误调用次数。

这是验证「MCP 做提供方、CLI 做消费方」这一判断的关键证据，也是 0.1 → 0.2 的门槛（[路线图](../roadmap.md)）。0.1 没有 daemon，stdio server 每次调用都会重新拉起，评测应以 HTTP server 为主，避免启动延迟干扰结论。

## 性能目标

以下是初始目标，在 0.1 的基准测试中校准：

| 指标 | 目标 |
| --- | --- |
| CLI 冷启动（Node 22，单文件 + 编译缓存） | < 80 ms |
| 经热 daemon 调用的额外开销 | < 15 ms |
| 1,000 个工具上的 `find` | < 30 ms |
| daemon 常驻内存 | < 80 MB（不含 stdio 子进程） |
