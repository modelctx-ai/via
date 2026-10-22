# 性能基准结果（0.4：按相对目标复测，浏览路径回归的原因与修复）

[perf-0.3-cold-start.md](perf-0.3-cold-start.md#目标重新标定的建议已在-04-采纳) 末尾的三条重新标定建议被维护者采纳（路线图 d3），[性能目标](../../docs/development/testing.md#性能目标)按它们改写：冷启动写成「比同一次运行里的 `node -e 0` 多多少毫秒」，`find` 的库路径与整进程分开，daemon 内存看匿名内存（RssAnon）。`scripts/bench-perf.ts` 按新口径改写后的第一次复测（负载 1–3 时跑的）发现几项没有达到，而且比 0.3 的复测高。这份结果记录：在安静一些的机器上重测，回归是真的；查清原因；修复；再测。

**结论先说**：回归不是负载造成的，也不是哪一次提交造成的，是浏览路径上一点一点多出来的东西（见「回归在哪里」）。修复后 `via`（中位数 +45.6 ms）达到目标，`via github`（+50.6）在线上，带框架配置的两条命令（+60.8、+78.7）达到，同一台机器上逐轮交替运行时三条浏览命令都比 v0.3.1 快 5–8 ms。**仍有三项没有达到**：`via find`（+49–58 ms，中位数 +56.9，目标不超过 50）、经热 daemon 的 `via find`（+75–89 ms，目标 < 70；热 daemon 的 `via` 是 +68–75，在线上）、一千个工具的整进程 `find`（+85–104 ms，目标不超过 80）。其中热 daemon 两项在这台机器上连 v0.3.1 也过不去（交替运行测得 +68 与 +80），原因和剩下的差距见「没有达到的」。

## 环境

- CPU：Intel Xeon @ 2.80 GHz，4 核（虚拟机），内存 15.7 GiB；Linux 6.18.44 x64，Node.js v22.22.0
- 场景同 0.3：8 个真实 `tools/list` 快照（180 个工具）写入磁盘缓存后 server 全部停止；HOME 与 TMPDIR 在临时目录里；`VIA_NO_DAEMON=1`（热 daemon 一节与场景里的热 daemon 行除外）；每行预热 5 次、测 30 次
- **这台机器是共享的，噪声比目标的余量还大。** 每次运行开始时平均负载约 1（别的任务；脚本等到可运行任务数不超过 2 才开始，而基准自己在跑模拟 server 时负载也会到 1.5），`node -e 0` 在不同运行里是 34–48 ms，同一次运行里的配对基线也能差 5–10 ms。同一个构建同一条命令在六次运行里能差 9–24 ms（下表）。所以：（1）判定一项是否达到，只能看多次运行的分布，不能看一次；（2）比较改动前后，只有**同一次运行里交替**的数字可信（`--compare`，或 `node cmp` 式的逐轮交替，见下）；（3）这份结果里的绝对数字比 0.3 的复测整体高 3–8 ms，v0.3.1 在今天的这台机器上也是这样（见下）。
- **「修复前」是 `ad89a76`**（#26，修复前的 HEAD）的构建，**「修复后」是本次提交**。各自 `npm ci && npm run build`；脚本的 `--dist .build/<目录>` 指向修复前的构建，`--compare` 与它交替运行。二分用的老构建是 v0.3.1（`3068f1e`）、#21（`edfa0e6`，SDK v2 之前）、#22（`12926b5`，SDK v2）、#23（`1ddb960`）、#24（`e737249`）、#25（`f39aa59`）、#26（`ad89a76`）。
- 修复前后各跑了六次完整的 `npm run bench:perf`（修复前的构建用 `--dist`），两种构建逐次交替；修复后的前三次是在最后两处小改动（`app` 与 `provider` 少两个转发分块）之前的构建上跑的，数字在同一个范围里，一并列出。下面详细表来自修复后第六次运行（开始时负载最低，0.93）。

## 结论

「比裸 node 多」，单位 ms，每格是六次运行的值（修复前 / 修复后各六次），后面是中位数。

| 目标 | 修复前 | 修复后 | 结果 |
| --- | --- | --- | --- |
| `via`（根视图，缓存热，无 daemon）不超过 +50 | 66.3 54.3 48.6 49.8 66.8 63.1（58.7） | 42.2 42.5 47.2 49.5 45.5 45.6（45.6） | 达到（六次都在线内） |
| `via github` 同上 | 74.8 60.2 55.8 71.3 61.5 59.7（60.9） | 50.8 53.4 44.3 60.1 50.4 48.0（50.6） | 在线上（六次里两次在线内） |
| `via find` 同上 | 67.4 63.9 58.5 69.2 70.9 68.7（68.0） | 58.1 50.8 56.9 56.9 56.8 49.2（56.9） | 没有稳定达到：差 0–8 ms（六次里一次在线内） |
| 经热 daemon 的 `via`，< 70 | 74.1 72.2 78.7 86.8 80.2 68.3（76.4） | 68.2 75.1 74.7 75.2 69.9 71.6（73.2） | 没有达到：差 0–5 ms（六次里两次在线内） |
| 经热 daemon 的 `via find`，< 70 | 92.1 79.6 97.3 88.8 82.3 91.1（89.9） | 81.6 89.4 75.3 86.2 88.4 74.6（83.9） | 没有达到：差 5–19 ms |
| 带框架配置的 `via`，< 80 | 102.2 82.9 92.4 87.9 100.9 109.3（96.7） | 54.6 58.5 65.6 62.5 74.6 59.1（60.8） | 达到 |
| 带框架配置的 `via find`，< 80 | 107.8 110.0 98.4 106.5 113.8 119.1（108.9） | 70.3 84.7 71.1 94.3 92.2 72.8（78.7） | 在线上（六次里三次在线内） |
| 一千个工具、50 个 provider 的整进程 `via find`，不超过 +80 | 93.5 107.8 91.9 95.2 104.4 104.9（99.8） | 90.2 103.7 100.5 100.8 85.3 95.6（98.1） | 没有达到：差 5–24 ms |
| 一千个工具上的 `find`，库路径（新进程，预构建缓存：还原 + 索引 + 首次查询）< 30 | 23.9 23.5 24.3 27.7 26.1 26.1 | 24.4 27.2 25.8 27.5 24.0 22.9 | 达到 |
| 经热 daemon 调用的额外开销 < 15 | 9.1 7.3 6.2 6.8 8.8 6.3 | 7.2 5.8 5.6 6.6 7.0 7.0 | 达到 |
| daemon 常驻匿名内存（RssAnon，最高值）< 55 MiB | 37.5 46.8 43.0 42.8 46.8 44.8 | 43.4 43.5 37.4 40.7 39.7 44.2 | 达到 |

**同一次运行里与改动前交替运行**（比上表可信得多，因为两个构建经历同样的机器状态）。无 daemon 的三条命令用逐轮交替的小脚本测（每轮依次跑 `node -e 0`、v0.3.1、修复前、修复后各一次，一百五十轮，丢掉前四轮；表里是最快 60% 的均值减去 `node -e 0` 的同样统计，ms）；场景那几行用 `bench:perf --only scenarios --compare .build/dist-p26`（三十轮，中位数之差）：

| 命令 | v0.3.1 | 修复前（#26） | 修复后 |
| --- | --- | --- | --- |
| `via`（无 daemon） | 48.5 | 51.7 | 43.3 |
| `via github`（无 daemon） | 54.4 | 57.2 | 46.9 |
| `via find`（无 daemon） | 57.6 | 58.7 | 51.4 |
| 经热 daemon 的 `via`（八十轮） | 68.3 | 69.9 | 64.4 |
| 经热 daemon 的 `via find`（八十轮） | 80.2 | 79.1 | 71.0 |
| 带框架配置的 `via` | - | 84.5 | 57.8 |
| 带框架配置的 `via find` | - | 99.8 | 72.9 |
| 一千个工具的整进程 `via find`（一百轮，逐轮交替） | 90.3 | 90.7 | 85.8 |
| 一千个工具的 `via`（同上） | 65.0 | 69.5 | 60.2 |

怎么读：（1）修复前确实比 v0.3.1 慢 1–3 ms（`via` 51.7 对 48.5、`via github` 57.2 对 54.4），也就是第一次复测里「比 0.3 高」的那一部分是真的；（2）修复后比 v0.3.1 还快 5–9 ms；（3）v0.3.1 今天在这台机器上是 +48.5 / +54.4 / +57.6，而 0.3 的复测记的是 44.3 / 47.9 / 50.7：机器今天整体慢 4–7 ms，第一次复测里的「49–56」有一半是机器，一半是回归；（4）热 daemon 的两项即使回到 v0.3.1 也是 +68 与 +80，所以这两项的差距主要来自机器，不是回归；（5）一千个工具的整进程 `find` 只快了 5 ms，离 80 还差 6–20 ms，见下。

## 回归在哪里

### 二分

老构建在同一次运行里逐轮交替（一百轮），「比裸 node 多」取最快 60% 的均值（ms）。每格有 ±1.5 ms 的噪声。

| 构建 | `via` | `via find` | `via` 加载的分块 / KiB |
| --- | --- | --- | --- |
| v0.3.1 | 44.8 | 51.8 | 40 / 249 |
| #21（safe quoting、`-h` 调用示例，SDK v2 之前） | 44.6 | 54.2 | |
| #22（SDK v2） | 44.2 | 53.9 | |
| #23（mcpc 借鉴的几项） | 45.4 | 55.1 | |
| #24（OAuth CIMD、tasks、skills、server 自述） | 46.9 | 54.5 | |
| #25（elicitation、日志） | 46.3 | 55.7 | |
| #26（npm-only、钉住授权服务器，修复前） | 47.4 | 56.7 | 42 / 265 |

没有哪一次提交是元凶：SDK v2 迁移（#22）对浏览路径是 0（浏览路径不加载 SDK），`via find` 在 #21 就多了约 2 ms，之后每个功能提交多 0.5–1 ms，合计 `via` 约 +3、`via find` 约 +5。

### 原因

用 `metafile`（每个分块由哪些源文件组成）加上模块加载追踪逐个对照 v0.3.1 与 #26 浏览路径上多出来的东西，再用 `strace`、逐阶段计时（给分块加 `performance.now()` 标记）和 `--cpu-prof` 找时间花在哪。四个原因，前两个是每个功能提交各带一点的「顺手 import」，后两个是早就存在、这次才被测出来的：

1. **浏览路径上加载了只有调用、失败、凭证引用或游标才用的代码。** 一次缓存命中的 `via find` 要读配置、读缓存、建索引、打印，但路径上还加载了：`client/errors.ts`（v0.3.1 里 9 KB，加了 tasks、skills、elicitation 的错误构造后 16 KB，连带 `client/elicit.ts` 与 `render/sanitize.ts` 共 20 KB、3 个分块，只因为 `listing()` 开头 `Promise.all` 里预先 `import('../client/errors')` 要用 `mapError`，`client/credentials.ts` 又静态 import 了 `oauthNeedsHttp`，守护进程的 `DaemonBackend` 为了 `throw new ClientError` 整个 import 了它）；`config/credentials.ts`（12 KB 的凭证解析器，带 `cmd:`、`file:`、钥匙串、`platform/command.ts`、`fs/promises`，只因为 `browse-deps` 从 `config/index` 重新导出了它，而没有凭证引用的 server 一次也不会调用它）；`render/cursor-file.ts` 加 `fs/promises`（`InProcessBackend` 静态 import，游标只有截断输出的调用与 `via more` 用）。**`via <provider>` 还多加载了整个调用流水线**：`commands/provider.ts` 静态 import `commands/tool.ts`（13 KB）、`args/snapshot.ts`（9.5 KB）、`args/parse.ts` 与 `report.ts`（60 KB）、`render/pipeline.ts`（18 KB）、`client/errors.ts`、`fs/promises`，只为调用和 `-h` 那两条分支（v0.3.1 里就是这样，增长的是被加载的模块本身）。合起来 `via github` 加载 48 个分块 / 381 KiB，现在 35 / 229。
2. **同一个 server 以两个名字出现时，预构建缓存每次运行都互相覆盖。** `catalog/<哈希>.view.json` 的哈希只来自 server 的连接定义，不含 provider 名，而快照里存的是按 provider 名构建的目录。框架配置场景（四个框架文件里的 server 与用户配置里的指向同样四个地址，只是名字不同）里 12 个 provider 有 4 个每次都未命中，重建（`loadProviders` 里的 `catalog built` 一步 21 ms，别的场景是 1 ms）并把文件写回去，下一次又轮到另一个名字未命中。这是场景测出来的：第一次复测里 `via` / `via find` 的 82 / 92 ms 有约 20 ms 是它。真实使用里同一个 server 配成两个名字（在 Claude Code 和 Cursor 的配置里各一份、名字不同）是会出现的。
3. **`dist/` 里没有 `package.json`。** Node 判断一个 `.js` 是不是 ES 模块要找最近的 `package.json`，从文件自己的目录开始往上找。`dist/` 里没有，每个分块（浏览命令加载约 35 个）都先失败地打开 `dist/package.json` 再去上一级找，`strace` 数出一次 `via find` 有 **201 次失败的 `openat`**（总共 298 次），有了 `dist/package.json` 是 1 次失败（总共 98 次）。逐轮交替测，`via find` 快 2–3 ms。这从 0.1 起就有，不是回归。
4. **分块数量本身。** 每个分块是一个要解析路径、`stat`、读、链接的文件，实测浏览路径上平均约 0.4–0.5 ms（修复前第 4 节的 42 个分块里，`via.js` 的静态链 6 个、`run` 与它的静态依赖约 11 个、`app` 3 个，其余是命令与共享库）。esbuild 的分块规则是按「被哪些入口引用」划分，所以 17 个按需加载的命令入口把共享的小模块切成了很多小块；这是这次没有动的结构（见「试过没有留下的」）。

另外，修复后一次 `via find`（八个 provider，无 daemon）里每个阶段花的时间（给分块加 `performance.now()` 标记，六十次的中位数，ms；`via.js` 开始执行时进程已经过了 35–47 ms，那是 Node 自己的启动，`node -e 0` 同样要付）：加载 `run` 及其静态依赖 5–7 → 加载 `app` 2–4 → 加载 `find` 命令及目录库 4–6 → 配置与 `browse-deps`（`table`）6–13 → `loadProviders`（读缓存、还原目录）10–11 → 建索引 5–7 → 查询 2–4 → 渲染 1。`find` 比 `via` 多的约 8 ms 就是还原工具、建索引、查询和渲染，都在一个没有 JIT 预热的新进程里。

## 做了什么

修复不改任何行为（输出逐字节不变；现有的快照与端到端测试不变）。每一项都在上面的数字里测过，没有测出收益的没有留下（见下一节）。

- **浏览路径不再加载只有失败或调用才要的代码**（原因 1）：
  - `client/credentials.ts` 里 `oauthNeedsHttp` 改成出错时才 `import('./errors')`；`InProcessBackend#listing` 的 `mapError` 只在 `catch` 里 `import('../client/errors')`；`ClientError` 类拆到只有 1 KB 的 `client/client-error.ts`（`errors.ts` 重新导出同一个类，`instanceof` 不变），`DaemonBackend` 从那里 import。
  - 凭证解析器：引用的语法（`parseCredentialRef`、`MIN_REDACTED_LITERAL_LENGTH`）拆到 `config/credential-ref.ts`，配置加载只依赖它；解析器本身（`config/credentials.ts`）由 `config/lazy-resolver.ts` 的 `createLazyCredentialResolver` 在第一次 `resolve()` 时才加载（`track()` 在加载前记下的秘密会交给真正的解析器，脱敏名单的顺序不变）；`browse-deps` 不再从 `config/index` 重新导出，而是按文件 import。解析器里的 `platform/command.ts` 与 `node:fs/promises` 也改成用到 `cmd:` / `file:` 时才加载。
  - `InProcessBackend#cursors()` 与 daemon 回退用的文件游标改成 `fileCursors()`：第一次 `put` / `get` 时才加载 `render/cursor-file.ts`。
  - `commands/provider.ts` 只在真的调用或显示工具用法时才 `import('./tool')`；`via <provider>` 与 `via <provider> <resource>` 不再加载调用流水线。`openProvider`、`splitToolRef`、`resolveToolRef` 搬到 `cli/open-provider.ts`，`batch` 和 `provider` 各自 import 它。
  - `toErrorInfo` 搬到 `cli/error-info.ts`，`App#report` 在失败时才 `import()`；`daemonDisabled` 由 `App#daemonOff` 提供。这样 `app.ts` 只被 `run` 动态 import，不再多一个转发分块；`daemon/client.ts` 重新导出 `daemonPaths`，`App#daemonClient` 少一次 `import()`。
  - 浏览命令加载的分块：`via` 42 → 33（265 → 221 KiB），`via github` 48 → 35（381 → 229 KiB），`via find` 42 → 33（266 → 222 KiB）。
- **预构建缓存按 provider 名分文件**（原因 2）：`catalog/<哈希>.<名字哈希>.view.json`（名字哈希是 provider 名的 `stringHash` 前 8 个十六进制字符）。早先的 `<哈希>.view.json` 不再读取，写新文件时顺手删除；`CatalogCache#clear` 删除这个 server 的全部预构建文件。[discovery.md](../../docs/spec/discovery.md#预构建缓存)已改。文件内容与有效性判断不变。
- **`dist/package.json`**（原因 3）：构建后写入 `{"type":"module"}`（`scripts/lib/dist-manifest.ts`，tsup 的 `onSuccess`）。`--version` 与 `-h` 的 6 个分块同样受益。
- `bench:perf` 加了 `--keep-sandbox`：不删除沙盒（HOME、配置、目录缓存；场景一节的框架与一千个工具沙盒也一样），打印路径，用来对着同一份缓存手工跟踪、剖析一条命令。

守护的测试（都不依赖时间）：`test/cli/dist.test.ts` 新增「缓存命中的浏览命令不加载只有调用、失败、凭证引用或游标才需要的模块」（`commands/tool`、`args/`、`render/pipeline`、`render/media`、`client/errors`、`client/elicit`、`config/credentials`、`platform/command`、`render/cursor-file` 一个都不能出现在 `via`、`via find`、`via gh`、`via gh issue` 加载的分块里，并先断言这些标记在包里确实存在，避免空转）与「`dist/` 有自己的 `package.json`」；`test/cli/view-cache.test.ts` 新增同一个 server 两个名字各有一份、清除时一并删除、早先的文件名被清理；`test/config/lazy-resolver.test.ts`（与真正的解析器结果一致、加载前 `track` 的秘密保留）；`test/client/unit.test.ts`（`ClientError` 是同一个类）。

## 试过没有留下的

| 做法 | 结果 |
| --- | --- |
| 把 `root`、`find`、`provider` 并成一个动态入口，减少 esbuild 的分块组合 | 分块数 34 → 35，没有减少：共享的小模块仍被 `run`、`app` 和别的命令同时引用 |
| 不分块，整个打成一个文件 | `via find` 变成约 +190 ms（要解析 4.4 MB，包括 MCP SDK 与 ajv） |
| `config/parse.ts` 只导入 `jsonc-parser` 的 `parse` 与 `smol-toml` 的 `parse`（小包装模块，分块各小约 25 KB 与 7 KB） | 能少加载一半的 JSONC 解析器，但 `test/bundle.test.ts` 断言单文件库打包里不静态 import 这两个包，包装模块会让它们变成静态导入；收益不到 1 ms，没有留下 |
| 快照还原里用对象字面量的 getter 代替每个工具一次 `Object.defineProperty` | 新进程里一千个工具的还原 + 索引 + 查询 24.45 → 24.34 ms，噪声内 |
| 把 JSON 体里的检索词改成词典编码 | 体少 35%，解析快 0.4 ms / 一千个工具，不值得改缓存格式 |
| V8 参数（命令行上，每个参数各用一份编译缓存目录）：`--always-sparkplug`、`--no-lazy-feedback-allocation`、`--min-semi-space-size=16`、`--max-lazy` | `--always-sparkplug` 慢 10 ms，`--min-semi-space-size=16` 慢 2 ms，`--max-lazy` 慢 6 ms，`--no-lazy-feedback-allocation` 快 2 ms（噪声内）；而且 `via` 的入口是 `#!/usr/bin/env node`，用户的命令行参数不由 via 决定 |
| 结束时直接 `process.exit(code)` | `via find` 没有变化 |

没有做、但估计有收益的：（a）**合并分块的后处理**：把 `run` 静态链上的小模块（`failure`、`exit-codes`、`render/errors`、`builtin`、`text`、`shell`、`options`、`builtins`）并进一个文件，估计浏览路径少 6–8 个文件、约 3–4 ms，但需要给分块之间的导入重写绑定，风险和工作量都不小，没有在这次做；（b）**热 daemon 路径提前建立连接**：在加载配置的同时开始 `connect` 与握手，估计少 2–3 ms，要改 `DaemonClient#connection` 的并发语义（一个已经在途的「不启动 daemon」的连接尝试不能吞掉后来要求启动 daemon 的请求）以及 `idleTimeout` 在配置读到之后才知道的问题；（c）只读原始缓存文件的头部（`fetchedAt`、`ttl`、`protocol`、`features`）与 `fstat` 的大小，而不是整个文件，估计一千个工具的整进程命令少 2–3 ms，要改 `rawBytes` 的含义（字符数改成字节数）和工具数组的延迟读取一致性。

## 没有达到的

- **`via find`（无 daemon）+49–58 ms，目标不超过 50。** 修复后比 v0.3.1 少 6 ms，余下的就是 `find` 自己的工作量：在冷进程里还原 180 个工具、建索引、查询、渲染，约 8 ms（上面的逐阶段），再加 33 个分块的加载。要再少 5 ms 需要上面的（a）或让索引更便宜（一千个工具上的还原 + 索引 + 首次查询是 23 ms，其中 JSON 体的解析约 4–6 ms、建倒排表约 4 ms、对象分配与垃圾回收其余）。
- **经热 daemon 的 `via find` +75–88 ms，`via` +68–75 ms，目标都是 < 70。** 这台机器上 v0.3.1 交替测得 +68 与 +80，也就是即使回到 0.3 这两项也达不到；修复后 +64 与 +71。热 daemon 路径比无 daemon 多：加载 `daemon/backend`、`daemon/client` 等 8 个分块加 `node:net`（单独测 `require('net')` 就是 3.5–4.5 ms，26 个内部模块，没法省）约 13 ms，连接加握手约 3 ms，列表请求往返约 2 ms。（b）估计能省 2–3 ms，不够。
- **一千个工具、50 个 provider 的整进程 `via find` +85–101 ms，目标不超过 80。** 修复后比修复前和 v0.3.1 快约 5 ms（交替测 85.8 对 90.7 与 90.3）。逐阶段：配置与依赖 +12，`loadProviders` +22（50 个 server 各一次 `sha256` 的缓存键、两个文件读取、两次 JSON 解析、还原），索引加查询 +21。库路径单独是 23 ms（达到）；差的是 50 个 provider 的逐个开销，只有（c）这一类改动或常驻的 daemon 索引能动它。
- **`via github` 在线上（44–60 ms）**，`via find`、热 daemon 两项上面已说。

这些数字的噪声：同一个构建在六次运行里 `via find` 是 49–58。上面的「达到」「在线上」是按分布判的；在更安静的机器上（或者本机的噪声小下来时）`via` / `via github` 会稳定在线内，`via find` 在线上。

## 1. 冷启动（修复后第六次运行，缓存热的行，ms）

| 命令 | 中位数 | p95 | 最小 | 同轮 `node -e 0` | 比 `node -e 0` 多 | 目标（不超过 +50） |
| --- | --- | --- | --- | --- | --- | --- |
| `--version` | 48.0 | 60.0 | 42.3 | 39.6 | 8.38 | 无目标 |
| `-h` | 46.5 | 67.2 | 41.8 | 40.7 | 5.86 | 无目标 |
| `via` | 85.1 | 110.4 | 73.3 | 39.5 | 45.6 | 达到 |
| `via github` | 90.4 | 109.3 | 76.9 | 42.4 | 48.0 | 达到 |
| `via find` | 85.2 | 110.3 | 79.3 | 36.0 | 49.2 | 达到 |
| `via doctor`（实时探测，不在目标内） | 448.6 | 487.8 | 381.4 | 44.2 | 404.4 | 无目标 |

无编译缓存与缓存冷（每次新目录）的行也测了：`via` +61.4 / +61.4，`via find` +63.3 / +64.0；`NODE_COMPILE_CACHE` 环境变量下 `--version` / `-h` 为 +10.9 / +10.7。目标只针对缓存热的行（脚本输出里有全部的行）。

## 1b. 更接近真实使用的场景（修复后第六次运行，交替运行，ms）

| 场景 | 命令 | 中位数 | p95 | 最小 | 同轮 `node -e 0` | 比 `node -e 0` 多 | 目标 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 8 个 provider，热 daemon | `via` | 110.3 | 141.5 | 89.0 | 38.7 | 71.6 | < 70，未达到 |
| | `via github` | 112.3 | 156.7 | 93.2 | 40.6 | 71.7 | 无目标 |
| | `via find` | 112.0 | 130.6 | 96.7 | 37.5 | 74.6 | < 70，未达到 |
| 框架配置（12 个 provider · 329 个工具，4 个配置文件，含 71 KiB `.claude.json`） | `via` | 97.8 | 124.2 | 84.3 | 38.7 | 59.1 | < 80，达到 |
| | `via find` | 110.7 | 145.5 | 94.1 | 37.9 | 72.8 | < 80，达到 |
| 1,000 个工具 / 50 个 provider | `via` | 97.4 | 132.5 | 84.9 | 37.5 | 59.9 | 无目标 |
| | `via find`（整进程） | 137.9 | 168.4 | 115.6 | 42.3 | 95.6 | 不超过 80，未达到 |
| | `via <provider>` | 87.5 | 111.4 | 74.2 | 40.2 | 47.4 | 无目标 |

## 2. 一千个工具上的 `find`（库调用，新进程里的首次调用，修复后第六次运行，ms）

| 阶段 | 中位数 | p95 | 最小 |
| --- | --- | --- | --- |
| 构建 + 索引 + 首次查询（无预构建缓存，一次性 CLI；参考，无目标） | 57.8 | 86.2 | 48.3 |
| 预构建缓存：还原快照 | 0.53 | 0.90 | 0.44 |
| 预构建缓存：由存下的检索词建索引（含还原工具） | 18.6 | 25.8 | 17.0 |
| 预构建缓存：首次查询 | 3.78 | 6.34 | 3.56 |
| **预构建缓存：还原 + 索引 + 首次查询（一次性 CLI），目标 < 30** | **22.9** | 32.7 | 21.3 |
| 常驻索引上的查询（稳态；参考，无目标） | 0.50 | 0.64 | 0.40 |

这一节没有被这次的改动触及（库路径本身没变）。

## 4. 每条命令加载的模块（修复后）

不变：`--version` 与 `-h` 不加载任何库；`via`、`via github`、`via find` 不加载 MCP SDK 与 ajv，也不初始化 `crypto`、`net`、`tty`、`stream`、`fs/promises`、`readline`、`child_process`。

| 命令 | 分块数 | KiB | 修复前（分块数 / KiB） |
| --- | --- | --- | --- |
| `--version` / `-h` | 6 | 18 | 6 / 18 |
| `via` | 33 | 221 | 42 / 265 |
| `via github` | 35 | 229 | 48 / 381 |
| `via find` | 33 | 222 | 42 / 266 |
| `via doctor` | 56 | 1560 | 56 / 1564 |
| `via gh echo_text` | 68 | 1706 | 68 / 1718 |

Node 内部模块数 79（`via`、`via github`、`via find`），与修复前相同。

## 5. 热 daemon（修复后第六次运行）

热 daemon 上一次调用比复用连接的 SDK 调用多 7.00 ms（六次运行 5.6–7.2，目标 < 15）。

| daemon 常驻内存 | RSS MiB | RssAnon MiB | RssFile MiB | 目标（RssAnon < 55） |
| --- | --- | --- | --- | --- |
| 刚启动 | 58.9 | 13.8 | 45.4 | 达到 |
| 一个 HTTP 会话与一次调用之后 | 89.8 | 40.8 | 49.3 | 达到 |
| 再加一个 stdio 会话与一次调用之后 | 90.9 | 42.0 | 49.4 | 达到 |
| 再 109 次调用之后 | 93.3 | 44.2 | 49.5 | 达到 |

RssAnon 的最高值六次运行里是 37.4–44.2 MiB（修复前 37.5–46.8），阈值 55 的理由不变，见 [testing.md](../../docs/development/testing.md#性能目标)。

没有 `/proc/<pid>/status` 的平台（macOS）上脚本退回到 RSS，输出里标明是 RSS，阈值是 RssAnon 的阈值加 node 可执行文件的约 49 MiB 文件页，即 105 MiB。这个数字没有在 macOS 上测过。

## 脚本

[`scripts/bench-perf.ts`](../../scripts/bench-perf.ts) 这次只加了 `--keep-sandbox`（见上）；其余同 0.4 的第一次复测：每一行冷启动与 `node -e 0` 交替运行并打印同轮的基线与差值，目标判定相对，`find` 的目标只判定库路径一行，daemon 内存读 RssAnon，环境信息里有开始与结尾的平均负载。时间只报告、不断言，所以未达到的项不会让脚本以非零退出码结束；非零退出码仍然只来自模块加载约束。
