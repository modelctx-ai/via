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

对一组真实 server（github、playwright、linear、notion 等）计算并持续跟踪：

- **原生注入成本**：框架挂载这些 server 时每轮注入的 schema token；
- **via 成本**：`via prompt` 说明 + 完成一组典型任务时发现与调用产生的 token；
- **同类 CLI 成本**：用 [mcp2cli](https://github.com/knowsuchagency/mcp2cli) 的 skill 加 `--list`/`--search` 完成同一组任务的 token，作为平铺命名、不去噪输出的对照。

这是项目的核心指标，结果随版本记录。

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

### 性能基准

```bash
npm run build        # 基准测量的是 dist/，先打包
npm run bench:perf   # 加 --quick 缩短运行，--runs <n> / --warmup <n> 调整次数，--skip-bun 跳过 Bun
```

`scripts/bench-perf.ts` 在隔离的 HOME 与 TMPDIR 里运行（不读取任何真实的框架配置），每项预热后取多次的中位数、p95 与最小值，并对照上表：

- **冷启动**：`node dist/via.js` 的 `--version`、`-h`、`via`、`via <provider>`、`via find`、`via doctor`，从进程创建到退出；各自在无编译缓存、缓存冷（每次新目录）、缓存热三种状态下测量，并减去 `node -e 0` 的基线，得到 via 自己的耗时。浏览类命令使用 8 个真实 `tools/list` 快照写入磁盘缓存后的目录；`doctor` 会实时探测 server，所以对着运行中的本地 server 测。
- **1,000 个工具上的 `find`**：用 `scripts/lib/synth-catalog.ts` 从夹具确定性地合成 1,000 个工具（固定种子，同一输入在任何机器上得到同一份目录），分别计时目录构建、索引构建、查询和渲染。新进程里的首次调用对应一次性的 CLI，稳态对应将来常驻的 daemon。
- **调用开销**：对本地 Streamable HTTP 模拟 server，比较 `via <provider> <tool>` 端到端与官方 SDK client 直接调用（进程内与整进程两个口径）。0.1 没有 daemon，「经热 daemon 调用的额外开销」一项只作参照。
- **模块加载**：用 `scripts/lib/load-trace.mjs`（`node --import` 的加载钩子）记录每条命令加载了哪些打包分块和 `node_modules` 包；`--version` 与 `-h` 不得加载任何包，命中缓存的浏览命令不得加载 MCP SDK 和 ajv，违反时脚本以非零退出码结束。`test/cli/dist.test.ts` 对同样的约束做了不依赖时间的断言。
- **Bun**：已安装 `bun` 时，另测 `bun build --compile` 的单文件可执行与 `bun dist/via.js` 的冷启动，用来回答[运行时与分发](../open-questions.md)这个开放问题；未安装则跳过并说明。

性能数字不进 vitest 断言（CI 机器噪声太大）；测试只覆盖确定性的部分：合成目录的生成、`find` 在其上的结果、加载约束。0.1 的实测结果、环境和校准建议记录在 [bench/results/perf-0.1.md](../../bench/results/perf-0.1.md)。
