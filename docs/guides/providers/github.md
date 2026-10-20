# GitHub

GitHub 官方 MCP server 把同一资源的多种读写合并成一个工具，用 `method` 区分，比如 `issue_read` 的 method 有 get、get_comments、get_sub_issues、get_parent、get_labels。拆分后资源和动作照样清楚，method 的可选值在 `-h` 里列出。

## 接入

```yaml
servers:
  github:
    url: https://api.githubcopilot.com/mcp/
    auth: { bearer: "keychain:via/github" }   # fine-grained PAT
```

远程 server 的 OAuth 需要客户端事先注册 GitHub App 或 OAuth App，第三方客户端用 PAT 最直接。也可以用本地 stdio 版本（`github-mcp-server stdio`，凭证通过 `GITHUB_PERSONAL_ACCESS_TOKEN` 注入）。

## 浏览

```console
$ via github
issue           read · write · list · search
issue-comment   add · update
pull-request    read · create · list · merge · search · update
file            create-or-update · push · delete
file-content    get
commit          get · list
action          list · get
action-run      trigger
job-log         get
… 14 more · via github --all

$ via github issue:read -h
usage: via github issue:read --owner <str> --repo <str> --issue-number <num>
         --method get|get_comments|get_sub_issues|get_parent|get_labels
         [--page <num>] [--per-page <num>]
```

## 调用

```bash
# 读 issue 的评论
via github issue:read --owner acme --repo api --issue-number 42 --method get_comments

# 新建 issue：issue_write 的 method 为 create，labels 是数组，重复传参
via github issue:write --method create --owner acme --repo api \
  --title "Login returns 500" --body @bug.md --labels bug --labels p1

# PR 的 diff 直接进管道统计，不经过模型上下文
via github pull-request:read --owner acme --repo api --pull-number 128 \
  --method get_diff -o raw | grep -c '^+'

# CI 失败时只取失败 job 日志的最后 50 行
via github job-log:get --owner acme --repo api --run-id 9876 --failed-only --tail-lines 50
```

## 拆分要点

| 原始工具名 | 规范写法 | 说明 |
| --- | --- | --- |
| `issue_read` | `issue:read` | 动词在末尾 |
| `add_issue_comment` | `issue-comment:add` | 动词在开头 |
| `create_or_update_file` | `file:create-or-update` | 复合动作 |
| `actions_run_trigger` | `action-run:trigger` | 资源末词单数化 |
| `get_job_logs` | `job-log:get` | — |

GitHub 的参数名混用了 `issue_number` 和 `pullNumber`，via 统一接受 kebab 写法（`--issue-number`、`--pull-number`）。

## 建议

- 用 fine-grained PAT，只授予需要的仓库与权限；只读 agent 可配合 server 端的 read-only 模式或工具集过滤。
- 配置 `deny: ["^github/(repository|file):delete$"]` 之类的规则作为本地兜底。

来源：[GitHub MCP Server README](https://github.com/github/github-mcp-server)（2026-10）。
