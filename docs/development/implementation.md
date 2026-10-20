# 实现说明

用 TypeScript 实现（[ADR 0004](../adr/0004-typescript.md)），运行在 Node.js 20 及以上（推荐 22，可启用模块编译缓存），以 npm 包发布，另提供免装 Node 的单文件可执行版本。CLI 与 `via daemon run` 是同一个入口。

## 依赖选型

| 用途 | 包 |
| --- | --- |
| MCP client（stdio、Streamable HTTP、OAuth） | `@modelcontextprotocol/sdk`（官方 SDK，client 端自带 OAuth 流程支持） |
| 固定子命令解析 | `commander`；工具参数由 schema 驱动的自定义解析器处理 |
| schema 校验 | `ajv` |
| 配置解析 | `yaml`、`smol-toml`、`jsonc-parser`（部分框架配置带注释） |
| 钥匙串 | `@napi-rs/keyring` |
| 用户目录 | `env-paths` |
| 进程间通信 | Node 内置 `net`（unix socket，Windows 上为 named pipe） |
| 表格对齐 | `string-width`（中日韩字符按双宽计算） |
| 打包 | `tsup`（esbuild）打成单个 ESM 文件；`bun build --compile` 产出单文件可执行 |
| 测试 | `vitest`（含快照） |

新增运行时依赖前先评估对冷启动的影响。

## 启动速度

冷启动比原生二进制慢，是选择 TypeScript 的主要代价。应对措施：

- 打包成单个文件，减少模块解析开销；
- 按子命令懒加载：走 daemon 的请求不加载 MCP SDK 和 ajv，只做参数解析、socket 通信和渲染；
- Node 22 及以上调用 `module.enableCompileCache()`；
- 热路径交给常驻 daemon，CLI 尽量薄。

## 代码结构

单个包、按模块分目录，薄封装不需要 monorepo：

```text
via/
├─ src/
│  ├─ cli/          # 入口、子命令、工具参数解析
│  ├─ config/       # 框架配置探测与解析、合并、凭证引用
│  ├─ catalog/      # 名称拆分、分域、索引、搜索、浏览视图、缓存
│  ├─ client/       # MCP 会话、鉴权、OAuth
│  ├─ render/       # 输出流水线：清理、形状判断、表格、截断、游标
│  ├─ daemon/       # socket 服务、生命周期、并发控制
│  └─ protocol.ts   # CLI 与 daemon 之间的消息类型
├─ data/
│  ├─ frameworks/   # 各框架的配置路径、解析方式、关闭提示
│  ├─ verbs.json    # 动词表与单数化例外
│  ├─ domains.json  # 内置 server 分类表与分域参数
│  ├─ domain-lexicon.json  # 由脚本生成的分域词典
│  ├─ noise.json    # 默认噪声字段表
│  ├─ columns.json  # 表格选列规则
│  └─ schema/       # 上述数据文件的 JSON Schema
├─ scripts/         # 词典生成（npm run lexicon）、拆分结果差异检查（npm run split-diff）、token 基准
├─ test/fixtures/   # tools/ 与 other/：tools/list 快照；splits/：拆分结果基线；模拟 MCP server、框架配置样例（待补）
└─ docs/
```

`protocol.ts` 定义的消息类型（草案见 [daemon.md](../spec/daemon.md#cli-与-daemon-的协议)）由 CLI、daemon 和进程内模式共用，这是用 TypeScript 的一个好处：两端不会出现序列化格式不一致。

规则类内容放在 `data/` 下，打包时内联，用户配置可覆盖；大部分迭代只需改数据，不必改代码（格式见 [数据文件](data-files.md)）。

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
