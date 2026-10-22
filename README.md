<div align="center">

<img src="docs/assets/logo.svg" width="96" height="96" alt="via logo">

# via

**Every MCP server, one shell command away.**

via turns the tools of any MCP server into a command line that agents discover and call on demand,<br>
so tool schemas stay out of the context window.

[![CI](https://github.com/modelctx-ai/via/actions/workflows/ci.yml/badge.svg)](https://github.com/modelctx-ai/via/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/modelctx-ai/via?color=blue)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](package.json)
[![npm](https://img.shields.io/npm/v/@modelctx-ai/via?color=f76b15&logo=npm)](https://www.npmjs.com/package/@modelctx-ai/via)
[![npm downloads](https://img.shields.io/npm/dm/@modelctx-ai/via?color=f76b15)](https://www.npmjs.com/package/@modelctx-ai/via)
[![GitHub stars](https://img.shields.io/github/stars/modelctx-ai/via?style=flat&logo=github&color=yellow)](https://github.com/modelctx-ai/via/stargazers)

[Quick look](#a-quick-look) · [Install](#install) · [Getting started](#getting-started) · [Docs](docs/README.md) · [Benchmark](bench/results/0.4-tokens.md) · [Roadmap](docs/roadmap.md)

English | [简体中文](README.zh-CN.md)

</div>

---

**MCP for providers, CLI for consumers.** Agent frameworks stop mounting MCP servers and stop loading hundreds of tool schemas into the context window. When an agent needs a tool, it uses `via` in the shell to browse, read the usage, and call it. via handles authentication and output formatting for every server the same way.

> [!NOTE]
> 0.3.1 is released (`npm install -g @modelctx-ai/via`). Roadmap 0.1–0.3 is in this version: direct and daemon modes, OAuth, `find`, `batch`, `trust`, resources/prompts and Windows. Commands and output may change before 1.0. [`docs/spec/`](docs/spec/) defines the behavior. The documentation under `docs/` is written in Chinese.

## Why via

- When a framework connects to MCP, it injects every tool definition up front. With a few servers mounted, tens of thousands of tokens are gone before the task starts.
- Each framework keeps its own copy of server URLs and credentials, so rotating a key means editing every one of them.
- Raw JSON results repeat the same keys on every row, and each framework handles truncation and paging differently.

via is a standalone MCP client. It reads the MCP configuration your frameworks already have (read-only), injects credentials per server, exposes tools as `provider → resource → verb` commands, and renders all output with one set of rules. The agent's context holds only a usage note of about 200 tokens.

![How via works: the agent runs via in the shell and gets compact output back; the via CLI hands the call to a local daemon, which reads framework MCP configs and credentials and talks MCP to the servers over stdio or HTTP](docs/assets/how-it-works.svg)

On the 9 tasks of the [token benchmark](bench/results/0.4-tokens.md) (github, linear, notion, playwright and cloudflare, 167 tools in total), **via used about 4% of the tokens that native MCP injection used**; the other shell-based MCP clients measured with it, mcp2cli and mcpc, used about 16% and 15%. The figures are estimated from scripted command sequences. Nearly all of the saving comes from not injecting tool definitions, so the gap is much smaller in frameworks that already defer schema loading. Success rates from the live-model evaluation (`npm run bench:eval`) have not been published yet.

## Highlights

- **No schemas in context.** The agent gets a short usage note from `via prompt` and finds tools when it needs them: `via` → `via <provider>` → `via <provider> <resource>` → `-h`.
- **Reuses the config you already have.** Reads MCP servers from Claude Code, Claude Desktop, Cursor, Codex, VS Code, Gemini CLI, GitHub Copilot CLI, Devin Desktop / Windsurf, Antigravity and Amp. Read-only: via never writes to them.
- **One place for credentials.** Configuration holds references (`keychain:`, `env:`, `file:`, `cmd:`) or via's own OAuth sign-in. Resolved values are shown as `***` everywhere.
- **Search across servers.** `via find "create issue"` ranks tools from every provider, with synonym expansion. Deterministic by default: no model calls unless you turn on `search.semantic`.
- **Compact, predictable output.** One set of rendering rules for every server, a `next:` hint after every error, cursors for truncated output, and `-o json` for scripts.
- **Built for the shell.** Pipe results between tools without passing them through the model, or send many calls through `via batch` at once.
- **Guard rails.** `deny` rules hide tools, destructive tools need `--yes`, and project-level commands and endpoints need `via trust` before first use.
- **Fast and portable.** Browsing a warm cache takes about 80 ms. A local daemon keeps MCP sessions open between calls. Runs on macOS, Linux and Windows.

## A quick look

```console
$ via
7 providers · 177 tools
code     github
search   context7 · exa
browser  playwright
docs     notion
project  linear
cloud    cloudflare
→ via <provider> to browse · via find <query> to search

$ via linear issue
issue:get     id                                                               Retrieve detailed information about an issue by ID. [read-only]
issue:list    [team], [state], [assignee], [label], [query], [limit], …        List issues in the user's Linear workspace. [read-only]
issue:create  title, team, [description], [priority], [assignee], [labels], …  Create a new Linear issue.
issue:update  id, [title], [description], [priority], [assignee], [labels], …  Update an existing Linear issue.
→ via linear issue:<verb> -h for usage

$ via linear issue:create --title "Rate limiter fails closed when Redis is down" --team Platform --priority 2
identifier: PLT-331
title: Rate limiter fails closed when Redis is down
priority:
  value: 2
  name: High
url: https://linear.app/acme/issue/PLT-331/rate-limiter-fails-closed-when-redis-is-down
status: Todo
…
· linear issue:create · 286ms · 568 bytes
```

Intermediate results can flow through the shell without passing through the model's context:

```bash
title=$(via github issue:read --method get --owner acme --repo api --issue-number 42 -o json | jq -r .title)
via linear issue:create --team ENG --title "$title" --description "From acme/api#42"
```

## Install

Requires Node.js 20 or later (22 recommended).

```bash
npm install -g @modelctx-ai/via
via --version
```

npm is the only distribution channel: there is no Homebrew formula and no prebuilt executable. Platform notes, including Windows, are in the [getting-started guide](docs/guides/getting-started.md#1-安装).

To work on via itself: `git clone https://github.com/modelctx-ai/via.git && cd via && npm ci && npm run build && npm link`.

## Getting started

### 1. Check your existing setup

via reads the MCP servers already configured in Claude Code, Claude Desktop, Cursor, Codex, VS Code, Gemini CLI, GitHub Copilot CLI, Devin Desktop / Windsurf, Antigravity and Amp. There is nothing to set up again, and via never writes to those files:

```bash
via doctor        # server status, frameworks still injecting schemas (with token estimates), plaintext secrets
```

### 2. Fill in authentication

For OAuth servers, via signs in once on its own; it does not read tokens stored by other clients. API keys go into `~/.config/via/config.yaml` as credential references:

```bash
via auth login linear      # needs auth: oauth in the config; add --manual where no browser is available
```

```yaml
servers:
  github:
    url: https://api.githubcopilot.com/mcp/
    auth: { bearer: "keychain:via/github" }   # env:, file: and cmd: also work
  exa:                                         # defined in a framework config; only the credential is added here
    env: { EXA_API_KEY: "env:EXA_KEY" }
deny: ["^github/.*:delete$"]                   # tools the agent must not touch
```

### 3. Discover and call

```bash
via                                   # all providers with their tool counts
via linear                            # resources and verbs
via linear issue                      # signature of each verb
via linear issue:create -h            # argument usage
via find "create issue"               # search across providers
```

### 4. Hand it to the agent

Put the instructions into the AGENTS.md you already have — via adds one marked block and leaves the rest of the file alone — then turn off MCP injection in the framework as `via doctor` suggests. Both can run side by side during the transition:

```bash
via prompt --out AGENTS.md       # creates the block, or refreshes the one already in the file
via prompt --check AGENTS.md     # exit 1 when the block is out of date; for CI
via prompt --skill --out <dir>/via/SKILL.md   # a SKILL.md instead, for agents that load skills from a directory
```

The block says what via is and asks the agent to prefer `via` over the MCP tools it already has. Keep one copy of it: Claude Code can pull that file in from CLAUDE.md with `@AGENTS.md` instead of keeping a second one.

An agent without a shell (Claude Desktop, an IDE chat panel) mounts `via serve` as its only MCP server instead and gets nine meta-tools (`via_browse`, `via_find`, `via_call`, …, about 1,150 tokens) that behave exactly like the commands:

```json
{ "mcpServers": { "via": { "command": "via", "args": ["serve"] } } }
```

See the [getting-started guide](docs/guides/getting-started.md) and [agent framework integration](docs/guides/agent-integration.md) for the full steps.

## Common commands

| Command | Purpose |
| --- | --- |
| `via` · `via <provider>` · `via <provider> <resource>` | Browse level by level; `-h` shows the usage of one tool |
| `via <provider> <resource>:<verb> [--arg value]` | Call a tool; `-o json` prints JSON, `--dry-run` prints the call without sending it |
| `via find <query>` | Search tools across providers |
| `via more <cursor>` | Continue truncated output |
| `via batch` | Read JSON Lines from stdin, run the calls concurrently, print results in input order |
| `via resources` · `via read` · `via prompts` | MCP resources and prompts |
| `via auth login\|status\|logout` | OAuth sign-in and status |
| `via trust` | Approve the commands and endpoints in a project's `.via.yaml` |
| `via serve` | Run as a stdio MCP server with nine meta-tools, for agents without a shell |
| `via doctor` · `via servers` · `via sync` | Diagnostics, server list, refresh the tool cache |

Syntax, global options and exit codes are in the [CLI spec](docs/spec/cli.md) and [output spec](docs/spec/output.md); more combinations are in [recipes](docs/guides/recipes.md).

## Security notes

- via is not a gateway. It runs as the same user as the agent, so it lowers the chance of a credential leaking by accident but cannot stop a deliberate read. When you need isolation and auditing, put a gateway such as [Asterlane](https://github.com/komiyoo/asterlane) behind via; via treats it as an ordinary MCP server.
- Configuration stores only credential references, and resolved credential values are replaced with `***` in all output.
- Tools marked destructive require `--yes`. Tools matched by a `deny` rule are hidden from listings and cannot be called.
- Commands and endpoints from project-level configuration (`.via.yaml`, a repository's `.mcp.json` and similar) must be approved with `via trust` in your terminal before first use. Do not let the agent run it for you.

The threat model is in the [security spec](docs/spec/security.md).

## How via compares

| | Native MCP in the framework | Single-server MCP-to-CLI tools | **via** |
| --- | --- | --- | --- |
| Tool schemas in context | All of them, up front | None | None, only a ~200-token note |
| Servers | Each framework has its own list | One endpoint per call | All servers in one catalog |
| Cross-server search | — | — | `via find` |
| Credentials | Copied into each framework | Passed per call | One reference per server |
| Output | Raw JSON, each framework does it differently | Varies by tool | One set of rendering rules, cursors |

See the [vision document](docs/overview/vision.md#与相近工具的区别) for how via differs from mcpc, mcp2cli, mcporter and gateways.

## Documentation

| Topic | Where |
| --- | --- |
| Goals, non-goals, and how via differs from mcpc, mcp2cli and similar tools | [Vision](docs/overview/vision.md) |
| How the pieces fit together | [Architecture](docs/overview/architecture.md) |
| Configuration fields and credential references | [Configuration](docs/spec/config.md), [authentication](docs/spec/auth.md) |
| Using GitHub, Linear, Notion and Cloudflare | [Provider guides](docs/guides/providers/) |
| What comes next | [Roadmap](docs/roadmap.md), [open questions](docs/open-questions.md) |
| Why things are the way they are | [Architecture decision records](docs/adr/) |

The full index is [docs/README.md](docs/README.md).
## Contributing

Feedback from real MCP servers and agent frameworks is the most useful contribution right now: [open an issue](https://github.com/modelctx-ai/via/issues/new/choose) when a server's tools split into odd commands, a framework config is not picked up, or an output is hard for the agent to read.

```bash
npm ci
npm run typecheck
npm test
npm run build      # output in dist/, entry point dist/via.js
```

`docs/spec/` is normative: a change to user-visible behavior updates the spec and `CHANGELOG.md` in the same PR. See [CONTRIBUTING](CONTRIBUTING.md) for the process and [docs/development/](docs/development/implementation.md) for implementation notes and the test layout. Security issues go through [SECURITY.md](SECURITY.md), not public issues.

If via saves you tokens, a ⭐ helps other people find it.

## Star history

<a href="https://star-history.com/#modelctx-ai/via&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=modelctx-ai/via&type=Date&theme=dark">
    <img alt="Star history chart for modelctx-ai/via" src="https://api.star-history.com/svg?repos=modelctx-ai/via&type=Date">
  </picture>
</a>

## License

[Apache License 2.0](LICENSE)
