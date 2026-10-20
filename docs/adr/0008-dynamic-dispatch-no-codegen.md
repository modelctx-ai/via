# 0008. 运行时动态分发，不生成代码

- 状态：已接受
- 日期：2026-10-20

## 背景

现有的 MCP 转 CLI 工具大多采用代码生成：mcporter 的 `generate-cli`、mcp2cli（mcp-to-cli）为每个 server 生成专属 CLI 与 skill 文件。server 的工具变化后需要重新生成。

## 决策

via 是一个动态分发器：运行时根据缓存的 `tools/list` 和 `inputSchema` 解析命令和参数，不生成任何代码或产物。

## 备选方案

- **为每个 server 生成 CLI**：生成后启动更快、可以离线分发，但存在同步问题，需要 `update`/`regenerate` 命令，产物也需要管理。

## 后果

- 没有生成产物，也就没有同步问题；server 工具变化通过缓存 TTL 和 `list_changed` 自动生效。
- 参数解析器必须是 schema 驱动的通用实现，覆盖 anyOf、嵌套对象、数组、文件输入等情况（[arguments.md](../spec/arguments.md)）。
- 需要目录缓存保证浏览和帮助的速度，冷启动不能每次都调用 `tools/list`。
