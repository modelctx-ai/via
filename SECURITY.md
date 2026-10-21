# Security Policy · 安全策略

## Reporting a vulnerability · 报告漏洞

Please do not open a public issue for security problems. Report them privately through [GitHub Security Advisories](https://github.com/modelctx-ai/via/security/advisories/new) instead.

请不要为安全问题提公开 issue，改用 [GitHub Security Advisories](https://github.com/modelctx-ai/via/security/advisories/new) 私下报告。

Include the via version (`via --version`), your platform, and the steps to reproduce. Redact real credentials from logs and configs before you send them.

请附上 via 版本（`via --version`）、平台和复现步骤；发送前把日志和配置里的真实凭证去掉。

## Scope · 范围

via runs as the same user as the agent. It lowers the chance of a credential leaking by accident but cannot stop a process running as that user from reading it on purpose. The threat model and what via does and does not protect against are in [docs/spec/security.md](docs/spec/security.md).

via 与 agent 以同一用户运行，只能降低凭证意外暴露的概率，挡不住同一用户下进程的有意读取。威胁模型以及 via 防什么、不防什么，见 [docs/spec/security.md](docs/spec/security.md)。

Examples of what we want to hear about:

- A resolved credential value showing up in output, logs or error messages instead of `***`.
- Project-level configuration (`.via.yaml`, a repository's `.mcp.json`) running a command or reaching an endpoint without `via trust`.
- A `deny` rule or the `--yes` requirement for destructive tools being bypassed.
- Another local user being able to talk to your via daemon.

## Supported versions · 支持的版本

via has not had a release yet. Fixes go to the `main` branch.

via 尚未发布正式版本，修复合入 `main` 分支。
