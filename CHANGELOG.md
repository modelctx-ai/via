# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

影响规范写法的改动（动词表、单数化规则、域分类表）必须在这里单独列出，因为它们会改变 `provider resource:verb` 的规范名。

## [Unreleased]

### Changed

- 项目名与命令名由占位名 `mx` 改为 `via`，npm 包名 `@modelctx/via`；配置路径、项目配置文件、socket、环境变量前缀随之改名（ADR 0009）。
- 规范补充（随首个实现，不改变既有设计决策）：naming.md 明确逐词单数化并加入不规则复数；discovery.md 补全启发式打分的细节（递减计分、`minScore`、双域判定）、浏览视图的排序与截断、签名上限、安全标记和搜索排序的并列规则；output.md 补全表格选列、一行数组、元信息行格式、游标续读、脱敏顺序和错误文本清理；data-files.md 增加 `columns.json`、`singularIrregular`、`minScore`、`stopwords` 以及词典与差异检查的命令。
- 规范补充（随 config / client 实现）：config.md 的 `sources` 列表语义、框架写法规范化（`type`/`transport`、`serverUrl`、Codex 的 `*_env_var` 等）、合并细节、校验与诊断、stdio 子进程的基础环境；data-files.md 的框架条目新增 `platforms`、`notes`，`verifiedAt` 可为 `null`；auth.md 明确 403 退出码 4、0.1 暂不支持 OAuth、stdio 的 stderr 不转发；output.md 补全传输与上游错误的格式。
- 规范补充（随 CLI 实现）：cli.md 补充各内置子命令的细节、配置错误时的行为与 `--dry-run` 输出格式；arguments.md 明确默认方言 2020-12、usage 折行规则、新增几类报错说法与错误顺序、危险操作拒绝与 progress 行的格式；discovery.md 补充进程内模式的目录缓存；agent-integration.md 补充 `via doctor` 的各节、token 估算、明文判定规则与退出码。
- client 把上游 `InvalidParams`（-32602）映射为退出码 1，并提示 schema 与 server 行为不一致。
- 安全：项目级配置的信任范围从 stdio 命令扩大到 HTTP 端点。项目级文件设置或覆盖 `url`、`headers` 时同样需要 `via trust`，避免仓库把 server 指向别处，从而拿到用户为它配置的凭证（security.md）。
- 构建：纯 JS 依赖（MCP SDK、ajv、yaml、smol-toml、jsonc-parser、string-width 等）打进分块，不再作为外部包在运行时逐文件解析，只有原生的 `@napi-rs/keyring` 保持外部。浏览类命令（`via`、`via find`）的冷启动各快约 50 ms（8 个 provider 的缓存目录，见 bench/results/perf-0.1.md）。CommonJS 依赖经动态 `import()` 只有 `default`，配置解析因此兼容两种形态。

### Added

