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

`auth: oauth` 只用于 HTTP server（stdio server 写 `oauth` 视为配置错误，退出码 2）。`oauth: { scopes: […], clientId: …, clientMetadataUrl: … }`：

| 字段 | 含义 |
| --- | --- |
| `scopes` | 覆盖 server 声明的 scope |
| `clientId` | 预注册的客户端，用于既不支持 CIMD 也不支持动态注册的授权服务器；没有 `clientSecret` 时作为公开客户端使用 |
| `clientSecret` | 预注册客户端的 secret，凭证引用（`env:`、`file:`、`keychain:`、`cmd:`，[config.md](config.md#凭证引用)；`cmd:` 只允许出现在用户配置里）；需要同时写 `clientId`。令牌请求按授权服务器支持的方式带上它（优先 `client_secret_basic`，其次 `client_secret_post`），登录与刷新都带。值不写入存储的记录 |
| `grant` | `authorization_code`（默认）或 `client_credentials`（见[OAuth client credentials](#oauth-client-credentials)） |
| `privateKey`、`keyAlgorithm` | 只与 `grant: client_credentials` 一起用：用私钥签名的客户端断言（`private_key_jwt`），`privateKey` 是 PEM 私钥的凭证引用，`keyAlgorithm` 取 `RS256`（默认）、`RS384`、`RS512`、`PS256`、`PS384`、`PS512`、`ES256`、`ES384`、`ES512` |
| `clientMetadataUrl` | CIMD 的客户端元数据文档地址，缺省为 via 托管的那份（见[客户端标识](#客户端标识)）；写 `false` 关闭 CIMD、直接动态注册。必须是 https、有路径、不含用户信息与片段，否则是 `invalid-field` 错误 |

### 客户端标识

via 向授权服务器表明身份的方式，按下列顺序取第一个可用的（授权服务器元数据决定能用哪个）：

1. **配置的 `clientId`**：预注册的客户端，不再做别的注册。
2. **CIMD（Client ID Metadata Document，`2025-11-25` 授权规范推荐的方式）**：授权服务器元数据里 `client_id_metadata_document_supported` 为 `true` 时，`client_id` 就是元数据文档的 https 地址，不注册、不保存客户端信息；授权服务器自己去取这份文档，核对回调地址。via 的文档托管在 GitHub Pages：`https://modelctx-ai.github.io/via/client-metadata.json`（仓库里的 `pages/client-metadata.json`，由 `.github/workflows/pages.yml` 发布）。内容：`client_id`（即它自己的地址）、`client_name: via`、`client_uri`、`redirect_uris`（见下）、`grant_types: [authorization_code, refresh_token]`、`response_types: [code]`、`token_endpoint_auth_method: none`、`application_type: native`。`clientMetadataUrl` 换成别的地址（自托管、测试）或 `false`（关闭）。
3. **动态客户端注册（RFC 7591）**：授权服务器不支持 CIMD（或 `clientMetadataUrl: false`）但有 `registration_endpoint` 时自动注册，客户端名为 `via`，公开客户端（`token_endpoint_auth_method: none`），回调地址只登记本次登录用的那一个。每次登录重新注册。
4. 都不可用：必须配置 `clientId`，否则 `login` 退出码 2 并说明。

CIMD 的文档地址是 via 所有安装共用的身份：改动文档的地址等于换一个客户端。文档里的 `redirect_uris` 必须与代码里的回调端口范围一致（测试核对）。授权服务器取不到文档（例如服务器出不了网、文档地址暂时不可达）时，浏览器里会看到授权服务器的错误页，`via auth login` 等到超时；改用 `clientMetadataUrl: false` 即可。登录时 stderr 会提示本次用的是 CIMD 以及怎样关掉。

### 流程

- 发现：先向 server 发未带凭证的探测请求（先按无状态协议发 `server/discover`，没有得到 401/403 再按 SDK 支持的最新旧版本发 `initialize`，版本号不写死在代码里，[ADR 0017](../adr/0017-protocol-versions-newest-first-with-fallback.md)），从 `WWW-Authenticate` 取 `resource_metadata` 和 `scope`；取不到就按 RFC 9728 的 well-known 路径找受保护资源元数据，再据此找授权服务器元数据（RFC 8414，退回 OpenID Connect Discovery）。授权请求带 RFC 8707 的 `resource`。
- 客户端标识：配置的 `clientId`，授权服务器支持 CIMD 时用元数据文档的地址，否则动态注册（[客户端标识](#客户端标识)）。
- 授权：PKCE（S256）授权码流程，带随机 `state`，回调时校验 `state`；授权被拒绝、`state` 不匹配、超时（默认 300 秒，`--timeout` 覆盖）都退出码 4。
- 回调：`via auth login <provider>` 在 `127.0.0.1` 监听 `/callback`（只接受 `Host` 为该地址与端口的请求），端口取固定范围 **29842–29851** 里第一个空闲的（回调地址 `http://127.0.0.1:<端口>/callback`，只用 IP 字面量，不用 `localhost`，RFC 8252 第 8.3 节）；某个端口被占用（或系统不让绑，如 Windows 的保留端口段）就试下一个，十个都不可用时退出码 6，`next:` 建议 `--manual`。范围固定是为了让 CIMD 文档能事先列出全部回调地址（预注册的 `clientId` 也只需在授权服务器登记这十个地址，或让它按 RFC 8252 接受任意回环端口）。选这段的理由：低于所有系统的临时端口范围（Linux 32768–60999，macOS、Windows、BSD 49152 起），端口被占用只会是别的程序在监听，而不是本机某个外发连接；避开开发服务器与数据库常用的端口（3000、5000、8000–9999、5432 等）；十个，几次并发登录或一个残留的监听不会让登录失败。同时用平台的打开命令（macOS `open`、Linux `xdg-open`、Windows `rundll32 url.dll,FileProtocolHandler`）打开浏览器，并总是把授权 URL 打印出来。只打开 `http://` 与 `https://` 的地址，其他 scheme（`file:`、`ms-settings:` 等）不交给系统。server 向用户要求打开网页的 elicitation（URL 模式）用同一套打开规则，但总是先显示完整 URL 并等用户确认（[cli.md](cli.md#server-向用户提问)）。Windows 上不用 `cmd /c start`：授权 URL 来自授权服务器而不是用户，`cmd.exe` 会解释其中的 `|`、`^`、`(` 和 `%VAR%`；`rundll32.exe` 以完整路径（`%SystemRoot%\System32`）直接启动，URL 只是它的一个参数，没有 shell 看到它。动态注册的客户端每次登录都按本次的回调地址重新注册（端口取决于当时哪个空闲）；配置了 `clientId` 时，授权服务器要么登记了上述十个地址，要么按 RFC 8252 接受任意端口的回环地址。`--manual` 没有监听，回调地址取范围里的第一个（`http://127.0.0.1:29842/callback`，落地页打不开是预期行为），它同样在文档登记的地址之内。
- 无头环境：通过 SSH 登录的 VPS、容器里，浏览器和 via 不在同一台机器，本地回调端口收不到重定向。`via auth login <provider> --manual` 只打印授权 URL，不打开浏览器、不监听回调端口；用户在任意机器上完成授权后，把落地页的完整 URL（落地页本身打不开是预期行为）粘贴回终端（从 stdin 读一行），via 从中取出 `code` 和 `state`。PKCE 与 state 校验不变。检测不到可用浏览器时（Linux 无 `DISPLAY` 与 `WAYLAND_DISPLAY`、处于 SSH 会话），不尝试打开浏览器，默认打印授权 URL 并提示可改用 `--manual`；打开命令不存在或启动失败也只是提示，不报错、不等待。
- 代理：登录、刷新与撤销令牌的请求同样遵守 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`（[config.md](config.md#代理)）；回调监听在本机回环上，不经代理。
- 输出：授权 URL 写 stdout（它是命令的数据），进度与提示写 stderr，以 `·` 开头；成功后 stdout 输出 `logged in: <provider>` 与 scope、有效期、存放位置。输出中不出现 token。

### OAuth client credentials

机器对机器的授权：没有人、没有浏览器，用于 CI 与 headless 环境。实现 MCP 扩展 `io.modelcontextprotocol/oauth-client-credentials`：客户端用自己的凭据直接向授权服务器换取访问令牌（`grant_type=client_credentials`）。

```yaml
servers:
  ci-tools:
    url: https://mcp.example.com/mcp
    auth:
      oauth:
        grant: client_credentials
        clientId: ci-bot
        clientSecret: env:CI_TOOLS_SECRET     # 或者用私钥签名断言：
        # privateKey: file:~/.keys/ci-bot.pem
        # keyAlgorithm: ES256
        scopes: [read]                        # 可选
```

- 配置：`grant: client_credentials` 必须写 `clientId`，并且恰好写 `clientSecret`（`client_secret_basic`，授权服务器只支持 post 时用 `client_secret_post`）和 `privateKey`（`private_key_jwt`，RFC 7523：断言的 `iss` 与 `sub` 是 `clientId`，`aud` 是授权服务器的 issuer，有效期 300 秒）两者之一，否则是 `invalid-field` 错误。凭据是凭证引用，每次需要时才解析，值只在内存里，计入脱敏列表。**签名断言只支持 PEM（PKCS#8）私钥**；`EdDSA`、JWK、`client_secret_jwt` 不支持。
- 发现：与授权码流程相同——未带凭证的探测请求取 `WWW-Authenticate` 的 `resource_metadata` 与 `scope`，否则按 RFC 9728 的 well-known 路径找受保护资源元数据，再找授权服务器元数据（RFC 8414、OpenID Connect Discovery）；令牌请求带 RFC 8707 的 `resource`。scope 取配置的 `scopes`，没有则取挑战头的 `scope`，再没有取资源元数据的 `scopes_supported`。不做动态注册，不用 CIMD（客户端是预先配置好的），`clientMetadataUrl` 对它无意义。
- 不需要先登录：没有可用的令牌（没有记录、已过期或不足 60 秒、服务器返回 401）时，调用自己向授权服务器要一个新的，保存下来供后续调用与其他进程使用。机器授权没有 refresh token，到期就用凭据重新申请；服务器发来的 refresh token 不保存。`via auth login <provider>` 是可选的：立刻做一次令牌请求来验证凭据，同时记下这条凭据绑定的授权服务器（见下节），不打开浏览器、不监听端口、不读终端；`--manual` 对它无意义。`via auth logout <provider>` 删除保存的令牌与绑定，不向授权服务器撤销（撤销需要客户端凭据，而访问令牌很短命）。
- 凭据解析不到（环境变量未设置、钥匙串无条目等）时，发请求之前就以退出码 4 失败，`next:` 与其他凭证引用一致；授权服务器拒绝凭据（`invalid_client`、`unauthorized_client`、`invalid_scope` 等）是退出码 4：`error: <provider>: the authorization server refused the client credentials (invalid_client)`，`next: check auth.oauth of <provider> in your via config`；网络错误和授权服务器的 5xx 是退出码 6，不删除保存的令牌。
- 保存的记录与授权码登录分开：存储键里多一项 `client_credentials`，同一端点、同一 `clientId` 的两种授权互不覆盖。
- 状态：`via servers` 的鉴权列写 `oauth (client credentials, token expires in 54m)` 或 `oauth (client credentials, token requested on use)`，缺凭据时写 `oauth (client credentials, missing env:NAME)`；`via auth status` 同样；未登录不是问题，所以不报 `not logged in`。
- daemon：令牌请求在持有会话的进程里发出，用 daemon 自己的环境解析 `env:`（引用的环境变量与 CLI 不同时按[环境与工作目录](daemon.md#环境与工作目录)的 `stale` 规则退回进程内；`file:` 引用按调用方的目录解析）。

#### 企业托管授权（ID-JAG）

企业托管授权扩展（`io.modelcontextprotocol/enterprise-managed-authorization`，经企业 IdP 的身份断言换取令牌，一致性测试 `auth/cross-app-access-complete-flow`）**不实现**：它需要先在企业 IdP 上登录，流程和配置面都不小，目前没有用户需求，在路线图里排在最后。该场景留在 `test/conformance/expected-failures.yml` 里，有需求时再做。

### 绑定授权服务器

客户端凭据——动态注册得到的 `client_secret`、配置的 `clientSecret` 或私钥、机器授权的断言，以及 refresh token——只发给它们被验证时所在的授权服务器（SEP-2352）。MCP server 通过受保护资源元数据决定自己用哪个授权服务器，如果这个决定可以事后改变，一个被攻陷或被改写的 server 就能让 via 把凭据发给别处。

- 记录里存 `issuer`：登录（或机器授权的第一次令牌请求）时授权服务器元数据里的 `issuer`，没有元数据则为授权服务器的地址。DCR 客户端信息与令牌上 SDK 打的 `issuer` 标记是同一个值。比较时忽略末尾的 `/`。
- **刷新、机器授权的令牌请求**：用保存的发现结果（保存的发现结果本身就是被验证的那个授权服务器，所以日常调用不重新发现）；没有保存的发现结果（早先版本写的记录、被清掉）则重新发现，发现到的授权服务器与记录的 `issuer` 不同就拒绝，请求一个字节也不发给新的授权服务器。保存的发现结果与记录的 `issuer` 互相矛盾（记录被改过）同样拒绝。
- **再次登录**：`via auth login` 总是重新发现。配置了 `clientSecret` 或机器授权的凭据时，发现到的授权服务器与已有记录的 `issuer` 不同就拒绝，在发出授权请求或令牌请求之前；没有配置 secret 的登录（DCR、CIMD、公开客户端）没有秘密可泄露，照常进行，用新的授权服务器重新注册，覆盖旧记录。
- 拒绝的表现：退出码 4，`error: <provider>: its authorization server changed from <旧> to <新>; the saved client credentials belong to the first and were not sent to the second`，`next: via auth logout <provider>`。`logout` 删除记录（包括绑定）后再登录，凭据才会被验证到新的授权服务器——这是用户在确认「这个变更是合法的」之后才做的事。
- 早于绑定功能的记录没有 `issuer` 字段：取 DCR 客户端信息或令牌上的标记；都没有就采用遇到的第一个授权服务器，并在下一次保存时写入。
- 边界：第一次登录没有可比较的东西，凭据会发往受保护资源元数据当时指向的授权服务器（首次使用即信任）。配置里不能钉住授权服务器；每次 CI 运行都是全新机器时，存储里没有记录，绑定不起作用，这时的保护只来自配置的 `url` 本身需要可信。存储不可写时机器授权的令牌与绑定只存在于本次进程，不报警告（令牌可以重新申请）。

### 存储

- 一个 server 对应一条记录，键为 server 定义的哈希：`sha256(MCP 端点 URL, clientId, 排序后的 scopes[, grant])` 的前 32 个十六进制字符（`grant` 只在 `client_credentials` 时加入，所以已有记录的键不变）。同一个定义出现在多个来源或多个名字下共用一条记录；改了 URL、`clientId` 或 `scopes` 后需要重新登录。
- 记录是一个 JSON 对象：access token、refresh token、过期时间、scope、动态注册得到的客户端信息、授权服务器元数据缓存，以及这些所绑定的授权服务器 `issuer`（[绑定授权服务器](#绑定授权服务器)）和机器授权的 `grant`。配置里的 `clientSecret`、`privateKey` 不写入记录。
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
- 需要登录：`auth: oauth` 的 server（机器授权除外，见[OAuth client credentials](#oauth-client-credentials)）没有登录记录时不发起任何网络请求，退出码 4，输出上面的两行；登录已失效（refresh token 被拒绝或不存在且 access token 已过期）时第一行写作 `linear requires auth (the saved login expired)`。调用过程永远不会弹出浏览器，也不会等待终端输入：登录只发生在 `via auth login`。
- 目录缓存命中时，OAuth server 仍然要求有登录记录（与 bearer 缺凭证时一致），不读取过期时间，不发请求；机器授权要求的是凭据能解析，而不是记录。
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
