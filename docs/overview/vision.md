# 愿景与定位

mx 是一个独立的 MCP client，以 CLI 形态让 agent 按需发现和调用任意 MCP server 的工具。agent 框架不再挂载 MCP，鉴权全部由 mx 负责。

一句话：**MCP 做提供方协议，CLI 做消费方接口。**（[ADR 0001](../adr/0001-mcp-for-providers-cli-for-consumers.md)）

## 要解决的问题

- **schema 预注入**：框架接入 MCP 时，会把所有工具的 schema 预先注入上下文。server 一多，任务还没开始就占掉几万 token。
- **配置与凭证分散**：每个框架各配一遍 server 地址和凭证，轮换一次要改所有地方。
- **输出冗长**：工具返回的原始 JSON 冗长，键名逐行重复，截断和翻页各家各做。

## 目标

- **零注入**：agent 上下文里只有一段 100–300 token 的使用说明。
- **不碰原配置**：只读引用各框架的 MCP 配置，从不写入（[ADR 0003](../adr/0003-read-only-framework-configs.md)）。
- **统一鉴权**：按 server 自动注入凭证，框架侧不做任何鉴权。
- **启发式发现**：provider → 资源 → 动作逐级展开，配合 `mx find` 搜索；借鉴 Asterlane 的按域聚合思路。
- **统一紧凑输出**：一套全局渲染规则，带截断游标。

## 非目标

- **不是网关或代理**。多 agent 的权限隔离、审计、凭证隔离交给专门的网关，例如 Asterlane；网关对 mx 来说只是普通 MCP server（[ADR 0002](../adr/0002-standalone-client-not-gateway.md)、[ADR 0007](../adr/0007-no-gateway-specific-adaptation.md)）。
- **不修改框架配置**。只输出关闭 MCP 注入的提示，由用户自己操作。
- **发现不调用模型**。命名拆分、分域、搜索全部是确定性规则。
- **不提供凭证隔离**。mx 与 agent 同用户运行，能读到 mx 配置的进程理论上也能读到凭证（见[安全模型](../spec/security.md)）。

## 设计原则

1. **薄**：不生成代码，运行时根据缓存的 schema 动态分发（[ADR 0008](../adr/0008-dynamic-dispatch-no-codegen.md)）。
2. **借用约定**：git 风格子命令、`-h`、did you mean、退出码、stdout 与 stderr 分离——这些是模型在训练中见得最多的 CLI 习惯。
3. **每个输出都指向下一步**：列表给出查看详情的命令，报错给出正确用法，截断给出续读命令。
4. **输出严格，输入宽松**：规范名稳定不变，输入接受多种写法。

## 适用边界

| 场景 | 建议 |
| --- | --- |
| agent 有 shell（编码、运维、数据处理类 agent） | 用 mx |
| agent 没有 shell（纯聊天、托管型 agent） | 仍需 MCP；可考虑网关的懒加载元工具 |
| 个人开发、本地工具 | 只用 mx |
| 团队、多 agent、需要审计与凭证隔离 | mx 加网关 |