- 性能基准 `npm run bench:perf`（`scripts/bench-perf.ts`，需先 `npm run build`）：在隔离的 HOME 里测 `dist/via.js` 各命令的冷启动（无缓存 / 缓存冷 / 缓存热，减去 `node -e 0` 基线）、确定性合成的 1,000 个工具上目录构建、索引构建与查询的耗时、`via <provider> <tool>` 相对官方 SDK 直接调用的开销、每条命令加载的分块与包，装有 `bun` 时再测单文件可执行；结果对照 testing.md 的性能目标。合成目录生成器与模块加载追踪放在 `scripts/lib/`，`test/bench/` 与 `test/cli/dist.test.ts` 增加不依赖时间的断言（合成目录可复现、`--version` / `-h` 不加载任何包、无配置的浏览命令不加载 MCP SDK 与 ajv）。
- 工程骨架：`@modelctx/via` 包（ESM、Node 20+，TypeScript strict），tsup 打成单个文件并内联 `data/`，vitest 测试，`typecheck` / `build` / `test` 脚本。
- `src/catalog/`：工具名拆分（切词、去 provider 词、找动作、复合动词、逐词单数化、叶子工具、`resource:verb` 冲突退回叶子、`rename` 覆盖、`deny` 过滤）；分域（配置 → 内置分类表 → 启发式打分 → `other`，按资源拆分，`--why` 的依据）；`SearchIndex`（规范写法三级匹配 + BM25）；工具引用解析与 did you mean；`via`、`via <provider>`、`via <provider> <resource>`、`via find` 的浏览视图。规则放在 `data/verbs.json`、`data/domains.json`、`data/domain-lexicon.json`（`npm run lexicon` 生成）。
- `src/render/`：输出流水线（选数据源、清理噪声、形状判断、表格与 CJK 双宽对齐、单元格与预算截断、游标、媒体落盘、脱敏）、元信息行、`next:` 提示与错误格式、退出码常量。游标存储与媒体落盘在接口之后，0.1 的实现写入用户缓存目录（权限 0700）。规则放在 `data/noise.json`、`data/columns.json`。
- 数据文件的 JSON Schema（`data/schema/`），测试中校验。
- `src/config/`：`loadConfig`（框架配置只读解析、用户配置 `config.yaml`、项目配置 `.via.yaml`、命令行覆盖，按 server 名逐字段合并；同名异义的框架定义记入 `conflicts`；字段校验带路径；坏文件跳过并返回诊断）。
- `data/frameworks/`：Claude Code、Claude Desktop、Cursor、Codex、VS Code、Windsurf 的配置路径与关闭提示，附 `data/schema/framework.schema.json`。各条目尚未按实际安装的版本核对（`verifiedAt` 为 `null`）。
- 凭证引用解析（`env:`、`file:`、`keychain:`，钥匙串懒加载）；`cmd:` 0.1 在加载阶段对项目与框架配置拒绝，用户配置中解析时提示 0.2 才支持。
- 项目级信任存储（真实路径 + SHA-256，目录 0700、文件 0600）；未信任的项目级 server 标记 `trusted: false`。`via trust` 命令留待 0.2。
- `src/protocol.ts`：CLI、daemon 与进程内模式共用的消息类型（Request / Response / Event / ErrorInfo / ResultMeta / 握手）。
- `src/client/`：进程内模式的 MCP client。stdio 与 Streamable HTTP 会话按 server 复用，`listTools` 跟随分页，`callTool` 返回未渲染的原始结果；MCP SDK 仅在首次连接时动态加载。凭证在连接前经 `CredentialResolver` 解析并注入（`auth.bearer`、`auth.headers`、`headers`、stdio `env`）；stdio 子进程只继承基础环境变量。按 server 的 `timeout` 与 `concurrency`（超出排队），只读调用在超时或断线后重试一次。错误映射到退出码 3/4/5/6：凭证缺失、401/403 退出码 4，未信任的 server 在连接前以退出码 5 拒绝，独占 server 启动失败附冲突提示，OAuth 型 server 暂提示改用 bearer。
- 测试夹具：`test/fixtures/mcp/` 基于官方 SDK 的模拟 stdio / Streamable HTTP MCP server；`test/fixtures/config/` 各框架配置样例与 via 用户 / 项目配置。
- `src/cli/args/`：schema 驱动的工具参数解析（`--name value` / `--flag` / `--no-flag` / 点号路径 / 重复数组 / `--args` / `@文件` / stdin / `@@` 转义 / 位置参数 / `--p.` 前缀），按 schema 决定是否解析 JSON，anyOf / oneOf 自动补齐，ajv 懒加载校验（默认 2020-12，`format` 仅警告，外部 `$ref` 跳过），固定英文报错与 `-o json` 的 `details`，`-h` / usage 渲染，`outputSchema` 输出校验。
- `src/cli/`：命令入口与路由（内置子命令 → provider → 资源 / 工具；唯一前缀、大小写与 `-`/`_` 宽松输入；歧义与 did you mean 退出码 3）。全局选项可出现在任意位置，`--p.` 前缀留给工具。支持浏览视图、`-h` 与调用：deny 退出码 5，危险工具需要 `--yes`，`--dry-run`，校验失败且 schema 缓存超过 5 分钟时刷新一次，只读工具重试一次，progress 写 stderr，`outputSchema` 警告，元信息行与游标。
- 目录缓存：每个 server 的 `tools/list` 缓存在用户缓存目录 `catalog/`（权限 0700，键为传输定义与凭证引用的哈希，不含解析后的凭证，TTL 24 小时）。浏览只拉取需要的 server，并行且带超时，失败的 server 显示为 `needs auth` / `failed` / `untrusted`；`via sync` 强制刷新。
- 内置子命令 `find`、`call`、`more`、`servers`、`sync`、`doctor`、`prompt`；`batch`、`auth`、`trust`、`daemon` 保留名字，提示 0.2 才可用。via 自己的配置有 error 级诊断时，除 `doctor` / `servers` 外拒绝执行（退出码 2），避免无效的 deny 规则失效放行。
- `via doctor`：server 状态计数与 `next:`、仍在注入 MCP schema 的框架及 token 估算（4 字节约 1 token）、明文凭证告警（只写键名与文件，不写值）、配置诊断与目录告警，退出码 0/2/4/5/6。`via prompt`：给 agent 的说明块加按域摘要；`--out` 覆盖已有文件需要 `--yes`。
- 打包启用代码分块：`--version` 与 `-h` 只加载入口，MCP SDK、ajv、配置解析器都在首次需要时加载。
- GitHub Actions CI：Node 22 / 24 上类型检查、打包、测试，并在 Node 20 上运行打包产物。
- 测试夹具：GitHub / Linear / Notion / Cloudflare 等 `tools/list` 快照与拆分结果基线（`test/fixtures/`），`npm run split-diff` 离线检查拆分变化；渲染与浏览视图的文件快照；快照与夹具的凭证扫描。
- 初始设计文档：愿景、架构、术语表。
- 规范：命令语法、工具名拆分、发现与分域、参数映射、输出与退出码、配置与鉴权、daemon 协议、安全模型。
- 指南：快速上手、与 agent 框架集成、GitHub / Linear / Notion / Cloudflare / 网关类 server 示例、组合用法。
- 开发文档：实现说明、测试与评测、数据文件格式。
- 架构决策记录 ADR 0001–0009。
- 参数映射：object / array 参数支持内联 JSON；明确 JSON 文本型 string 参数原样传入、宽松 schema 的处理与参数合并顺序。
- 参数校验：明确校验流程与范围、`format` 与外部 `$ref` 的处理、schema 过期或出错时的回退、`--no-validate`，以及 `outputSchema` 输出校验。
- 校验报错：固定各类错误的提示格式，多错误逐行列出，`-o json` 时提供结构化 `details`。
- 鉴权：`via auth login --manual`，在无头环境中打印授权 URL，并从终端读取重定向 URL 完成 OAuth。
- 愿景：增加「与相近工具的区别」，明确 via 只接 MCP。
- 评测：token 基准与 agent 评测加入 mcp2cli 作为对照，门槛 1 要求成功率不低于 mcp2cli。
- 待定问题：MCP roots 支持、按使用频率排序。

