# Linear

Linear 的 MCP server 是细粒度的资源型工具，一个工具一个动作，拆分后就是 `issue:create` 这种形式。

## 接入

```yaml
servers:
  linear:
    url: https://mcp.linear.app/mcp
    auth: oauth            # 然后执行 via auth login linear
```

- OAuth 2.1，支持动态客户端注册。
- 也可以把 Linear API key 作为 bearer：`auth: { bearer: "keychain:via/linear" }`。
- 只读场景使用 `https://mcp.linear.app/mcp/readonly`，它只暴露读工具，比 via 本地的 `deny` 规则更彻底。

## 浏览

```console
$ via linear
issue      list · get · create · update
my-issue   list
comment    list · create
project    list · create · update
cycle      list
document   list · get
team       list
```

## 调用

```bash
# 我名下的 issue
via linear my-issue:list

# 唯一必填的 string 参数可以写成位置参数
via linear issue:get ENG-123

# 长描述从文件读
via linear issue:create --team ENG --title "Support OAuth DCR" --description @spec.md

# 只要 identifier 列，交给 jq
via linear issue:list --team ENG --state "In Progress" -o json | jq -r '.[].identifier'
```

## 拆分要点

| 原始工具名 | 规范写法 |
| --- | --- |
| `create_issue` | `issue:create` |
| `list_my_issues` | `my-issue:list` |
| `create_comment` | `comment:create` |
| `list_cycles` | `cycle:list` |

Linear 官方文档没有列出完整工具清单，以上工具名取自第三方整理的列表，参数以 `-h` 为准。

来源：[Linear MCP 文档](https://linear.app/docs/mcp)、[Linear MCP 工具列表（Portkey）](https://portkey.ai/docs/integrations/mcp-servers/linear-mcp-server)（2026-10）。
