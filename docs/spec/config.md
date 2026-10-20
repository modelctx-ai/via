# 配置

mx 读取各框架的 MCP 配置但从不写入（[ADR 0003](../adr/0003-read-only-framework-configs.md)）；凭证在 mx 自己的覆盖层里按 server 绑定，调用时自动注入。框架侧不做任何鉴权。

## 配置来源与合并顺序

后者覆盖前者：

1. **框架配置（只读）**：每次加载时读取，不做快照，框架那边改了这边自动生效。默认探测的框架与路径由 `data/frameworks/` 描述（[数据文件](../development/data-files.md#frameworks)），包括 Claude Code、Claude Desktop、Cursor、Codex、VS Code、Windsurf。具体路径实现时按各框架当前版本核对。
2. **用户配置**：`~/.config/mx/config.yaml`（遵循 `XDG_CONFIG_HOME`；Windows 为 `%APPDATA%\mx\config.yaml`）。补充凭证、覆盖定义、新增 server。
3. **项目配置**：当前目录向上查找的第一个 `.mx.yaml`。首次使用需 `mx trust`（[security.md](security.md#项目级配置的信任)）。
4. **命令行参数**。

合并规则：

- 以 server 名为键逐字段深合并，优先级高的来源覆盖低的。
- 不同框架配置中出现同名但定义不同的 server 时，按 `sources` 中的顺序取第一份，并在 `mx servers` 里标出冲突。
- 框架配置中的 `env`、`headers` 原样继承，包括其中的明文值；`mx doctor` 对明文值告警。

## 配置示例

```yaml
sources: auto              # 或显式列出：[claude-code, cursor, ./tools/mcp.json]
servers:
  github:
    url: https://api.githubcopilot.com/mcp/
    auth: { bearer: "keychain:mx/github" }
    domain: code
  exa:                     # 定义来自 Cursor 配置，这里只补凭证
    env: { EXA_API_KEY: "env:EXA_KEY" }
  linear:
    auth: oauth            # mx auth login linear
  aster:                   # 网关也只是普通 HTTP server
    url: http://127.0.0.1:3721/mcp
    auth: { bearer: "env:ASTERLANE_KEY" }
  playwright:
    exclusive: true        # 独占资源，与框架实例冲突时给出提示
  find:                    # 与内置子命令重名，必须改名
    alias: finder
deny: ["^github/.*:delete$"]  # 正则，匹配 provider/资源:动作，deny 优先
domains:
  research: [exa, context7]
```

## 字段参考

### 顶层

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `sources` | `auto` \| `false` \| 列表 | `auto` | 要读取的框架配置。`auto` 探测全部已知框架；列表项可以是框架 id 或文件路径；`false` 只用 mx 自己的配置 |
| `servers` | 映射 | `{}` | 以 server 名为键的定义与覆盖，见下表 |
| `deny` | 正则列表 | `[]` | 匹配单字符串形式的工具引用（`provider/资源:动作`），也匹配原始名形式（`provider/原始名`） |
| `domains` | 映射 | `{}` | 自定义域及其成员 provider，优先级高于推断 |
| `output.budget` | 字节数 | `8192` | 默认输出预算 |
| `output.cellWidth` | 字符数 | `80` | 表格单元格截断宽度 |
| `daemon.idleTimeout` | 秒 | `600` | daemon 空闲退出时间 |
| `daemon.serverIdleTimeout` | 秒 | `300` | 单个 stdio server 空闲停止时间 |

### `servers.<name>`

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `command`、`args`、`env`、`cwd` | stdio | 进程启动参数；`env` 的值可以是凭证引用 |
| `url`、`headers` | HTTP | Streamable HTTP 端点；`headers` 的值可以是凭证引用 |
| `auth` | 全部 | 鉴权方式，见 [auth.md](auth.md) |
| `alias` | 全部 | provider 名；默认取 server 名 |
| `domain` | 全部 | 指定域，跳过推断 |
| `rename` | 全部 | 单个工具的规范写法覆盖，如 `{ list_my_issues: "issue:list-mine" }` |
| `disabled` | 全部 | `true` 时对 mx 隐藏这个 server（不影响框架） |
| `exclusive` | stdio | 独占资源；启动失败时提示可能与框架实例冲突 |
| `confirm` | 全部 | `destructive`（默认）或 `never` |
| `timeout` | 全部 | 调用超时，秒，默认 60 |
| `concurrency` | 全部 | 同一 server 的并发上限，默认 4 |
| `budget` | 全部 | 覆盖输出预算 |
| `noise` | 全部 | 追加的噪声字段名或通配 |

## 凭证引用

配置里只写引用，不写明文：

| 写法 | 含义 |
| --- | --- |
| `env:NAME` | 读取环境变量 |
| `file:~/.secrets/x` | 读取文件内容并去掉首尾空白 |
| `keychain:service/account` | 读取系统钥匙串（macOS Keychain、Linux Secret Service、Windows Credential Manager） |
| `cmd:op read op://dev/exa/key` | 执行命令取 stdout，结果在 daemon 内存中按 TTL（默认 10 分钟）缓存；只允许出现在用户配置中 |

- 凭证引用可以出现在 `env`、`headers` 的值以及 `auth.bearer` 中。
- 不以上述前缀开头的值视为字面量；出现在用户或项目配置中的字面量凭证，`mx doctor` 告警。
- 解析结果只存在于 daemon（或进程内模式下的当前进程）内存中，不写盘。

## deny

- 正则在单字符串形式上匹配，例如 `^github/.*:delete$`、`^notion/page:(delete|move)$`。
- 命中的工具在浏览、`find` 中不可见，直接调用退出码 5。
- deny 只在 mx 一侧生效；需要不可绕过的限制时使用上游的只读端点或网关（见 [security.md](security.md)）。
