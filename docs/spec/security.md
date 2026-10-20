# 安全模型

via 与 agent 以同一用户、在同一个 shell 环境中运行，因此**只能降低凭证意外暴露的概率，不能防止有意读取**。需要真正隔离时，用网关（如 Asterlane）把上游凭证移出本机，via 只持有网关 key。README 与面向用户的文档必须把这条边界写清楚。

## 威胁与缓解

| 风险 | 缓解措施 |
| --- | --- |
| 凭证出现在输出或日志里 | 已解析的凭证值在所有输出中精确匹配替换为 `***`；日志不记录参数值；协议消息不携带凭证 |
| agent 读取配置文件拿到凭证 | 配置只存引用；推荐 `keychain:`；`via doctor` 对明文值告警 |
| 误调用破坏性工具 | `destructiveHint` 工具需要 `--yes`；`deny` 正则规则，deny 优先 |
| 不可信仓库里的项目配置 | 项目级配置中的 stdio 命令和 HTTP 端点首次使用前需 `via trust`；`cmd:` 凭证引用只允许出现在用户配置中，信任也不能放行 |
| 其他本地用户访问 daemon | socket 权限 0600、目录 0700，CLI 连接前检查属主与权限位，握手需要 0600 令牌文件里的随机令牌（Node 取不到 `SO_PEERCRED`，用这三项代替对端 uid 校验，见 [daemon.md](daemon.md#socket-安全)）。Windows：管道名由每次启动的令牌派生，令牌文件在用户目录里（见 [daemon.md](daemon.md#windows)） |
| Windows 上经 `cmd.exe` 的命令注入（参数里的 `&`、`\|`、`%VAR%`） | 命令名只从 `PATH` 解析、不找当前目录；`.cmd` / `.bat` 的每个词放进双引号，含 `"`、`%`、换行的参数拒绝而不转义；打开浏览器不经 `cmd.exe`（见下） |
| 工具返回内容里夹带指令（提示注入） | via 只做格式化，不解释内容；元信息使用固定的 `·` 前缀行，避免与工具内容混淆；`via prompt` 生成的说明提醒 agent 把工具输出当作数据 |
| 缓存中的敏感结果 | 游标与媒体文件存放在权限为 0700 的用户缓存目录，按 TTL 清理。Windows 没有这类权限位，私密性来自用户目录的默认 ACL（见下「Windows 上的文件权限」） |
| 读取其他客户端的 token | 不读取；OAuth 由 via 自己完成并存入钥匙串（不可用时退回 0600 的私有文件，[auth.md](auth.md#存储)） |
| OAuth token 出现在输出里 | access token、refresh token、ID token 与客户端 secret 一律计入脱敏列表；授权 URL 只含 `state` 与 PKCE challenge，不含秘密；回调监听只绑 `127.0.0.1` 并校验 `Host` 与 `state`；调用过程永远不会启动授权 |
| 授权被发往仓库指定的地址 | `via auth login` 对未信任的项目级 server 退出码 5 |

## 项目级配置的信任

项目目录可能来自不可信的仓库，因此：

- 项目级 `.via.yaml`，以及作为来源读取的项目级框架配置（如 `.mcp.json`、`.cursor/mcp.json`、`.vscode/mcp.json`）中定义的 **stdio 命令**和 **HTTP 端点**，首次使用前必须经 `via trust` 确认。HTTP 同样需要确认，因为项目配置一旦能改 `url`，用户为这个 server 配置的凭证（`auth.bearer`、钥匙串、文件）就会被发往仓库指定的地址。
- 信任按「文件路径（符号链接解析后的真实路径）+ 内容的 SHA-256」记录。Windows 上路径先规范成唯一写法再记录和比较：用 `realpath.native` 取真实路径（还原大小写、展开 8.3 短名、联接点与 `subst` 盘符），去掉 `\\?\` 与 `\\?\UNC\` 前缀，盘符大写；比较时不区分大小写（NTFS 默认不区分），所以 `c:\repo\.via.yaml`、`C:/Repo/.via.yaml` 和 `\\?\C:\REPO\.via.yaml` 是同一个文件、同一条记录。在用户数据目录的 `trust.json`（目录 0700，文件 0600，原子替换）；内容变化后需要重新确认。哈希针对 via 实际解析的那份字节，读取与校验之间文件被改动不会被误信任。记录文件损坏时视为没有任何信任记录，并给出告警。
- 凡是参与决定传输的项目级文件都要已被信任：stdio 进程如何启动（`command`、`args`、`env`、`cwd`），HTTP 请求发往哪里、带什么头（`url`、`headers`）。用户级配置里定义的 server，如果项目配置给它加了 `env`、改了 `url` 或加了 `headers`，同样视为未信任；项目配置只改 `timeout`、`disabled`、`auth` 等不影响传输的字段则不需要。项目配置里 `sources` 列出的文件按项目级处理。
- 未信任时，这些 server 在视图中显示为 `untrusted`，调用退出码 5，并提示 `via trust <路径>`（同一个 server 有多个文件待确认时提示不带路径的 `via trust`）。路径含空格等字符时按 shell 规则加引号。
- 项目级配置和框架配置中出现 `cmd:` 凭证引用时直接拒绝，信任也不能放行：该 server 的定义整条被忽略，并报 error 级诊断（`cmd-forbidden`）。`cmd:` 会执行命令，不属于「确认之后可以使用」的范畴；需要时在用户配置里定义，项目配置只能引用用户配置里已有的 server（改传输部分仍要信任）。
- `deny` 不受信任机制约束：项目配置只能追加规则，不能撤销用户配置的规则，详见 [config.md](config.md#deny)。

### `via trust`

```console
via trust [<路径>]               # 显示将被信任的内容，确认后记录
via trust --list                 # 列出信任记录及其状态
via trust --revoke <路径>        # 删除一条记录
```

- **范围**：不带路径时，处理当前目录加载到的、因信任而被拦住的项目级文件（含 `.via.yaml`、`sources` 列出的项目级文件、项目级框架配置）；带路径时只处理这一个文件。路径必须是当前目录实际加载的项目级文件（相对路径相对于当前目录，符号链接按真实路径匹配），否则退出码 2；该文件里没有需要信任的 server 定义时只说明情况，不记录。信任是针对文件的，不是针对 server 的。
- **显示内容**：每个文件一段，写明文件路径、状态（`not trusted`；曾信任过但内容变了则为 `changed since it was trusted`）、哈希前 12 位，以及受它影响的每个 server 的有效传输定义：stdio 的命令行（含参数，含空白的参数加引号）、`cwd`、`env` 的变量名；HTTP 的 scheme、主机与路径（userinfo、查询串隐藏，并注明），`headers` 的头名。`env`、`headers`、`auth` 的值只写来源：凭证引用写引用本身，字面量写 `(literal)`，不显示值；`cmd:` 只写程序名，因为参数里可能带密钥。文件内容里的控制字符、双向文本控制符按转义形式显示，避免文件伪造显示内容。命令行的参数是配置原文，会原样显示，**不要把密钥写进参数**。
- **确认**：显示之后需要明确确认才记录。在终端（stdin 与 stderr 都是 TTY）里提示 `trust this file? [y/N]`，只有 `y`/`yes` 通过；否则必须带 `--yes`，没有终端又没有 `--yes` 时退出码 5，提示 `next:` 重新运行并带 `--yes`；回答 `n` 或直接回车同样退出码 5，什么都不记录。`--dry-run` 只显示、不记录，退出码 0。`--yes` 是给脚本用的显式开关；它也意味着任何能执行 `via trust --yes` 的 agent 都能放行不可信的仓库，所以应当在 agent 的权限设置里不放行 `via trust`，而是让它把提示转给用户。
- **记录**：写入 `trust.json` 的是 via 解析时读到的那份字节的 SHA-256（不是确认时磁盘上的内容），成功后在 stderr 输出 `· trusted <路径> · sha256 <12 位> · <provider 列表>`。文件内容之后改变则视为未信任，`via trust` 会再次显示并要求确认。
- **`--list`**：每条记录一行：状态（`trusted`、`changed`、`missing`）、路径、哈希前 12 位、日期；没有记录时输出 `no trust records`。
- **`--revoke <路径>`**：删除该路径（真实路径）的记录，stderr 输出 `· revoked <路径>`；没有记录时退出码 3，提示 `via trust --list`。撤销不需要文件仍然存在。
- 信任记录损坏时输出告警，视为没有记录；重新 `via trust` 会整个重写。
- 不读取配置里的凭证，也不连接任何 server。

### `cmd:` 凭证

- 只在用户配置（及命令行覆盖）里有效；项目配置与框架配置里的 `cmd:` 在加载阶段拒绝（见上）。解析时再次校验来源，来自项目或框架的引用即使别处已缓存了同名结果也不会拿到值。
- 命令不经 shell 执行（`shell: false`），不做变量、通配符、`~` 展开，不支持管道与重定向；需要这些时显式写 `cmd:sh -c '…'`（Windows 上写 `cmd:powershell -NoProfile -Command '…'`）。分词规则见 [config.md](config.md#凭证引用)。Windows 上批处理文件的处理见下节。
- 命令继承 via 的环境变量（凭证助手如 `op`、`pass` 依赖它们），在 via 的当前目录运行，stdin 关闭，stderr 丢弃。
- stdout 去掉首尾空白后即凭证值，**视为凭证**：只留在内存，进入脱敏列表，不写盘。stdout 与 stderr 的内容不进入任何错误信息，命令失败时也不会出现（失败的助手完全可能把密钥打印出来）；错误信息只含程序名（不含路径与参数）和原因：未找到、退出状态码、被信号终止、超时、输出为空、输出超过 64 KiB。
- 超时 30 秒（超时即强制结束命令）；输出上限 64 KiB。

## Windows 上的子进程

Node 的 `spawn` 在 Windows 上只能启动 `.exe` 和 `.com`；`npx`、`npm`、`az`、`pass` 等通常是 `.cmd` / `.bat` 垫片，必须经 `cmd.exe`，而 `cmd.exe` 会重新解析整行命令（"BatBadBut"：参数里的 `&`、`|`、`^`、`%VAR%` 被当成命令或变量）。via 的取舍：

1. **命令名只从 `PATH` 和 `PATHEXT` 解析，永远不找当前目录**。`CreateProcess`、`cmd.exe` 以及 `which` 类库在 Windows 上都先找当前目录，而 stdio server 默认在调用方的工作目录运行，那可能是一个陌生仓库：用户配置里写 `command: npx` 并不意味着愿意运行仓库里的 `npx.cmd`。`PATH` 里的相对条目同样忽略。
2. **`cmd:` 凭证命令自己实现**（`src/platform/command.ts`）：`.exe` / `.com` 以完整路径直接启动，参数按普通的 Windows 规则传递，没有 shell 参与；`.cmd` / `.bat` 以 `cmd.exe /d /v:off /s /c "<批处理> <参数…>"` 启动（`/d` 跳过 AutoRun，`/v:off` 关闭延迟变量展开，`cmd.exe` 取 `%ComSpec%`——必须是名为 `cmd.exe` 的绝对路径，否则用 `%SystemRoot%\System32\cmd.exe`），命令行已拼好，不再让 Node 二次转义。每个词（批处理路径与所有参数）都放进双引号，引号内 `& | < > ^ ( )` 都是字面字符；结尾的反斜杠加倍，以免转义收尾的引号。**含 `"`、`%`、回车换行、NUL 的参数或路径整条拒绝**，不尝试转义——`cmd.exe` 对这几个字符没有可靠的转义写法（引号会让后面的 `&` 跳出引用，`%` 无论怎么写都会被展开）。拒绝的错误信息只指出第几个参数、什么问题。
3. **stdio server 的命令**同样先由 via 解析成完整路径（规则 1），参数检查同规则 2（含这些字符就不启动），然后交给 MCP SDK 的 `cross-spawn`：它对 `.cmd` / `.bat` 用 `cmd.exe /d /s /c` 并给每个元字符前加 `^`。via 不自己拼这条命令行，是因为 SDK 的 stdio 传输把 `command` 和 `args` 交给 `cross-spawn`，换掉它就要重写整个传输；`cross-spawn` 的转义不处理 `%` 展开的所有情形，所以 via 事先拒绝这些参数。拿到完整路径后 `cross-spawn` 不会再搜索任何目录。
4. 其他扩展名（`.ps1`、`.js`、`.vbs`、`.wsf`，即使 `PATHEXT` 列了它们）不启动，错误信息说明；想运行脚本请显式写解释器（`command: node`、`args: [script.js]`；`powershell` 是 `.exe`）。
5. **打开浏览器**（`via auth login`）不用 `cmd /c start`：授权 URL 是授权服务器给的，里面的 `|`、`^`、`(` 会被 `cmd.exe` 当成命令。改为 `rundll32.exe url.dll,FileProtocolHandler <url>`（完整路径直接启动），并且只打开 `http(s)://`。
6. 强制结束进程在 Windows 上不会连带结束子进程：`cmd:` 命令超时被杀、或 stdio server 关闭时 MCP SDK 先关 stdin（正常的 server 因此退出，`cmd.exe` 随之退出），2 秒后 `TerminateProcess` 只结束 `cmd.exe`，批处理拉起的子进程（`npx` 起的 `node`）可能继续运行。`cmd:` 的 stdout 管道已被销毁，不会再有输出被读取；不响应 stdin 关闭的 stdio server 可能残留，`via daemon status` 里的 pid 是 `cmd.exe` 的。用 `.exe` 形式的命令没有这个问题。

残留风险：参数检查之外，批处理文件本身怎么使用收到的参数（例如不加引号地展开 `%1` 再交给别的命令）是它自己的事；via 保证的是 `cmd.exe` 这一层不会把参数变成命令。

## Windows 上的文件权限

via 在 POSIX 上靠文件模式（目录 0700、文件 0600）保护信任记录、OAuth 回退文件、游标、媒体与目录缓存、daemon 令牌。Windows 的 `mode` 参数不起作用，`chmod` 只能切换只读标志。via 不调用 `icacls` 或 Win32 ACL API（没有原生依赖，也不想在每次写文件时起子进程），也**不宣称**这些文件是 0600：

- 这些文件都在 `%LOCALAPPDATA%\via\`（缓存与数据）下，目录从用户目录继承 ACL；标准的用户目录只授予该用户、SYSTEM 和管理员访问，其他普通用户读不到。via 依赖这一点。
- 不成立的情形：`%LOCALAPPDATA%`（或 `LOCALAPPDATA` 环境变量）被指到共享位置，或用户目录的 ACL 被放宽。via 不检查 ACL，也就无法告警；`via doctor` 目前也不探测。
- 管理员和 SYSTEM 不受任何一种保护，同 POSIX 的 root。
- 对令牌、凭证最敏感的两项（OAuth 记录、握手令牌）：OAuth 优先存 Credential Manager（受 DPAPI 保护，按用户加密）；握手令牌只在 daemon 运行期间存在，每次启动重新生成。

## 边界说明

- `deny` 只在 via 一侧生效。agent 可以绕过 via 直接访问上游，需要不可绕过的限制时，使用上游提供的只读端点（如 Linear 的 `/mcp/readonly`）、最小权限的 token，或网关。
- via 不修改任何框架配置，也不代替框架做权限判断。
