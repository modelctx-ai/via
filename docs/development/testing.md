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

### 跨平台约定

- 路径、环境变量、引号、`PATHEXT` 等逻辑用注入的 `platform: 'win32'` 在所有宿主上测试（`test/config/paths.test.ts`、`test/platform/`、`test/daemon/paths.test.ts`），不要求在 Windows 上才能跑；守护进程的「按令牌派生的端点」流程用手工构造的 `derived` 路径集在 unix socket 上同样跑一遍（`test/daemon/protocol.test.ts`）。
- 只在 POSIX 上有意义的测试（模式位、`chmod 000`、符号链接、unix socket 文件、`pgrep`）用 `it.skipIf(process.platform === 'win32')`，并在注释里写明原因，不要静默跳过。
- 需要启动 Node 夹具时用 `process.execPath` 加脚本路径，不依赖 shebang 或 `.bin` 下的可执行文件；`--import` 的路径传 `pathToFileURL(...).href`；沙箱的子进程环境用 `test/cli/helpers.ts` 的 `homeEnv` / `SYSTEM_ENV`（Windows 上的子进程需要 `SystemRoot`，用户目录来自 `USERPROFILE` / `APPDATA` 而不是 `HOME` / `XDG_*`）。
- Windows 上的 daemon 端到端测试用各沙箱独有的 `LOCALAPPDATA` 和 `USERNAME`，使管道和令牌文件互不干扰。

### 持续集成

`.github/workflows/ci.yml` 在每个 PR 和 `main` 的推送上运行：

- Node 22、24 上执行 `npm ci`、`npm run typecheck`、`npm run build`、`npm test`（含快照、拆分基线、词典是否最新、凭证扫描）；
- `windows-latest`（Node 22）上执行同样四步，再用空的用户目录运行 `dist/via.js`（`--version`、浏览、`doctor`、`daemon status`）；
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
- **token 估算**：4 字节约 1 token，与 `via doctor` 用的是同一个常量（`BYTES_PER_TOKEN`）。可复现起见，元信息行的耗时、端口、沙箱路径归一为常量。可选的精确计数（调用 token 计数接口）0.1 没有做；agent 评测直接使用 API 返回的 `usage`。
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

同一组任务分别让模型用原生 MCP、mcp2cli 和 via 完成，比较：

- 任务成功率；
- 总 token（取自 API 返回的 `usage`，输入含缓存读写）；
- 模型轮数、工具调用数与错误调用次数。

这是验证「MCP 做提供方、CLI 做消费方」这一判断的关键证据，也是 0.1 → 0.2 的门槛（[路线图](../roadmap.md)）。与 mcp2cli 的对比单独验证 via 自己的设计：`resource:verb` 拆分、分域浏览和紧凑渲染相对于平铺的原始工具名和原样 JSON，是否减少了错误调用和发现轮数。拆分出错时模型可能更难找到工具，这一项要单独统计（逐任务的成功次数和未成功运行的检查明细就是为此保留的）。0.1 没有 daemon，stdio server 每次调用都会重新拉起，评测以 HTTP 回放 server 为主，避免启动延迟干扰结论。

### 怎么跑

```console
$ npm run build
$ export ANTHROPIC_API_KEY=...                      # 也支持 ANTHROPIC_BASE_URL
$ npm run bench:eval -- --trials 10                 # 写 bench/results/eval-<日期>.md 与 .json
$ npm run bench:eval -- --fake-model                # 不需要密钥：只验证流水线，不衡量任何模型
```

