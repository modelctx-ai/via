# 测试与评测

## 测试分层

| 层 | 内容 | 方式 |
| --- | --- | --- |
| 拆分与分域 | 真实 server 的 `tools/list` 快照 → 规范写法、域 | 快照测试；规则变更时输出差异 |
| 渲染 | 每种输出形状（表格、对象、文本、截断、媒体、错误） | vitest 快照，规则的任何变化在评审中显式可见 |
| 参数解析 | schema → 命令行参数的各条规则，含 anyOf 补齐、`@文件`、重名 | 单元测试 |
| 配置 | 每个框架的真实配置样例、合并顺序、凭证引用、信任 | fixture 测试 |
| 端到端 | 模拟 MCP server + CLI 全链路，含 daemon 与进程内模式 | 集成测试 |

### 模拟 server

用官方 SDK 的 server 端写一组测试 server，覆盖：

- 大目录（500 个工具）；
- structuredContent、`isError`、超长输出、图片等媒体内容；
- OAuth（含动态客户端注册与刷新）；
- `list_changed` 通知；
- 慢响应与超时、progress 通知；
- 带 `destructiveHint` / `readOnlyHint` 的工具。

### 安全相关测试

- 所有快照中不得出现测试凭证值，CI 中对快照做凭证值扫描。
- 项目级配置未信任时 stdio 命令不得执行。

### 持续集成

`.github/workflows/ci.yml` 在每个 PR 和 `main` 的推送上运行：

- Node 22、24 上执行 `npm ci`、`npm run typecheck`、`npm run build`、`npm test`（含快照、拆分基线、词典是否最新、凭证扫描）；
- 开发工具链（vitest、tsup）需要 Node 22.12+，而发布产物声明支持 Node 20：在 22 上打包后，换到 Node 20 用空的 HOME 运行 `dist/via.js`（`--version`、`via`、`via doctor`，覆盖懒加载的 chunk）。

## token 基准

对一组 server（github、linear、notion、playwright、cloudflare，共 167 个工具）和九个典型任务，计算并持续跟踪：

