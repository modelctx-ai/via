# 实现说明

用 TypeScript 实现（[ADR 0004](../adr/0004-typescript.md)），运行在 Node.js 20 及以上（推荐 22，可启用模块编译缓存），以 npm 包发布，另提供免装 Node 的单文件可执行版本。CLI 与 `via daemon run` 是同一个入口。

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
- 平台判断仍用 `process.platform`。Windows 上的 daemon 走命名管道（[daemon.md](../spec/daemon.md#windows)），Node 版本在 CI 的 Windows 任务里完整测试；Windows 的单文件版本只构建，冒烟测试只在 Linux 与 macOS 上跑。

### 测试与发布

- `test/cli/bin.test.ts`：装有 `bun` 时构建一次本机可执行文件，跑冒烟集（`--version`、`-h`、根视图与调用、stdio server、daemon 的拉起与停止、`.env` 不被读取、钥匙串可用与不可用、OAuth 回环登录、`batch`）；没有 `bun` 时整组跳过。设 `VIA_REQUIRE_BUN=1`（CI 里设了）则「没有 bun」本身是失败。`test/runtime.test.ts`、`test/bin-targets.test.ts` 不需要 Bun。
- CI（`.github/workflows/ci.yml` 的 `binary` 任务）：Ubuntu 与 macOS 上安装固定版本的 Bun，构建本机版本，跑上述测试，并把产物拷到仓库外、用空 HOME 运行 `--version`、根视图和 `doctor`。
- 发布（`.github/workflows/release.yml`）：只在 `v*` 标签或手动触发时运行。各平台在原生 runner 上构建，Linux x64/arm64 与 macOS arm64 跑冒烟测试；Intel macOS、Windows、musl 只构建。汇总后生成 `SHA256SUMS` 并上传到同名 Release。`v*` 标签另外把 `@modelctx-ai/via` 发到 npm：先跑 typecheck 和测试，核对 `package.json` 版本与标签一致（`v0.3.0` 对应 `0.3.0`），再 `npm publish`。登录用 GitHub Actions 的 OIDC trusted publisher（npm 上登记的工作流文件名是 `release.yml`，仓库 `modelctx-ai/via`），不存放长期 token；公开仓库会自动附带 provenance。`dist/` 不入库，`prepack` 在打包前构建。手动触发只重做单文件产物，不重复发 npm。
- 没有做的：x64 的 `baseline` 构建（给没有 AVX2 的 CPU）、macOS 的签名与公证、Windows 签名、压缩分发（gzip 约 42 MiB）。需要时在 `bin-targets.ts` 里加一行。

## Homebrew

`packaging/homebrew/via.rb.in` 是 Homebrew formula 的模板，macOS（Apple 芯片与 Intel）和 Linux（x86_64、arm64）共用一份。

### 为什么装 npm 包，而不是单文件可执行

- **这是 Homebrew 对 Node CLI 的惯例。** formula 的 `url` 指向 npm registry 上的 tarball，`depends_on "node"`，`system "npm", "install", *std_npm_args`，再把 `libexec/bin` 链到 `bin`。一份 formula、一个校验和就覆盖四个平台组合；`std_npm_args` 与 `--build-from-source` 之类的约定由 Homebrew 维护。
- **单文件可执行不适合做 Homebrew 的安装物。** 每个平台一个 URL 和校验和（Homebrew 用得到 darwin-arm64、darwin-x64、linux-x64、linux-arm64 四个，每个 65–95 MiB，npm tarball 只有 0.4 MiB）；产物是 Bun 把 JS 字节码追加在运行时尾部的文件，任何改写这个文件的后处理（strip、重签名）都会破坏它，而 Homebrew 在 macOS 上会对装进去的 Mach-O 做重定位和（Apple 芯片上的）临时签名，这条路径是否安全没有验证过；Homebrew 的核心仓库也不接受预编译二进制（要求从源码构建）。macOS 产物还没有公证（路线图 d4 的另一项），没有人在 Homebrew 的流程下验证过它。
- **代价。** 依赖 Homebrew 的 `node`（多数装 Homebrew 的机器已经有），冷启动比单文件版慢：同一台机器上 `--version` 约 66 ms 对 20 ms，根视图约 124 ms 对 54 ms（Node 22、编译缓存热；[perf-0.3](../../bench/results/perf-0.3.md)，那之后 Node 一侧又优化过，[perf-0.3-cold-start](../../bench/results/perf-0.3-cold-start.md)）。冷启动是核心指标，所以这是选 npm 包时明确付出的代价，只为换 Homebrew 能接受的做法。不想装 Node 的环境继续用 Release 里的单文件。这个选择不依赖「单文件是否成为默认推荐的安装方式」（[待定问题](../open-questions.md)）：formula 只是 npm 包的一个分发渠道；那个问题有了结论、macOS 公证也做完之后，再加一份装单文件的 formula（或在同一份里按平台选择）。
- **Node 版本。** formula 依赖不带版本的 `node`，即 Homebrew 当前的 Node；via 声明 `engines.node >=20`，CI 测 Node 22 与 24。如果 Homebrew 的 `node` 升到 via 还没测过的大版本并出现问题，改成 `depends_on "node@24"`（这类 keg-only 的版本化 formula 还要用 `Language::Node.detected_node_shebang` 重写入口脚本的 shebang）。
- `@napi-rs/keyring` 的平台包是 npm 的可选依赖，`npm install` 只装与当前系统和 CPU 匹配的那一个（Linux 上区分 glibc 与 musl），所以不需要在 formula 里清理其他平台的文件；它没有通用（universal）的 macOS 构建，不需要 `deuniversalize_machos`。

### 生成与发布

1. 模板里只有两个占位符：`@VERSION@` 和 `@SHA256@`。`node scripts/render-homebrew.mjs --version 0.3.1 --out via.rb` 从 registry 取 `@modelctx-ai/via@0.3.1` 的元数据，下载 tarball，用元数据里的 `dist.integrity`（sha512）核对下载内容和 `dist.tarball` 正是 formula 里 `url` 的地址，再算出 Homebrew 要的 SHA-256 填进去；新发布的版本有时要几秒才出现，默认重试 12 次、间隔 10 秒。`--tarball <文件>` 用本地文件算校验和，`--sha256 <十六进制>` 直接给校验和，两者都不联网。脚本不依赖任何包，也不需要密钥。
2. `release.yml` 的 `homebrew` 任务在 `npm`（`npm publish`）和 `publish`（建 Release、传单文件）都成功之后运行：渲染、`ruby -c` 检查语法，再把 `via.rb` 作为附件传到同一个 Release。它只写这个仓库的 Release，不推送到任何 tap，所以不需要额外的密钥。
3. **手工的一步**：把 `via.rb` 放进 tap 仓库。tap 仓库需要先建好（仓库名必须以 `homebrew-` 开头，约定为 `modelctx-ai/homebrew-tap`），然后：

   ```bash
   gh release download v0.4.0 --repo modelctx-ai/via --pattern via.rb
   cp via.rb path/to/homebrew-tap/Formula/via.rb      # 提交并推送 tap
   brew install modelctx-ai/tap/via
   ```

   以后可以让 tap 仓库自己的工作流在新 Release 出现时拉取 `via.rb` 并提交，这需要一个对 tap 有写权限的令牌，所以没有放进这个仓库。
4. 想在装有 Homebrew 的机器上验证 formula（**这个仓库的环境里没有 Homebrew，下面的命令没有被运行过**）：

   ```bash
   brew tap-new --no-git modelctx-ai/local
   cp via.rb "$(brew --repository modelctx-ai/local)/Formula/via.rb"
   brew install --build-from-source modelctx-ai/local/via && brew test modelctx-ai/local/via
   brew audit --strict --online modelctx-ai/local/via
   ```

- 仓库里的测试（`test/packaging/homebrew.test.ts`）覆盖能离开 Homebrew 检查的部分：占位符、`url` 与 registry 上 tarball 的地址一致、`desc`/`license`/`depends_on`/`test do` 这些 `brew audit` 会看的字段、装了 Ruby 时的语法检查，以及渲染脚本对完整性不符、地址不符和 registry 延迟的处理（用假的 `fetch`，不联网）。formula 的 `install` 步骤等价于下面这条命令，已对 0.3.1 的 tarball 手工跑过：解包后 `npm pack --ignore-scripts`，再 `npm install -g --prefix=<libexec> --build-from-source ./modelctx-ai-via-0.3.1.tgz`，`<libexec>/bin/via --version` 输出 `0.3.1`，钥匙串的平台包 `keyring-linux-x64-gnu` 随之装好。
- 没有做的：向 homebrew-core 提交（它有项目知名度的要求）、自动推送 tap、macOS 公证。

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
├─ packaging/       # homebrew/via.rb.in：Homebrew formula 模板（scripts/render-homebrew.mjs 在发布时渲染）
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
