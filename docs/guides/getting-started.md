# 快速上手

> 当前版本 0.3.1。命令与输出以 [规范](../spec/) 为准，1.0 之前可能调整。

## 1. 安装

需要 Node.js 20 或更新版本（推荐 22）。

```bash
npm install -g @modelctx-ai/via
via --version
```

via 只通过 npm 分发（[ADR 0023](../adr/0023-npm-is-the-only-distribution-channel.md)）：没有 Homebrew formula，没有免装 Node 的单文件可执行，也没有签名或公证的安装包。没有 Node.js 的机器（容器、CI 镜像）先装 Node 再用 npm。

从源码安装（开发 via 本身时，需要 Node.js 20+）：

```bash
git clone https://github.com/modelctx-ai/via.git && cd via
npm ci && npm run build && npm link
```

### Windows

via 在 Windows 10 / 11 上与 macOS、Linux 用法一致（Node.js 20+，推荐 22），下面几点不同。agent 在 Windows 上用 via 时更推荐的做法是把二者都装进 WSL2（见本节末尾的[推荐姿势](#推荐姿势agent-与-via-都装在-wsl2-内)）：

- 用户配置在 `%APPDATA%\via\config.yaml`，缓存与信任记录在 `%LOCALAPPDATA%\via\`；`~` 指 `%USERPROFILE%`，配置里的路径可以写 `/` 或 `\`，`%NAME%` 会被展开。
- 框架配置里的 `command: npx`（或 `uvx`、`pnpm` 等 `.cmd` 垫片）可以直接用：via 在 `PATH` 里按 `PATHEXT` 找到 `npx.cmd` 再启动，不会运行当前目录里同名的文件。参数里带 `"` 或 `%` 的 `.cmd` 命令会被拒绝（改用 `node` 加脚本路径，或 `.exe` 形式的命令）。详见 [config.md](../spec/config.md#windows-上启动-stdio-命令)。
- 常驻 daemon 和 macOS、Linux 一样自动拉起（named pipe，无需防火墙放行，也不会弹窗）；不想要时设 `VIA_NO_DAEMON=1`（PowerShell：`$env:VIA_NO_DAEMON = "1"`）。
- `keychain:` 用 Windows 凭据管理器；OAuth 登录同样先存凭据管理器，放不下时退回 `%LOCALAPPDATA%\via\Data\oauth\` 下的文件（靠用户目录的 ACL 保护，[security.md](../spec/security.md#windows-上的文件权限)）。
- `cmd:` 凭证里的 Windows 路径可以直接写：`cmd:"C:\Program Files\1Password CLI\op.exe" read op://dev/exa/key`。
- 输出一律是 UTF-8。Windows Terminal、VS Code 终端和 PowerShell 7 直接正常显示；旧的 PowerShell 5.1 / `cmd.exe` 在管道或重定向时按 OEM 代码页解码，`·`、`…` 和中文会变成乱码，先执行 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new()`（cmd.exe 里 `chcp 65001`）。用 `>` 重定向 via 的输出到文件时，PowerShell 5.1 会写成 UTF-16；via 读取 `--args @文件`、标准输入、`file:` 凭证和配置文件时认得 UTF-8 BOM 与 UTF-16 BOM，其他编码（如 GBK）不猜。
- 向原生程序传参时，PowerShell 5.1 会吃掉参数里的内层双引号，`--args '{"a":1}'` 到不了 via。改用文件（`--args @args.json`）或标准输入（`'{"a":1}' | via … --args -`）；PowerShell 7.3 起（`$PSNativeCommandArgumentPassing = 'Standard'`，默认值）没有这个问题。`via batch` 的输入是标准输入，同样不受影响，CRLF 行尾与开头的 BOM 都会被接受。

#### 推荐姿势：agent 与 via 都装在 WSL2 内

via 在 Windows 原生环境能用（ADR 0012，CI 全量），但 agent 实际是在用户的 shell 里生成命令：PowerShell 5.1 吃内层双引号，`cmd.exe` 不认单引号，agent 生成的命令大多又假设 POSIX shell（`$(…)`、heredoc、`| jq`）。[output.md](../spec/output.md) 的「可粘贴的命令行」为此按 shell 做了三套引用规则，但 agent 自己写的命令不受 via 控制。所以 Windows 上的推荐姿势是：**agent 框架和 via 都装在同一个 WSL2 发行版里**，在发行版的终端里工作。

做法：

1. 在 WSL2 发行版（Ubuntu 等）里装 Node.js 20+，`npm install -g @modelctx-ai/via`；命令行 agent（Claude Code、Codex 等）也装在这个发行版里。
2. 项目放在发行版自己的文件系统（`~/work/…`），不要放在 `/mnt/c/…` 下。
3. 在发行版里 via 的行为与 Linux 一致：用户配置在 `~/.config/via/config.yaml`，daemon 走 Unix socket，本页「Windows」一节的其余差异都不适用。

为什么：

- **冷启动**：via 的冷启动是核心指标（[性能目标](../development/testing.md#性能目标)）。agent 在一侧、via 在另一侧，或者 via 读 `/mnt/c` 下的文件，都要经过 Windows 与 Linux 之间的跨文件系统访问；微软的文档也建议把文件放在使用它们的工具所在的一侧（[WSL 文件系统](https://learn.microsoft.com/en-us/windows/wsl/filesystems)）。同侧才能保住 via 的启动优势。具体慢多少没有测过，见下面的待测清单。
- **引号**：POSIX shell 里 `--args '{"a":1}'` 就是字面写法，不用绕到 `--args @文件`。
- **agent 的习惯**：agent 生成的命令、管道和 heredoc 在 bash 里直接可用。

在 WSL 里要留意几处：

- **Windows 侧的框架配置**（Claude Desktop、Cursor 等装在 Windows 上的框架）不在 `auto` 探测的路径里（那些是 Linux 路径）。在 `sources` 里显式列出，路径用 `/mnt/<盘符>/…`（[config.md](../spec/config.md) 的 `sources` 一节：列表项含 `/` 即按文件路径处理；用户配置里列出的文件按用户级处理，不需要 `via trust`）：

  ```yaml
  # ~/.config/via/config.yaml
  sources:
    - claude-code        # 发行版内的框架仍可按 id 列出
    - /mnt/c/Users/<name>/AppData/Roaming/Claude/claude_desktop_config.json
    - /mnt/c/Users/<name>/.cursor/mcp.json
  ```

  这些文件是只读读取的，via 不会写它们（[ADR 0003](../adr/0003-read-only-framework-configs.md)）。两点代价：读 `/mnt/c` 比读 Linux 侧文件慢，每次命令都读，`via doctor` 会提示（见 [agent-integration.md](agent-integration.md#via-doctor检测与关闭提示)）；其中 `command` 写着 Windows 路径（`C:\…`）或 `.exe` 的 server 在发行版里启动不了，写 `npx`、`uvx` 这类名字的则在发行版里按 Linux 的 `PATH` 解析。需要的话在 via 的覆盖层里改写这些 server。
- **凭证**：发行版里通常没有 Secret Service，`keychain:` 引用读不到 Windows 凭据管理器里的条目（缺失按退出码 4 处理）；用 `env:`、`file:` 或 `cmd:`。OAuth 登录在钥匙串不可用时退回用户数据目录下的文件（[auth.md](../spec/auth.md)）。
- **OAuth 回调**：`via auth login` 在发行版内监听 `127.0.0.1` 的 29842–29851。浏览器在 Windows 一侧，回调要能从 Windows 的 `localhost` 到达发行版：`.wslconfig`（`%UserProfile%\.wslconfig`，改完执行 `wsl --shutdown`）里 `[wsl2]` 的 `localhostForwarding` 默认是开着的，别关；Windows 11 22H2 起也可以用 `networkingMode=mirrored`（[WSL 网络](https://learn.microsoft.com/en-us/windows/wsl/networking)）。via 打开浏览器用的是 `xdg-open`，发行版里没有它或没有 `DISPLAY`/`WAYLAND_DISPLAY`（没有 WSLg）时只打印授权 URL，把它复制到 Windows 的浏览器里打开即可；回调到不了时用 `--manual`。
- **VM 空闲关闭与 daemon**：WSL2 的 VM 在没有活动时会自行关闭（`.wslconfig` 的 `[wsl2]` 里 `vmIdleTimeout`，默认值见[配置文档](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)）。via 的 daemon 本来就空闲 10 分钟自行退出（[daemon.md](../spec/daemon.md)），下一条命令会自动重新拉起；VM 关闭带走它只是提前发生同一件事：代价是下一次调用多一次冷启动与 stdio server 重新握手，之前的会话状态不保留，可以接受。daemon 在后台运行时 VM 是否真的会保持开着，没有实测过（见下面的待测清单）。不想让 VM 关得太早，可以调大 `vmIdleTimeout`；不想要 daemon 时设 `VIA_NO_DAEMON=1`。

没有 WSL 的机器（公司策略不让开虚拟化等）：装 Git for Windows，在 Git Bash 里使用 via 和 agent。Git Bash（MSYS2）会把以 `/` 开头的参数改写成 Windows 路径（比如 `--uri /foo` 变成 `C:/Program Files/Git/foo`），需要在 shell 里设 `export MSYS_NO_PATHCONV=1`（[说明](https://docs.cloudbees.com/docs/cloudbees-cd-kb/latest/cloudbees-cd-kb/kbec-00420-stopping-path-conversion-for-git-bash)）。Git Bash 里运行的是 Windows 版 via，上面「Windows」一节的其余差异仍然适用。不建议用 busybox-w32 或 Cygwin 当 agent 的 shell。

#### `via.cmd` 垫片：Windows 侧的 agent 调用 WSL 里的 via

> **未在真实 Windows 上验证。** 垫片是按 `wsl.exe` 的文档行为写的，没有在任何 Windows 机器上跑过；下面的「已知限制」是推断，「待测清单」是动手前必须做的实测。

如果 agent 只能跑在 Windows 一侧（比如桌面应用里的 agent），又想用装在 WSL 里的 via，可以用 [`scripts/windows/via.cmd`](../../scripts/windows/via.cmd)：它把 Windows 侧的 `via …` 原样转发给 `wsl.exe -e via …`。它**不是**npm 包的一部分（`package.json` 的 `files` 只有 `dist`，不会被 `npm install` 装出来），via 也没有生成它的子命令；需要时从仓库里复制：

1. 在 WSL 里装好 via（上面的步骤）。
2. 把 `via.cmd` 复制到 Windows `PATH` 里的一个目录。
3. 在 PowerShell 或 cmd 里运行 `via --version`。用的不是默认发行版时，先设 `VIA_WSL_DISTRO`（发行版名，不含空格，`wsl -l -q` 可列出）。

已知限制（推断，待实测）：

- **引号**：参数先被 PowerShell 或 cmd.exe 解析一遍，再由 `wsl.exe` 转发给发行版里的进程；`wsl.exe` 自己不改写参数，所以 PowerShell 5.1 吃内层双引号的问题依然在。JSON 参数用 `--args @文件`，或标准输入（`--args -`）。`&`、`|`、`<`、`>`、`^` 和 `%VAR%` 在进 `wsl.exe` 之前先归 cmd.exe 处理。
- **路径与当前目录**：`wsl.exe` 会沿用当前工作目录并转成 `/mnt/…`，但命令行参数里的 Windows 路径（`C:\x\args.json`）不会被转换，要写成 `/mnt/c/x/args.json`。
- **TTY**：标准输入输出是否仍被当成终端取决于 `wsl.exe` 对句柄的处理。via 靠 TTY 判断才在终端里交互（`via trust` 的确认、elicitation 的提问）；经垫片被 agent 调用时不是终端，这些命令按非交互处理。所以 **`via trust` 请直接在 WSL 终端里运行**，不要经垫片；`via auth login` 要在浏览器与回调之间来回（见上面「OAuth 回调」），也建议在 WSL 终端里运行。
- **性能**：每次调用多一次 `wsl.exe` 的进程启动；WSL 的 VM 若已关闭还要先拉起 VM。daemon 在发行版里，Windows 侧不能直接连它的 Unix socket，每次调用都经 `wsl.exe`。
- **PATH**：`wsl.exe -e` 不经 shell，也不读登录脚本；用 nvm 等把 Node 装在 `~/.nvm` 下时，`via` 可能不在它的 `PATH` 里。可以改成 `npm install -g` 到系统路径，或在垫片里写成 `wsl.exe -e bash -lc "via …"`（那样又多了一层引号，更要实测）。

待测清单（需要真实 Windows + WSL2）：

1. `wsl --shutdown` 之后第一次、与之后连续几次 `wsl.exe -e via --version` 的耗时（冷转发、热转发），对照在发行版终端里直接运行；以及 via 在 `/mnt/c` 与在发行版文件系统上读同一份框架配置的差别。
2. WSL VM 空闲关闭之后 daemon 的行为：后台 daemon 是否让 VM 保持开着；VM 关闭后下一次 `wsl.exe -e via …` 能否干净地拉起新 daemon（旧的 token/socket 文件是否残留、是否自行清理）。
3. 引号：PowerShell 5.1、PowerShell 7.3+、cmd.exe 三种 shell 下，含空格、双引号、单引号、`%`、`&` 的参数经 `via.cmd` 到达 via 之后是否原样。
4. TTY：经垫片时 `process.stdin.isTTY` / `stdout.isTTY` 在 PowerShell、cmd.exe、Windows Terminal 与被 agent 以管道调用时的取值；`via trust`、`via auth login` 在这些情形下的表现。
5. 退出码：`wsl.exe` 是否原样回传 via 的退出码（`output.md` 的 0–6），含被信号终止的情形。
6. `localhostForwarding` 开与关、`networkingMode=mirrored` 下，Windows 浏览器完成回调的 `via auth login`。

## 2. 检查现有配置

via 会自动读取 Claude Code、Cursor、Codex、VS Code 等框架里已经配好的 MCP server，不需要重新配置：

```console
$ via doctor
servers   9 ok · 1 needs auth (linear)

frameworks still injecting MCP schemas:
  claude-code   6 servers · ~41k tokens/turn
    hint: 启动时用 --strict-mcp-config 加载空配置，或在 /mcp 中逐个禁用；默认已用 tool search 延迟加载 schema，设 ENABLE_TOOL_SEARCH=false 才会全量注入
  cursor        3 servers · ~12k tokens/turn
    hint: 侧栏 Customize 中找到对应 server，关闭开关；命令行用 agent mcp disable <名称>

secrets: exa 的 EXA_API_KEY 在 ~/.cursor/mcp.json 中为明文
```

`via doctor` 之后再跑一次 `via sync`，把每个 server 的工具目录预热进缓存：

```console
$ via sync
exa         12 tools
github      42 tools
linear      needs auth: …
playwright  21 tools
```

`npx -y …`、`uvx …` 这类 server 第一次启动要下载包，常要几秒到几十秒。不预热的话，第一条 `via` 或 `via find` 遇到它们时只等 3 秒就先输出，慢的 provider 标成 `starting · retry in a moment`（`failed` 才表示真的起不来，后面带原因）。daemon 在后台继续连并写缓存，过几秒再跑就正常了；没有 daemon 时（`VIA_NO_DAEMON=1`）后台不存在，标记是 `starting · via sync <provider>`。缓存 24 小时后过期，慢 server 再次冷启动时会遇到同样的事，`via sync <provider>` 随时可以重新预热。

## 3. 补齐鉴权

框架通过 OAuth 拿到的 token 存在框架私有的位置，via 不读取，需要自己授权一次：

```bash
via auth login linear            # 先在配置里写 auth: oauth；打开浏览器完成授权
via auth login linear --manual   # SSH、容器等没有浏览器的环境：打印授权 URL，把落地页的完整 URL 粘贴回来
via auth status                  # 各 server 的登录状态与过期时间
```

CI、容器里没有人可以点浏览器：用机器授权（OAuth client credentials），配置里写 `auth: { oauth: { grant: client_credentials, clientId: ci-bot, clientSecret: "env:CI_SECRET" } }`，不需要 `via auth login`，第一次调用时自己申请令牌（[auth.md](../spec/auth.md#oauth-client-credentials)）。

需要 API key 的 server，在 `~/.config/via/config.yaml` 里写凭证引用（[配置](../spec/config.md)）：

```yaml
servers:
  github:
    auth: { bearer: "keychain:via/github" }
```

## 4. 发现与调用

```console
$ via                       # 所有 provider 及其工具数
$ via linear                # linear 的资源与动作
$ via linear issue          # issue 下每个动作的签名
$ via linear issue:create -h
$ via linear issue:create --team ENG --title "Support OAuth DCR"
$ via find "create issue"   # 跨 provider 搜索
```

## 5. 交给 agent

```bash
via prompt                  # 打印一段约 190 token 的说明和 provider 列表
via prompt --out AGENTS.md  # 或写到你指定的文件
```

把这段说明放进 agent 的说明文件后，按 `via doctor` 的提示在框架中关闭 MCP 注入。过渡期两边可以并存，详见 [与 agent 框架集成](agent-integration.md)。

## 6. 可选：收窄命令、放进沙箱

两项都写在用户配置 `~/.config/via/config.yaml` 里，默认都不开。

**只给 agent 需要的子命令**（[config.md](../spec/config.md#commands)）：

```yaml
commands:
  deny: [serve, daemon]   # 禁止：运行时退出码 5
  hide: [doctor, sync]    # 隐藏：不出现在 via -h、via prompt、via serve 的工具列表里，仍可运行
```

也可以反过来写 `allow`（只允许这些）、`show`（只显示这些）。改完之后重跑 `via prompt --out AGENTS.md`，说明块会跟着去掉被隐藏的命令。这只是 via 一侧的约定；要让 agent 绝对用不到某条命令，在 agent 框架的权限设置里禁止它。

**让 via 在沙箱里运行**（[config.md](../spec/config.md#sandbox)）：先装 [srt](https://github.com/anthropics/sandbox-runtime)（`npm install -g @anthropic-ai/sandbox-runtime`；Linux 还要 `bubblewrap` 和 `socat`），再写：

```yaml
sandbox:
  enabled: true
  policy:
    network:
      allowedDomains: [api.githubcopilot.com, mcp.linear.app, registry.npmjs.org]
    filesystem:
      allowWrite: ["."]           # server 可以写当前目录
      denyRead: [~/.ssh, ~/.aws]
```

之后每条 `via …` 都等于 `srt via …`：via 和它启动的 stdio server 只能写 `allowWrite` 里的目录（外加 via 自己的缓存），只能连 `allowedDomains` 里的域名，改不了 via 的配置。确认一下：

```console
$ via doctor | grep sandbox
sandbox   srt · the settings in sandbox.policy · this check ran inside it
```

要知道的几件事：

- 网络默认全部拒绝。HTTP server、OAuth 的授权服务器、`npx`/`uvx` 下载包的地址都要写进 `allowedDomains`，否则会报连不上。
- 沙箱里不用 daemon，stdio server 每条命令都重新启动，慢的 server 会明显变慢。
- `via auth`、`via trust`、`via daemon` 默认在沙箱外运行（`sandbox.exclude`）。
- 它不是凭证隔离：server 能读到 via 能读到的东西。需要隔离凭证时仍然用网关。

