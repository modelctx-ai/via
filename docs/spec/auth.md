# 鉴权

框架不做鉴权，全部由 via 负责：凭证按 server 绑定，调用时自动注入。

## 鉴权方式

`servers.<name>.auth` 的取值：

| 类型 | 写法 | 适用 | 注入方式 |
| --- | --- | --- | --- |
| 无 | `none`（默认） | 本地无鉴权 server，或凭证已在 `env`/`headers` 中 | — |
| bearer | `{ bearer: "<凭证引用>" }` | 远程 HTTP server、网关 | `Authorization: Bearer <值>` |
| headers | `{ headers: { X-Api-Key: "<凭证引用>" } }` | 自定义头 | 按模板写入请求头 |
| env | 直接在 `env` 中写凭证引用 | stdio server | 拉起进程时注入环境变量 |
| oauth | `oauth` 或 `{ oauth: { scopes: [...], clientId: … } }` | 支持 MCP 授权规范的远程 server | 见下文 |

## OAuth

`auth: oauth` 只用于 HTTP server（stdio server 写 `oauth` 视为配置错误，退出码 2）。`oauth: { scopes: […], clientId: … }`：`scopes` 覆盖 server 声明的 scope；`clientId` 用于不支持动态注册的授权服务器（作为公开客户端使用，不带 secret）。

### 流程

- 发现：先向 server 发一次未带凭证的请求，从 `WWW-Authenticate` 取 `resource_metadata` 和 `scope`；取不到就按 RFC 9728 的 well-known 路径找受保护资源元数据，再据此找授权服务器元数据（RFC 8414，退回 OpenID Connect Discovery）。授权请求带 RFC 8707 的 `resource`。
- 注册：授权服务器支持动态客户端注册（RFC 7591）时自动注册，客户端名为 `via`，公开客户端（`token_endpoint_auth_method: none`）；不支持时必须配置 `clientId`，否则 `login` 退出码 2 并说明。
- 授权：PKCE（S256）授权码流程，带随机 `state`，回调时校验 `state`；授权被拒绝、`state` 不匹配、超时（默认 300 秒，`--timeout` 覆盖）都退出码 4。
- 回调：`via auth login <provider>` 在 `127.0.0.1` 的随机端口监听 `/callback`（只接受 `Host` 为该地址的请求），同时用平台的打开命令（macOS `open`、Linux `xdg-open`、Windows `rundll32 url.dll,FileProtocolHandler`）打开浏览器，并总是把授权 URL 打印出来。只打开 `http://` 与 `https://` 的地址，其他 scheme（`file:`、`ms-settings:` 等）不交给系统。Windows 上不用 `cmd /c start`：授权 URL 来自授权服务器而不是用户，`cmd.exe` 会解释其中的 `|`、`^`、`(` 和 `%VAR%`；`rundll32.exe` 以完整路径（`%SystemRoot%\System32`）直接启动，URL 只是它的一个参数，没有 shell 看到它。动态注册的客户端每次登录都按本次的回调地址重新注册，因为端口是随机的；配置了 `clientId` 时需要授权服务器按 RFC 8252 接受任意端口的 loopback 回调地址。
- 无头环境：通过 SSH 登录的 VPS、容器里，浏览器和 via 不在同一台机器，本地回调端口收不到重定向。`via auth login <provider> --manual` 只打印授权 URL，不打开浏览器、不监听回调端口；用户在任意机器上完成授权后，把落地页的完整 URL（落地页本身打不开是预期行为）粘贴回终端（从 stdin 读一行），via 从中取出 `code` 和 `state`。PKCE 与 state 校验不变。检测不到可用浏览器时（Linux 无 `DISPLAY` 与 `WAYLAND_DISPLAY`、处于 SSH 会话），不尝试打开浏览器，默认打印授权 URL 并提示可改用 `--manual`；打开命令不存在或启动失败也只是提示，不报错、不等待。
- 输出：授权 URL 写 stdout（它是命令的数据），进度与提示写 stderr，以 `·` 开头；成功后 stdout 输出 `logged in: <provider>` 与 scope、有效期、存放位置。输出中不出现 token。

