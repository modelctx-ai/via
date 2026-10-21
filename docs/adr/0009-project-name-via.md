# 0009. 项目名与命令名为 via

- 状态：已接受。npm 包名这一条被 [ADR 0015](0015-npm-scope-modelctx-ai.md) 取代，命令名与路径命名仍然有效。
- 日期：2026-10-20

## 背景

项目最初以 `mx` 为占位名。命令名会被 agent 高频输入，并出现在每一条示例和报错提示里，因此要求：短、读起来就懂、不与已有命令冲突。

2026-10-20 的检查结果：

| 候选 | 情况 |
| --- | --- |
| `mx` | Homebrew 上是 GraalVM 的开发工具 `mx`；npm 上 `mx` 已被占用 |
| `mcpc` | Homebrew 上是 Apify 的 MCP 命令行客户端，同类产品 |
| `mcpx` | GitHub 上已有多个同名 MCP 项目，npm 上该名字也被占用 |
| `mcli` | npm 上已被无关包占用，存在与其他命令行工具重名的风险 |
| `via` | Homebrew、apt 上没有同名包；npm 上的 `via` 是早年的占位包 |

## 决策

- 项目名与命令名为 `via`。
- npm 包名为 `@modelctx/via`，二进制名为 `via`。
- 配置与运行时路径随之命名：`~/.config/via/config.yaml`、项目配置 `.via.yaml`、socket `via.sock`、环境变量前缀 `VIA_`、钥匙串服务名 `via`。

## 备选方案

见上表。`mctx` 与组织名呼应且无冲突，但不够直白。

## 后果

- `via linear issue:create` 读起来像一句话（「通过 linear 创建 issue」），模型几乎不需要解释就能照着用。
- `via` 是普通英文单词，搜索引擎上不易检索；对外介绍时固定写作「modelctx via」。
- GitHub 仓库需要从 `modelctx-ai/mx` 改名为 `modelctx-ai/via`。
