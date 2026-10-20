# 快速上手

> mx 尚未发布。本文描述的是目标体验，命令与输出以 [规范](../spec/) 为准。

## 1. 安装

```bash
npm install -g <待定包名>   # 包名见 open-questions.md
# 或下载单文件可执行版本（不需要 Node.js）
```

## 2. 检查现有配置

mx 会自动读取 Claude Code、Cursor、Codex、VS Code 等框架里已经配好的 MCP server，不需要重新配置：

```console
$ mx doctor
servers   9 ok · 1 needs auth (linear)

frameworks still injecting MCP schemas:
  claude-code   6 servers · ~41k tokens/turn
    hint: 启动时用 --strict-mcp-config 加载空配置，或在 /mcp 中逐个禁用
  cursor        3 servers · ~12k tokens/turn
    hint: Settings → MCP，关闭对应 server 的开关

secrets: exa 的 EXA_API_KEY 在 ~/.cursor/mcp.json 中为明文
```

## 3. 补齐鉴权

框架通过 OAuth 拿到的 token 存在框架私有的位置，mx 不读取，需要自己授权一次：

```bash
mx auth login linear
```

需要 API key 的 server，在 `~/.config/mx/config.yaml` 里写凭证引用（[配置](../spec/config.md)）：

```yaml
servers:
  github:
    auth: { bearer: "keychain:mx/github" }
```

## 4. 发现与调用

```console
$ mx                       # 所有 provider，按域分组
$ mx linear                # linear 的资源与动作
$ mx linear issue          # issue 下每个动作的签名
$ mx linear issue:create -h
$ mx linear issue:create --team ENG --title "Support OAuth DCR"
$ mx find "create issue"   # 跨 provider 搜索
```

## 5. 交给 agent

```bash
mx prompt                  # 打印一段约 150 token 的说明和域摘要
mx prompt --out AGENTS.md  # 或写到你指定的文件
```

把这段说明放进 agent 的说明文件后，按 `mx doctor` 的提示在框架中关闭 MCP 注入。过渡期两边可以并存，详见 [与 agent 框架集成](agent-integration.md)。
