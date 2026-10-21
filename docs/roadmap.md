# 路线图

先用 MVP 证明「不注入 schema、按需发现」既省 token 又不降低成功率；通过后再加 daemon 和 OAuth，最后做扩展。0.4 一个版本里做三件事：补齐验证证据，跟进官方 MCP 协议（必须做），吸收同类工具里与 via 定位相符的做法。

## 当前状态（0.3.1）

0.1–0.3 的功能项除 c5 外都已实现，并随 0.3.1 发布到 npm（`@modelctx-ai/via`）与 GitHub Release；c5（`via serve`）已在主分支实现，随下一个版本发布。两道门槛还没有正式过关：功能先于验证推进了，缺的证据列在[门槛](#门槛)里，补齐它们是 0.4 的第一件事。

```mermaid
flowchart LR
  subgraph v01["0.1 MVP：核心链路 ✅"]
    direction TB
    a1["HTTP 与 stdio 直连（进程内模式）"]
    a2["只读解析框架配置"]
    a3["凭证引用与注入（env / file / keychain）"]
    a4["三级浏览 · find · 调用"]
    a5["工具名拆分"]
    a6["统一渲染、游标、退出码"]
    a7["via doctor · via prompt"]
  end
  g1{{"门槛 1 ⏳"}}
  subgraph v02["0.2 常驻与鉴权 ✅"]
    direction TB
    b1["daemon 与会话复用"]
    b2["OAuth（PKCE、动态注册）"]
    b3["list_changed 实时刷新"]
    b4["via batch 与 cmd: 凭证"]
    b5["via trust 与 deny 规则"]
    b6["框架关闭提示数据文件"]
  end
  g2{{"门槛 2 ⏳"}}
  subgraph v03["0.3 扩展 ✅"]
    direction TB
    c1["Bun 单文件可执行"]
    c2["可选语义检索"]
    c3["resources、prompts 与 roots"]
    c4["Windows 支持"]
    c5["via serve"]
  end
  subgraph v04["0.4 验证、协议对齐与补齐"]
    direction TB
    subgraph v04d["验证与打磨"]
    direction TB
    d1["发布 agent 评测结果"]
    d2["OAuth 实测记录"]
    d3["重新标定性能目标"]
    d4["单文件分发：签名、公证、目标平台实测"]
    d5["拆分规则与截断预算的实测调整"]
    d6["next: 提示与示例命令的引号审计"]
    end
    subgraph v04e["MCP 协议对齐"]
    direction TB
    e1["迁移到官方 TypeScript SDK v2"]
    e2["2026-07-28 无状态协议与自动回退"]
    e3["协议版本可见、可固定"]
    e4["tasks"]
    e5["elicitation"]
    e6["MCP Skills 扩展"]
    e7["授权规范对齐：CIMD、client credentials"]
    e8["官方一致性测试进 CI"]
    e9["completion 与 server 自述字段"]
    end
    subgraph v04f["借鉴与补齐"]
    direction TB
    f1["schema 快照校验"]
    f2["via 自身出站请求走代理"]
    f3["daemon 与 stdio server 日志"]
    f4["-h 给出完整调用示例"]
    f5["via prompt 输出 SKILL.md"]
    end
  end
  v01 --> g1 --> v02 --> g2 --> v03 --> v04
```

| 项 | 状态 | 说明 |
| --- | --- | --- |
| a1–a7 | 已实现 | |
| b1–b6 | 已实现 | |
| c1 Bun 单文件可执行 | 已实现 | `npm run build:bin`，发布见 `.github/workflows/release.yml`。Linux x64 完整验证；Linux arm64 与 macOS arm64 在发布流程里跑冒烟；Intel macOS、Windows、musl 只构建，未在目标机器上验证（[实现说明](development/implementation.md#单文件可执行)） |
| c2 可选语义检索 | 已实现 | 默认开启确定性的同义词扩展；embedding 检索由用户配置 `search.semantic` 开启，默认关闭（[ADR 0011](adr/0011-find-synonym-expansion-and-optional-embeddings.md)） |
| c3 resources、prompts 与 roots | 已实现 | [ADR 0010](adr/0010-mcp-resources-prompts-and-roots.md) |
| c4 Windows 支持 | 已实现 | daemon 走命名管道（[ADR 0012](adr/0012-windows-pipe-name-and-batch-files.md)），CI 在 Windows 上跑完整检查 |
| c5 `via serve` | 已实现，未发布 | stdio MCP server，七个元工具，每次调用就是一次 CLI 命令（[ADR 0016](adr/0016-via-serve-meta-tools-over-stdio.md)、[cli.md](spec/cli.md#via-serve)） |
| d1–d6 | 计划中（0.4） | 见[验证与打磨](#验证与打磨) |
| e1–e9 | 计划中（0.4），必须做 | 见 [MCP 协议对齐](#mcp-协议对齐)；不依赖 d1 的评测结论，与验证同时开工 |
| f1–f5 | 计划中（0.4） | 见[借鉴与补齐](#借鉴与补齐) |

## 门槛

| 门槛 | 条件 | 状态 |
| --- | --- | --- |
| 门槛 1（0.1 → 0.2） | token 基准与 agent 评测跑通，任务成功率不低于原生 MCP，且不低于 mcp2cli | 未过关：token 基准已发布（[0.1](../bench/results/0.1.md)），agent 评测（`npm run bench:eval`）已实现但还没有发布成功率结果 |
| 门槛 2（0.2 → 0.3） | 热 daemon 调用开销达到[性能目标](development/testing.md#性能目标)，OAuth 在主流远程 server 上验证通过 | 部分达到：热 daemon 的额外开销远低于 15 ms；冷启动的几项和 daemon 内存在目标线上或略超（[perf-0.3-cold-start](../bench/results/perf-0.3-cold-start.md)）；OAuth 在真实远程 server 上的验证还没有记录 |

## 0.4：验证、协议对齐与补齐

0.4 包括三组：补齐 0.1–0.3 欠下的证据并按证据调整默认值（d），跟进官方 MCP 协议（e），吸收同类工具的做法（f）。d 与 e 同时开工，互不依赖；f 穿插进行。三组都完成才发布 0.4。

### 验证与打磨

- **d1 发布 agent 评测结果**：用 `npm run bench:eval` 在 token 基准的同一组任务上跑原生 MCP、via、mcp2cli 三组，结果写进 `bench/results/`。这是门槛 1 的条件，也是「省 token 不降成功率」的直接证据；结果不达标时先改拆分、浏览与渲染，而不是继续加功能。
  - 对照组加入 [mcpc](https://github.com/apify/mcpc)，与 mcp2cli 一样是可选的一列（PATH 上有才运行并记录版本，说明文本取自 `mcpc help --skill`，`connect` 建会话的命令计入成本）。mcpc 与 via 的判断相同（agent 经 shell 用 MCP），但工具名原样、结果保持 MCP 的 JSON 形状，是检验 via 自己的设计（`resource:verb` 拆分、按 schema 生成的参数、紧凑渲染）最直接的对照（[愿景](overview/vision.md#与相近工具的区别)）。token 基准（`bench:tokens`）同样加这一列。
- **d2 OAuth 实测记录**：在 Linear、Notion 等主流远程 server 上走一遍 `via auth login`、调用、刷新、`via auth logout`，记录到 `bench/results/` 或对应的 [provider 指南](guides/providers/)，补齐门槛 2。
- **d3 重新标定性能目标**：按 [perf-0.3-cold-start](../bench/results/perf-0.3-cold-start.md#目标重新标定的建议未改规范里的数字) 的建议，由维护者决定是否把冷启动改成相对 `node -e 0` 的增量、把 `find` 的库路径与整进程分开、daemon 内存改看匿名内存；决定后同步 [testing.md](development/testing.md#性能目标)。
- **d4 单文件分发**：macOS 公证与 Windows 签名；交叉编译产物在 Intel macOS、Windows、musl 上的实测；决定单文件是否成为默认推荐的安装方式（[待定问题](open-questions.md)）；提供 Homebrew formula（macOS 与 Linux），装单文件可执行或自带 Node 的 npm 包，取决于前一项的结论。
- **d5 拆分规则与截断预算**：在真实 server 上统计拆分失败（退回叶子工具）的比例、调整动词表；用 d1 的评测确定截断预算的默认值（现在是 8 KB）。动词表的改动按 CHANGELOG 的约定写明影响哪些规范写法。
- **d6 引号审计**：`next:` 提示、`-h` 的用法行和 `--dry-run` 回显里拼出的命令行含有来自 server 的文本（工具名、参数名、枚举值、默认值、URI）和用户输入。逐处核对：复制粘贴这些命令时不会触发 shell 展开或执行（POSIX shell 的 `$`、反引号、`\`，PowerShell 与 `cmd.exe` 各自的转义），不能安全引用的值不出现在可粘贴的命令里。mcpc 修过同类问题（[apify/mcpc#450](https://github.com/apify/mcpc/pull/450)，反斜杠转义缺失导致粘贴的提示可执行命令）。结论写进 [output.md](spec/output.md) 与 [security.md](spec/security.md)，补测试。

### MCP 协议对齐

via 现在锁定 `@modelcontextprotocol/sdk` 1.32.1，它最多协商到 `2025-11-25`；`2026-07-28` 把 MCP 改成无状态协议（没有 `initialize` 握手和 server 端会话），只有官方 TypeScript SDK v2（`@modelcontextprotocol/client`，目前 2.3.1）支持。OAuth 登录的探测请求还写死了 `2025-06-18`（`src/client/oauth/login.ts`）。`2025-11-25` 本身也有几项 via 没有覆盖：tasks、elicitation、completion。新版协议的 server 会越来越多，这一组必须做，不等 d1 的评测结论。

原则：

- **新版本优先，自动回退**：先按最新版本谈，server 不支持时退回旧版本，用户不需要配置。旧版本 server 上的行为不变。
- **只对齐协议，不改命令语法**：新能力进 CLI 时和 resources、prompts 一样，不进入 `provider resource:verb` 的工具语法（[ADR 0010](adr/0010-mcp-resources-prompts-and-roots.md)）。新增的内置子命令名成为保留字，按 [cli.md](spec/cli.md) 的规则写明受影响的 server 名，并记入 CHANGELOG。
- **冷启动约束不变**：SDK v2 同样只在调用路径和 daemon 里懒加载，浏览命令不加载它。
- **不为特定 server 适配**：协议差异按版本处理，不按 server 处理（[ADR 0007](adr/0007-no-gateway-specific-adaptation.md)）。

| 项 | 内容 | 涉及规范 |
| --- | --- | --- |
| e1 迁移到 SDK v2 | 换到 `@modelcontextprotocol/client` 2.x。重新测冷启动、daemon 内存与单文件体积，对照 [perf-0.3-cold-start](../bench/results/perf-0.3-cold-start.md)；via 自己用到的协议版本常量加单测，SDK 升级时发现漂移；OAuth 登录的探测请求不再写死版本 | [implementation.md](development/implementation.md)、[daemon.md](spec/daemon.md) |
| e2 2026-07-28 无状态协议 | 用 `server/discover` 探测，不支持时退回 `initialize` 握手（`2025-11-25` 至 `2024-11-05`）；无状态 server 在 daemon 里只保留连接与缓存，不做会话恢复，已存的会话 ID 丢弃；请求按新协议带 `Mcp-Method` 头，`serverInfo` 从响应的 `_meta` 读取；server 给出的 `ttlMs` 缓存提示与目录缓存的 24 小时取较短者；`list_changed` 改用新协议的订阅方式接入 daemon 的刷新（[daemon.md](spec/daemon.md) 现在依赖 `notifications/tools/list_changed`）；新协议去掉了 `logging/setLevel`，roots 在新协议下的形态需要核对（[ADR 0010](adr/0010-mcp-resources-prompts-and-roots.md)） | [daemon.md](spec/daemon.md)、[discovery.md](spec/discovery.md)、[config.md](spec/config.md) |
| e3 协议版本可见、可固定 | `via servers` 与 `via doctor` 显示每个 server 协商出的协议版本，以及连接是否有状态；配置字段 `protocolVersion` 固定版本，server 不支持时报错而不是退回 | [config.md](spec/config.md)、[cli.md](spec/cli.md) |
| e4 tasks | `2025-11-25` 核心协议里的 tasks 与 `2026-07-28` 的 `io.modelcontextprotocol/tasks` 扩展。默认跟随到结果（受 `--timeout` 约束，超时时给出任务 ID 和续取命令）；`--detach` 立即返回任务 ID；另需查看、取结果、取消任务的命令。新扩展没有 server 端的任务列表，via 只能列出自己创建的任务。命令形态和保留字要先写一篇 ADR（[待定问题](open-questions.md)） | [cli.md](spec/cli.md)、[output.md](spec/output.md)、[daemon.md](spec/daemon.md)、新 ADR |
| e5 elicitation | server 在调用中途向用户要输入（表单模式与 URL 模式）。终端里交互填写；非交互（agent 经 shell、`via serve`、`via batch`）时拒绝，退出码与 `next:` 提示按 [output.md](spec/output.md)，说明需要用户在终端运行；URL 模式只打开 `http(s)`，规则与 OAuth 回调相同。sampling 不声明：via 不调用模型（[ADR 0011](adr/0011-find-synonym-expansion-and-optional-embeddings.md) 的原则） | [output.md](spec/output.md)、[security.md](spec/security.md)、新 ADR |
| e6 MCP Skills 扩展 | `skills/list`、`skills/get` 与技能的附属文件，输出前按 server 发布的清单校验大小和摘要，不符的拒绝显示。与 resources、prompts 一样不进工具语法，命令形态与 e4 一起定 | [cli.md](spec/cli.md)、[ADR 0010](adr/0010-mcp-resources-prompts-and-roots.md) 的补充或新 ADR |
| e7 授权规范对齐 | CIMD（Client ID Metadata Document，`2025-11-25` 授权规范推荐的客户端注册方式）：托管一份 https 的客户端元数据文档，回调从随机端口改为固定的回环端口范围（文档里要列出回调地址），授权服务器不支持时退回动态注册；OAuth client credentials 扩展（无浏览器，用于 CI 与 headless）；保存的客户端凭证绑定到验证时的授权服务器，换了授权服务器的 server 拿不到它。企业托管授权（ID-JAG）排在最后，有需求再做。文档托管位置见[待定问题](open-questions.md) | [auth.md](spec/auth.md)、[security.md](spec/security.md) |
| e8 一致性测试 | 把官方 `@modelcontextprotocol/conformance` 的 client 场景接进 CI；回放 server 增加 `2026-07-28` 模式，e2e 测试对新旧两代 server 各跑一遍 | [testing.md](development/testing.md) |
| e9 completion 与 server 自述字段 | `completion/complete` 用于 prompt 参数和资源模板参数的取值提示；`serverInfo` 的 `description`、`websiteUrl` 和 `initialize` 的 `instructions` 是否进入 provider 视图或 `find` 的检索，要在 token 预算内权衡（[待定问题](open-questions.md)） | [discovery.md](spec/discovery.md)、[output.md](spec/output.md) |

### 借鉴与补齐

以下几项来自与 [mcpc](https://github.com/apify/mcpc)（0.7.0）的对比，选的是 via 还没有、又不违背 via 定位的做法。via 已经有的（stdin 与文件传参、stdio 子进程的环境变量白名单、钥匙串不可用时退回文件、项目配置的信任）不再列出。

| 项 | 内容 | 涉及规范 |
| --- | --- | --- |
| f1 schema 快照校验 | 调用或查看用法时带 `--schema <文件>`：把当前工具的 `inputSchema`/`outputSchema` 和保存的快照（`-o json` 的工具详情）比较。分兼容与严格两档：兼容档允许新增可选参数、新增输出字段，必填参数的类型变化或删除必填输出字段算不兼容；不兼容时不发调用并以非零退出码报告差异。用于脚本和 CI 尽早发现上游的破坏性变更 | [cli.md](spec/cli.md)、[arguments.md](spec/arguments.md)、[output.md](spec/output.md) |
| f2 via 自身出站请求走代理 | via 发出的 HTTP 请求（MCP server、OAuth、embedding 检索）遵守 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`。现在这些变量只转发给 stdio 子进程（[config.md](spec/config.md)），via 自己的请求不走代理，公司网络里连不上远程 server。`via doctor` 显示生效的代理（隐藏 userinfo） | [config.md](spec/config.md)、[security.md](spec/security.md) |
| f3 daemon 与 stdio server 日志 | 现在 stdio 子进程的 stderr 只在出错时取末尾几行拼进报错，`via.sock.log` 只在 daemon 启动失败时读取。改为按 server 分文件、按大小轮转的日志，`via daemon logs [<provider>]` 查看（`-n`、`--follow`、`--since`），内容同样脱敏，文件权限与缓存目录一致 | [daemon.md](spec/daemon.md)、[security.md](spec/security.md)、[cli.md](spec/cli.md) |
| f4 `-h` 给出完整调用示例 | 用法里按 schema 生成一条可直接粘贴的调用示例，覆盖嵌套 object、对象数组、nullable、`$ref`、tuple；引号规则随 d6 | [arguments.md](spec/arguments.md)、[output.md](spec/output.md) |
| f5 `via prompt` 输出 SKILL.md | 增加输出格式选项，打印带 frontmatter 的 `SKILL.md`（`name`、`description`、`allowed-tools: Bash(via:*)`），供按技能目录加载说明的 agent 使用。只写 stdout 或 `--out` 指定的文件，不自己找框架的技能目录（via 对框架配置只读，[ADR 0003](adr/0003-read-only-framework-configs.md)）；与标记块共用正文（[ADR 0013](adr/0013-agent-instructions-are-a-marked-block.md)） | [cli.md](spec/cli.md)、[agent-integration.md](guides/agent-integration.md) |

## 不借鉴

mcpc 有、via 明确不做的：

- **本地代理 MCP server 做凭证隔离**（`--proxy`）：凭证隔离是 via 的非目标，交给网关（[ADR 0002](adr/0002-standalone-client-not-gateway.md)、[愿景](overview/vision.md#非目标)）。
- **x402 支付**：与「agent 按需发现和调用工具」无关，等有真实需求再议。
- **与协议一一对应的命令和显式会话**（`tools-list`、`tools-call <name> key:=value`、先 `connect @name` 再使用）：via 已经选择聚合目录与 `resource:verb`（[ADR 0005](adr/0005-command-grammar-provider-resource-verb.md)、[ADR 0008](adr/0008-dynamic-dispatch-no-codegen.md)）。
- **订阅资源并写入文件**（`resources-subscribe <uri> <file>`）：一次性的 CLI 进程里没有消费者；资源与列表的变更通知只在 daemon 里用于刷新缓存（e2）。
- **跳过 TLS 校验**（`--insecure`）：自签证书用 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`。

其余[待定问题](open-questions.md)有结论后再排进路线图。

## 说明

- 0.1 没有 daemon，stdio server 每次调用都会重新拉起，评测时应以 HTTP server 为主，避免启动延迟干扰结论。
- 0.1 的游标保存在用户缓存目录。
- 0.1 中 OAuth 型 server 可以先用 bearer（如 Linear API key）验证链路。
