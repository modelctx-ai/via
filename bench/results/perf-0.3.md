# 性能基准结果（0.3：Bun 单文件可执行）

回答 [open-questions](../../docs/open-questions.md) 里「运行时与分发」的冷启动一问，并给出 `npm run build:bin` 的产物数据。方法见 [测试与评测](../../docs/development/testing.md#性能基准)：`npm run bench:perf` 的第 6 节（`--only-bun` 只跑这一节）和第 5 节里新增的两行。0.1 的数字见 [perf-0.1.md](perf-0.1.md)。

## 环境

- CPU：Intel Xeon @ 2.80 GHz，4 核（虚拟机），内存 15.7 GiB；Linux 6.18.44 x64，Node.js v22.22.0，Bun 1.4.2
- 场景同 0.1：8 个真实 `tools/list` 快照（180 个工具）写入磁盘缓存后 server 全部停止；HOME 与 TMPDIR 在临时目录里；`VIA_NO_DAEMON=1`（第 5 节除外）
- **这台机器是共享的**：测量期间平均负载约 7（4 核），别的任务在同时跑测试，所以绝对值比 0.1 的普遍偏大（`node -e 0` 为 43–55 ms，0.1 为 34 ms），p95 尤其不可信。同一次运行内各行是交替、相邻测量的，只看量级和比值；两次独立运行（下面第 1 节是第二次，第 2 节的单文件两行来自整套运行）结论一致。

## 结论

| 问题 | 结果 |
| --- | --- |
| 为什么 0.1 的单文件比 Node 慢、还有 85 MiB？ | 体积：只含一行 `console.log` 的程序用 Bun 1.4.2 编译出来就有 77.5 MiB，via 的 JS 压缩后只有约 0.7 MiB（含内联的依赖），是运行时本身占大头，没有标志能缩小它。慢：每次启动都要把整包 JS（单文件里是一个模块）重新解析、生成字节码，约 50–60 ms，与文件大小无关。 |
| 什么有用？ | `--bytecode`：`--version` 约 88 → 32 ms，根视图约 149 → 49 ms；再加 `--splitting`（让 `--version` 不加载命令运行器与库）：`--version` 约 32 → 19 ms，已经接近裸 `bun -e 0`（约 10 ms）。 |
| 什么没有用？ | `--minify`（`--compile` 已隐含）、`--sourcemap=none`（默认无 source map）、改从 tsup 产物编译而不是 `src/`：都在噪声内。 |
| 和 Node 比？ | `--version`：19.9 对 66.1 ms（Node 22 + 编译缓存热）；根视图 53.8 对 123.7；`find` 59.0 对 165.9。经热 daemon 的整进程调用 74.6 对 198.7 ms。Bun 运行时（`bun dist/via.js`）也比 Node 快，但不及编译后的字节码版本。 |
| 对「运行时与分发」的含义 | 冷启动不再是反对以单文件可执行为主要分发形式的理由，反而是支持它的理由：加了字节码与分块之后，它是目前最快的形态。代价是体积（65–94 MiB，gzip 后约 42 MiB）、平台矩阵与签名（macOS 公证、Windows 签名未做）。该问题仍保持开放，因为剩下的是分发策略（是否默认推荐、是否出 baseline/Intel 构建、是否签名），不是性能。 |

## 1. 冷启动：各种构建方式（ms，中位数）

`bun build --compile` 是 0.1 的做法（无标志）；后两行在它之上逐个加标志；`build:bin` 是 `scripts/build-bin.ts` 的产物（字节码 + 分块 + 平台钥匙串模块 + 关闭 `.env`/`bunfig.toml` 自动加载）。括号里是文件大小。

| 命令 | `node dist/via.js` | `bun dist/via.js` | `bun build --compile`（85 MiB） | `+ --bytecode` | `+ --splitting` | `build:bin`（86 MiB） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `--version` | 66.1 | 31.2 | 88.5 | 32.1 | 19.4 | **19.9** |
| `-h` | 66.7 | 35.3 | 94.8 | 32.3 | 17.4 | **17.7** |
| `via`（根视图，缓存热） | 123.7 | 106.2 | 148.9 | 49.2 | 47.7 | **53.8** |
| `via find` | 165.9 | 164.0 | 156.7 | 89.6 | 77.5 | **59.0** |

基线：`node -e 0` 42.6，`bun -e 0` 9.6。`+ --bytecode` 是 `--bytecode --format=esm`，`+ --splitting` 是 `--bytecode --format=esm --splitting`（累加）。`build:bin` 与 `+ --splitting` 的差别只在钥匙串模块（只内嵌一个平台的）与关闭 `.env`/`bunfig.toml` 自动加载，没有性能差别（根视图与 `find` 的差异是噪声）。

## 2. 调用：整进程（经热 daemon 与无 daemon）

| 场景 | `node dist/via.js` | `build:bin` |
| --- | ---: | ---: |
| `gh echo_text`，无 daemon（加载 MCP SDK 与 ajv） | 690.6 | 306.8 |
| `gh echo_text`，经热 daemon | 198.7 | 74.6 |

（负载最重的一次整套运行里的数字；`node -e 0` 在那次是 55.0 ms，所以绝对值偏高，比值可信。）

热 daemon 下可执行文件的整进程调用约为 Node 版本的三分之一；无 daemon 时加载 MCP SDK 仍然最贵，但字节码省掉了解析，同一次运行里从 690.6 降到 306.8 ms。

## 3. 体积

| 目标 | 大小（MiB） | 内嵌的钥匙串模块 |
| --- | ---: | --- |
| linux-x64 | 86.1 | `keyring.linux-x64-gnu.node` |
| linux-arm64 | 85.7 | `keyring.linux-arm64-gnu.node` |
| linux-x64-musl | 80.4 | `keyring.linux-x64-musl.node` |
| linux-arm64-musl | 79.2 | `keyring.linux-arm64-musl.node` |
| darwin-x64 | 72.2 | `keyring.darwin-x64.node` |
| darwin-arm64 | 65.4 | `keyring.darwin-arm64.node` |
| windows-x64 | 89.5 | `keyring.win32-x64-msvc.node` |

- 构成（Linux x64，90,301,920 字节）：Bun 运行时 77.5 MiB（一行 `console.log` 的程序）；钥匙串 `.node` 3.0 MiB；via 的压缩 JS 0.7 MiB；字节码约 5 MiB（`--bytecode` 比不加多出来的部分）。
- 不用插件、直接 `bun build --compile` 时 Linux 版本里 gnu 与 musl 的 `.node` 都被内嵌（多约 3 MiB），交叉编译出的非 Linux 版本里则是 Linux 的文件。
- gzip -9：Linux x64 约 42 MiB。
- 除 linux-x64 外的产物都是交叉编译出来的，**没有在目标平台上运行过**；只核对了每个文件恰好内嵌了自己平台的 `.node`（按字节比对）。

## 4. 钥匙串路径

本机可执行文件读取一个不存在的 `keychain:` 条目（加载并解压内嵌模块、`dlopen`、查询、报 `no keychain entry`，不含 daemon）约 45 ms 整进程；`.node` 首次解压到 `$TMPDIR/.bun-<uid>-<哈希>.node`，之后复用。

## 局限

- 共享虚拟机，见上；p95 与最小值不可靠。
- 只测了 Linux x64。macOS 与 Windows 上的 Bun 启动特性（macOS 的代码签名校验、Windows Defender 扫描）没有数据，CI 的 `binary` 任务只做功能冒烟，不计时。
- 字节码的收益来自省掉解析；工具很多时（目录构建、yaml 解析）大头回到执行时间，与 Node 的差距会按比例缩小。
