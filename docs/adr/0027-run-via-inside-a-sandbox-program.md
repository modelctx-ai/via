# 0027. 可选地把整个 via 放进沙箱程序里运行（`sandbox`）

- 状态：已接受
- 日期：2026-10-26

取代 [ADR 0026](0026-sandbox-stdio-server-processes.md)（提议中，未实现）。讨论见 [issue #38](https://github.com/modelctx-ai/via/issues/38)。

## 背景

stdio server 子进程由 via 以用户身份启动，拥有用户的全部文件与网络权限；`via trust` 只决定「运行与否」（[security.md](../spec/security.md)）。ADR 0026 提议只包裹 stdio 子进程：按 server 写策略，srt 作为 `optionalDependencies` 在启动路径上 `import()`。

维护者对 0026 的要求有三处不同：

1. **作为可选项**：在用户配置里开启，开启后成为默认行为，不需要按 server 逐个声明。
2. **语义是「裸 `via` 等价于 `srt via`」**：整个 via 进程在沙箱里运行，而不只是它派生的子进程。
3. **与 `@anthropic-ai/sandbox-runtime` 解耦**：不作为 npm 依赖（可选依赖也不要），不 `import` 它的库接口。

## 决策

1. **配置**（只在用户配置与命令行覆盖里生效，[config.md](../spec/config.md#sandbox)）：

   ```yaml
   sandbox:
     enabled: true          # 默认 false
     command: srt           # 沙箱程序；字符串或词的列表，默认 srt
     policy:                # 交给沙箱程序的设置：映射原样写成 JSON，或写一个 JSON 文件的路径
       network: { allowedDomains: [registry.npmjs.org] }
       filesystem: { allowWrite: ["."] }
     exclude: [auth, trust, daemon]   # 在沙箱外运行的子命令，默认这三个
   ```

2. **怎么启动**：开启后，`via <参数…>` 由外层的 via 改为启动

   ```text
   <command…> --settings <设置文件> -- <node> <via 入口> <参数…>
   ```

   并原样返回它的退出码。这正是 srt 的命令行（`--` 之后是 argv，srt 自己做引用，参数不经 via 拼成字符串）。via 对沙箱程序的全部假设就是这一行：任何接受 `--settings <文件> -- <argv>` 的程序都可以写进 `command`。via 不依赖、不加载 srt 的包，`package.json` 不变。

3. **设置文件**：via 把 `policy` 原样写成 JSON（字段不校验，由沙箱程序校验；它拒绝时的报错直接显示），只追加四项，存在用户缓存目录的 `sandbox/settings-<哈希>.json`（0600）：
   - `filesystem.allowWrite` 追加 via 的缓存目录（目录缓存、游标、媒体、日志、任务记录）和 OAuth 文件目录（刷新后的令牌要能存下来）；
   - `filesystem.denyWrite` 追加 via 的用户配置目录与信任记录 `trust.json`：沙箱里的任何东西都不能改写 `sandbox` 本身把它关掉，也不能为下一次运行信任一个项目；
   - `network`、`filesystem` 缺的数组补成空数组。

   这是 via 唯一知道 srt 设置形状的地方（`src/cli/sandbox.ts` 的 `sandboxSettings`）。

4. **沙箱里不用 daemon**：里层的 via 带 `VIA_NO_DAEMON=1` 运行，在自己的进程里连 server。srt 在 Linux 上以 `--die-with-parent`、`--unshare-pid` 运行 bubblewrap（核对于 srt 0.0.81 的源码），在里面拉起的 daemon 会随这一条命令的沙箱一起结束；macOS 上 daemon 能活下来，但 srt 的网络代理随 srt 退出。所以每条命令都是进程内模式：stdio server 每次重新启动，没有跨调用的会话。

5. **不重复包裹**：里层的 via 带 `VIA_SANDBOXED=1`，看到它就不再包裹自己（`via serve` 在沙箱里时，它的每次元工具调用也就不再包裹）。

6. **在沙箱外运行的**：`sandbox.exclude` 列出的子命令（默认 `auth`、`trust`、`daemon`：OAuth 登录要打开浏览器、监听回调、读写钥匙串；`via trust` 是人在终端里的决定，要写 `trust.json`；`daemon` 在沙箱模式下用不上），`help` 与 `-h` 打印的固定用法，`daemon run`（via 拉起 daemon 的内部入口）。浏览、搜索、调用、`doctor` 都在里面。

7. **失败关闭**：沙箱程序不存在是退出码 6，`next: ask the user: srt is not installed (needed by sandbox.enabled in the via config)`；`policy` 指向的文件读不出或不是 JSON 对象是退出码 2。都不会退回到不加沙箱运行。被 `commands` 拒绝的子命令在启动沙箱之前就被拒绝（[ADR 0028](0028-restrict-and-hide-subcommands.md)）。

8. **只读用户配置**：项目配置里的 `sandbox` 被忽略并告警（`sandbox-forbidden`），与 `search.semantic` 同理：仓库不能关掉沙箱，也不能放宽它的策略。

9. **可见性**：`via doctor` 在 `proxy`、`logs` 那一节多一行 `sandbox`，写明程序、设置来源，以及这次检查是否在沙箱里运行。

## 备选方案

- **ADR 0026：只包裹 stdio 子进程，按 server 写策略，srt 作为可选依赖**。隔离更细：via 自己、钥匙串、OAuth 回调、daemon 都在沙箱外，server 读不到 via 的凭证文件。但它把 srt 的库接口变成 via 的依赖，也不是维护者要的「裸 via 等价于 srt via」。保留为以后可以再加的模式（例如 `sandbox.scope: servers`），本 ADR 不排除它。
- **daemon 在沙箱里常驻**（外层 CLI 拉起 `srt via daemon run`，经 socket 通信）：能保留会话，但 srt 在 Linux 上默认用 seccomp 拦截 Unix socket 的创建，要打开 `allowAllUnixSockets`；daemon 与它的子进程共用一份长期运行的策略，`policy` 改了要重启 daemon。先不做。
- **用 srt 的库接口包裹**：要么是硬依赖，要么是可选依赖加懒加载；两者都违背第 3 条要求。
- **自己实现 bubblewrap、Seatbelt 的策略翻译**：重复造轮子，见 ADR 0026。

## 后果

好处：

- 一行配置就能让 via 的所有调用（以及它派生的 stdio server、`cmd:` 助手）在用户声明的文件与网络范围内运行。
- 与 srt 解耦：换沙箱程序、换 srt 版本都不改 via；没有新依赖，`npm install` 的体积与冷启动路径都不变（没有开启时只多读一次配置文件的文本，见 [ADR 0028](0028-restrict-and-hide-subcommands.md) 的「读取时机」）。

代价与风险：

- **server 与 via 在同一个沙箱里**：via 能读的（凭证引用指向的文件、OAuth 记录、`env:` 读到的环境变量）server 也能读，`env` 里注入的凭证照样交给子进程。它限制的是「这一批进程」能写哪里、能连哪里，不是凭证隔离；[愿景](../overview/vision.md#非目标)里「不提供凭证隔离」这条非目标不变。
- **没有 daemon**：每条命令都重新启动 stdio server，`npx -y …` 一类慢 server 每次都慢；每条命令还多一次沙箱程序的启动（srt 本身是 Node 程序）。目录缓存仍在磁盘上，浏览命令照常从缓存读。
- **钥匙串与回调**：Linux 上 srt 默认拦截 Unix socket，Secret Service（D-Bus）多半连不上，`keychain:` 引用在沙箱里预计解析失败（退出码 4，未实测）；macOS 上 Seatbelt 是否放行钥匙串同样没有实测。需要时改用 `env:`、`file:`，或把相关子命令放进 `exclude`。OAuth 登录默认在沙箱外运行；沙箱里的刷新要能连到授权服务器，需要把它的域名写进 `policy`。
- **网络默认全部拒绝**（srt 的默认值）：HTTP server、OAuth、`search.semantic` 的端点、`npx` 的包注册表都要写进 `network.allowedDomains`。
- **`VIA_SANDBOXED=1` 能被伪造**：同一个 shell 里的 agent 可以设置它跳过沙箱。沙箱防的是 via 运行的 server，不是与用户同权限的 agent（[security.md](../spec/security.md) 顶部的边界）。
- **原生 Windows 不在承诺范围内**：srt 的 Windows 后端是 alpha 且需要一次提权安装；via 在 Windows 上按 `.cmd` 规则启动沙箱程序，但没有验证过。Windows 用户在 WSL2 内使用（[快速上手](../guides/getting-started.md#windows)）。

验证：自动测试用一个记录参数的假 srt（`test/fixtures/sandbox/fake-srt.mjs`），并经打包后的 CLI 跑一遍端到端。另在 Linux 上用 srt 0.0.81 与 bubblewrap 0.9.0 手工验证：浏览、stdio server 调用、`via doctor` 在沙箱里完成；server 写不了 `allowWrite` 之外的文件，也写不了 via 的配置；HTTP server 在域名写进 `allowedDomains` 之前连不上。这次验证还发现打包后的 CLI 在设置了代理变量时连不上任何 HTTP server（undici 的导出形状），已一并修复。macOS 与 WSL2 没有验证。

不做的事：

- 不加依赖，不加载 srt 的库接口。
- 不校验 `policy` 的字段。
- 不包裹单个 server（ADR 0026 的模式），不做 microVM 后端。
