# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

影响规范写法的改动（动词表、单数化规则、域分类表）必须在这里单独列出，因为它们会改变 `provider resource:verb` 的规范名。

## [Unreleased]

### Changed

- 性能（0.1/0.2 没有达到的冷启动、`find` 与 daemon 内存目标；数据与重新标定的建议见 [bench/results/perf-0.3-cold-start.md](bench/results/perf-0.3-cold-start.md)）。输出、退出码、`next:` 提示与命名规范都不变，没有动词表、单数化规则或分类表的改动，所以没有规范名受影响：
  - 浏览类命令（`via`、`via <provider>`、`via find`，缓存热、无 daemon）比同机 `node -e 0` 多 44–51 ms（改动前 72–102 ms），墙钟约 74–80 ms；一千个工具上 `find` 的库路径（新进程）81 ms 降到 21 ms；daemon 建立 HTTP 与 stdio 会话后 89–92 MiB 降到 76–79 MiB。
  - 规范补充（随冷启动工作，不改变既有设计决策）：discovery.md 新增「预构建缓存」（`catalog/<哈希>.view.json`：拆分、分域与检索词的计算结果，规则指纹、原始列表与构建输入任一变化即失效，不含凭证值）；config.md 新增「解析缓存」（YAML 文件按字节哈希缓存其结构，字符串只存偏移，不复制任何值）；daemon.md 的 `list` 请求新增可选的 `have`、应答新增 `unchanged`（`list` 的其余字段与语义不变，旧 CLI 不带 `have` 时行为不变），daemon 在内存里不再保存解析后的工具列表（磁盘缓存就是副本），Node 运行时下拉起 daemon 时加 `--max-semi-space-size=2` 与（Linux）`MALLOC_ARENA_MAX=2`；security.md 的缓存一行补充新增缓存不含凭证值。原始缓存文件的 `features` 写在 `tools` 之前（读取仍兼容旧文件）。
  - 实现（[implementation.md](docs/development/implementation.md#启动速度)）：打包产物里的 `fs`、`fs/promises` 不经 ESM 门面加载；stdout/stderr 用 `fs.writeSync`，tty 检测按需；64 KiB 以内的 SHA-256 用纯 JS 实现（与 `node:crypto` 逐例对照，信任哈希语义不变）；合法 JSON 配置用原生 `JSON.parse`；浏览命令一次 `import()` 取齐依赖，不加载渲染流水线与 MCP 客户端；分词、签名、倒排表走 ASCII 快路径与扁平数组。
- 规范补充（随单文件可执行，不改变既有设计决策）：daemon.md 写明拉起的是当前程序自身（脚本为 `<运行时> <入口脚本> daemon run`，可执行文件为 `<该文件> daemon run`）；config.md 补充钥匙串模块加载失败时 `keychain:` 的表现与 `NAPI_RS_NATIVE_LIBRARY_PATH`；security.md 新增「单文件可执行」一节（不读取当前目录的 `.env` 与 `bunfig.toml`、钥匙串模块的来源、校验和）。无规范写法（动词表、分类表）受影响。
- `via find` 默认做确定性的同义词扩展（路线图 c2 的第一层，[ADR 0011](docs/adr/0011-find-synonym-expansion-and-optional-embeddings.md)）：查询侧按 `data/synonyms.json` 把动词（`remove`/`delete`/`destroy`…）、资源（`issue`/`ticket`、`pr`/`pull request`/`merge request`、`repo`/`repository`…）和简单词形（`creating` → `create`）展开成打折的替代词，只改变第 4 级 BM25 的分数。规范写法的三级匹配、并列规则、空查询、`--domain` 不变，带原词的工具总排在只带同义词的工具之前。**不改变任何规范名**（不影响「影响规范写法」一节）。fixture 目录上 98 条自然语言查询：recall@1 42.9% → 66.3%，recall@5 74.5% → 96.9%，MRR 0.570 → 0.790；调参后另写的 30 条留出集：recall@1 50.0% → 66.7%，recall@5 76.7% → 86.7%，MRR 0.615 → 0.775；原本就能命中的 12 条仍然 100% 排第一。1,000 个工具上稳态单次查询仍是亚毫秒级（中位约 0.3–0.5 ms，目标 < 30 ms），首次查询多约 1 ms 的同义词表编译。discovery.md 的「搜索」一节、data-files.md 的 `synonyms.json` 一节相应更新。
- AGENTS.md 的「发现逻辑是确定性的」改为「默认确定性；唯一的例外是用户显式开启的 `search.semantic`」（ADR 0011）。
- 测试：`test/bench/synth-catalog.test.ts` 的「发送邮件」查询接受 `acme-workspace`（其 `mail-message:send` 现在是 `email` 的同义词命中，与 gmail 的描述命中同分）。
- 规范补充（随 Windows 支持）：daemon.md 的「生命周期」「无 daemon 模式」「socket 安全」按平台改写并新增「Windows」一节；config.md 的 Windows 基础环境、「Windows 上启动 stdio 命令」与 `cmd:` 分词；security.md 新增「Windows 上的子进程」「Windows 上的文件权限」，并说明信任记录的 Windows 路径规范化；auth.md 的打开命令与 Credential Manager 拆分存放。`open-questions.md` 的「Windows 支持」条目随之移除。没有动词表、分类表或命名规则的改动，规范写法不受影响。
- 规范补充（随 OAuth 实现）：auth.md 补全 OAuth 的发现、注册、回调、存储（含文件退路与 `VIA_OAUTH_STORE`）、刷新、状态与登出，以及调用时「需要登录」的行为；cli.md 的 `via auth` 说明；security.md、daemon.md 中 OAuth token 的脱敏与 daemon 持有的状态。`auth: oauth` 的 server 不再提示改用 bearer。
- 项目名与命令名由占位名 `mx` 改为 `via`，npm 包名 `@modelctx/via`；配置路径、项目配置文件、socket、环境变量前缀随之改名（ADR 0009）。
- 规范补充（随首个实现，不改变既有设计决策）：naming.md 明确逐词单数化并加入不规则复数；discovery.md 补全启发式打分的细节（递减计分、`minScore`、双域判定）、浏览视图的排序与截断、签名上限、安全标记和搜索排序的并列规则；output.md 补全表格选列、一行数组、元信息行格式、游标续读、脱敏顺序和错误文本清理；data-files.md 增加 `columns.json`、`singularIrregular`、`minScore`、`stopwords` 以及词典与差异检查的命令。
- 规范补充（随 config / client 实现）：config.md 的 `sources` 列表语义、框架写法规范化（`type`/`transport`、`serverUrl`、Codex 的 `*_env_var` 等）、合并细节、校验与诊断、stdio 子进程的基础环境；data-files.md 的框架条目新增 `platforms`、`notes`，`verifiedAt` 可为 `null`；auth.md 明确 403 退出码 4、0.1 暂不支持 OAuth、stdio 的 stderr 不转发；output.md 补全传输与上游错误的格式。
- 规范补充（随 CLI 实现）：cli.md 补充各内置子命令的细节、配置错误时的行为与 `--dry-run` 输出格式；arguments.md 明确默认方言 2020-12、usage 折行规则、新增几类报错说法与错误顺序、危险操作拒绝与 progress 行的格式；discovery.md 补充进程内模式的目录缓存；agent-integration.md 补充 `via doctor` 的各节、token 估算、明文判定规则与退出码。
- 规范补充（随框架数据文件核对）：框架条目新增 `sources`、`configs[].dollarVariables`，`verifiedAt` 改为 `YYYY-MM-DD`；config.md 的规范化表补充 Codex `env_vars` 的 `{ name, source }` 写法与 `$NAME` 变量；显式指定的框架只要其配置文件之一存在，就不再为其余缺失的备选文件告警。无规范写法（动词表、分类表）受影响。
- 规范补充（随 daemon 实现，docs/spec/daemon.md 为准）：协议改为围绕「server 定义 + 请求」组织，CLI 在每个请求里带上配置里的 server 定义（只含凭证引用）、工作目录和 `envStamp`，daemon 不读配置；去掉 `ls`、`find`、`describe`、`more`、`sync` 请求（目录由 CLI 从原始工具列表计算，续读与刷新用 `cursor-*`、`list`），新增 `list`、`validate`、`redact`、`cursor-put`、`cursor-get`、`shutdown`、`stale` 应答，`hello` 带令牌。补充启动锁与陈旧 socket 清理、版本不一致时先释放 socket、回退的边界（可能已执行的非只读调用不重放，退出码 6）、`env:` 在 daemon 自己的环境里解析并以摘要探测差异、凭证 10 分钟过期、独占 server 请求结束即停、空闲退出的含义、`list_changed` 的合并与失败处理、游标随 daemon 退出失效。socket 安全因 Node 无法取得 `SO_PEERCRED`，改为目录与 socket 权限、CLI 侧属主检查和握手令牌（peer uid 校验留作后续）。cli.md 补充 `via daemon status|stop|run` 的输出与退出码。
- client 把上游 `InvalidParams`（-32602）映射为退出码 1，并提示 schema 与 server 行为不一致。
- 安全：项目级配置的信任范围从 stdio 命令扩大到 HTTP 端点。项目级文件设置或覆盖 `url`、`headers` 时同样需要 `via trust`，避免仓库把 server 指向别处，从而拿到用户为它配置的凭证（security.md）。
- 构建：纯 JS 依赖（MCP SDK、ajv、yaml、smol-toml、jsonc-parser、string-width 等）打进分块，不再作为外部包在运行时逐文件解析，只有原生的 `@napi-rs/keyring` 保持外部。浏览类命令（`via`、`via find`）的冷启动各快约 50 ms（8 个 provider 的缓存目录，见 bench/results/perf-0.1.md）。CommonJS 依赖经动态 `import()` 只有 `default`，配置解析因此兼容两种形态。
- 表格宽度：`src/render/terminal-width.ts` 移植 `string-width` 的算法，`Intl.Segmenter` 与 `\p{RGI_Emoji}` 正则推迟到第一次遇到非窄字符时才创建（直接加载 `string-width` 在冷启动里约占 30 ms，而浏览视图里几乎全是 ASCII、`·`、`…`、`→` 这类窄字符）。`string-width` 降为开发依赖，仅在测试里作为一致性参照；`get-east-asian-width` 成为直接依赖。输出不变。
- 规范补充（随 `via trust`、`cmd:`、deny 审计实现，不改变既有设计决策）：security.md 新增 `via trust` 的范围、显示内容、确认方式（终端提示或 `--yes`、`--dry-run`）、`--list` / `--revoke` 与退出码，以及 `cmd:` 的执行细节（不经 shell、环境、超时、输出上限、错误信息不含命令输出）；config.md 补全 `cmd:` 的分词与缓存语义、deny 的匹配范围（规范写法与原始名、别名、区分大小写）、分层规则（只能追加）与 deny 先于 `--yes`；`via servers` 不执行 `cmd:`；output.md 的退出码 5 补充未信任。
- 未信任时的 `next:`：同一个 server 有多个文件待确认时提示不带路径的 `via trust`，路径含空格时加引号。
- 规范补充（随 `via batch` 实现）：cli.md 的 `via batch` 一节补全输入字段（`tool`、`args`，其余字段报错）、行号、空输入（退出码 2）、全局选项对整批生效、危险工具缺少 `--yes` 时只让该行失败、`--dry-run`、全局并发上限 `--concurrency`（默认 16）、text 与 `-o json` 的逐行框架（`line N` 标记、`· batch · …` 汇总行、JSONL 记录字段、超出预算时的 `truncated` / `next`）以及整体退出码取数值最大者；output.md 的元信息行增加 `line N` 标记；arguments.md、config.md、daemon.md 各补一句与批量的关系。
- 内部：`commands/tool.ts` 抽出 `executeCall`，`via <provider> …`、`via call`、`via batch` 共用同一条「校验 → dry-run / 确认 → 调用 → 渲染」路径；它返回结果（stdout、stderr、退出码、结构化的元信息与错误）而不直接写输出，也只通过 `app.client()` 触达上游，后端（进程内或 daemon）对它透明。渲染流水线的返回值附带元信息与结构化错误。
- `via trust --yes` 不再是单个开关（security.md、cli.md）：agent 若能执行 `via trust --yes` 就能放行不可信的仓库。现在默认在终端里确认；`--yes` 必须带显式路径并设置 `VIA_ALLOW_NONINTERACTIVE_TRUST=1`，否则不记录（不带路径退出码 2，缺少变量退出码 5）。没有终端时的 `next:` 改为请用户在终端运行 `via trust <路径>`，不再建议 `--yes`。`via prompt` 生成的说明增加一句「不要自己运行 `via trust`，请用户来做」。
- 文档：README 按开源项目的使用者重写——状态改为「预发布、0.1–0.3 已实现、需从源码安装」（原先写的「设计阶段」已过时），补充安装、快速上手、常用命令、安全须知、开发命令，示例输出换成对着回放 server 的实际输出，引用 token 基准结果并注明口径；设计原理、性能数字、Windows 与单文件细节只留链接。CONTRIBUTING 与快速上手同步更新阶段描述和源码安装方式。不涉及规范与规范写法。
- 文档：README 默认改为英文（`README.md`），中文版移到 `README.zh-CN.md`，两份顶部互相链接；CONTRIBUTING 写明两份需同步。不涉及规范与规范写法。

### Added

- 性能缓存的测试：`test/cli/view-cache.test.ts`（预构建目录的还原、失效与凭证）、`test/config/parse-cache.test.ts`、`test/sha256.test.ts`、`test/daemon/backend.test.ts`，`test/cli/dist.test.ts` 增加浏览命令不得初始化的内置模块与 `require` 垫片的检查。
- `npm run bench:perf` 增加 `--only`、`--compare <目录>`（与另一份构建交替运行）、`--plain-daemon`，新增更接近真实使用的场景一节（热 daemon、框架配置、一千个工具的整进程命令）、预构建缓存路径的 `find`、Node 内部模块加载检查，以及 daemon 内存的匿名/文件拆分。
- 单文件可执行（路线图 c1，`npm run build:bin`）：`scripts/build-bin.ts` 用 Bun 从 `src/` 编译出 `dist/bin/via-<系统>-<架构>[-musl][.exe]`（默认本机平台；`--all` 或 `--target a,b` 交叉编译 linux-x64/arm64、linux-x64/arm64-musl、darwin-x64/arm64、windows-x64），每个文件带 `.sha256`。构建参数是实测选出来的：`--bytecode` 去掉每次启动对整包 JS 的解析（`--version` 约 66 → 20 ms，对比 `node dist/via.js`；0.1 里不带标志的 `bun build --compile` 比 Node 还慢，原因在此，而不是 85 MiB 的体积），`--splitting` 保持 `--version`/`-h` 不加载命令运行器与库，关闭 `.env` 与 `bunfig.toml` 的自动加载（默认会读当前目录的，见 security.md）。`@napi-rs/keyring` 经 Bun 插件替换为目标平台的 `.node` 文件并内嵌（非本机平台的包从 npm 下载并校验 `package-lock.json` 的完整性），每个产物只带自己平台的模块；加载失败时 `keychain:` 报「native keychain module is not available」并提示改用 `env:`/`file:`，`NAPI_RS_NATIVE_LIBRARY_PATH` 可指定 `.node`。`via daemon run` 拉起的是可执行文件自身（`src/runtime.ts` 的 `selfCommand()`）；Bun 下不调用 `module.enableCompileCache()`。`dist/bin` 不进 npm 包。
- 测试：`test/cli/bin.test.ts`（装有 `bun` 时构建本机产物并跑冒烟集，否则跳过；`VIA_REQUIRE_BUN=1` 时缺少 Bun 即失败）、`test/runtime.test.ts`、`test/bin-targets.test.ts`。CI 增加 `binary` 任务（Ubuntu、macOS，固定 Bun 1.4.2）；新增 `release.yml`（仅 `v*` 标签与手动触发）构建全部目标、生成 `SHA256SUMS` 并上传到 Release。
- 性能基准：`npm run bench:perf` 的 Bun 一节比较 `bun dist/via.js`、不带标志的编译、逐个加标志的编译与 `build:bin` 产物，第 5 节增加产物经热 daemon 的整进程调用；`--only-bun` 只跑 Bun 一节。结果记录在 `bench/results/perf-0.3.md`。
- MCP resources、prompts 与 roots（ADR 0010，roadmap c3；open-questions 里的对应条目已移除）：
  - 新内置子命令 `via resources <provider>`（资源与资源模板）、`via read <provider> <uri>`、`via prompts <provider> [<名称> [参数]]`。`resources`、`read`、`prompts` 成为保留字，与之重名的 provider 需要 `alias`；`prompt` 与 `prompts` 是两个命令，`via prompt <provider>` 会提示后者。URI 是普通位置参数，不进工具语法（冒号）；不适用 `deny`、`--yes`、`--dry-run`（协议上只读）。订阅、补全、sampling 不在范围内。
  - 输出走现有渲染流水线（预算、游标、媒体落盘、脱敏、`-o text|json|raw`），元信息行名称为 `resources <p>`、`read <p>`、`prompts <p> <名称>`；一次读取返回多个内容时每个前加 `# <uri>`。prompt 的参数转成字符串 schema，复用工具的参数解析、`-h`、校验与报错。server 没有声明相应能力退出码 3（不发请求），URI 不存在退出码 3，server 拒绝 prompt 参数退出码 1。
  - `via <provider>` 在 server 声明了 resources 或 prompts 时多一行 `also: via resources <p> · via prompts <p>`；能力随 `tools/list` 缓存（缓存文件新增可选的 `features`，旧文件照常读取）。`via prompt` 的说明文本不变，不增加 token。
  - 配置 `servers.<name>.roots`（路径或 `file://` URI）：声明 `roots` 能力并回应 `roots/list`。**默认不声明**；`listChanged` 为 `false`；相对路径相对运行 `via` 的当前目录，`~` 展开；daemon 里换算成绝对 URI 后参与会话键，所以相对 roots 不会跨目录共用会话。项目级配置设置非空 `roots` 需要 `via trust`（`via trust` 列出），`[]` 不需要；给 HTTP server 配 `roots` 有告警（`roots-remote`）。
  - 协议：新增 `resources-list`、`resource-read`、`prompts-list`、`prompt-get` 请求（结果在 daemon 内脱敏，回退时作为无副作用请求重做），`list` 的结果带 `features`；会话键加入 `roots`。
  - 测试夹具 `test/fixtures/mcp/cli-server.mjs` 增加可选的 resources（文本、JSON、二进制、多内容、长文本、模板、两页列表）、prompts 与读取 roots 的工具 `list_roots`。
- 可选的 embedding 检索（路线图 c2 的第二层，默认关闭）：用户配置 `search.semantic: { provider: openai-compatible, url, model, auth, timeout, indexTimeout, dimensions }` 后，`via find` 把查询与工具描述的 embedding 同 BM25 做 RRF 融合（第 1–3 级规范写法匹配仍在最前）。只读用户配置与命令行覆盖，项目配置里的被忽略并告警（`search-forbidden`）；`url` 必须是 https（回环地址可用 http）且不含内嵌凭证；`auth` 是凭证引用，不跟随重定向，响应体、请求头、端点从不进入输出。工具描述的向量按文本哈希缓存在 `<缓存目录>/embeddings/`（目录 0700、文件 0600），描述变了才重新请求；缓存完整时语义步骤的期限是 `timeout`（默认 3 秒），补 embedding 时是 `indexTimeout`（默认 30 秒），期限内没完成（超时、HTTP 错误、凭证缺失、响应异常、缓存仍不完整）就退回词法排序并在 stderr 写一行 `· semantic unavailable: <原因> · lexical results`，退出码不变，已取得的向量保留供下次继续。只影响 `via find`；实现是独立分块，关闭时零加载；在 CLI 进程内完成，不经 daemon。spec 见 discovery.md、config.md、security.md（新增「embedding 检索的数据外流」）。
- `npm run eval:search`（`scripts/eval-search.ts`）：在 `test/fixtures/search/eval.json`（调参集）和 `heldout.json`（留出集）上报告词法基线与默认的 recall@1、recall@5、MRR，`--misses` 列出仍然答错的查询；回归测试 `test/catalog/search-eval.test.ts` 断言不低于基线并锁定下限。
- 测试：`test/helpers/embeddings-server.ts`（本机 OpenAI 兼容 embeddings 服务，确定性假向量），覆盖融合、缓存、超时与错误退回、脱敏、配置校验（`test/catalog/semantic.test.ts`、`test/cli/semantic.test.ts`、`test/config/search.test.ts`）；`test/cli/dist.test.ts` 校验默认的 `find` 不加载 embedding 分块。

- Windows 支持（路线图 c4；daemon.md「Windows」、security.md「Windows 上的子进程」「Windows 上的文件权限」、ADR 0012）：
  - daemon 在 Windows 上启用（不再始终用进程内模式；`VIA_NO_DAEMON=1` 照常有效）。默认管道名为 `\\.\pipe\via-<用户名>-<令牌摘要>`，摘要取自 daemon 每次启动生成、写在 `%LOCALAPPDATA%\via\Cache\via.token` 的令牌，因此名字无法被预先占位；握手令牌校验与 POSIX 一致，启动锁、陈旧令牌清理、令牌文件被删后自行退出。`via daemon status` 在 daemon 未运行时显示 `\\.\pipe\via-<用户名>-*`。peer 身份（对端 SID）与文件 ACL 不校验，残留风险写入规范。
  - `command: npx` 一类 `.cmd` / `.bat` 垫片可用：命令名由 via 按 `PATH` 与 `PATHEXT` 解析（不找当前目录），`.exe` 直接启动，批处理文件的参数含 `"`、`%`、换行、NUL 时拒绝启动。`cmd:` 凭证命令在 Windows 上同样解析，`.cmd` / `.bat` 经 `cmd.exe /d /v:off /s /c` 启动、每个词加双引号；`cmd:` 的分词在 Windows 上采用 C 运行时规则，`cmd:C:\Tools\op.exe …` 和带引号的路径可直接写。
  - 路径：用户配置 `%APPDATA%\via\config.yaml`，数据与缓存 `%LOCALAPPDATA%\via\{Data,Cache}`；环境变量名不分大小写（`%AppData%`、`env:Path`）；`~\`、`%NAME%` 展开；信任记录按规范化后的真实路径记录、不区分大小写，去掉 `\\?\` 前缀；已加载的框架配置文件按路径身份去重。`via` 的提示里 Windows 路径按 cmd.exe 与 PowerShell 都认的双引号规则加引号。
  - OAuth：打开浏览器改用 `rundll32 url.dll,FileProtocolHandler`（不再经 `cmd /c start`，授权 URL 里的 `|`、`^`、`%VAR%` 不再被 `cmd.exe` 解释），所有平台只打开 `http(s)` 地址；Credential Manager 单条凭据放不下整条登录记录，Windows 上超过 1000 个字符时拆成多条存放。
  - 文本：配置文件、`--args @文件`、标准输入（含 `via batch`）、`file:` 凭证都识别 UTF-8 BOM 与 UTF-16 BOM；CRLF 行尾已兼容。stdio 子进程的基础环境在 Windows 上增加 `USERDOMAIN`、`COMPUTERNAME`、`ProgramFiles(x86)` 等系统变量。
  - 测试与 CI：`.github/workflows/ci.yml` 增加 `windows-latest`（Node 22）任务（typecheck、build、test、运行打包产物）；仓库根 `.gitattributes` 固定 LF。路径、引号、`PATHEXT`、令牌派生管道名等逻辑用注入的 `platform: 'win32'` 在所有宿主上测试，只在 POSIX 有意义的测试带原因地跳过（testing.md「跨平台约定」）。

- OAuth（auth.md）：`via auth login|status|logout`。PKCE 授权码流程，按 MCP 授权规范发现受保护资源与授权服务器（RFC 9728 / 8414）、动态客户端注册（RFC 7591）、`resource` 参数（RFC 8707）；回调监听 `127.0.0.1` 的随机端口并校验 `state` 与 `Host`，`--manual` 在无头环境打印授权 URL、从终端读取粘贴的重定向 URL；平台打开命令只是尽力而为（SSH 会话或无显示时不尝试，打开失败不报错、不等待）。登录存入系统钥匙串（服务名 `via`，账户名 `oauth:<server 定义的哈希>`），不可用时退回用户数据目录下 0600 的文件，`VIA_OAUTH_STORE=file|keychain|auto` 可固定；调用前和收到 401 时用 refresh token 静默刷新（同进程串行，多进程轮换冲突时改用已刷新的 token），登录失效时退出码 4 并提示 `via auth login`，调用过程永远不会启动浏览器或等待输入；`logout` 撤销 token（RFC 7009，尽力而为）并删除本地记录。OAuth token 计入脱敏列表（`CredentialResolver.track`）。`via servers` 的鉴权列显示登录状态，`via doctor` 对未登录的 server 给出 `next: via auth login <provider>`。MCP SDK 仍按需加载。
- 测试夹具 `test/fixtures/mcp/oauth-server.mjs`：模拟授权服务器（元数据、动态注册、PKCE 校验、刷新与轮换、撤销）加受保护的 Streamable HTTP MCP server。

- `via trust [<路径>] [--yes] [--dry-run]`、`via trust --list`、`via trust --revoke <路径>`：显示项目级文件将让 via 启动或访问什么（命令行、URL、env / header 的名字与凭证引用，不显示值），确认后按真实路径 + 解析时读到的那份字节的 SHA-256 记录信任；文件变化后需重新确认。`trust` 不再是 0.2 的保留名。
- `cmd:` 凭证：用户配置里可用，不经 shell 执行，30 秒超时、64 KiB 上限、stdout 去首尾空白，结果按引用在解析器内存中缓存 10 分钟（失败不缓存，并发解析只运行一次）；错误信息只含程序名与原因，不含命令的 stdout / stderr；项目与框架配置里的 `cmd:` 仍在加载阶段拒绝，信任也不能放行。
- deny 规则的审计与测试：分层并集（项目与命令行只能追加）、规范写法与原始名两种匹配、别名、`--yes` 之前拒绝、全局 / 粘性标志不影响结果。
- token 基准（`npm run bench:tokens`，路线图门槛 1 的前半）：`bench/` 下九个任务（github、linear、notion、playwright、cloudflare，含一个跨 server 任务）、回放 MCP server `bench/replay-server.mjs`（Streamable HTTP 或 stdio；`tools/list` 取自夹具，`tools/call` 按任务里的返回值回答，其余 `isError`；任务文件格式与回放接口供之后的 agent 评测复用）和测量脚本。比较原生注入、`via`（真实运行 `dist/via.js`）和 mcp2cli（PATH 上有才运行并记录版本，说明文本取自它的 skill），核对三者发出的 `tools/call` 一致；结果记录在 `bench/results/0.1.md` 与 `0.1.json`。冒烟测试校验任务文件、回放 server 和全部 via 命令，凭证扫描覆盖 `bench/`。
- agent 评测（`npm run bench:eval`，路线图门槛 1 的后半）：让真实模型在原生 MCP、`via`、mcp2cli 三种条件下完成 token 基准的同一批任务，对着同一批回放 server。native 条件把全部挂载 server 的工具原样暴露为模型工具，经 MCP SDK 转发；via / mcp2cli 条件只给一个 `shell` 工具，只能运行 `via …` / `mcp2cli …`（POSIX 切词后作为 argv，不经 shell），模型得到 `via prompt` / mcp2cli 自带 skill 的原文。成功由回放 server 的调用日志判定，不由模型自评：任务文件新增可选的 `success` 块（`require` 必需调用及参数子集、`forbid` 禁止调用、`max` 写操作次数、只读任务的 `answer` 关键事实；参数匹配支持 `$contains`、`$containsAll`、`$regex`、`$oneOf`、`$not`、`$exists`），九个任务都已填写，测试用任务自带的原生调用序列验证判定标准。每次运行记录成功与否、API `usage` 的输入 / 输出 / 缓存 token、轮数、工具调用数、错误调用数（非零退出、`isError`、回放 server 无对应返回值）和耗时；支持 `--trials`、`--task`、`--condition`、`--model`、`--max-turns`、`--concurrency`、`--out`、`--effort`、`--cache`；汇总每个条件的成功率（含 95% Wilson 区间）与 token、轮数、错误调用的均值和中位数，写 `bench/results/eval-<日期>.md/.json`，并打印门槛 1 是否成立。需要 `ANTHROPIC_API_KEY`（支持 `ANTHROPIC_BASE_URL`），没有则给出提示并退出；`--fake-model` 用按任务脚本回放的模型走完整条流水线（不需要密钥，输出带明确标注，且拒绝写入 `bench/results/`），冒烟测试覆盖三个条件（mcp2cli 未安装时跳过）。`@anthropic-ai/sdk` 只是 devDependency，via 本身没有新的运行时依赖。
- 任务文件的回放条目对承载身份的参数（`issue_number`、`id`、元素 `ref`）按参数区分，操作了录制里不存在的对象会失败；`linear-my-work` 补上并列最紧急的 PLT-328 的录制。token 基准的命令序列与数字不受影响。
- `via batch`：从 stdin 读 JSON Lines（`{"tool":"<provider>/<resource>:<verb>","args":{…}}`），各行并发执行，同一 server 遵守其 `concurrency`，另有 `--concurrency <n>` 限制整批在途行数；结果严格按输入顺序输出，单行失败（解析、找不到、deny、危险操作、校验、上游）不影响其他行；text 输出以元信息行分隔并汇总，`-o json` 输出每行一条记录。不再属于「保留名字」的子命令。
- 性能基准 `npm run bench:perf`（`scripts/bench-perf.ts`，需先 `npm run build`）：在隔离的 HOME 里测 `dist/via.js` 各命令的冷启动（无缓存 / 缓存冷 / 缓存热，减去 `node -e 0` 基线）、确定性合成的 1,000 个工具上目录构建、索引构建与查询的耗时、`via <provider> <tool>` 相对官方 SDK 直接调用的开销、每条命令加载的分块与包，经热 daemon 调用的开销与 daemon 的常驻内存（空闲、HTTP 会话、stdio 会话之后；结束时 `via daemon stop`），装有 `bun` 时再测单文件可执行；结果对照 testing.md 的性能目标。除热 daemon 一节外都设 `VIA_NO_DAEMON=1`。合成目录生成器与模块加载追踪放在 `scripts/lib/`，`test/bench/` 与 `test/cli/dist.test.ts` 增加不依赖时间的断言（合成目录可复现、`--version` / `-h` 不加载任何包、无配置的浏览命令不加载 MCP SDK 与 ajv）。
- 工程骨架：`@modelctx/via` 包（ESM、Node 20+，TypeScript strict），tsup 打成单个文件并内联 `data/`，vitest 测试，`typecheck` / `build` / `test` 脚本。
- `src/catalog/`：工具名拆分（切词、去 provider 词、找动作、复合动词、逐词单数化、叶子工具、`resource:verb` 冲突退回叶子、`rename` 覆盖、`deny` 过滤）；分域（配置 → 内置分类表 → 启发式打分 → `other`，按资源拆分，`--why` 的依据）；`SearchIndex`（规范写法三级匹配 + BM25）；工具引用解析与 did you mean；`via`、`via <provider>`、`via <provider> <resource>`、`via find` 的浏览视图。规则放在 `data/verbs.json`、`data/domains.json`、`data/domain-lexicon.json`（`npm run lexicon` 生成）。
- `src/render/`：输出流水线（选数据源、清理噪声、形状判断、表格与 CJK 双宽对齐、单元格与预算截断、游标、媒体落盘、脱敏）、元信息行、`next:` 提示与错误格式、退出码常量。游标存储与媒体落盘在接口之后，0.1 的实现写入用户缓存目录（权限 0700）。规则放在 `data/noise.json`、`data/columns.json`。
- 数据文件的 JSON Schema（`data/schema/`），测试中校验。
- `src/config/`：`loadConfig`（框架配置只读解析、用户配置 `config.yaml`、项目配置 `.via.yaml`、命令行覆盖，按 server 名逐字段合并；同名异义的框架定义记入 `conflicts`；字段校验带路径；坏文件跳过并返回诊断）。
- `data/frameworks/`：Claude Code、Claude Desktop、Cursor、Codex、VS Code、Windsurf 的配置路径与关闭提示，附 `data/schema/framework.schema.json`。各条目尚未按实际安装的版本核对（`verifiedAt` 为 `null`）。
- 框架数据文件按官方文档与源码核对（2026-10-20，路线图 b6），`verifiedAt` 与新增的 `sources` 记录依据：
  - 已核对：Claude Code（补充 tool search 默认延迟加载 schema 的说明）、Claude Desktop（Linux 路径见 VS Code 官方文档）、Cursor（关闭方式改为 Customize 侧栏开关与 `agent mcp disable`）、Codex（源码确认字段；`env_vars` 元素可为 `{ name, source }`）、VS Code（关闭提示改为 Disable 与 `chat.mcp.access`）、Windsurf。
  - Windsurf 自 2026-06-02 起更名为 Devin Desktop，MCP 配置迁到 `~/.config/devin/mcp_config.json`（Windows 为 `%APPDATA%/devin/`），项目级为 `.devin/mcp_config.json` 与 `.devin/mcp_config.local.json`；新增 `devin` 条目，`windsurf` 条目保留旧路径 `~/.codeium/windsurf/mcp_config.json`。
  - 新增框架：`devin`、`gemini-cli`、`antigravity`、`copilot-cli`、`amp`。探测顺序为 claude-code、claude-desktop、cursor、codex、vscode、devin、windsurf、gemini-cli、antigravity、copilot-cli、amp。
  - 未收录（官方文档不足或配置形态不适合现有规则）：opencode（`mcp` 下新旧两种形态并存）、Zed（`context_servers` 里混有扩展提供的 server）、Goose（`extensions` 里有 `cmd`/`envs`/`uri` 等专有写法与内置类型）、Cline（IDE 内的配置路径官方文档未写明）、Continue、JetBrains AI Assistant。
- 凭证引用解析（`env:`、`file:`、`keychain:`，钥匙串懒加载）；`cmd:` 0.1 在加载阶段对项目与框架配置拒绝，用户配置中解析时提示 0.2 才支持。
- 项目级信任存储（真实路径 + SHA-256，目录 0700、文件 0600）；未信任的项目级 server 标记 `trusted: false`。`via trust` 命令留待 0.2。
- `src/protocol.ts`：CLI、daemon 与进程内模式共用的消息类型（Request / Response / Event / ErrorInfo / ResultMeta / 握手）。
- `src/client/`：进程内模式的 MCP client。stdio 与 Streamable HTTP 会话按 server 复用，`listTools` 跟随分页，`callTool` 返回未渲染的原始结果；MCP SDK 仅在首次连接时动态加载。凭证在连接前经 `CredentialResolver` 解析并注入（`auth.bearer`、`auth.headers`、`headers`、stdio `env`）；stdio 子进程只继承基础环境变量。按 server 的 `timeout` 与 `concurrency`（超出排队），只读调用在超时或断线后重试一次。错误映射到退出码 3/4/5/6：凭证缺失、401/403 退出码 4，未信任的 server 在连接前以退出码 5 拒绝，独占 server 启动失败附冲突提示，OAuth 型 server 暂提示改用 bearer。
- 测试夹具：`test/fixtures/mcp/` 基于官方 SDK 的模拟 stdio / Streamable HTTP MCP server；`test/fixtures/config/` 各框架配置样例与 via 用户 / 项目配置。
- `src/cli/args/`：schema 驱动的工具参数解析（`--name value` / `--flag` / `--no-flag` / 点号路径 / 重复数组 / `--args` / `@文件` / stdin / `@@` 转义 / 位置参数 / `--p.` 前缀），按 schema 决定是否解析 JSON，anyOf / oneOf 自动补齐，ajv 懒加载校验（默认 2020-12，`format` 仅警告，外部 `$ref` 跳过），固定英文报错与 `-o json` 的 `details`，`-h` / usage 渲染，`outputSchema` 输出校验。
- `src/cli/`：命令入口与路由（内置子命令 → provider → 资源 / 工具；唯一前缀、大小写与 `-`/`_` 宽松输入；歧义与 did you mean 退出码 3）。全局选项可出现在任意位置，`--p.` 前缀留给工具。支持浏览视图、`-h` 与调用：deny 退出码 5，危险工具需要 `--yes`，`--dry-run`，校验失败且 schema 缓存超过 5 分钟时刷新一次，只读工具重试一次，progress 写 stderr，`outputSchema` 警告，元信息行与游标。
- 目录缓存：每个 server 的 `tools/list` 缓存在用户缓存目录 `catalog/`（权限 0700，键为传输定义与凭证引用的哈希，不含解析后的凭证，TTL 24 小时）。浏览只拉取需要的 server，并行且带超时，失败的 server 显示为 `needs auth` / `failed` / `untrusted`；`via sync` 强制刷新。
- 内置子命令 `find`、`call`、`more`、`servers`、`sync`、`doctor`、`prompt`；`batch`、`auth`、`trust`、`daemon` 保留名字，提示 0.2 才可用。via 自己的配置有 error 级诊断时，除 `doctor` / `servers` 外拒绝执行（退出码 2），避免无效的 deny 规则失效放行。
- `via doctor`：server 状态计数与 `next:`、仍在注入 MCP schema 的框架及 token 估算（4 字节约 1 token）、明文凭证告警（只写键名与文件，不写值）、配置诊断与目录告警，退出码 0/2/4/5/6。`via prompt`：给 agent 的说明块加按域摘要；`--out` 覆盖已有文件需要 `--yes`。
- 打包启用代码分块：`--version` 与 `-h` 只加载入口，MCP SDK、ajv、配置解析器都在首次需要时加载。
- GitHub Actions CI：Node 22 / 24 上类型检查、打包、测试，并在 Node 20 上运行打包产物。
- 测试夹具：GitHub / Linear / Notion / Cloudflare 等 `tools/list` 快照与拆分结果基线（`test/fixtures/`），`npm run split-diff` 离线检查拆分变化；渲染与浏览视图的文件快照；快照与夹具的凭证扫描。
- daemon（`src/daemon/`，`via daemon status|stop|run`）：首次使用时由 CLI 分离拉起，之后的调用复用同一批 MCP 会话（同一个 stdio server 进程跨多次 `via` 调用）；空闲 10 分钟退出，stdio server 空闲 5 分钟停止，`exclusive` 的 server 用完即停；多个 CLI 同时启动只留下一个 daemon，陈旧 socket 自动清理，版本不一致时重启；daemon 或连接不可用时回退为进程内模式并在 stderr 提示一次；`VIA_NO_DAEMON=1` 关闭。socket 与令牌文件权限 0600，CLI 连接前检查属主与权限位。同一 server 的并发上限跨 CLI 进程生效。解析后的凭证不经过 socket，结果、进度和错误在 daemon 内先脱敏。
- `list_changed` 实时刷新：daemon 订阅 `notifications/tools/list_changed`，合并连发的通知后重新拉取该 server 的工具列表，更新内存副本和磁盘缓存。
- `src/cli/backend.ts`：命令访问 MCP server 的唯一入口（`App.backend()` / `App.client()`）：`InProcessBackend`、`DaemonBackend`、`FallbackBackend`；`batch`、`auth` 等不用改动就走 daemon。daemon 模式下参数校验在 daemon 里完成，CLI 进程不加载 MCP SDK 和 ajv。
- 游标在 daemon 模式下保存在 daemon 内存（30 分钟），`via more` 先问已运行的 daemon 再看缓存目录。
- 测试：端到端（真实分离的 daemon 进程：复用、空闲退出、陈旧 socket、版本不一致、启动竞争、跨进程并发上限、`list_changed`、回退、权限、凭证不出现在 socket 上、OAuth、冷启动不加载 SDK/ajv）与协议层测试；`mock-server` 增加 `add_tool`（触发 `list_changed`）。vitest 默认设置 `VIA_NO_DAEMON=1`，daemon 测试显式打开。
- 初始设计文档：愿景、架构、术语表。
- 规范：命令语法、工具名拆分、发现与分域、参数映射、输出与退出码、配置与鉴权、daemon 协议、安全模型。
- 指南：快速上手、与 agent 框架集成、GitHub / Linear / Notion / Cloudflare / 网关类 server 示例、组合用法。
- 开发文档：实现说明、测试与评测、数据文件格式。
- 架构决策记录 ADR 0001–0009。
- 参数映射：object / array 参数支持内联 JSON；明确 JSON 文本型 string 参数原样传入、宽松 schema 的处理与参数合并顺序。
- 参数校验：明确校验流程与范围、`format` 与外部 `$ref` 的处理、schema 过期或出错时的回退、`--no-validate`，以及 `outputSchema` 输出校验。
- 校验报错：固定各类错误的提示格式，多错误逐行列出，`-o json` 时提供结构化 `details`。
- 鉴权：`via auth login --manual`，在无头环境中打印授权 URL，并从终端读取重定向 URL 完成 OAuth。
- 愿景：增加「与相近工具的区别」，明确 via 只接 MCP。
- 评测：token 基准与 agent 评测加入 mcp2cli 作为对照，门槛 1 要求成功率不低于 mcp2cli。
- 待定问题：MCP roots 支持、按使用频率排序。

### Fixed

- 测试（Windows）：daemon 测试的收尾依赖一次 `via daemon status`，它失败时（测试改坏了令牌，或刚被强杀的 daemon 的管道还没消失）错误被吞掉，daemon 和它的 stdio server 都没有被终止，还以沙箱为工作目录，删除沙箱时报 `EBUSY`（`test/daemon/e2e.test.ts` 的连接中断用例、`short-credentials.test.ts` 在 Windows CI 上反复失败）。现在 daemon 启动时由预加载的 `test/helpers/record-pid.mjs` 记下 pid，收尾不经 daemon 也能终止它们，再终止登记过的 server；收尾出错不再被忽略。另一个原因是沙箱删除从未真正重试：Node 22 的 `rmSync` 的 `maxRetries` 只重试顶层目录的「非空」错误，`project` 这类子目录的 `EBUSY` 会立即抛出，而被强杀的 stdio server 释放工作目录稍有延迟。现在用 `removeSandbox` 自行重试最多 10 秒，到期仍失败时在 Windows 上列出最近启动的进程。只改测试，不影响规范与规范写法。
- Windows：`via --version`、`-h` 与浏览命令在 stdout 是管道或文件时不再经 `process.stdout` 输出（会加载 `net` 与 `stream`，冷启动变慢）；只有控制台才用真正的流（控制台按代码页处理字节，需要流的 UTF-16 写入）。输出内容不变。
- 凭证很短或很常见（`GH_TOKEN=x`、`true`、`1`、`json`、`text`）时，脱敏会改写结构：daemon 对整份 `tools/call` 结果的所有字符串和键做子串替换，把内容块的 `type: "text"` 改成 `te***t`，CLI 随即报 `internal error: blockPieces is not a function or its return value is not iterable`；进程内模式虽不崩，也会改写 JSON 的键、`error:` / `next:` 标签、`rule` 之类的字段、资源的 `mimeType`、prompt 的 `role` 和保存下来的媒体文件路径，`-o json` 与 `via batch -o json` 的输出可能不再是合法 JSON。现在脱敏保持结构：只替换字符串值里的凭证，键、协议字段（`type`、`mimeType`、`role`、base64 的 `data`/`blob`）、数字布尔、via 自己写的文字和保存的文件路径不动；这些位置只扫描 8 个字符以上的凭证，更短的凭证（`x`、`1`）只在内容里替换（宁可让正文变成 `a *** b`，也不放过）。`structuredContent` 与 `_meta` 里的字段仍是内容，不享受协议字段的豁免。规则见 output.md「脱敏的范围」、security.md、daemon.md；daemon 的 `redact` 请求新增 `value` 形式，用于回显用户给出的参数（`--dry-run`）。
- daemon 的游标不再随 daemon 空闲退出（10 分钟）而提前失效：daemon 与进程内模式一样把游标写入用户缓存目录（0700 目录、0600 文件、内容已脱敏、TTL 30 分钟），`via more` 在 daemon 退出后仍可续读。
- deny 规则的 ReDoS：项目配置可以追加会灾难性回溯的正则（如 `^(a+)+$`）卡死 via。现在加载时静态检查（嵌套量词、被重复分组里重叠的候选分支、反向引用、开放量词超过 3 个、长度超过 200 字符），不通过的规则按无效规则处理：忽略并给出 error 级诊断 `unsafe-deny`，CLI 停止执行；匹配只在不超过 256 字符的写法上进行，更长的工具名按 deny 处理（config.md「deny」）。
- deny 规则与 `rename`：按工具默认规范写法写的规则（如 `^github/file:delete$`）在用户用 `rename` 改名后不再命中，该工具重新可见。现在一条规则同时匹配当前规范写法、原始名写法和默认规范写法（命名规则对原始名的拆分结果，不含 `rename`）（config.md「deny」）。
- OAuth 刷新遇到不可写的登录存储时，新 token 只在内存里使用且没有任何提示，别的进程（以及之后的调用）读到的仍是旧记录，轮换 refresh token 的 server 会因此让登录失效。现在：当前会话继续用内存里的新记录（后续刷新不再读回存储里作废的旧 refresh token），并在 stderr 提示一次 `warning: could not save the refreshed OAuth login for <provider> …`（daemon 里作为 `log` 事件转发给触发刷新的请求）；`via doctor` 对不可写的文件存储给出提示和 `chmod` 建议（auth.md、daemon.md、agent-integration.md）。
- daemon 在不同 shell 的 `env:` 值不同时反复重启：两个 shell 里同名变量（如 `GH_TOKEN`）取值不同，每次交替调用都会让 daemon 因摘要不一致而重启，会话和 stdio 子进程随之丢失。现在 daemon 回复 `stale` 时，CLI 不再重启 daemon，而是只把这个 server 的这一个请求改在进程内完成（也不会把取值发给 daemon，凭证值不过 socket 的约定不变）；与 daemon 环境一致的 shell 继续用 daemon，另一个 shell 各自用自己的取值，没有设置变量的调用方得到退出码 4 而不是 daemon 环境里的值。代价：取值不一致的 shell 里，该 server 的 stdio 子进程每次调用都重新拉起（daemon.md「环境与工作目录」）。
- ADR 0008 的背景误称 mcp2cli 采用代码生成；mcp2cli 实际是运行时分发。
- 多个 server 同时解析凭证（`via doctor`、`via sync`）时，CLI 可能创建两个凭证解析器和两个 MCP client：脱敏只认其中一个解析器的值，另一个解析出的凭证可能漏出脱敏，退出时也只关闭一个 client。现在一次运行共用一个。
- Windows 首次 CI 暴露的问题（不改变规范）：`roots` 里 `file://` URI 的显示名在 Windows 上取不到（`fileURLToPath` 拒绝没有盘符的 `file:///already/a/uri`），现在无法转成本机路径时直接取 URI 路径的末段，各平台一致；`bench:eval --fake-model` 的输出目录检查在目标与 `bench/results/` 位于不同盘符时误判为「在其中」（`path.relative` 此时返回绝对路径），现在只把真正的 `..` 段当作在外面。
- 测试（Windows）：`cmd:` 的批处理夹具以 `exit /b 0` 结束（`set /p` 读 NUL 会让退出码变成 1）；`splitCommandLine` 的 POSIX 用例显式传 `'linux'`；`via trust` 的 `· trusted` 断言用真实路径（`realpath.native` 会展开 `RUNNER~1` 这类 8.3 短名）、`next:` 的引号按平台（Windows 用双引号）；快照与路径断言按平台归一分隔符（`test/helpers/portable.ts`），`via servers` 快照的列宽不再依赖沙箱路径长度；不存在模式位的断言在 Windows 上略过；沙箱清理先结束测试看到的所有 daemon 与 stdio server 进程再删目录，并对 `EBUSY` 重试。

### 影响规范写法的改动（动词表、单数化规则）

首个实现对规范里的几处细节做了补充，初版的 `data/verbs.json` 以此为准：

- 动词表在 naming.md 的最小集合之外增加：`push`、`call`、`describe`、`batch`、`enable`、`disable`、`fork`、`resolve`、`unresolve`。影响的规范写法：`push_files` → `file:push`，`enable_pr_auto_merge` → `pr-auto-merge:enable`，`disable_pr_auto_merge` → `pr-auto-merge:disable`，`fork_repository` → `repository:fork`，`resolve_review_thread` → `review-thread:resolve`，`unresolve_review_thread` → `review-thread:unresolve`，网关的 `asl_call` / `asl_describe` / `asl_batch` → `asl:call` / `asl:describe` / `asl:batch`。
- 资源中的每个词都单数化，而不只是末词（`actions_run_trigger` → `action-run:trigger`，与 naming.md 的示例一致）。
- 单数化新增 `singularIrregular`（`statuses` → `status`、`aliases` → `alias`、`caches` → `cache`、`people`、`children`、`indices`、`analyses`），`singularExceptions` 增加 `alias`、`aws`、`atlas`、`bias`、`canvas`、`gas`、`ios`、`lens`、`species`；长度不超过 2 的词不做单数化。