### Fixed

- ADR 0008 的背景误称 mcp2cli 采用代码生成；mcp2cli 实际是运行时分发。

### 影响规范写法的改动（动词表、单数化规则）

首个实现对规范里的几处细节做了补充，初版的 `data/verbs.json` 以此为准：

- 动词表在 naming.md 的最小集合之外增加：`push`、`call`、`describe`、`batch`、`enable`、`disable`、`fork`、`resolve`、`unresolve`。影响的规范写法：`push_files` → `file:push`，`enable_pr_auto_merge` → `pr-auto-merge:enable`，`disable_pr_auto_merge` → `pr-auto-merge:disable`，`fork_repository` → `repository:fork`，`resolve_review_thread` → `review-thread:resolve`，`unresolve_review_thread` → `review-thread:unresolve`，网关的 `asl_call` / `asl_describe` / `asl_batch` → `asl:call` / `asl:describe` / `asl:batch`。
- 资源中的每个词都单数化，而不只是末词（`actions_run_trigger` → `action-run:trigger`，与 naming.md 的示例一致）。
- 单数化新增 `singularIrregular`（`statuses` → `status`、`aliases` → `alias`、`caches` → `cache`、`people`、`children`、`indices`、`analyses`），`singularExceptions` 增加 `alias`、`aws`、`atlas`、`bias`、`canvas`、`gas`、`ios`、`lens`、`species`；长度不超过 2 的词不做单数化。
