# AGENTS.md

给在这个仓库里写代码的人和 coding agent 的工作约定。

## 文档是规范

- `docs/spec/` 下的文档是**规范性**的：命令语法、命名拆分、参数映射、输出格式、退出码、配置字段、daemon 协议都以它为准。
- 实现与规范不一致时，要么改代码，要么在**同一个 PR** 里先改规范并说明理由。不要让二者长期分叉。
- 改变已有设计决策（而不只是补细节）时，新增一篇 ADR（见 `docs/adr/README.md`），旧 ADR 标为「被取代」。
- 术语以 `docs/overview/glossary.md` 为准，代码里的命名（类型名、模块名、错误信息）与之保持一致。

## 实现约定

- TypeScript，`strict` 模式，ESM，目标 Node.js 20+。技术选型与目录结构见 `docs/development/implementation.md`。
- 规则类内容放在 `data/`（动词表、停用词表、噪声字段、框架描述），不要写死在代码里。格式见 `docs/development/data-files.md`。
- 不为任何特定 server 或网关写专门适配逻辑；所有 server 走同一套命名、参数映射和渲染规则（ADR 0007）。
- 发现逻辑默认是确定性的，不调用模型；唯一的例外是用户在用户配置里显式开启的 `search.semantic`，它只影响 `via find` 的排序、失败时退回词法排序（[ADR 0011](docs/adr/0011-find-synonym-expansion-and-optional-embeddings.md)）。
- CLI 冷启动是核心指标：入口文件只做参数解析和 socket 通信，MCP SDK、ajv 等重依赖按需懒加载。
- 退出码、stderr 元信息行、错误后的 `next:` 提示必须符合 `docs/spec/output.md`。

## 安全红线

- 任何输出、日志、错误信息、快照测试里都不能出现解析后的凭证值；已知凭证值一律替换为 `***`。
- 不读取其他客户端私有存储的 OAuth token。
- 不写入任何 agent 框架的配置文件；`via` 对框架配置只读。
- 项目级配置里的 stdio 命令和 `cmd:` 凭证引用遵循 `docs/spec/security.md` 的信任规则。

## 提交前

- 相关的规范文档、`CHANGELOG.md` 的 Unreleased 一节已同步更新。
- 渲染相关改动附带快照测试；动词表、停用词表与命名规则的改动在 CHANGELOG 中写明会影响哪些规范写法。
- 提交信息和 PR 描述不加 `Co-Authored-By`、`Claude-Session` 或 “Generated with Claude Code” 署名行。
