# 愿景与定位

via 是一个独立的 MCP client，以 CLI 形态让 agent 按需发现和调用任意 MCP server 的工具。agent 框架不再挂载 MCP，鉴权全部由 via 负责。

一句话：**MCP 做提供方协议，CLI 做消费方接口。**（[ADR 0001](../adr/0001-mcp-for-providers-cli-for-consumers.md)）

## 要解决的问题

- **schema 预注入**：框架接入 MCP 时，会把所有工具的 schema 预先注入上下文。server 一多，任务还没开始就占掉几万 token。
- **配置与凭证分散**：每个框架各配一遍 server 地址和凭证，轮换一次要改所有地方。
- **输出冗长**：工具返回的原始 JSON 冗长，键名逐行重复，截断和翻页各家各做。

## 目标

- **零注入**：agent 上下文里只有一段 100–300 token 的使用说明。
- **不碰原配置**：只读引用各框架的 MCP 配置，从不写入（[ADR 0003](../adr/0003-read-only-framework-configs.md)）。
- **统一鉴权**：按 server 自动注入凭证，框架侧不做任何鉴权。
- **启发式发现**：provider → 资源 → 动作逐级展开，配合 `via find` 搜索；借鉴 Asterlane 的按域聚合思路。
- **统一紧凑输出**：一套全局渲染规则，带截断游标。

## 非目标

- **不是网关或代理**。多 agent 的权限隔离、审计、凭证隔离交给专门的网关，例如 Asterlane；网关对 via 来说只是普通 MCP server（[ADR 0002](../adr/0002-standalone-client-not-gateway.md)、[ADR 0007](../adr/0007-no-gateway-specific-adaptation.md)）。
- **不修改框架配置**。只输出关闭 MCP 注入的提示，由用户自己操作。
- **发现不调用模型**。命名拆分、分域、搜索全部是确定性规则。
- **不提供凭证隔离**。via 与 agent 同用户运行，能读到 via 配置的进程理论上也能读到凭证（见[安全模型](../spec/security.md)）。
- **只接 MCP**。不直接接 OpenAPI、GraphQL 等其他 API 描述；这些 API 需要先包装成 MCP server。MCP 是提供方协议（[ADR 0001](../adr/0001-mcp-for-providers-cli-for-consumers.md)），只接一种协议，命名、鉴权和渲染规则才能保持统一。

## 设计原则

1. **薄**：不生成代码，运行时根据缓存的 schema 动态分发（[ADR 0008](../adr/0008-dynamic-dispatch-no-codegen.md)）。
2. **借用约定**：git 风格子命令、`-h`、did you mean、退出码、stdout 与 stderr 分离——这些是模型在训练中见得最多的 CLI 习惯。
3. **每个输出都指向下一步**：列表给出查看详情的命令，报错给出正确用法，截断给出续读命令。
4. **输出严格，输入宽松**：规范名稳定不变，输入接受多种写法。

## 与相近工具的区别

| 工具 | 做法 | 与 via 的区别 |
| --- | --- | --- |
| [mcp2cli](https://github.com/knowsuchagency/mcp2cli) | 运行时把单个 MCP server、OpenAPI 或 GraphQL 端点转成 CLI，每次调用指定来源，或用 `bake` 保存连接参数 | 它面向单个来源：先知道连哪个端点，再 `--list`。via 面向 agent 这一侧：读取框架现有配置，把所有 server 汇成一个目录，跨 server 浏览和 `find`，凭证按 server 绑定，输出统一渲染 |
| mcporter `generate-cli` | 为每个 server 生成专属 CLI | via 不生成代码（[ADR 0008](../adr/0008-dynamic-dispatch-no-codegen.md)） |
| 网关（如 Asterlane） | 服务端托管凭证、划分权限、审计 | via 是本地 client，网关可以接在 via 背后（[ADR 0002](../adr/0002-standalone-client-not-gateway.md)） |

「运行时分发、不注入 schema、省 token」不是 via 独有的；via 的差异在**多 server 聚合与跨 server 发现**、**只读复用框架配置**、**统一的命名与渲染规则**。评测也以此为准（[测试与评测](../development/testing.md#agent-评测)）。

## 适用边界

| 场景 | 建议 |
| --- | --- |
| agent 有 shell（编码、运维、数据处理类 agent） | 用 via |
| agent 没有 shell（纯聊天、托管型 agent） | 仍需 MCP；可考虑网关的懒加载元工具 |
| 个人开发、本地工具 | 只用 via |
| 团队、多 agent、需要审计与凭证隔离 | via 加网关 |
