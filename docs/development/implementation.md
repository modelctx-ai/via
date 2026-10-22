# 实现说明

用 TypeScript 实现（[ADR 0004](../adr/0004-typescript.md)），运行在 Node.js 20 及以上（推荐 22，可启用模块编译缓存），只以 npm 包发布（[ADR 0023](../adr/0023-npm-is-the-only-distribution-channel.md)）。CLI 与 `via daemon run` 是同一个入口。

## 依赖选型

| 用途 | 包 |
| --- | --- |
| MCP client（stdio、Streamable HTTP、OAuth） | `@modelcontextprotocol/client`（官方 TypeScript SDK v2，client 端自带 OAuth 流程支持；是目前唯一支持 `2026-07-28` 无状态协议的官方实现，见下「MCP SDK」） |
| 出站 HTTP 代理 | `undici` 的 `ProxyAgent`（仅在设置了代理变量时按需加载；锁在 7.x：Node 内置的 `fetch` 带的 undici 版本拒绝 8.x 的 dispatcher） |
| `via serve` 的 MCP server | `@modelcontextprotocol/server`（同一代 SDK 的 server 端） |
| 固定子命令解析 | 全局选项可以出现在任何位置（包括工具参数之间），0.1 用 `cli/options.ts` 里的小解析器先取走它们，不引入 `commander`；工具参数由 schema 驱动的自定义解析器处理 |
| schema 校验 | `ajv` |
| 配置解析 | `yaml`、`smol-toml`、`jsonc-parser`（部分框架配置带注释） |
| 钥匙串 | `@napi-rs/keyring` |
| 用户目录 | `env-paths` |
| 进程间通信 | Node 内置 `net`（unix socket，Windows 上为 named pipe，名字由握手令牌派生，见 [daemon.md](../spec/daemon.md#windows)） |
| 表格对齐 | `get-east-asian-width`（中日韩字符按双宽计算）；宽度算法是 `string-width` 的移植，只是把 `Intl.Segmenter` 与 emoji 正则推迟到第一次遇到非窄字符时才创建，一致性由测试把 `string-width`（仅开发依赖）当参照来保证 |
| 打包 | `tsup`（esbuild）打成带按需分块的 ESM 包（npm 发布，见[发布](#发布)） |
| 测试 | `vitest`（含快照） |

新增运行时依赖前先评估对冷启动的影响。

## 启动速度

冷启动比原生二进制慢，是选择 TypeScript 的主要代价。应对措施：

- tsup 打包并开启代码分块：`dist/via.js` 只是极薄的入口，`--version` 与 `-h` 只加载它和一个很小的文本分块；其余命令经动态 `import()` 按需加载，各子命令只加载自己用到的分块；
- 按子命令懒加载：走 daemon 的请求不加载 MCP SDK 和 ajv，只做参数解析、socket 通信和渲染；进程内模式下 MCP SDK 在首次建立连接时才加载，命中目录缓存的浏览命令不会加载它；`via more` 不加载配置和目录；
- 纯 JS 依赖（MCP SDK、ajv、yaml 等）一并打进各自的分块，仍然按需加载：作为外部包时，它们是成百上千个要逐个解析、读取的文件，实测仅 `yaml` 就要 30 ms 左右，打包后约 6 ms（`npm run bench:perf`）；只有原生的钥匙串绑定 `@napi-rs/keyring` 保持外部；
- Node 22 及以上调用 `module.enableCompileCache()`；
- 热路径交给常驻 daemon，CLI 尽量薄。

### 0.3 的冷启动工作（数据见 [bench/results/perf-0.3-cold-start.md](../../bench/results/perf-0.3-cold-start.md)）

目标是浏览类命令（`via`、`via <provider>`、`via find`）不再比 `--version` 慢一倍。每一项都是测过才留下的（`npm run bench:perf`，用 `--compare <目录>` 与改动前的构建交替运行）；输出逐字节不变、仍然确定。

- **不经 ESM 门面加载 Node 内置模块。** `import { readFileSync } from 'node:fs'` 会让 Node 为整个 `fs` 生成 ES 模块门面，读遍它的属性，包括惰性的 `fs.promises`，于是加载 `internal/fs/promises`、streams、`readline`，约 12 ms。`scripts/lib/lazy-builtins.ts`（tsup 的 esbuild 插件）把打包产物里对 `fs`、`fs/promises` 的导入改成 `process.getBuiltinModule` 取到的同一模块，名字按当前 Node 在构建时枚举；源码、类型和测试仍照常写 `node:fs`。`node:process`、`node:tty`、`node:crypto`、`node:net` 同样各要 6 到 12 ms，所以：stdout/stderr 用 `fs.writeSync` 写（`src/cli/stdio.ts`，处理 `EAGAIN`；Windows 上只有控制台（字符设备）保留真正的流，管道与文件同样直接写），终端检测按需（`src/builtin.ts`），代码里用全局 `process`。构建后 `scripts/lib/strip-require.ts` 去掉不需要 `require` 的分块里 tsup 加的 `require` 垫片。`test/cli/dist.test.ts` 断言浏览命令不初始化这些模块。
- **哈希不走 `node:crypto`。** `src/sha256.ts`：64 KiB 以内用纯 JS 的 SHA-256（`test/sha256.test.ts` 与 `node:crypto` 逐例对照），更大的输入才加载 `node:crypto`。配置文件的信任哈希、缓存键、媒体文件名都用它；信任语义不变，仍是文件字节的 SHA-256，且只在真有 stdio 命令要启动时才计算。
- **预构建目录**（[discovery.md](../spec/discovery.md#预构建缓存)）：把拆分与检索词存成 `catalog/<哈希>.view.json`，浏览命令只读头或体，不解析 schema。规则指纹由构建时的 `define`（`__VIA_RULES_ID__`）注入。
- **配置解析缓存**（[config.md](../spec/config.md#解析缓存)）：YAML 只存结构与偏移，不复制字符串，凭证不会进缓存；合法 JSON 用原生 `JSON.parse`，不加载 `jsonc-parser`。
- **一次 `import()` 取齐浏览命令要用的模块**（`src/cli/browse-deps.ts`），而不是按命令逐个串行 `import()`；渲染流水线与 MCP 客户端不进浏览命令的加载路径。
- **分词、签名、索引**：ASCII 快路径（不用正则）、字符串只 kebab 一次、倒排表用扁平数组并能直接使用预算好的词频。分词在一千个工具上约 4–6 ms 降到约 2.3 ms；一千个工具、新进程里的目录构建加索引加首次查询约 80 ms，命中预构建缓存时约 21 ms。
- **daemon**：不在内存里保存解析后的工具列表（磁盘缓存就是副本），`list` 带 `have` 时不重传（[daemon.md](../spec/daemon.md)）；Node 运行时下拉起时加 `--max-semi-space-size=2` 与（Linux）`MALLOC_ARENA_MAX=2`（`daemonRuntime`），建立会话后的常驻内存少 5 到 10 MiB；SDK 与 ajv 仍是按需加载。

### MCP SDK（v2）

via 用官方 TypeScript SDK v2：client 端 `@modelcontextprotocol/client`，`via serve` 的 server 端 `@modelcontextprotocol/server`（均精确锁版本）。1.x 的 `@modelcontextprotocol/sdk` 最高协商到 `2025-11-25`，`2026-07-28` 的无状态协议只有 v2 支持（[daemon.md](../spec/daemon.md#协议版本与无状态连接)）；`@modelcontextprotocol/sdk` 现在只是开发依赖，测试用的模拟 server 仍用它，这样「旧一代 server」是真正的旧 SDK。

- **结果不经 SDK 的类型化方法校验。** `listTools()`、`readResource()` 等会按完整的 MCP schema 校验整个结果，一个畸形条目就让整次操作失败。via 一直用通用请求加一个什么都接受的 schema（`src/client/session.ts` 的 `RAW`），只留下自己要用的条目（有 `name` 的工具、有 `uri` 的内容），其余原样交给渲染。迁移后保持这一点；`2026-07-28` 连接上的 `tools/call` 例外，走 SDK 的 `callTool()`：只有它会按 `x-mcp-header` 声明镜像 `Mcp-Param-*` 请求头，缺了头 server 会拒绝调用。它的输出校验被换成什么都接受的校验器，结果仍按 server 给的样子显示。
- **重定向。** v2 的 HTTP 传输默认只跟随同源重定向（1.x 跟随到任何地方，并把自定义请求头一起带过去）。via 保持 v2 的默认：指向别处的重定向报错，错误信息带目标地址，让用户直接配置那个地址。
- **协议版本常量。** `src/protocol-versions.ts` 重复了 SDK 的版本列表和 `serverInfo` 的 `_meta` 键，因为配置加载器要校验 `protocolVersion`，不能为此加载 SDK。`test/protocol-versions.test.ts` 对照 node_modules 里的 SDK 检查它们：旧版列表等于 `SUPPORTED_PROTOCOL_VERSIONS`，无状态版本等于 SDK server 在 `server/discover` 里给出的列表，并用真正的 SDK client 钉住每个版本连一次。SDK 升级后增减版本会让这个测试失败。OAuth 登录的探测请求（`src/client/oauth/login.ts`）不再写死版本：用 SDK 的 `LATEST_PROTOCOL_VERSION` 发 `initialize`，用 via 的无状态版本发 `server/discover`，哪个先得到 401 就用哪个的挑战头。
- **代价**（`npm run bench:perf`，同一台机器上与迁移前的构建交替运行，噪声明显）：调用路径多加载约 0.55 MiB 的分块（`gh echo_text` 加载的分块 1.0 → 1.6 MiB：SDK 与 zod 4 共约 1.0 MiB，1.x 连同其中的 zod 约 0.3 MiB），加载时要构造全部 schema；进程内模式（无 daemon）的一次 `gh echo_text` 中位数多约 40 ms（HTTP 514 → 554 ms，stdio 735 → 771 ms；各自用独立的目录缓存，交替运行 25 次）；单文件可执行 86 → 89 MiB，进程内的一次调用没有可见差别（232 → 236 ms）；走 daemon 的 CLI、浏览类命令不加载 SDK，不受影响（`test/cli/dist.test.ts`、`test/daemon/e2e.test.ts` 的加载追踪断言，冷启动数字在噪声内）；daemon 建立 HTTP 会话与调用后的常驻内存约多 5 MiB（三次交替测量的均值 80 → 85 MiB，单次波动 ±5 MiB）。热 daemon 的调用开销不变（5.3 ms）。undici（出站代理）是另一个按需加载的分块（约 1 MiB），只有设置了代理变量才加载。

评估后**没有**保留的做法：把目录和索引常驻在 daemon 里再让 CLI 查询（协议要新增 `ls`/`find`，渲染要在两处实现，而预构建缓存已经把 CLI 一侧压到几毫秒，收益不抵复杂度）；在命令之间预取（并行 `import()`，收益在噪声内）；用非密码学哈希给缓存键（字面量凭证会进入键的原文）；关闭 socket 后立即释放（会破坏进程内测试的「空闲退出」语义）。

仍然偏高的部分（真实的下限）：ESM 入口本身比 `node -e 0` 多约 3–5 ms；`--version` 比裸 `node` 多约 8–14 ms（加载 V8 编译缓存与入口分块）；daemon 里 MCP SDK 与 zod 常驻约 16 MiB，不可避免；有框架配置（带 70 KiB 的 `.claude.json`）时要读并解析它们。

## 发布

via 只通过 npm 分发（[ADR 0023](../adr/0023-npm-is-the-only-distribution-channel.md)）：没有 Homebrew formula，Release 里没有单文件可执行，也不做代码签名与公证。

- `.github/workflows/release.yml` 只在 `v*` 标签上运行。`npm` 任务先跑 typecheck、构建和测试，核对 `package.json` 版本与标签一致（`v0.3.0` 对应 `0.3.0`），再 `npm publish`；`release` 任务在发布成功之后建同名的 GitHub Release，发布说明由 GitHub 自动生成，不附任何文件。
- 登录用 GitHub Actions 的 OIDC trusted publisher（npm 上登记的工作流文件名是 `release.yml`，仓库 `modelctx-ai/via`），不存放长期 token；公开仓库会自动附带 provenance。
- `dist/` 不入库，`prepack` 在打包前构建。
- `@napi-rs/keyring` 的各平台预编译模块是 npm 的可选依赖，`npm install` 只装与当前系统和 CPU 匹配的那个。

没有 Node.js 的环境（容器、CI 镜像）自己装 Node 再用 npm；不再有免装 Node 的构建。

### 曾经有过的单文件可执行

0.3 里实现过一条 `bun build --compile` 的构建路径（`npm run build:bin`，从 `src/` 编译出 `via-<系统>-<架构>` 文件，随 Release 发布）。ADR 0023 决定不再分发它，并把构建脚本、冒烟测试、CI 任务和 `src/runtime.ts` 里识别编译产物的分支一并删除：保留一条没人发布、没人在目标机器上验证的构建路径，只会让它悄悄失效。当时的实测数据仍在 `bench/results/`（[perf-0.1](../../bench/results/perf-0.1.md)、[perf-0.3](../../bench/results/perf-0.3.md)），那是历史记录，对应的脚本已不在仓库里；需要的话可以去 0.3.1 及之前的标签里找 `scripts/build-bin.ts`。

## 代码结构

单个包、按模块分目录，薄封装不需要 monorepo：

```text
via/
├─ src/
│  ├─ cli/          # 入口、子命令、工具参数解析
│  ├─ config/       # 框架配置探测与解析、合并、凭证引用
│  ├─ catalog/      # 名称拆分、索引、搜索（含同义词扩展与可选的 embedding 检索 semantic.ts）、浏览视图、缓存
│  ├─ client/       # MCP 会话、鉴权、OAuth
│  ├─ render/       # 输出流水线：清理、形状判断、表格、截断、游标
│  ├─ platform/     # 平台差异：Windows 上命令的解析与 cmd.exe 启动（command.ts）、BOM / UTF-16 文本解码（text.ts）
│  ├─ log/          # 日志：按大小轮转的异步追加（index.ts）、读取与跟随（read.ts，`via daemon logs`）；调用路径与 daemon 才加载
│  ├─ daemon/       # socket 服务（server）、会话与目录（sessions）、CLI 侧连接与拉起（client、backend）、路径与安全检查（paths）、协议帧（wire）
│  └─ protocol.ts   # CLI 与 daemon 之间的消息类型
├─ data/
│  ├─ frameworks/   # 各框架的配置路径、解析方式、关闭提示
│  ├─ verbs.json    # 动词表与单数化例外
│  ├─ stopwords.json  # 建索引时忽略的泛用词
│  ├─ synonyms.json # find 的查询侧同义词、词形还原与口语停用词
│  ├─ noise.json    # 默认噪声字段表
│  ├─ columns.json  # 表格选列规则
│  └─ schema/       # 上述数据文件的 JSON Schema
├─ scripts/         # 拆分结果差异检查（npm run split-diff）、拆分统计（npm run split-stats）、token 基准（npm run bench:tokens）、检索质量评测（npm run eval:search）、agent 评测（npm run bench:eval）
├─ bench/           # token 基准：tasks/（任务）、recordings/（合成的返回值）、replay-server.mjs（回放 MCP server）、harness/、results/；eval/ 是 agent 评测的实现，复用任务与回放 server（见 bench/README.md）
├─ test/fixtures/   # tools/ 与 other/：tools/list 快照；splits/：拆分结果基线；`mcp/`：模拟 MCP server（stdio 与 Streamable HTTP）；`config/`：每个框架的配置样例与 via 用户/项目配置
└─ docs/
```

### Windows 约定

- 所有平台相关的路径与环境变量查找走 `PathContext`（`src/config/paths.ts`：`platform` 可注入；Windows 的 `userConfigDir` / `userCacheDir` / `userDataDir`、不分大小写的 `getEnv`、`pathIdentity`、`shortenHome`）。需要读懂「某个平台的路径」时传 `platform: 'win32'`，不要写 `process.platform === 'win32'` 的分支。凡是拼出字符串但不碰文件系统的地方用 `pathModule(platform)`（`win32` 的 `join` / `resolve` 在任何宿主上给出反斜杠路径），碰文件系统的地方用宿主的 `node:path`。
- 子进程只经 `src/platform/command.ts`（`planSpawn`、`prepareStdioCommand`），不要在别处对用户给的命令直接 `spawn`。`shell: true` 一律不用。
- 读用户文件和标准输入时用 `decodeText`（去 BOM、识别 UTF-16），而不是 `toString('utf8')`；批处理输入与配置已兼容 CRLF。输出一律是 UTF-8 加 `\n`。
- 权限位（0600 / 0700）在 Windows 上无效，代码仍然传，但文档与测试不得假定它们生效（[security.md](../spec/security.md#windows-上的文件权限)）。
- 仓库根的 `.gitattributes` 把全部文本文件固定为 LF，快照、夹具和信任记录的内容哈希依赖确切的字节。

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

1. `catalog/` 的拆分：纯函数，先用真实 `tools/list` 快照做测试，最快验证核心设计。
2. `render/`：纯函数，配快照测试。
3. `config/`：框架配置只读解析与合并、凭证引用。
4. `client/` 进程内模式：stdio 与 HTTP 直连、bearer/env 鉴权。
5. `cli/`：子命令、浏览视图、schema 驱动的参数解析、退出码。
6. `via doctor`、`via prompt`。
7. token 基准与 agent 评测（[testing.md](testing.md)）。
