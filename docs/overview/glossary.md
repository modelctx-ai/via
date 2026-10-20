# 术语表

| 术语 | 含义 |
| --- | --- |
| **server** | 一个 MCP server，来自框架配置或 via 自己的配置。 |
| **provider** | server 在 via 中的别名，命令的第一级，如 `via linear` 中的 `linear`。小写 kebab-case，不得与内置子命令重名。 |
| **原始名** | MCP `tools/list` 返回的工具名，如 `create_issue`。始终可作为别名调用。 |
| **资源（resource）** | 从原始名拆出的名词部分，如 `issue`、`pull-request`。命令的第二级。 |
| **动作（verb）** | 从原始名拆出的动词部分，如 `create`、`create-or-update`。 |
| **工具引用** | 定位一个工具的写法。命令行形式 `linear issue:create`，单字符串形式 `linear/issue:create`。 |
| **规范写法** | via 所有输出中使用的工具引用形式，由[拆分规则](../spec/naming.md)确定。 |
| **叶子工具** | 拆不出资源或动作的工具，直接挂在 provider 下，如 `via notion search`。 |
| **域（domain）** | provider 的分类，如 `code`、`search`。只是浏览视图，不进入命令路径和规范名。 |
| **分类表** | 内置的「已知 server → 域」映射，精度最高。 |
| **词典（lexicon）** | 启发式分域使用的「关键词 → 各域权重」表，由脚本从分类表样本生成。 |
| **目录（catalog）** | 所有 provider 的工具、拆分结果、域和索引的集合，缓存在磁盘与 daemon 内存中。 |
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