没有密钥时 `bench:eval` 给出说明并以退出码 2 结束。选项（`--trials`、`--task`、`--condition`、`--model`、`--max-turns`、`--concurrency`、`--out` 等）、三种条件的工具与系统提示、每次运行的记录项见 [bench/README.md](../../bench/README.md#agent-评测)。模型默认值在 `bench/eval/anthropic.ts`，用 `--model` 换；结论只对评测所用的模型成立，换模型要重跑。`@anthropic-ai/sdk` 是 devDependency，via 本身不依赖它。

### 对比什么

三个条件使用同一批回放 server（与 token 基准相同的合成录制）、同一份任务描述和同一段系统提示骨架，只有各自的工具和说明文本不同：

| 条件 | 模型看到什么 | 模型能做什么 |
| --- | --- | --- |
| native | 全部挂载 server 的工具定义，原样（167 个工具） | 直接调用 MCP 工具，调用转发给回放 server |
| via | `via prompt` 的输出 | 一个 `shell` 工具，只能运行 `via …`（不经真实 shell） |
| mcp2cli | mcp2cli 自带 skill 原文加 server 别名 | 一个 `shell` 工具，只能运行 `mcp2cli …` |

mcp2cli 不在 PATH 上时这一条件跳过并在输出里说明，不伪造数字。

### 怎么判定成功

确定性的，只看回放 server 收到的调用日志，不调用模型打分，也不信模型自己说「做完了」。每个任务文件有 `success` 块：

- **必需调用**：工具加参数子集，且被回放 server 回答了（命中某个录制的返回值）才算；写操作可以限制最多几次，防止重复执行；
- **禁止调用**：不论是否被回答，企图对错误的对象做写操作就算违规（例如评论了别的 issue、用了测试环境的账号）；
- **最终回答**：只读任务（找代码、总结 PR、列 DNS 记录）另查回答里是否提到关键事实，否则「读了数据但什么也没说」也会算成功。

标准只看结果，不要求模型走脚本里的路径：并列的合理选择（两个同样紧急的 issue、优先级 1 或 2、团队名或键或 ID）都放行。判定标准本身有测试：每个任务自带的原生调用序列必须满足它。模型没有自己停下（用完轮数、回复被截断、被拒绝、API 出错）的运行一律不算成功。

| 任务 | 成功的条件（摘要） |
| --- | --- |
| github-triage-bugs | 列出 acme/api 的 OPEN 且带 bug 标签的 issue；读 #214；在 #214 评论一次，内容提到日志（log）和 Redis；不评论别的 issue、不改 issue |
| github-find-code | 搜 `RateLimiter`；读 `src/middleware/rate_limiter.ts`；回答里提到这个路径 |
| github-pr-summary | 对 PR #482 取 `get`、`get_files`、`get_reviews` 三种读取；回答提到标题里的 per-tenant、改动的文件和「changes requested」 |
| linear-create-issue | 创建一次 issue：标题含 rate limiter，团队 Platform（名、键或 ID），描述提到 Redis，优先级 1 或 2，指派给我 |
| linear-my-work | 列出进行中的 issue；读并列最紧急的 PLT-300 或 PLT-328；把它设为 Done 一次；不改别的 issue |
| notion-update-doc | 搜 roadmap；读 Q3 Roadmap 页面；对这个页面更新一次，新增内容提到 per-tenant 限制和 public API docs |
| playwright-docs-search | 打开 docs.acme.test；在搜索框（`e8`）输入 `rate limit`；点击 `Rate limits` 结果（`e73`） |
| cloudflare-dns-records | 用生产账号（Acme Production）执行包含 DNS 的代码；不用测试账号；回答列出记录（含 `203.0.113.10`、`docs.acme.test`、`status.acme.test`） |
| cross-issue-to-pr | 读 PLT-300；在它下面评论一次，只含修复它的 PR #487 的编号，不含 #482、#455 |

回放 server 对承载身份的参数按参数区分（读或改录制里没有的 issue 会失败），所以走错对象的模型会在运行里看到一次普通的工具失败，并计入错误调用。

### 门槛 1 比较什么

门槛 1 要求 via 的任务成功率**不低于**原生 MCP，**且不低于** mcp2cli。`bench:eval` 在汇总后打印这个判断：逐条件的成功次数 / 运行次数、点估计的比较，以及 95% Wilson 区间是否重叠。区间重叠时不要把差异当结论：增加 `--trials`，或看逐任务的成功次数和未成功运行的检查明细，判断是模型随机性还是 via 的某个设计（拆分、分域、渲染）确实让模型找不到工具。mcp2cli 缺失时比较标为不完整，不算门槛通过。token、轮数与错误调用不是门槛条件，但随结果一起记录：token 基准说明「几乎不占上下文」，这里说明「省下的上下文有没有换来更多弯路」。

### 局限

- 返回值是合成的，且同一工具的返回值基本不随参数变化；它检验模型能否找到并正确调用工具，不检验真实 server 的行为差异。
- 评测对象是「模型加说明文本加工具」整体，三个条件的说明文本篇幅和风格天然不同（native 没有文字说明，mcp2cli 是一份通用 skill，via 是一段为它写的短说明）；这正是被比较的东西，但意味着结论包含了提示的差异。
- 模型有随机性、API 会变；每份结果记录模型、日期、effort 和次数，只对那一次成立。
- `--fake-model` 的输出不是结果（见 bench/README.md），不会写入 `bench/results/`。

## 性能目标

以下是初始目标，在 0.1 的基准测试中校准（实测、环境和校准建议见 [bench/results/perf-0.1.md](../../bench/results/perf-0.1.md)，目标本身尚未改动）：

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
npm run bench:perf   # 加 --quick 缩短运行，--runs <n> / --warmup <n> 调整次数，--skip-bun 跳过 Bun，--dist <目录> 测另一份构建（用来对比改动前后）
```

`scripts/bench-perf.ts` 在隔离的 HOME 与 TMPDIR 里运行（不读取任何真实的框架配置）；除热 daemon 一节外都设 `VIA_NO_DAEMON=1`，保证各项可比。每项预热后取多次的中位数、p95 与最小值，并对照上表：

- **冷启动**：`node dist/via.js` 的 `--version`、`-h`、`via`、`via <provider>`、`via find`、`via doctor`，从进程创建到退出；各自在无编译缓存、缓存冷（每次新目录）、缓存热三种状态下测量，并减去 `node -e 0` 的基线，得到 via 自己的耗时。浏览类命令使用 8 个真实 `tools/list` 快照写入磁盘缓存后的目录；`doctor` 会实时探测 server，所以对着运行中的本地 server 测。
- **1,000 个工具上的 `find`**：用 `scripts/lib/synth-catalog.ts` 从夹具确定性地合成 1,000 个工具（固定种子，同一输入在任何机器上得到同一份目录），分别计时目录构建、索引构建、查询和渲染。新进程里的首次调用对应一次性的 CLI，稳态对应将来常驻的 daemon。
- **调用开销（无 daemon）**：对本地 Streamable HTTP 模拟 server，比较 `via <provider> <tool>` 端到端与官方 SDK client 直接调用（进程内与整进程两个口径）。
- **热 daemon**：同一个 server 加一个 stdio server，另起 `via daemon run`，测 `via` 经热 daemon 调用的耗时，对照无 daemon 的 `via` 与复用连接的 SDK 调用（目标里的「额外开销」取前者减后者），并读 `via daemon status` 的 RSS：刚启动、建立一个 HTTP 会话后、再建立一个 stdio 会话后、多次调用后。脚本结束时执行 `via daemon stop`，不留下 daemon。
- **模块加载**：用 `scripts/lib/load-trace.mjs`（`node --import` 的加载钩子）记录每条命令加载了哪些打包分块和 `node_modules` 包；`--version` 与 `-h` 不得加载任何包，命中缓存的浏览命令不得加载 MCP SDK 和 ajv，违反时脚本以非零退出码结束。`test/cli/dist.test.ts` 对同样的约束做了不依赖时间的断言。
- **Bun**：已安装 `bun` 时，另测 `bun build --compile` 的单文件可执行与 `bun dist/via.js` 的冷启动，用来回答[运行时与分发](../open-questions.md)这个开放问题；未安装则跳过并说明。

性能数字不进 vitest 断言（CI 机器噪声太大）；测试只覆盖确定性的部分：合成目录的生成、`find` 在其上的结果、加载约束。0.1 的实测结果、环境和校准建议记录在 [bench/results/perf-0.1.md](../../bench/results/perf-0.1.md)。
