# 0026. 用进程级沙箱包裹 daemon 派生的 stdio server 子进程

- 状态：被 ADR-0027 取代
- 日期：2026-10-26

> 这是提议，还没有任何实现，也没有加依赖。接受之前，本文的配置字段只是草案，不进 [config.md](../spec/config.md)；接受时再随实现把规范写进 spec，并按[流程](README.md#流程)更新状态。讨论见 [issue #38](https://github.com/modelctx-ai/via/issues/38)。

## 背景

stdio server 子进程由 via（进程内模式下是 CLI，常驻模式下是 daemon）以**用户身份**直接 `spawn`：一个被 `via trust` 放行、或从框架配置读进来的 `npx -y @someone/server`，拥有用户的全部文件与网络权限。这与[安全模型](../spec/security.md)里「不可信仓库里的项目配置」一行相邻：`via trust` 只能决定「要不要运行它」，运行起来之后 via 什么也管不了。

现有的边界是有意划出来的：

- via 是独立的本地 MCP client，不是网关；凭证隔离、按 key 的权限、审计交给网关（[ADR 0002](0002-standalone-client-not-gateway.md)）。
- [愿景](../overview/vision.md#非目标)的非目标里写着「不提供凭证隔离」；via 与 agent 同用户运行，只能降低凭证意外暴露的概率。
- via 不为特定 server 或网关写适配（[ADR 0007](0007-no-gateway-specific-adaptation.md)），也只读引用框架配置（[ADR 0003](0003-read-only-framework-configs.md)）。

网关是现在的官方答案，适合团队，不适合个人开发者；把整个 agent 关进沙箱（Docker Sandboxes、srt）能解决问题，但粒度是整个 agent 会话，不是单个不可信的 server。agent 框架自己的沙箱通常也不包住本地 MCP server：Claude Code 的沙箱文档写明本地 MCP server 在沙箱外以完整权限运行（来源见末尾）。

要决定的是：针对「单个不可信 stdio server」做一层限制，算不算进入 via 的边界，如果算，怎么做才不破坏冷启动、确定性和零适配这几条约束。

## 调研结论

调研于 2026-10-26 完成，对象是面向 agent 的本地沙箱（srt、Codex 沙箱、bubblewrap/nsjail/firejail/Landlock、gVisor、microsandbox、smolvm、Docker Sandboxes、Apple container）与托管沙箱（E2B、Modal、Vercel、Cloudflare、Daytona）。star 数、启动延迟等数字多为项目自述或二手来源，**没有经过我们实测**，这里不作为依据。

- **进程级首选 `@anthropic-ai/sandbox-runtime`（srt）**：macOS 用 Seatbelt，Linux 与 WSL2 用 bubblewrap；网络默认拒绝，经宿主侧代理按域名放行；文件系统默认可读，写入需显式授权。仍在 beta。Windows 原生为 alpha，需要一次 UAC 提权安装本地账户与过滤器，Schannel 类工具（`curl.exe` 等）在沙箱内不可用，不能当作前提。共享宿主内核，不抵御内核漏洞。
- **microVM 可作第二后端**：microsandbox 与 smolvm 都基于 libkrun，隔离更强，调研时点都处于 beta，Windows 需要 Windows Hypervisor Platform（WHP）。自述启动在百毫秒量级，每个 server 要多一个 VM，stdio 要在宿主与 VM 之间桥接。
- **不依赖托管沙箱**：它们拿不到本地凭证与文件，也不是「在本机用 via」的前提。Daytona 的仓库已于 2026-10-03 归档，不能作为开源依赖。
- **Docker Sandboxes（`sbx`）面向整个 agent**：每个沙箱一个 microVM，Windows 上同样需要 WHP；适合「把整个 agent 关进去」，不适合当 via 的库依赖。
- **Codex 的沙箱**（Seatbelt、Landlock+seccomp、Windows 原生的多档方案）是 Codex 自己的实现，不能复用，只能参考。
- **Docker/Podman 当沙箱**对 via 的几条宿主侧路径都不顺：daemon 的 Unix socket、`@napi-rs/keyring`（容器里通常没有 Secret Service）、OAuth 的 localhost 回调（需要绑到非回环地址并发布端口）、只读挂载框架配置（Windows 宿主还有 `/mnt/c` 的路径与性能问题）。

## 决策

提议采纳下面这些。除非另有说明，都是「接受后实现时遵守」的约束。

1. **进入边界，但只做进程级、按 server 选择开启、默认关闭**。限制的对象是 daemon（或进程内模式下 CLI）派生的 **stdio server 子进程**，不是 agent、不是 via 自己。HTTP server 不涉及。默认行为与今天完全一致；没有写 `sandbox` 的 server 不受影响，框架配置里读进来的 server 也一样（只读引用，via 不替用户改动它们，需要时在 via 自己的覆盖层里为它写 `sandbox`）。

2. **`SandboxBackend` 接口，三个取值 `none | srt | microvm`**。所有 stdio 子进程的启动都经过同一处；后端只负责「把一条启动命令包成在沙箱里运行的命令」和「报告自己是否可用」。草案（接受时以代码为准）：

   ```ts
   type SandboxBackendId = 'none' | 'srt' | 'microvm';
   interface SandboxBackend {
     readonly id: SandboxBackendId;
     /** 平台与依赖是否满足（bubblewrap、Seatbelt、srt 是否装了）；不可用时给出原因与 next:。 */
     available(): Promise<{ ok: true } | { ok: false; reason: string; next?: string }>;
     /** 返回实际要启动的命令；调用方负责启动与回收。 */
     wrap(spawn: { command: string; args: string[]; env: Record<string, string>; cwd?: string }, policy: SandboxPolicy): Promise<{ command: string; args: string[]; env: Record<string, string>; dispose?: () => Promise<void> }>;
   }
   ```

   `microvm` 只占位：等 microsandbox 或 smolvm 出 1.0（或有同等的稳定性证据）再接，在此之前配置它是配置错误。

3. **策略由配置按 server 声明，不为具体 server 写适配**（[ADR 0007](0007-no-gateway-specific-adaptation.md)）。字段草案（字段名借用 srt 的写法，接受时需对照 srt 当时的版本核对；**不进 config.md**）：

   ```yaml
   servers:
     some-tool:
       command: npx
       args: [-y, "@someone/server"]
       sandbox:
         backend: srt              # none（缺省）| srt | microvm
         network:
           allowedDomains: [registry.npmjs.org, api.example.com]   # 缺省：全部拒绝
         filesystem:
           allowWrite: [~/work/tmp]    # 缺省：不可写
           denyRead: [~/.ssh, ~/.aws]  # 在 via 自己的目录之外追加
   ```

   - via 自己的用户配置、数据和缓存目录（含 daemon 令牌文件、文件形式的 OAuth 登录）**总是**在子进程的 `denyRead` 里，用户不能去掉：令牌文件能让子进程冒充 CLI 去连 daemon，OAuth 文件是用户的登录。
   - 放宽类字段（`allowedDomains`、`allowWrite`）只在用户配置与命令行覆盖里生效；项目配置里的 `sandbox` 只能收紧（改成更严的后端、追加 `denyRead`/`denyWrite`），与 `deny` 同理（[config.md](../spec/config.md)）。项目配置不能借 `sandbox` 给一个不可信 server 开洞。
   - 配了 `sandbox` 却不可用（平台不支持、没装 bubblewrap、srt 没装）时**失败关闭**：该 server 不启动，错误信息说明原因并附 `next:`，不会悄悄退回无沙箱。退出码在实现时按 [output.md](../spec/output.md#退出码) 现有含义选取，不新增。

4. **srt 作为 `optionalDependencies`，只在配了沙箱的 server 的启动路径上 `import()`**。浏览命令、`find`、不带沙箱的调用都不加载它（AGENTS.md：CLI 冷启动是核心指标）；未安装时 `sandbox: { backend: srt }` 按上条失败关闭，`next:` 给出安装命令。

5. **只包裹子进程；宿主侧路径不动**：daemon、keyring、OAuth 回调、框架配置的只读读取都留在沙箱外。子进程只通过 stdio 管道与 via 通信，不依赖 Unix socket（srt 默认拦截）。这也意味着子进程够不着 daemon 的 socket。

6. **`env` 里注入的凭证值仍会进入子进程。沙箱不解决这件事**，文档必须写明：`sandbox` 不是凭证隔离，[愿景](../overview/vision.md#非目标)里「不提供凭证隔离」这条非目标不变。它做到的是缩小一个不可信 server 能碰的范围：读不到 `~/.ssh` 一类文件、写不到工作目录之外、默认只能连允许的域名；在网络收紧时，env 里的凭证也只能被送到允许的域名，这降低但不消除泄露的可能（允许的域名本身可以是攻击者的）。需要不让 server 拿到凭证时仍然用网关或最小权限的 token。

7. **可见性**：`via trust` 在显示项目级 server 时，同时显示它将在哪种沙箱策略下运行（后端、可联网的域名、可写目录），让确认是对「在这个限制下运行」的确认；`via doctor` 报告各后端（bubblewrap、Seatbelt、srt）在本机是否可用。两者都只读，不改变既有退出码规则。命令面不新增子命令；issue 里说的 `via sandbox` 指这项能力，不是一个新的命令组。

8. **平台范围**：先支持 macOS、Linux、WSL2（srt 在这三处的后端）。原生 Windows 不在第一版承诺之内：srt 的 Windows 后端是 alpha 且需要提权，与 [ADR 0012](0012-windows-pipe-name-and-batch-files.md) 的「不要求管理员、不引入原生依赖」不一致。Windows 用户的推荐路径是在 WSL2 内使用 via（[快速上手](../guides/getting-started.md#windows)），那里 srt 走 bubblewrap。

## 备选方案

- **维持现状，文档推荐用户把整个 agent 关进 Docker Sandboxes 或 srt**：能解决问题，不增加 via 的维护面。粒度是整个 agent 会话，而不是单个不可信的 server；而且这条建议今天也成立，不需要 ADR。保留为「不接受本提议时」的结论，并且在接受之前不妨碍它。
- **用网关托管不可信 server**：现在的官方答案（[ADR 0002](0002-standalone-client-not-gateway.md)），适合团队；个人开发者没有网关。两者不冲突。
- **自己用 bubblewrap、Seatbelt 实现**：不依赖 srt，但要自己维护两套平台的策略翻译与代理，且 srt 已经封装了域名放行的代理；重复造轮子。
- **直接以 microVM 为第一后端**：隔离最强，但 microsandbox、smolvm 都在 beta，Windows 需要 WHP，每个 server 多一个 VM，stdio 要桥接，凭证不进 VM 的说法是自述、待验证。作为第二后端留口。
- **用 Docker/Podman 包 server**：见上面的调研，会和 daemon socket、keyring、OAuth 回调都发生摩擦。
- **默认对所有 stdio server 开启沙箱**：会让现有的 server（要写任意目录、要联网到任意域名）在升级后坏掉，也与 via 其余部分默认行为不变的做法不一致；只做按 server 选择开启。
- **依赖托管沙箱（E2B、Vercel、Modal、Cloudflare）**：拿不到本地凭证和文件；Daytona 已归档。

## 后果

好处：

- 个人开发者第一次有办法把「一个来路不明的 stdio server」限制在有限的文件与域名范围内，而不必把整个 agent 搬进沙箱。
- 与现有约束相容：默认关闭、懒加载、不为具体 server 写适配、不写框架配置。

代价与风险：

- 新增一个可选依赖和一层要维护的策略翻译；srt 本身是 beta，上游的行为变化会直接影响 via。
- 用户要为每个想限制的 server 写策略。`npx -y` 一类 server 至少要放行包注册表域名，策略写得过严会让 server 启动不了；失败关闭让这类问题在配置阶段而不是静默暴露，但排错成本由用户承担。
- 共享宿主内核：srt 不抵御内核漏洞，强隔离要等 microVM 后端。
- 容易被误读成「via 现在有凭证隔离」。文档、`via trust` 的显示与本 ADR 都要重复第 6 条。
- 可能出现与现有行为的交互需要处理，见下面的实测清单（代理变量、进程回收）。

不做的事：

- 不加依赖、不写沙箱代码（本 ADR 只是提议）。
- 不包裹 daemon、CLI 自己，也不包裹 HTTP server。
- 不处理 `env` 里的凭证（第 6 条）。
- 不依赖托管沙箱，不依赖 Daytona。
- 不实现 microVM 后端；不承诺原生 Windows。
- 不对框架配置读进来的 server 默认套沙箱，不写任何框架配置。

## 动手前需要实测

下面这些在调研里要么是自述，要么没有找到依据，动手前逐项实测，结果记在对应的 `bench/results/` 或接受时的 ADR 补充里：

1. srt 包裹 `npx -y …` 与 `uvx …` 子进程：包注册表域名放行是否够用；子进程的 stdin/stdout 管道是否干净（不被沙箱包装器的输出污染），退出码与信号是否原样传回。
2. via 停止 stdio 子进程（空闲 5 分钟、daemon 退出）时，信号是否能传到被包裹的真正的 server 进程，不留孤儿进程。
3. srt 的包装接口接受的是 argv 还是一条命令字符串。via 启动 stdio 命令不经 shell，并对参数做检查（[ADR 0012](0012-windows-pipe-name-and-batch-files.md)）；若 srt 只能接受命令字符串，则 via 需要在 POSIX 上做一次可证明正确的引用，或不能采用。
4. srt 对 Unix socket 的默认拦截是否如描述（子进程连不到 daemon 的 socket）；`denyRead` 对 via 目录的保护是否生效。
5. srt 经宿主侧代理放行域名时，是否改写子进程的代理环境变量；via 现在把 `HTTPS_PROXY` 等转发给 stdio 子进程（[config.md](../spec/config.md#代理)），两者如何叠加、srt 的代理上游是否遵守用户的代理，都需要实测。
6. 额外开销：冷启动一个被包裹的 server 比不包裹多多少毫秒（对照 [perf 基准](../development/testing.md#性能目标)）；daemon 内每个会话多多少内存。
7. Ubuntu 24.04 及以后默认限制非特权用户命名空间，bubblewrap 需要 AppArmor 配置；WSL2 发行版里 bubblewrap 是否开箱可用。`via doctor` 的探测要能区分这些失败原因。
8. macOS Seatbelt 下 Node 子进程的行为（`node` 自己需要读的路径），以及 `keychain:` 解析在 daemon 侧不受影响。

## 来源

调研时点 2026-10-26；链接是当时抓取的页面，页面内容会变。

- srt（`@anthropic-ai/sandbox-runtime`）：<https://github.com/anthropics/sandbox-runtime>
- Claude Code 沙箱文档（本地 MCP server 在沙箱外运行；Windows 支持范围）：<https://code.claude.com/docs/en/sandboxing>
- Codex 的 Windows 沙箱：<https://learn.chatgpt.com/docs/windows/windows-sandbox>
- microsandbox：<https://github.com/superradcompany/microsandbox>
- smolvm：<https://github.com/smol-machines/smolvm>
- Docker Sandboxes 的架构：<https://docs.docker.com/ai/sandboxes/architecture/>
- bubblewrap：<https://github.com/containers/bubblewrap>
- Daytona（仓库页显示 2026-10-03 已归档）：<https://github.com/daytonaio/daytona>
