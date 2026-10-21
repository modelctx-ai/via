# 术语表

| 术语 | 含义 |
| --- | --- |
| **server** | 一个 MCP server，来自框架配置或 via 自己的配置。 |
| **provider** | server 在 via 中的别名，命令的第一级，如 `via linear` 中的 `linear`。小写 kebab-case，不得与内置子命令重名。 |
| **原始名** | MCP `tools/list` 返回的工具名，如 `create_issue`。始终可作为别名调用。 |
| **资源（resource）** | 从原始名拆出的名词部分，如 `issue`、`pull-request`。命令的第二级。 |
| **MCP 资源（MCP resource）** | MCP 协议里按 URI 寻址的只读内容（`resources/list`、`resources/read`），用 `via resources`、`via read` 访问。与上面从工具名拆出的「资源（resource）」是两回事；文档里凡是指前者都写「MCP 资源」。 |
| **资源模板** | MCP 资源的 URI 模板（RFC 6570，如 `file:///logs/{date}.log`），调用方替换占位符后用 `via read` 读取。 |
| **prompt（MCP prompt）** | server 提供的带参数消息模板（`prompts/list`、`prompts/get`），用 `via prompts` 访问。与 `via prompt`（生成给 agent 的说明）无关。 |
| **roots** | client 声明给 server 的目录列表（MCP 的 `roots` 能力）。via 默认不声明，按 server 用配置的 `roots` 字段开启。 |
| **动作（verb）** | 从原始名拆出的动词部分，如 `create`、`create-or-update`。 |
| **工具引用** | 定位一个工具的写法。命令行形式 `linear issue:create`，单字符串形式 `linear/issue:create`。 |
| **规范写法** | via 所有输出中使用的工具引用形式，由[拆分规则](../spec/naming.md)确定。 |
| **叶子工具** | 拆不出资源或动作的工具，直接挂在 provider 下，如 `via notion search`。 |
| **目录（catalog）** | 所有 provider 的工具、拆分结果和索引的集合，缓存在磁盘与 daemon 内存中。 |
| **签名** | 一行内的参数摘要，如 `owner, repo, title, [body]`，方括号表示可选。 |
| **预算（budget）** | 单次输出的字节上限，超出部分存入游标。 |
| **游标（cursor）** | 被截断结果的续读句柄，`via more <游标>` 续读。 |
| **元信息行** | 写到 stderr、以 `·` 开头的一行，包含工具引用、耗时、行数或字节数、下一步命令。 |
| **框架** | 使用 MCP 的 agent 客户端，如 Claude Code、Cursor、Codex、VS Code。 |
| **来源（source）** | via 只读引用的框架 MCP 配置文件。 |
| **覆盖层** | via 自己的用户配置与项目配置，用于补充凭证、覆盖定义、新增 server。 |
| **凭证引用** | 配置中对凭证的间接写法，如 `env:NAME`、`keychain:service/account`，不写明文。 |
| **daemon** | 按需拉起、空闲退出的 per-user 后台进程，持有 MCP 会话、目录和凭证。 |
| **进程内模式** | 不经 daemon、在 CLI 进程内直连 server 的运行方式。 |
| **独占 server** | 锁定文件、端口或浏览器 profile，无法与框架中的同名实例并存的 server，配置为 `exclusive: true`。 |
| **危险工具** | annotations 中 `destructiveHint: true` 的工具，调用需要 `--yes`。 |
| **网关类 server** | 自身代理多个上游的 MCP server（如 Asterlane），对 via 而言与普通 server 无异。 |
