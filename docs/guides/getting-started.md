# 快速上手

> via 尚未发布。本文描述的是目标体验，命令与输出以 [规范](../spec/) 为准。

## 1. 安装

```bash
npm install -g @modelctx/via
# 或下载单文件可执行版本（不需要 Node.js）
```

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