- **原生注入成本**：框架挂载这些 server 时，每轮注入的工具定义（名称、描述、`inputSchema`，按 `mcp__<server>__<工具>` 的命名序列化）乘以任务需要的轮数，加上模型写出的调用和未渲染的原始结果；
- **via 成本**：`via prompt` 说明（一次）加任务的命令序列：命令文本，以及它打印到 stdout 和 stderr 的全部内容；
- **同类 CLI 成本**：用 [mcp2cli](https://github.com/knowsuchagency/mcp2cli) 的 skill（一次）加 `--list`/`--search`、`--help` 和调用完成同一组任务，作为平铺命名、不去噪输出的对照。

这是项目的核心指标，结果随版本记录。

### 怎么跑

```console
$ npm run build
$ npm run bench:tokens                                            # 打印表格
$ npm run bench:tokens -- --out bench/results/0.1 --release 0.1   # 同时写 markdown 与 JSON
```

全程离线、可复现：任务在 `bench/tasks/`，返回值是 `bench/recordings/` 里的合成数据，由回放 MCP server（`bench/replay-server.mjs`，Streamable HTTP）提供；via 与 mcp2cli 在临时 HOME 里运行，配置只含这些回放 server，不读开发者自己的框架配置。任务文件格式、回放 server 的接口和新增任务的方法见 [bench/README.md](../../bench/README.md)；回放 server 与任务文件也是下面 agent 评测的共用基础。

### 方法

- **via 一列是真实运行**：脚本跑的是打包后的 `dist/via.js`，命令序列是人按「合理的 agent 路径」写的（从 `via <provider>` 或 `via find` 开始，签名足够时不加 `-h`）。mcp2cli 同理，工具不超过 25 个的 server 用 `--list`，更大的用 `--search`，每条要用的命令先看 `--help`。
- **做同样的事**：每个任务有一份原生调用序列和一份回放用的返回值。测量时核对回放 server 的调用日志，via 与 mcp2cli 发出的 `tools/call` 必须与原生的工具名、参数完全一致，否则报错。
- **原生一列也经过回放 server**：用官方 SDK 的 client 取 `tools/list` 和 `tools/call`，不手算。
- **token 估算**：4 字节约 1 token，与 `via doctor` 用的是同一个常量（`BYTES_PER_TOKEN`）。可复现起见，元信息行的耗时、端口、沙箱路径归一为常量。可选的精确计数（调用 token 计数接口）0.1 没有做，留给 agent 评测。
- **mcp2cli 是可选的一列**：PATH 上有 `mcp2cli` 才运行，并记录版本；没有就在输出里说明已跳过，不伪造数字。说明文本取自它自带的 skill（`bench/vendor/mcp2cli/`，MIT）。

### 结果随版本记录

每个版本把结果写到 `bench/results/<版本>.md`（含逐任务、逐命令明细和文末的局限说明）和同名 `.json`。0.1 的结果见 [bench/results/0.1.md](../../bench/results/0.1.md)，摘要：

| | native | via | mcp2cli |
| --- | ---: | ---: | ---: |
| 九个任务合计（token，估算） | 382,379 | 14,210 | 59,834 |
| 相对 native | 100% | 4% | 16% |
| 去掉 native 的工具注入后 | 15,813 | 14,210 | 59,834 |

读这些数字时要注意（完整说明在结果文件里）：

- 节省几乎全部来自**不注入工具定义**：native 总量的 96% 是每轮重复的注入。把注入去掉（相当于框架对工具定义做了延迟加载），native 只剩调用和原始结果，与 via 的整个会话（含说明和发现）在同一量级。在这类框架上，via 的价值要看成功率和发现轮数，不能靠 token 总量证明。文本型结果（源码、页面快照）via 原样输出，没有节省。
- 夹具是部分合成的：工具名取自真实 server，但描述和参数已精简，native 的注入成本是**偏低**估计；`tools/call` 的返回值按常见 API 形状合成，via 在结果侧的节省取决于 server 的 JSON 有多冗余。
- 命令序列是脚本，不是模型的实际行为，所以这里没有成功率、错误调用和发现轮数；这些由 agent 评测验证。
- 4 字节约 1 token 只是量级估计，比较的是比例，不是计费。

## agent 评测

同一组任务分别让 agent 用原生 MCP、mcp2cli 和 via 完成，比较：

- 总 token；
- 任务成功率；
- 工具调用轮数与错误调用次数。

这是验证「MCP 做提供方、CLI 做消费方」这一判断的关键证据，也是 0.1 → 0.2 的门槛（[路线图](../roadmap.md)）。与 mcp2cli 的对比单独验证 via 自己的设计：`resource:verb` 拆分、分域浏览和紧凑渲染相对于平铺的原始工具名和原样 JSON，是否减少了错误调用和发现轮数。拆分出错时模型可能更难找到工具，这一项要单独统计。0.1 没有 daemon，stdio server 每次调用都会重新拉起，评测应以 HTTP server 为主，避免启动延迟干扰结论。

## 性能目标

以下是初始目标，在 0.1 的基准测试中校准：

| 指标 | 目标 |
| --- | --- |
| CLI 冷启动（Node 22，单文件 + 编译缓存） | < 80 ms |
| 经热 daemon 调用的额外开销 | < 15 ms |
| 1,000 个工具上的 `find` | < 30 ms |
| daemon 常驻内存 | < 80 MB（不含 stdio 子进程） |

0.2 的实测（Linux，Node 22，一个 stdio server）：热 daemon 上一次请求的往返约 0.3 ms（`status`、`validate`）到 1 ms（`list`、`call`），连接加握手约 2–6 ms，一次调用（`list`、两次校验、`call`）合计远低于 15 ms 的目标；daemon 空闲时约 58 MB，建立一个会话并加载 MCP SDK 与 ajv 后约 79–86 MB，在 80 MB 目标附近，尚未优化。CLI 自身的冷启动（约 130 ms 加载命令、配置与目录）与是否使用 daemon 无关。

### 性能基准

```bash
npm run build        # 基准测量的是 dist/，先打包
npm run bench:perf   # 加 --quick 缩短运行，--runs <n> / --warmup <n> 调整次数，--skip-bun 跳过 Bun
```

`scripts/bench-perf.ts` 在隔离的 HOME 与 TMPDIR 里运行（不读取任何真实的框架配置）；除热 daemon 一节外都设 `VIA_NO_DAEMON=1`，保证各项可比。每项预热后取多次的中位数、p95 与最小值，并对照上表：

- **冷启动**：`node dist/via.js` 的 `--version`、`-h`、`via`、`via <provider>`、`via find`、`via doctor`，从进程创建到退出；各自在无编译缓存、缓存冷（每次新目录）、缓存热三种状态下测量，并减去 `node -e 0` 的基线，得到 via 自己的耗时。浏览类命令使用 8 个真实 `tools/list` 快照写入磁盘缓存后的目录；`doctor` 会实时探测 server，所以对着运行中的本地 server 测。
- **1,000 个工具上的 `find`**：用 `scripts/lib/synth-catalog.ts` 从夹具确定性地合成 1,000 个工具（固定种子，同一输入在任何机器上得到同一份目录），分别计时目录构建、索引构建、查询和渲染。新进程里的首次调用对应一次性的 CLI，稳态对应将来常驻的 daemon。
- **调用开销（无 daemon）**：对本地 Streamable HTTP 模拟 server，比较 `via <provider> <tool>` 端到端与官方 SDK client 直接调用（进程内与整进程两个口径）。
- **热 daemon**：同一个 server 加一个 stdio server，另起 `via daemon run`，测 `via` 经热 daemon 调用的耗时，对照无 daemon 的 `via` 与复用连接的 SDK 调用（目标里的「额外开销」取前者减后者），并读 `via daemon status` 的 RSS：刚启动、建立一个 HTTP 会话后、再建立一个 stdio 会话后、多次调用后。脚本结束时执行 `via daemon stop`，不留下 daemon。
- **模块加载**：用 `scripts/lib/load-trace.mjs`（`node --import` 的加载钩子）记录每条命令加载了哪些打包分块和 `node_modules` 包；`--version` 与 `-h` 不得加载任何包，命中缓存的浏览命令不得加载 MCP SDK 和 ajv，违反时脚本以非零退出码结束。`test/cli/dist.test.ts` 对同样的约束做了不依赖时间的断言。
- **Bun**：已安装 `bun` 时，另测 `bun build --compile` 的单文件可执行与 `bun dist/via.js` 的冷启动，用来回答[运行时与分发](../open-questions.md)这个开放问题；未安装则跳过并说明。

性能数字不进 vitest 断言（CI 机器噪声太大）；测试只覆盖确定性的部分：合成目录的生成、`find` 在其上的结果、加载约束。0.1 的实测结果、环境和校准建议记录在 [bench/results/perf-0.1.md](../../bench/results/perf-0.1.md)。
