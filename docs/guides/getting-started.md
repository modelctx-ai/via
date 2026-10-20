# 快速上手

> via 尚未发布。本文描述的是目标体验，命令与输出以 [规范](../spec/) 为准。

## 1. 安装

```bash
npm install -g @modelctx/via
```

没有 Node.js 的机器（容器、CI 镜像）可以改用单文件可执行版本：从发布页下载与平台对应的 `via-<系统>-<架构>` 文件，用同一页的 `SHA256SUMS` 校验，放到 `PATH` 里即可，不需要其他依赖。

```bash
sha256sum --check --ignore-missing SHA256SUMS      # macOS 上用 shasum -a 256 -c
chmod +x via-linux-x64 && mv via-linux-x64 ~/.local/bin/via
via --version
```

| 文件 | 平台 |
| --- | --- |
| `via-linux-x64`、`via-linux-arm64` | Linux（glibc）；x64 版本要求 CPU 支持 AVX2 |
| `via-linux-x64-musl`、`via-linux-arm64-musl` | Alpine 等 musl 发行版 |
| `via-darwin-arm64`、`via-darwin-x64` | macOS |
| `via-windows-x64.exe` | Windows（随 Windows 支持一起完善，目前只验证过能构建，没有 daemon；见[路线图](../roadmap.md)） |

- 行为与 npm 版本一致（配置、daemon、OAuth、钥匙串），冷启动更快；文件约 65–95 MiB，因为里面带着完整的 Bun 运行时。
- macOS 上经浏览器下载的文件带有隔离属性，首次运行会被 Gatekeeper 拦下（发布的文件没有 Apple 公证）：用 `curl -L -o` 下载，或执行 `xattr -d com.apple.quarantine via`。
- 钥匙串模块在文件里；加载不了时（例如 Linux 服务器上没有 Secret Service）`keychain:` 引用会报错并提示改用 `env:` 或 `file:`，OAuth 登录自动退回私有文件。
- 自己构建：`bun` 装好之后 `npm run build:bin`，产物在 `dist/bin/`（[实现说明](../development/implementation.md#单文件可执行)）。

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

需要 API key 的 server，在 `~/.config/via/config.yaml` 里写凭证引用（[配置](../spec/config.md)）：

```yaml
servers:
  github:
    auth: { bearer: "keychain:via/github" }
```

## 4. 发现与调用

```console
$ via                       # 所有 provider，按域分组
$ via linear                # linear 的资源与动作
$ via linear issue          # issue 下每个动作的签名
$ via linear issue:create -h
$ via linear issue:create --team ENG --title "Support OAuth DCR"
$ via find "create issue"   # 跨 provider 搜索
```

## 5. 交给 agent

```bash
via prompt                  # 打印一段约 150 token 的说明和域摘要
via prompt --out AGENTS.md  # 或写到你指定的文件
```

把这段说明放进 agent 的说明文件后，按 `via doctor` 的提示在框架中关闭 MCP 注入。过渡期两边可以并存，详见 [与 agent 框架集成](agent-integration.md)。
