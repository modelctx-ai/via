# 0019. OAuth 客户端身份与凭据：CIMD、固定回调端口、client credentials、绑定授权服务器

- 状态：已接受
- 日期：2026-10-21

## 背景

`2025-11-25` 的 MCP 授权规范把客户端的注册方式改成：优先 CIMD（Client ID Metadata Document，客户端用一个 https 地址作 `client_id`），其次预注册，动态注册（DCR）退为兜底（`2026-07-28` 起 DCR 已标为弃用）。via 原来只会 DCR：每次登录都在随机回环端口上重新注册，授权服务器里留下一堆一次性的客户端，授权页上的客户端名也不可信（谁都可以注册成 `via`）。

另有三个缺口：

- **预注册的机密客户端**：`clientId` 只能当公开客户端用，要求 HTTP Basic 认证的授权服务器没法接。
- **没有人在场的场景**（CI、容器、定时任务）：授权码流程要浏览器，`--manual` 也要人粘贴。MCP 的扩展 `io.modelcontextprotocol/oauth-client-credentials` 规定了机器对机器的 `client_credentials` 授权。
- **凭据跟着 MCP server 的声明走**：授权服务器由 MCP server 的受保护资源元数据决定。如果 via 保存的客户端凭据（DCR 得到的 secret、配置的 secret、refresh token）在 server 事后改了授权服务器后仍然发出去，被攻陷或被改写的 server 就能收走它们（SEP-2352 描述的问题）。

约束：不为特定 server 适配（[ADR 0007](0007-no-gateway-specific-adaptation.md)）；凭据不进输出、日志与存储里的明文（[security.md](../spec/security.md)）；CLI 冷启动不变，SDK 与 `jose` 仍按需加载；via 不读取其他客户端的 token（[ADR 0003](0003-read-only-framework-configs.md)）。

## 决策

**CIMD 优先，DCR 兜底，配置的 `clientId` 最优先。** 授权服务器元数据 `client_id_metadata_document_supported: true` 时，`client_id` 是 via 的元数据文档地址 `https://modelctx-ai.github.io/via/client-metadata.json`；否则 DCR；配置了 `clientId` 就都不用。文档放仓库的 `pages/client-metadata.json`，由 GitHub Actions 发布到 GitHub Pages（仓库已启用 Pages，不需要手工步骤）。地址即身份：改它等于换一个客户端，所以写进代码常量，由测试核对文档与代码一致。`auth.oauth.clientMetadataUrl` 可以换成自托管的地址，或写 `false` 关闭 CIMD；它和 `clientId` 一样允许写在项目级配置里，因为它只影响授权页上显示的客户端名与登记的回调地址，而授权请求里的 `redirect_uri` 总是 via 自己选的回环地址。

**回调端口固定为 `127.0.0.1:29842–29851`，取第一个空闲的；只用 IP 字面量，不用 `localhost`。** CIMD 文档必须事先列出回调地址，所以不能再是随机端口。选这一段的理由：低于所有系统的临时端口范围（Linux 32768–60999，macOS、Windows、BSD 49152 起），端口被占用就只会是别的程序在监听，而不是本机的外发连接碰巧占了；避开开发服务器与数据库常用的端口；十个，几次并发登录或一个残留的监听不会让登录失败。RFC 8252 第 8.3 节建议用 IP 字面量而不是 `localhost`（后者要经 DNS 解析，且可能指到 `::1`），所以文档里只列 `127.0.0.1`，via 的监听也只绑 `127.0.0.1`。`--manual` 没有监听，回调地址取范围里的第一个。DCR 与配置的 `clientId` 也用同一个范围，不再有随机端口：DCR 注册的仍是本次用的那一个地址；预注册的客户端现在只需在授权服务器登记这十个地址（原来必须让授权服务器接受任意端口）。十个端口都被占用时退出码 6，`next:` 建议 `--manual`。

**预注册客户端可以有 secret。** `auth.oauth.clientSecret` 是凭证引用，登录与刷新时由 SDK 按授权服务器支持的方式（优先 `client_secret_basic`）带上；值不写进存储的记录。

