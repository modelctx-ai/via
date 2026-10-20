# bench：token 基准的任务集与回放 server

比较同一组任务在三种方式下放进模型上下文的 token：原生 MCP 注入、`via`、[mcp2cli](https://github.com/knowsuchagency/mcp2cli)。方法与口径见 [测试与评测](../docs/development/testing.md#token-基准)，0.1 的结果在 [results/0.1.md](results/0.1.md)。

任务文件与回放 server 是通用的，不绑定基准：之后的 agent 评测（让模型在原生 MCP、mcp2cli、via 三种环境里完成同一批任务）直接复用它们。

## 目录

| 路径 | 内容 |
| --- | --- |
| `suite.yaml` | 挂载哪些 server、跑哪些任务、mcp2cli 对照的版本 |
| `tasks/<id>.yaml` | 一个任务：目标、原生调用序列、回放用的返回值、via 与 mcp2cli 的命令序列 |
| `recordings/<任务>/` | 任务里 `resultFile` / `textFile` 引用的返回值（合成数据，见下） |
| `replay-server.mjs` | 回放 MCP server（官方 SDK 的 server 端，纯 ESM，无需构建） |
| `schema/` | `suite.yaml` 与任务文件的 JSON Schema（draft-07） |
| `harness/` | 基准的实现：加载与校验、沙箱、原生与命令序列的测量、报告 |
| `vendor/mcp2cli/` | mcp2cli 的 skill 原文（对照一列的「说明文本」），附来源与许可 |
| `results/` | 各版本的结果（`<版本>.md`、`<版本>.json`） |

脚本入口是 `scripts/bench-tokens.ts`。

## 运行

```console
$ npm run build
$ npm run bench:tokens                      # 打印表格
$ npm run bench:tokens -- --out bench/results/0.1 --release 0.1   # 同时写 .md 与 .json
$ npm run bench:tokens -- --task triage --show --no-mcp2cli       # 只跑一个任务并打印每条命令的输出
```

选项：

| 选项 | 说明 |
| --- | --- |
| `--task <文本>` | 只跑 id 含该文本的任务，可重复 |
| `--via <路径>` | 被测的 CLI，默认 `dist/via.js`（必须先 `npm run build`） |
| `--mcp2cli <路径>` | mcp2cli 可执行文件，默认取 PATH 上的 `mcp2cli` |
| `--no-mcp2cli` | 不跑 mcp2cli 一列 |
| `--show` | 把每条命令和它的输出打到 stderr，写任务时用 |
| `--out <前缀>` | 写 `<前缀>.md` 和 `<前缀>.json` |
| `--release <标签>` | markdown 标题里的版本标签，默认 `dev` |

全程离线：回放 server 监听本机端口，via 与 mcp2cli 用临时 HOME 里生成的配置（`sources: false`，只有这些 server），不会读开发者自己的框架配置、凭证或缓存。

### mcp2cli 一列

脚本启动时执行 `mcp2cli --version`。能运行才会有这一列，并记录实际版本；找不到时打印原因并跳过，不伪造数字。安装方式：

```console
$ uv tool install mcp2cli==3.8.0      # 版本见 suite.yaml
```

对照一列用 mcp2cli 的 `bake` 为每个 server 建一个别名（`@github`、`@linear` ……，属于一次性配置，不计入），命令里用别名；说明文本是 `vendor/mcp2cli/SKILL.md` 加一行告诉 agent 有哪些别名（`Servers: @github @linear …`，对应 `via prompt` 里的 Providers 一行）。

## suite.yaml

```yaml
version: 1
fixtures: test/fixtures/tools      # 每个 server 的 tools/list，文件名即 provider 名
mounted: [github, linear, notion, playwright, cloudflare]   # 每一列都挂载的 server
tasks: [github-triage-bugs, ...]   # tasks/<id>.yaml，按此顺序汇报
mcp2cli: { skill: bench/vendor/mcp2cli/SKILL.md, version: 3.8.0 }
```

`mounted` 是三种方式共同的前提：原生每轮注入全部 server 的工具定义，via 与 mcp2cli 都配置了全部 server，任务只用到其中一部分。

## 任务文件

```yaml
id: github-triage-bugs            # 与文件名一致
title: Triage the oldest open bug
goal: >                            # 自然语言目标，给人读，也是 agent 评测给模型的任务描述
  In acme/api, list the open issues ...
servers: [github]                  # 任务用到的 server，必须在 mounted 里

native:                            # 原生 MCP 的 agent 会做的调用
  rounds:                          # 一轮 = 一批并行调用；轮之间有先后依赖
    - - { server: github, tool: list_issues, args: { owner: acme, repo: api, ... } }
    - - { server: github, tool: issue_read, args: { ... } }

calls:                             # 回放 server 的返回值，三种方式共用
  - { server: github, tool: list_issues, resultFile: recordings/github-triage-bugs/list_issues.json }

via:                               # via 的命令序列，每条是一轮
  - run: via github issue
  - run: via github issue:list --owner acme --repo api --labels bug
  - run: via more {cursor}         # {cursor} 取前面某条输出里最后一个 `via more <游标>`
    # exit: 3                      # 预期退出码，默认 0

mcp2cli:                           # 同样的任务用 mcp2cli 完成（可省略）
  - run: mcp2cli @github --search issue
```

规则：

- `run` 是一行命令，按 POSIX 风格切词（单引号、双引号、反斜杠），**不经过 shell**：切出的词直接作为 `via` 或 `mcp2cli` 的 argv，所以第一个词必须是 `via` / `mcp2cli`。YAML 里命令含 `: ` 时用 `>-` 折叠写法。
- `native.rounds[].args` 用原始 MCP 工具名和原始参数名；加载时按该工具的 `inputSchema` 校验。
- 每个原生调用都要在 `calls` 里有对应条目（同 server、同工具）。
- 三种方式必须做同样的事：测量时会核对回放 server 的调用日志，via 与 mcp2cli 发出的 `tools/call`（工具名与参数）必须与 native 的完全一致，并且每个调用都命中了某个返回值。不一致就报错，不会悄悄比较不同的工作量。

### `calls` 条目

| 字段 | 说明 |
| --- | --- |
| `server`、`tool` | 属于哪个 server 的哪个原始工具名 |
| `args` | 可选。参数子集匹配：条目里写的键必须在实际参数里且值相等，多出的键忽略；数组与标量要求相等。省略则匹配任意参数 |
| `result` | 内联的 JSON 值，作为一个 text 块返回（紧凑序列化，和多数 server 一样） |
| `resultFile` | 相对 `bench/` 的 JSON 文件，读入后紧凑序列化返回 |
| `text` / `textFile` | 原样返回的文本（源码、Markdown、页面快照等） |
| `content` | 直接给出 MCP 的 `content` 数组（图片等） |
| `isError` | 返回 `isError: true` |

`result`、`resultFile`、`text`、`textFile`、`content` 五选一。同一工具有多个条目时按文件顺序尝试，第一个匹配的生效；条目不会因为被用过而失效。

`recordings/` 下的数据是**合成**的：按常见 API 的形状（GitHub 的 REST 对象、Linear 的 issue、Notion 的页面、Playwright 的页面快照、Cloudflare 的 DNS 记录）手写，不含真实账号、令牌或内部数据。要换成真实录制的返回值，替换这些文件即可，任务文件不用改。

## 回放 server

`replay-server.mjs` 是一个普通的 MCP server：`tools/list` 返回夹具文件里的工具，`tools/call` 按 `calls` 回答；**未知工具、没有匹配条目的调用都返回 `isError`**（不是协议错误），文本说明原因，所以模型猜错时看到的是一次普通的工具失败。

命令行：

```console
$ node bench/replay-server.mjs --tools test/fixtures/tools/github.json \
    --server github --task bench/tasks/github-triage-bugs.yaml [--task ...] [--port 0] [--stdio]
{"server":"github","url":"http://127.0.0.1:41234/mcp"}
```

- 默认是 Streamable HTTP（无状态、JSON 响应），监听就绪后在 stdout 打印一行 JSON；`--stdio` 改为 stdio。
- `--server` 决定使用任务文件里哪个 server 的 `calls`，默认取夹具文件名。
- `GET /__replay/calls` 返回已收到的调用日志：`[{ "tool", "args", "matched" }]`，agent 评测用它核对模型到底调了什么。

作为模块使用：

```js
import { readTools, readTaskFile, cannedCalls, createReplayServer, startReplayHttp } from './bench/replay-server.mjs';

const calls = cannedCalls([readTaskFile('bench/tasks/x.yaml')], 'github', 'bench');
const running = await startReplayHttp({ name: 'github', tools: readTools('test/fixtures/tools/github.json'), calls });
// running.url, running.log, await running.close()
```

`calls` 数组在运行中可以替换内容（`calls.splice(0, calls.length, ...next)`），基准据此在任务之间切换返回值而不重启 server。

## 测量

原生一列不是估算出来的，而是用官方 SDK 的 client 连接回放 server：

- **注入**：`tools/list` 的每个工具序列化成 `{name, description, input_schema}`（名称加框架常用的 `mcp__<server>__` 前缀；annotations 模型看不到，不计），全部挂载 server 求和，每轮都要付；
- **轮数**：`native.rounds` 的轮数加最后回答的一轮；
- **调用与结果**：模型写出的调用块（名称加参数的 JSON），加未渲染的原始结果文本。

via 与 mcp2cli 两列真实运行命令，计入：说明文本（`via prompt` 的输出一次；mcp2cli 的 skill 一次）、每条命令的文本、以及它打印到 stdout 和 stderr 的全部内容。元信息行里的耗时、端口、沙箱路径归一为常量，让字节数可复现。token 一律按 4 字节约 1 token 估算，与 `via doctor` 用的是同一个常量（`BYTES_PER_TOKEN`）。

## 新增任务

1. 在 `tasks/` 写任务文件，返回值放 `recordings/<id>/`，把 id 加进 `suite.yaml`。
2. `npm run bench:tokens -- --task <id> --show` 看每条命令的真实输出，调整命令直到都以预期退出码结束、三种方式的调用一致。
3. `npm test` 里的 `test/bench/` 会校验任务文件、回放 server，并在进程内跑完所有 via 命令。
