# 0001. MCP 做提供方协议，CLI 做消费方接口

- 状态：已接受
- 日期：2026-10-20

## 背景

agent 接入外部工具有两条路：MCP 和 CLI。

- MCP 的优势在提供方：输入有 JSON Schema、输出结构化、鉴权由 server 托管、可以按工具授权、能在没有 shell 的环境里使用、一个 server 可被各种客户端复用。
- MCP 的劣势在消费方：框架接入时会把所有工具 schema 预先注入上下文，多个 server 动辄几万 token；每次调用的完整返回都要回到模型；多步操作只能靠模型逐个串联。
- CLI 几乎零预加载，模型对常见 CLI 很熟，可以 `--help` 按需学习；管道和脚本让中间结果不经过模型；一次调用就能完成批量操作。但 CLI 需要 shell，凭证管理和权限粒度较弱。

## 决策

服务端继续用 MCP 暴露能力；消费端（有 shell 的 agent）不挂载 MCP，统一通过 mx 这个 CLI 按需发现和调用工具。mx 负责把 MCP 的结构化能力（schema、鉴权）转成 CLI 的使用方式（逐级发现、管道、紧凑输出）。

## 备选方案

- **继续直接挂载 MCP，依赖框架的延迟加载**：只解决了部分注入问题，输出冗长、组合困难依旧，且依赖各框架是否支持。
- **为每个 server 生成专属 CLI**（如 mcporter 的 generate-cli）：存在同步问题，见 [ADR 0008](0008-dynamic-dispatch-no-codegen.md)。
- **只用原生 CLI**（gh、kubectl 等）：很多服务只有 MCP，没有好用的 CLI。

## 后果

- 需要 agent 有 shell 和合适的沙箱；没有 shell 的 agent 仍需 MCP 或网关。
- 每次调用前多了发现步骤，需要用浏览视图和 `find` 带签名来压缩往返次数。
- 这一判断需要用 token 基准和 agent 评测验证，是 0.1 的门槛（[路线图](../roadmap.md)）。
