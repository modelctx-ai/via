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

- 流程：PKCE 授权码流程，按 MCP 授权规范发现授权服务器，支持动态客户端注册；不支持动态注册的 server 需在配置中提供 `clientId`。
- 触发：`via auth login <provider>` 打开浏览器完成授权，本地回调端口接收授权码。
- 无头环境：通过 SSH 登录的 VPS、容器里，浏览器和 via 不在同一台机器，本地回调端口收不到重定向。`via auth login <provider> --manual` 只打印授权 URL，不打开浏览器、不监听回调端口；用户在任意机器上完成授权后，把落地页的完整 URL（落地页本身打不开是预期行为）粘贴回终端，via 从中取出 `code` 和 `state`。PKCE 与 state 校验不变。检测不到可用浏览器时（无 `DISPLAY`、处于 SSH 会话），默认打印授权 URL 并提示可改用 `--manual`。
- 存储：access token、refresh token 存入系统钥匙串，服务名 `via`，账户名为 server 定义的哈希。
- 刷新：daemon 负责在过期前刷新；进程内模式在调用前检查并刷新。
- 不读取其他客户端（Claude、Cursor 等）私有存储的 OAuth token；需要 OAuth 的 server 由 via 自己授权一次。
- `via auth status [provider]` 显示鉴权方式、主体标识、过期时间（不显示 token）；`via auth logout <provider>` 删除存储的 token。

## 调用时的行为

- 每次调用前按 server 解析凭证，解析结果只存在内存中。
- 收到 401、403 或授权失败时，退出码 4，并提示下一步（已配置凭证时原因写作 `rejected the credentials (HTTP 401)`，不回显任何凭证值）：

  ```console
  error: linear requires auth
  next: via auth login linear
  ```

- 凭证缺失（如环境变量未设置、钥匙串无条目）时不发起调用，直接说明缺哪一项、可以用哪种写法补上，退出码 4。
- 0.1 尚未实现 OAuth：`auth: oauth` 的 server 在调用前直接以退出码 4 失败，说明暂不支持并建议改用 `bearer`（如 Linear API key）。
- stdio 子进程的 stderr 不转发（可能回显凭证）；启动失败时，脱敏后取最后一行放进错误信息。
- `via` 顶层视图和 `via servers` 中标出需要鉴权的 provider。

## 常见 server 的鉴权

| provider | 鉴权方式 | 说明 |
| --- | --- | --- |
| github（远程） | bearer（PAT） | 远程 OAuth 需要客户端事先注册 GitHub App，第三方客户端用 PAT 最直接 |
| linear | oauth，或 bearer（API key） | OAuth 2.1 动态客户端注册 |
| notion | oauth | — |
| cloudflare | oauth | — |
| 网关（如 Asterlane） | bearer | 只持有网关 key，上游凭证在网关侧 |

详见 [Provider 指南](../guides/providers/)。
