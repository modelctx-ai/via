# 组合用法

CLI 相比原生 MCP 最明显的优势：中间结果在 shell 里流转，不进模型上下文。下面的命令中，工具名与参数以运行时 `-h` 为准。

## 只取需要的字段

```bash
via linear issue:list --team ENG --state "In Progress" -o json | jq -r '.[].identifier'
```

## 大结果不进上下文

```bash
# 统计 PR 新增行数，diff 本身不经过模型
via github pull-request:read --owner acme --repo api --pull-number 128 \
  --method get_diff -o raw | grep -c '^+'

# CI 失败时只看失败 job 日志的最后 50 行
via github job-log:get --owner acme --repo api --run-id 9876 --failed-only --tail-lines 50
```

## 跨 provider

```bash
# 把 GitHub issue 同步成 Linear issue
title=$(via github issue:read --owner acme --repo api --issue-number 42 --method get -o json | jq -r .title)
via linear issue:create --team ENG --title "$title" --description "From acme/api#42"
```

## 并发调用

```bash
printf '%s\n' \
  '{"tool":"github/issue:read","args":{"owner":"acme","repo":"api","issue_number":41,"method":"get"}}' \
  '{"tool":"github/issue:read","args":{"owner":"acme","repo":"api","issue_number":42,"method":"get"}}' \
  '{"tool":"linear/issue:get","args":{"id":"ENG-123"}}' | via batch
```

结果按输入顺序输出，单行失败不影响其他行，整体退出码取各行最大值。要在脚本里逐行处理，用 `-o json`，每行一条记录：

```bash
via batch -o json < calls.jsonl | jq -r 'select(.ok | not) | "line \(.line): \(.error.message)"'
```

批量不是事务：已执行的写入不会因为后面的行失败而回滚。危险工具需要在命令上加 `--yes`，对整批生效。

## 长文本、代码、复杂对象

```bash
# 长描述从文件读
via linear issue:create --team ENG --title "Support OAuth DCR" --description @spec.md

# 代码从 heredoc 读，不用转义进 JSON
via cloudflare execute --code - <<'JS'
async () => (await cloudflare.request({ method: "GET", path: `/accounts/${accountId}/workers/scripts` })).result.map(s => s.id)
JS

# 嵌套很深的参数整体传 JSON
via notion data-source:query --data @query.json
```

## 先看再做

```bash
via github issue:write --method create --owner acme --repo api --title "x" --dry-run
```

`--dry-run` 打印规范写法、目标 server 和最终参数（凭证打码），不发起调用。

## 只让 agent 看到几条命令

```yaml
# ~/.config/via/config.yaml
commands:
  show: [find, call, more]   # 帮助、via prompt、via serve 只列这三条（provider 语法照常可用）
  deny: [serve, trust]       # 这两条直接拒绝
```

```bash
via -h                       # 只剩 find、call、more 与 provider 语法
via prompt --out AGENTS.md   # 说明块随之收窄
via serve                    # 退出码 5：serve 被禁止了
```

没有 `deny: [serve]` 时，`via serve` 的工具列表同样只剩 `via_browse`、`via_find`、`via_call`、`via_more`。

项目里的 `.via.yaml` 也能写 `commands`，但只能再收紧，不能把用户配置禁止的命令放出来。

## 在沙箱里跑一个来路不明的 server

```yaml
# ~/.config/via/config.yaml
servers:
  some-tool:
    command: npx
    args: [-y, "@someone/server"]
sandbox:
  enabled: true
  policy:
    network: { allowedDomains: [registry.npmjs.org, api.example.com] }
    filesystem: { allowWrite: ["./out"] }
```

```bash
via some-tool                # 在 srt 里运行：只能写 ./out，只能连上面两个域名
VIA_SANDBOXED=1 via doctor   # 人在排查时绕开沙箱（via 以为自己已经在沙箱里）；不要写进 agent 的环境
```

策略也可以放在单独的 JSON 文件里（`policy: ~/.config/via/srt.json`，格式同 srt 的 settings），via 每次读取并追加它自己需要的几项。

