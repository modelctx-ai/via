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
| 打包 | `tsup`（esbuild）打成带按需分块的 ESM 包（npm 发布）；`scripts/build-bin.ts` 用 Bun 从 `src/` 编译出单文件可执行（见[下文](#单文件可执行)） |
| 测试 | `vitest`（含快照） |

新增运行时依赖前先评估对冷启动的影响。

## 启动速度

冷启动比原生二进制慢，是选择 TypeScript 的主要代价。应对措施：

- tsup 打包并开启代码分块：`dist/via.js` 只是极薄的入口，`--version` 与 `-h` 只加载它和一个很小的文本分块；其余命令经动态 `import()` 按需加载，各子命令只加载自己用到的分块；
- 按子命令懒加载：走 daemon 的请求不加载 MCP SDK 和 ajv，只做参数解析、socket 通信和渲染；进程内模式下 MCP SDK 在首次建立连接时才加载，命中目录缓存的浏览命令不会加载它；`via more` 不加载配置和目录；
- 纯 JS 依赖（MCP SDK、ajv、yaml 等）一并打进各自的分块，仍然按需加载：作为外部包时，它们是成百上千个要逐个解析、读取的文件，实测仅 `yaml` 就要 30 ms 左右，打包后约 6 ms（`npm run bench:perf`）；只有原生的钥匙串绑定 `@napi-rs/keyring` 保持外部；
- Node 22 及以上调用 `module.enableCompileCache()`；
- 热路径交给常驻 daemon，CLI 尽量薄。

## 单文件可执行

`npm run build:bin` 在 `dist/bin/` 下产出免装 Node 的可执行文件：`via-<系统>-<架构>[-musl][.exe]`，每个文件旁有一个 `.sha256`。`bun` 只是构建机器的工具，运行时不需要。

```bash
npm run build:bin                      # 本机平台
npm run build:bin -- --all             # linux-x64 / arm64（glibc 与 musl）、darwin-x64 / arm64、windows-x64
npm run build:bin -- --target darwin-arm64,linux-x64-musl
```

`npm run build`（tsup 的 `clean`）会清空 `dist/`，包括 `dist/bin/`：先构建 npm 包，再构建可执行文件。`package.json` 的 `files` 排除了 `dist/bin`，它不会进 npm 包。

### 构建方式与取舍

- **从 `src/` 编译，不从 tsup 的产物编译。** Bun 自己打包同一份代码（`data/*.json` 作为 JSON 模块内联，和 tsup 一样）；两种来源的体积与冷启动在噪声内没有差别（实测，见 [perf-0.3](../../bench/results/perf-0.3.md)）。从 `src/` 编译才能在打包时把 `@napi-rs/keyring` 换成目标平台的 `.node` 文件（下一节），所以交叉编译不依赖本机装了哪个平台的可选依赖。
- **`--bytecode`**：最重要的一项。`bun build --compile` 默认已经压缩，但每次启动仍要把整个打包后的 JS（压缩后约 0.7 MiB，含内联的依赖）解析一遍，这就是 0.1 实测里单文件 `--version` 反而比 `node` 慢约 30 ms 的原因；85 MiB 里大头是 Bun 运行时本身（只有一行 `console.log` 的程序编译出来也有 77.5 MiB），不是 via 的代码。带上字节码，JSC 直接加载预编译的字节码，`--version` 从约 75–90 ms 降到约 30 ms。字节码与产物里内嵌的 Bun 运行时版本绑定，二者始终一起发布，不会错配。
- **`--splitting`**：保持 tsup 版本的懒加载性质。Bun 的编译模式也支持代码分块；入口块只含帮助文本，命令运行器、MCP SDK、ajv、yaml 等在需要时才从内嵌的块里加载（并解码它们的字节码）。单用 `--bytecode` 时整包的字节码在启动时一并读入，`--version` 约 30 ms，加上分块约 19 ms（裸 `bun -e 0` 约 10 ms 是下限）。`test/cli/bin.test.ts` 检查入口块的静态依赖里没有任何库、没有命令运行器。
- `--minify` 不用单独指定：`--compile` 隐含生产模式（压缩）；显式写 `--sourcemap=none` 与默认相比没有差别（默认不内嵌 source map）。
- **`autoloadDotenv: false`、`autoloadBunfig: false`**：Bun 编译出的可执行文件默认读取当前目录的 `.env` 与 `bunfig.toml`。via 常在不可信的仓库目录里运行，`.env` 会悄悄变成 `env:` 凭证引用能读到的值，`bunfig.toml` 甚至能预加载代码，所以关闭（[security.md](../spec/security.md#单文件可执行)，有测试覆盖）。

### 钥匙串（`@napi-rs/keyring`）

`@napi-rs/keyring` 是各平台一个预编译的 `.node` 文件，分布在可选依赖 `@napi-rs/keyring-<平台>` 里；它的入口 `index.js` 按运行平台 `require` 其中一个。直接 `bun build --compile` 时 Bun 能内嵌 `.node`，但只会内嵌**本机**装着的那几个（Linux 上 gnu 与 musl 各一份，6 MiB 白占），交叉编译出的 macOS 或 Windows 版本里是 Linux 的文件，运行时必然加载失败。

`scripts/build-bin.ts` 用 `Bun.build` 的插件把 `@napi-rs/keyring` 换成一个只含 `require("<目标平台的 .node>")` 的小模块（`scripts/lib/bin-targets.ts` 的 `keyringStub`），Bun 的单文件可执行支持内嵌 `.node`：字面路径的 `require` 会把文件打进可执行文件，首次用到时解压到临时目录（`$TMPDIR/.bun-<uid>-<哈希>.node`，之后复用）。目标平台的包取自 `node_modules`（版本与锁文件一致时），否则 `npm pack` 下载到 `.build/native/` 并校验 `package-lock.json` 里的 `sha512` 完整性。每个二进制恰好内嵌自己那个平台的模块（交叉编译的七个都核对过）。

- 加载是懒的：不用 `keychain:` 与 OAuth 存储就不会解压、`dlopen`。
- 加载失败时（`src/keyring.ts`）错误是一行：`cannot read the system keychain: the native keychain module is not available on <平台>…`，`next:` 提示改用 `env:` 或 `file:`；OAuth 的存储本来就会退回私有文件。napi-rs 的原始报错里「重装 npm 包」的建议对可执行文件没有意义，被去掉了。
- `NAPI_RS_NATIVE_LIBRARY_PATH` 指向某个 `.node` 文件时加载它，行为与 npm 版本相同；测试靠它制造「模块不可用」。
- 能做到的：本机（Linux x64 glibc）上钥匙串模块在可执行文件里加载并运行，读取不存在的条目得到 `no keychain entry`。**没有验证的**：其他平台的真实钥匙串读写（macOS Keychain、Windows Credential Manager、Secret Service）——没有这些环境；交叉编译的产物只检查了内嵌的是正确的 `.node` 文件，没有在目标平台运行。

### 与 Node 版本一致的部分

- **daemon**：`via daemon run` 重新执行的是当前程序自身（`src/runtime.ts` 的 `selfCommand()`）。脚本运行时是 `<node|bun> <入口脚本> daemon run`；可执行文件的 `process.argv[1]` 是 Bun 虚拟文件系统里的路径（`/$bunfs/root/…`），别的进程打不开，所以只用 `<可执行文件> daemon run`。冒烟测试核对守护进程的命令行。
- **`module.enableCompileCache()`**：Bun 里这个函数是空桩（返回成功但什么也不缓存），`main.ts` 在 Bun 下不调用它；可执行文件靠字节码；以 `bun dist/via.js` 运行时也不需要它。
- **stdio server、OAuth 回环监听、`cmd:` 凭证、`via batch` 读 stdin**：都是 Node API，Bun 兼容，冒烟测试各走一遍。
- 平台判断仍用 `process.platform`；Windows 版本能构建，但 daemon（命名管道）与对端校验是路线图 c4，冒烟测试也只在 Linux 与 macOS 上跑。

### 测试与发布

- `test/cli/bin.test.ts`：装有 `bun` 时构建一次本机可执行文件，跑冒烟集（`--version`、`-h`、根视图与调用、stdio server、daemon 的拉起与停止、`.env` 不被读取、钥匙串可用与不可用、OAuth 回环登录、`batch`）；没有 `bun` 时整组跳过。设 `VIA_REQUIRE_BUN=1`（CI 里设了）则「没有 bun」本身是失败。`test/runtime.test.ts`、`test/bin-targets.test.ts` 不需要 Bun。
- CI（`.github/workflows/ci.yml` 的 `binary` 任务）：Ubuntu 与 macOS 上安装固定版本的 Bun，构建本机版本，跑上述测试，并把产物拷到仓库外、用空 HOME 运行 `--version`、根视图和 `doctor`。
- 发布（`.github/workflows/release.yml`）：只在 `v*` 标签或手动触发时运行。各平台在原生 runner 上构建，Linux x64/arm64 与 macOS arm64 跑冒烟测试；Intel macOS、Windows、musl 只构建。汇总后生成 `SHA256SUMS` 并上传到同名 Release。
- 没有做的：x64 的 `baseline` 构建（给没有 AVX2 的 CPU）、macOS 的签名与公证、Windows 签名、压缩分发（gzip 约 42 MiB）。需要时在 `bin-targets.ts` 里加一行。

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
