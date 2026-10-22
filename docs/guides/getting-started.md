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

via 在 Windows 10 / 11 上与 macOS、Linux 用法一致（Node.js 20+，推荐 22），下面几点不同：

- 用户配置在 `%APPDATA%\via\config.yaml`，缓存与信任记录在 `%LOCALAPPDATA%\via\`；`~` 指 `%USERPROFILE%`，配置里的路径可以写 `/` 或 `\`，`%NAME%` 会被展开。
- 框架配置里的 `command: npx`（或 `uvx`、`pnpm` 等 `.cmd` 垫片）可以直接用：via 在 `PATH` 里按 `PATHEXT` 找到 `npx.cmd` 再启动，不会运行当前目录里同名的文件。参数里带 `"` 或 `%` 的 `.cmd` 命令会被拒绝（改用 `node` 加脚本路径，或 `.exe` 形式的命令）。详见 [config.md](../spec/config.md#windows-上启动-stdio-命令)。
- 常驻 daemon 和 macOS、Linux 一样自动拉起（named pipe，无需防火墙放行，也不会弹窗）；不想要时设 `VIA_NO_DAEMON=1`（PowerShell：`$env:VIA_NO_DAEMON = "1"`）。
- `keychain:` 用 Windows 凭据管理器；OAuth 登录同样先存凭据管理器，放不下时退回 `%LOCALAPPDATA%\via\Data\oauth\` 下的文件（靠用户目录的 ACL 保护，[security.md](../spec/security.md#windows-上的文件权限)）。
- `cmd:` 凭证里的 Windows 路径可以直接写：`cmd:"C:\Program Files\1Password CLI\op.exe" read op://dev/exa/key`。
- 输出一律是 UTF-8。Windows Terminal、VS Code 终端和 PowerShell 7 直接正常显示；旧的 PowerShell 5.1 / `cmd.exe` 在管道或重定向时按 OEM 代码页解码，`·`、`…` 和中文会变成乱码，先执行 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new()`（cmd.exe 里 `chcp 65001`）。用 `>` 重定向 via 的输出到文件时，PowerShell 5.1 会写成 UTF-16；via 读取 `--args @文件`、标准输入、`file:` 凭证和配置文件时认得 UTF-8 BOM 与 UTF-16 BOM，其他编码（如 GBK）不猜。
- 向原生程序传参时，PowerShell 5.1 会吃掉参数里的内层双引号，`--args '{"a":1}'` 到不了 via。改用文件（`--args @args.json`）或标准输入（`'{"a":1}' | via … --args -`）；PowerShell 7.3 起（`$PSNativeCommandArgumentPassing = 'Standard'`，默认值）没有这个问题。`via batch` 的输入是标准输入，同样不受影响，CRLF 行尾与开头的 BOM 都会被接受。

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
via prompt                  # 打印一段约 175 token 的说明和 provider 列表
via prompt --out AGENTS.md  # 或写到你指定的文件
```

把这段说明放进 agent 的说明文件后，按 `via doctor` 的提示在框架中关闭 MCP 注入。过渡期两边可以并存，详见 [与 agent 框架集成](agent-integration.md)。