**client credentials 扩展：secret 优先，私钥断言一并支持。** `auth.oauth.grant: client_credentials`，配 `clientId` 和 `clientSecret`（`client_secret_basic`/`post`）或 `privateKey`（PEM，`private_key_jwt`，RFC 7523，`keyAlgorithm` 默认 `RS256`）之一，都是凭证引用。发现仍走受保护资源元数据（RFC 9728）。机器授权不需要先登录：没有可用令牌时调用自己申请，令牌（没有 refresh token）连同授权服务器的身份存进与授权码登录分开的记录；`via auth login` 只是可选的「现在就验证」。用 SDK 自带的 `ClientCredentialsProvider`/`PrivateKeyJwtProvider` 做令牌请求，via 自己管发现、存储与绑定。私钥只支持 PEM（PKCS#8）：SDK 对字符串形式的密钥只支持 RS、PS、ES 系列，也不想在这里发明密钥格式。

**绑定授权服务器。** 记录里存 `issuer`；刷新与机器授权的令牌请求用保存的发现结果，没有就重新发现并与 `issuer` 比对；带配置 secret 的再次登录同样比对；不一致就拒绝（退出码 4，`next: via auth logout <provider>`），一个字节也不发给新的授权服务器。没有 secret 的登录（DCR、CIMD）没有秘密可保护，照常重新注册。早于绑定的记录采用遇到的第一个授权服务器。

**企业托管授权（ID-JAG）不做。** 它需要经企业 IdP 先登录，配置面和流程都大，目前没有需求，路线图里排在最后；一致性场景 `auth/cross-app-access-complete-flow` 留在已知失败清单里。

## 备选方案

- **保留随机端口，CIMD 文档用一个通配的回调地址**：CIMD 文档的 `redirect_uris` 是精确匹配，RFC 8252 的任意端口规则只对 DCR/预注册的原生客户端成立；授权服务器对通配的态度不一致。固定范围最可预测。
- **文档放在独立域名**：多一个要续费、要维护的东西；GitHub Pages 随仓库走，足够。代价是 `modelctx-ai.github.io` 这个地址绑死了仓库的组织名（改组织名要同时发新版本，旧版本的客户端身份会随之失效）。
- **回调同时登记 `localhost`**：多十个地址，换来的只是 via 从不使用的写法。
- **机器授权必须先 `via auth login`**：CI 里每次都要多一条命令，令牌过期的长任务还是得有自动重新申请的路径，两条路径比一条差。
- **配置里钉死授权服务器（`issuer` 字段）**：对全新的 CI 机器（存储里没有记录，绑定不起作用）是唯一真正的保护，但是新增一个配置面；这次先做存储里的绑定，钉住授权服务器留作后续（记在路线图 e7 的说明里）。
- **CIMD 失败时自动退回 DCR**：失败发生在授权服务器取文档时，via 看到的只是浏览器里的错误页和超时，没有可靠的信号；用 `clientMetadataUrl: false` 显式切换。
- **自己实现 `client_credentials` 的令牌请求与断言签名**：SDK 的提供者就是这些的权威实现，并且已带上 SEP-2352 的 `expectedIssuer`。

## 后果

- 授权码登录不再在授权服务器里留下一次性的 DCR 客户端（对支持 CIMD 的服务器）；`via auth login` 的 stderr 提示用的是 CIMD 以及怎样关掉。
- 十个固定端口被占用的概率很低但不为零；`--manual` 始终可用。本机其他程序可以预先占满端口使登录失败，但拿不到可兑换的授权码（PKCE 的 verifier 只在 via 进程内）。
- 文档地址不可达时，支持 CIMD 的授权服务器会在授权页报错；用 `clientMetadataUrl: false` 绕开。
- 记录多了 `issuer` 与 `grant` 字段，存储键只在机器授权时多一项，已有登录不受影响。
- 新增 `jose` 为开发依赖（测试里的模拟授权服务器验证断言）；运行时的 `jose` 是 SDK 的依赖，只在用私钥断言时才加载。
- 一致性测试：`auth/basic-cimd`、`auth/pre-registration`、`auth/client-credentials-basic`、`auth/client-credentials-jwt` 通过，已从 `expected-failures.yml` 移除。