### 存储

- 一个 server 对应一条记录，键为 server 定义的哈希：`sha256(MCP 端点 URL, clientId, 排序后的 scopes)` 的前 32 个十六进制字符。同一个定义出现在多个来源或多个名字下共用一条记录；改了 URL、`clientId` 或 `scopes` 后需要重新登录。
- 记录是一个 JSON 对象：access token、refresh token、过期时间、scope、动态注册得到的客户端信息、授权服务器元数据缓存。
- 首选系统钥匙串：服务名 `via`，账户名 `oauth:<哈希>`，整条记录作为密码字段存放。钥匙串不可用（常见于没有 Secret Service 的 Linux 服务器、容器）或写入失败时，退回用户数据目录下的文件 `oauth/<哈希>.json`（目录 0700、文件 0600，原子替换），`login` 的输出说明存放位置和原因。读取时两处都查，钥匙串优先。
- Windows：钥匙串是 Credential Manager，单条凭据最多 2560 字节（1280 个 UTF-16 字符），而整条记录（token、客户端注册、发现结果）经常更长。Windows 上超过 1000 个字符的记录拆成几条存放：主条目（账户名 `oauth:<哈希>`）的内容是 `via:chunks:<N>`，片段在 `oauth:<哈希>#0` … `#N-1`，先写片段再写主条目，更新后多余的旧片段删除，读取时缺任何一片都当作没有登录。其他平台不拆，由系统钥匙串自己的限制决定是否退回文件。回退的文件存放在用户数据目录 `%LOCALAPPDATA%\via\Data\oauth\`，Windows 没有 `0600` 这类权限位，文件的私密性来自用户目录的默认 ACL（只有该用户、SYSTEM 和管理员可读），这是比钥匙串弱的保护，所以钥匙串仍是首选。
- `VIA_OAUTH_STORE=file|keychain|auto`（默认 `auto`）可固定存放位置：`file` 不碰钥匙串，`keychain` 在钥匙串不可用时报错而不退回文件。
- 记录损坏或无法解析时视为未登录。已知的 token 值计入脱敏列表，任何输出里一律替换为 `***`。
- 不读取其他客户端（Claude、Cursor 等）私有存储的 OAuth token；需要 OAuth 的 server 由 via 自己授权一次。via 也不写任何框架的配置。

### 刷新

- 每次发请求前检查 access token：已过期或不足 60 秒到期且有 refresh token 时，先用 refresh token 静默刷新，成功后写回存储；服务端轮换 refresh token 时保存新值。收到 401 时刷新一次后重试一次。
- 会话由谁持有都一样：进程内模式在每次请求前检查，daemon 里长期存活的会话同样在每次请求前检查，所以不需要后台定时器；登录或登出由另一个进程完成后，持有会话的进程在几秒内就会读到新的状态。
- 并发：同一进程内同一 server 的刷新串行化。多个进程同时刷新而 refresh token 被轮换时，输掉的一方重新读取存储，改用已经刷新好的 token。
- 存储不可写（只读的目录或钥匙串）时，刷新得到的新 token 存不下来：当前进程继续使用内存里的新记录（后续刷新也用它，不会读回存储里已被服务端轮换作废的旧 refresh token），但别的进程只能读到旧记录，服务端轮换 refresh token 时就会被拒绝而要求重新登录。因此 via 在 stderr 提示一次 `warning: could not save the refreshed OAuth login for <provider> (<原因>); …`（每个会话一次：进程内模式是本次运行，daemon 是该 server 的会话；daemon 里这条提示作为 `log` 事件发给触发刷新的那个请求，见 [daemon.md](daemon.md#cli-与-daemon-的协议)）。`via doctor` 对存放在文件里且目录或文件不可写的登录给出提示与 `chmod` 建议（不改变退出码）；钥匙串不做探测，因为探测只能靠写入。
- 刷新被拒绝（`invalid_grant` 等，说明登录已失效）时，删除记录里的 token（保留客户端信息），按下文「需要登录」处理。网络错误或授权服务器的 5xx 不算登录失效，按上游错误处理（退出码 6），不删除 token。

### 状态与登出

- `via auth status [provider]`：不带 provider 时每个未禁用的 server 一行：provider、鉴权方式、状态，OAuth 的状态为 `logged in`、`access token expired (refreshes on next call)`、`expired` 或 `not logged in`，后接过期时间、scope、主体（授权服务器返回 `id_token` 时取其中的 `email`、`preferred_username` 或 `sub`，仅用于显示）、存放位置。带 provider 时只输出该行，未登录或登录已失效则退出码 4。不显示 token。`-o json` 输出同样字段的 JSON 数组。
- `via auth logout <provider>`：先向授权服务器的 `revocation_endpoint`（RFC 7009）撤销 refresh token 和 access token（尽力而为，最长等 5 秒，失败只提示），再删除本地的整条记录；没有记录时也成功，输出 `not logged in`。
- `via auth login`、`via auth logout` 总是在 CLI 进程内完成（登录需要浏览器或终端交互）。daemon 不转发这两个动作；它持有的会话在下次请求时读到新状态，登出后下一次请求按「需要登录」处理。

## 调用时的行为

- 每次调用前按 server 解析凭证，解析结果只存在内存中。
- 收到 401、403 或授权失败时，退出码 4，并提示下一步（已配置凭证时原因写作 `rejected the credentials (HTTP 401)`，不回显任何凭证值）：

  ```console
  error: linear requires auth
  next: via auth login linear
  ```

- 凭证缺失（如环境变量未设置、钥匙串无条目、`cmd:` 命令失败）时不发起调用，直接说明缺哪一项、可以用哪种写法补上，退出码 4。`cmd:` 失败时只说明程序名与原因（退出状态、超时、输出为空等），不显示命令的任何输出（[config.md](config.md#凭证引用)）。
- 需要登录：`auth: oauth` 的 server 没有登录记录时不发起任何网络请求，退出码 4，输出上面的两行；登录已失效（refresh token 被拒绝或不存在且 access token 已过期）时第一行写作 `linear requires auth (the saved login expired)`。调用过程永远不会弹出浏览器，也不会等待终端输入：登录只发生在 `via auth login`。
- 目录缓存命中时，OAuth server 仍然要求有登录记录（与 bearer 缺凭证时一致），不读取过期时间，不发请求。
- 配置为 `auth: none` 的 HTTP server 收到 401 时，`next:` 仍是 `via auth login <provider>`；该命令会说明需要把 `servers.<name>.auth` 设为 `oauth`（或 bearer）。
- stdio 子进程的 stderr 不转发（可能回显凭证）；启动失败时，脱敏后取最后一行放进错误信息。
- `via` 顶层视图和 `via servers` 中标出需要鉴权的 provider；`via servers` 的鉴权列对 OAuth 写 `oauth (logged in, expires in 54m)`、`oauth (access token expired, refreshable)`、`oauth (expired)` 或 `oauth (not logged in)`，`via doctor` 对未登录或已失效的 OAuth server 报 `needs auth` 并给出 `next: via auth login <provider>`。

## 常见 server 的鉴权

| provider | 鉴权方式 | 说明 |
| --- | --- | --- |
| github（远程） | bearer（PAT） | 远程 OAuth 需要客户端事先注册 GitHub App，第三方客户端用 PAT 最直接 |
| linear | oauth，或 bearer（API key） | OAuth 2.1 动态客户端注册 |
| notion | oauth | — |
| cloudflare | oauth | — |
| 网关（如 Asterlane） | bearer | 只持有网关 key，上游凭证在网关侧 |

详见 [Provider 指南](../guides/providers/)。
