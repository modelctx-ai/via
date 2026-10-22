# 0004. 使用 TypeScript 实现

- 状态：已接受。「另提供单文件可执行版本」这一条被 [ADR 0023](0023-npm-is-the-only-distribution-channel.md) 取代，其余仍然有效。
- 日期：2026-10-20

## 背景

最初考虑用 Rust（静态二进制、冷启动快，可复用 rmcp）。后续决定 via 与其他项目没有代码复用关系，选型以开发效率和生态为主。

## 决策

用 TypeScript 实现，运行在 Node.js 20 及以上，以 npm 包发布，另提供单文件可执行版本。MCP 能力基于官方 TypeScript SDK（0.3 前是 1.x 的 `@modelcontextprotocol/sdk`，0.4 起是 v2 的 `@modelcontextprotocol/client` 与 `@modelcontextprotocol/server`，因为只有 v2 支持 `2026-07-28` 无状态协议；选型原则不变，见[实现说明](../development/implementation.md#mcp-sdkv2)）。

## 备选方案

- **Rust**：冷启动和内存更优，但 MCP client 端 OAuth、动态 schema 处理等的开发成本更高。
- **Go**：单文件分发方便，但 MCP 生态与 schema 工具链不如 TypeScript 成熟。

## 后果

- 官方 SDK 的 client 端自带 OAuth 支持，省去大量鉴权实现工作。
- CLI、daemon、进程内模式共用 `protocol.ts` 中的类型，两端序列化格式不会不一致。
- 冷启动比原生二进制慢，是主要代价。应对措施：单文件打包、按子命令懒加载、模块编译缓存、热路径交给 daemon（[实现说明](../development/implementation.md#启动速度)）。
- Windows 上 named pipe 可直接用 Node 的 `net` 模块。
