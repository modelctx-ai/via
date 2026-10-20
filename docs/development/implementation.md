# 实现说明

用 TypeScript 实现（[ADR 0004](../adr/0004-typescript.md)），运行在 Node.js 20 及以上（推荐 22，可启用模块编译缓存），以 npm 包发布，另提供免装 Node 的单文件可执行版本。CLI 与 `via daemon run` 是同一个入口。

## 依赖选型

| 用途 | 包 |
| --- | --- |
| MCP client（stdio、Streamable HTTP、OAuth） | `@modelcontextprotocol/sdk`（官方 SDK，client 端自带 OAuth 流程支持） |
| 固定子命令解析 | 全局选项可以出现在任何位置（包括工具参数之间），0.1 用 `cli/options.ts` 里的小解析器先取走它们，不引入 `commander`；工具参数由 schema 驱动的自定义解析器处理 |
| schema 校验 | `ajv` |
| 配置解析 | `yaml`、`smol-toml`、`jsonc-parser`（部分框架配置带注释） |
| 钥匙串 | `@napi-rs/keyring` |
| 用户目录 | `env-paths` |
| 进程间通信 | Node 内置 `net`（unix socket，Windows 上为 named pipe） |
| 表格对齐 | `get-east-asian-width`（中日韩字符按双宽计算）；宽度算法是 `string-width` 的移植，只是把 `Intl.Segmenter` 与 emoji 正则推迟到第一次遇到非窄字符时才创建，一致性由测试把 `string-width`（仅开发依赖）当参照来保证 |
| 打包 | `tsup`（esbuild）打成单个 ESM 文件；`bun build --compile` 产出单文件可执行 |
| 测试 | `vitest`（含快照） |

新增运行时依赖前先评估对冷启动的影响。

## 启动速度

冷启动比原生二进制慢，是选择 TypeScript 的主要代价。应对措施：

- tsup 打包并开启代码分块：`dist/via.js` 只是极薄的入口，`--version` 与 `-h` 只加载它和一个很小的文本分块；其余命令经动态 `import()` 按需加载，各子命令只加载自己用到的分块；
- 按子命令懒加载：走 daemon 的请求不加载 MCP SDK 和 ajv，只做参数解析、socket 通信和渲染；进程内模式下 MCP SDK 在首次建立连接时才加载，命中目录缓存的浏览命令不会加载它；`via more` 不加载配置和目录；
- 纯 JS 依赖（MCP SDK、ajv、yaml 等）一并打进各自的分块，仍然按需加载：作为外部包时，它们是成百上千个要逐个解析、读取的文件，实测仅 `yaml` 就要 30 ms 左右，打包后约 6 ms（`npm run bench:perf`）；只有原生的钥匙串绑定 `@napi-rs/keyring` 保持外部；
- Node 22 及以上调用 `module.enableCompileCache()`；
- 热路径交给常驻 daemon，CLI 尽量薄。

## 代码结构

单个包、按模块分目录，薄封装不需要 monorepo：

```text
via/
├─ src/
│  ├─ cli/          # 入口、子命令、工具参数解析
│  ├─ config/       # 框架配置探测与解析、合并、凭证引用
│  ├─ catalog/      # 名称拆分、分域、索引、搜索（含同义词扩展与可选的 embedding 检索 semantic.ts）、浏览视图、缓存
│  ├─ client/       # MCP 会话、鉴权、OAuth
│  ├─ render/       # 输出流水线：清理、形状判断、表格、截断、游标
│  ├─ daemon/       # socket 服务（server）、会话与目录（sessions）、CLI 侧连接与拉起（client、backend）、路径与安全检查（paths）、协议帧（wire）
│  └─ protocol.ts   # CLI 与 daemon 之间的消息类型
├─ data/
│  ├─ frameworks/   # 各框架的配置路径、解析方式、关闭提示
│  ├─ verbs.json    # 动词表与单数化例外
│  ├─ domains.json  # 内置 server 分类表与分域参数
│  ├─ domain-lexicon.json  # 由脚本生成的分域词典
│  ├─ synonyms.json # find 的查询侧同义词、词形还原与口语停用词
│  ├─ noise.json    # 默认噪声字段表
│  ├─ columns.json  # 表格选列规则
│  └─ schema/       # 上述数据文件的 JSON Schema
├─ scripts/         # 词典生成（npm run lexicon）、拆分结果差异检查（npm run split-diff）、token 基准（npm run bench:tokens）、检索质量评测（npm run eval:search）、agent 评测（npm run bench:eval）
├─ bench/           # token 基准：tasks/（任务）、recordings/（合成的返回值）、replay-server.mjs（回放 MCP server）、harness/、results/；eval/ 是 agent 评测的实现，复用任务与回放 server（见 bench/README.md）
├─ test/fixtures/   # tools/ 与 other/：tools/list 快照；splits/：拆分结果基线；`mcp/`：模拟 MCP server（stdio 与 Streamable HTTP）；`config/`：每个框架的配置样例与 via 用户/项目配置
└─ docs/
```

`protocol.ts` 定义的消息类型（见 [daemon.md](../spec/daemon.md#cli-与-daemon-的协议)）由 CLI、daemon 和进程内模式共用，这是用 TypeScript 的一个好处：两端不会出现序列化格式不一致。

规则类内容放在 `data/` 下，打包时内联，用户配置可覆盖；大部分迭代只需改数据，不必改代码（格式见 [数据文件](data-files.md)）。

### CLI 到 MCP server 的一个入口：Backend

所有会碰 MCP server 的命令（`call`、`batch`、`auth`、`doctor`、`sync`、浏览与 `find`）都经 `App.backend()`（`src/cli/backend.ts` 的 `Backend` 接口，`App.client()` 返回同一个对象）：

- `listing(server, { timeoutMs, refresh })`：工具列表（缓存、凭证检查在后端内完成）；`callTool(...)`、`compiler()`（参数校验用的 schema 编译器，daemon 模式下由 daemon 校验）、`cursors()`（游标存放处）、`redact(text)`、`secrets()`。
- `InProcessBackend`（进程内模式）、`DaemonBackend`（`src/daemon/backend.ts`，每个操作一个协议请求）和包住前者的 `FallbackBackend`（daemon 不可用时按 [daemon.md](../spec/daemon.md#生命周期) 回退）。新命令只用 `App` 的 `backend()`、`listing()`、`client()`、`compile`、`redactText()`，不要自己创建 `InProcessClient`，否则会绕过 daemon。

## 模块与规范的对应

| 模块 | 遵循的规范 |
| --- | --- |
| `cli/` | [cli](../spec/cli.md)、[arguments](../spec/arguments.md) |
| `config/` | [config](../spec/config.md)、[security](../spec/security.md#项目级配置的信任) |
| `catalog/` | [naming](../spec/naming.md)、[discovery](../spec/discovery.md) |
| `client/` | [auth](../spec/auth.md)、[daemon](../spec/daemon.md) |
| `render/` | [output](../spec/output.md) |
| `daemon/` | [daemon](../spec/daemon.md) |

## 实现顺序建议（0.1）

1. `catalog/` 的拆分与分域：纯函数，先用真实 `tools/list` 快照做测试，最快验证核心设计。
2. `render/`：纯函数，配快照测试。
3. `config/`：框架配置只读解析与合并、凭证引用。
4. `client/` 进程内模式：stdio 与 HTTP 直连、bearer/env 鉴权。
5. `cli/`：子命令、浏览视图、schema 驱动的参数解析、退出码。
6. `via doctor`、`via prompt`。
7. token 基准与 agent 评测（[testing.md](testing.md)）。
