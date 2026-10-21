# via

English | [简体中文](README.zh-CN.md)

Turn the tools of any MCP server into a command line that agents discover and call on demand.

**MCP for providers, CLI for consumers.** Agent frameworks stop mounting MCP servers and stop loading hundreds of tool schemas into the context window. When an agent needs a tool, it uses `via` in the shell to browse, read the usage, and call it. via handles authentication and output formatting for every server the same way.

> Status: roadmap 0.1–0.3 is implemented (direct and daemon modes, OAuth, `find`, `batch`, `trust`, resources/prompts, Windows, single-file executables), but via is not on npm yet, so you need to [install from source](#install). The version is still `0.0.0`; commands and output may change before 1.0. [`docs/spec/`](docs/spec/) defines the behavior.
>
> The documentation under `docs/` is written in Chinese.

## Why via

- When a framework connects to MCP, it injects every tool definition up front. With a few servers mounted, tens of thousands of tokens are gone before the task starts.
- Each framework keeps its own copy of server URLs and credentials, so rotating a key means editing every one of them.
- Raw JSON results repeat the same keys on every row, and each framework handles truncation and paging differently.

via is a standalone MCP client. It reads the MCP configuration your frameworks already have (read-only), injects credentials per server, exposes tools as `provider → resource → verb` commands, and renders all output with one set of rules. The agent's context holds only a usage note of about 150 tokens.

![How via works: the agent runs via in the shell and gets compact output back; the via CLI hands the call to a local daemon, which reads framework MCP configs and credentials and talks MCP to the servers over stdio or HTTP](docs/assets/how-it-works.svg)

On the 9 tasks of the [token benchmark](bench/results/0.1.md) (github, linear, notion, playwright and cloudflare, 167 tools in total), via used about 4% of the tokens that native MCP injection used. The figure is estimated from scripted command sequences. Nearly all of the saving comes from not injecting tool definitions, so the gap is much smaller in frameworks that already defer schema loading. Success rates from the live-model evaluation (`npm run bench:eval`) have not been published yet.

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
git clone https://github.com/modelctx-ai/via.git
cd via
npm ci
npm run build
npm link          # puts via on your PATH
via --version
```

Once released, via will be available through `npm install -g @modelctx/via` and as single-file executables on GitHub Releases that do not need Node.js. Platform notes, including Windows and the single-file builds, are in the [getting-started guide](docs/guides/getting-started.md#1-安装).

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
via                                   # all providers, grouped by domain
via linear                            # resources and verbs
via linear issue                      # signature of each verb
via linear issue:create -h            # argument usage
via find "create issue"               # search across providers
```

### 4. Hand it to the agent

Put the output of `via prompt` into AGENTS.md, CLAUDE.md or a skill, then turn off MCP injection in the framework as `via doctor` suggests. Both can run side by side during the transition:

```bash
via prompt                  # prints the usage note and a domain summary
via prompt --out AGENTS.md  # or writes it to a file
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
| `via doctor` · `via servers` · `via sync` | Diagnostics, server list, refresh the tool cache |

Syntax, global options and exit codes are in the [CLI spec](docs/spec/cli.md) and [output spec](docs/spec/output.md); more combinations are in [recipes](docs/guides/recipes.md).

## Security notes

- via is not a gateway. It runs as the same user as the agent, so it lowers the chance of a credential leaking by accident but cannot stop a deliberate read. When you need isolation and auditing, put a gateway such as [Asterlane](https://github.com/komiyoo/asterlane) behind via; via treats it as an ordinary MCP server.
- Configuration stores only credential references, and resolved credential values are replaced with `***` in all output.
- Tools marked destructive require `--yes`. Tools matched by a `deny` rule are hidden from listings and cannot be called.
- Commands and endpoints from project-level configuration (`.via.yaml`, a repository's `.mcp.json` and similar) must be approved with `via trust` in your terminal before first use. Do not let the agent run it for you.

The threat model is in the [security spec](docs/spec/security.md).

## Documentation

| Topic | Where |
| --- | --- |
| Goals, non-goals, and how via differs from mcp2cli and similar tools | [Vision](docs/overview/vision.md) |
| How the pieces fit together | [Architecture](docs/overview/architecture.md) |
| Configuration fields and credential references | [Configuration](docs/spec/config.md), [authentication](docs/spec/auth.md) |
| Using GitHub, Linear, Notion and Cloudflare | [Provider guides](docs/guides/providers/) |
| What comes next | [Roadmap](docs/roadmap.md), [open questions](docs/open-questions.md) |
| Why things are the way they are | [Architecture decision records](docs/adr/) |

The full index is [docs/README.md](docs/README.md).

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build      # output in dist/, entry point dist/via.js
```

`docs/spec/` is normative: a change to user-visible behavior updates the spec and `CHANGELOG.md` in the same PR. See [CONTRIBUTING](CONTRIBUTING.md) for the process and [docs/development/](docs/development/implementation.md) for implementation notes and the test layout.

## License

[Apache License 2.0](LICENSE)
