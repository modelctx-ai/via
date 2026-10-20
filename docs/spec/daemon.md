# Daemon 与连接管理

CLI 是短进程，每次调用都重新握手、重新拉起 stdio server 会慢到不可用；因此由一个按需自动拉起、空闲自动退出的 per-user daemon 持有 MCP 会话。用户感知不到它的存在。

## 生命周期

1. CLI 检查 socket：Linux 为 `$XDG_RUNTIME_DIR/via.sock`（未设置时退回用户缓存目录），macOS 为用户缓存目录下的 `via.sock`，Windows 为 named pipe `\\.\pipe\via-<用户名>`（路径可以算出，Windows 本身 0.3 才支持，0.2 在 Windows 上始终用进程内模式）。同目录下还有 `via.sock.lock`（启动锁）、`via.sock.token`（握手令牌）、`via.sock.log`（分离启动的 daemon 的 stderr，只在启动失败时读来拼错误信息，超过 64 KB 在下次启动时清空）。
2. 不存在则以 `via daemon run` 分离启动（`--socket`、`--idle-timeout` 由 CLI 传入），最多等待 2 秒就绪，然后转发请求。启动出错（可执行文件不存在、进程立即退出）时不必等满 2 秒，直接回退。
3. 握手时交换版本；CLI 与 daemon 版本不一致时，daemon 回复 `ok: false, reason: "version"`，**先停止监听并删除 socket**，处理完在途请求后退出，由本次 CLI 重新拉起一个版本一致的 daemon（旧 daemon 与新 daemon 因此可以短暂并存）。
4. daemon 空闲 10 分钟退出（没有连接、没有在途请求）；单个 stdio server 空闲 5 分钟停止子进程（均可配置，见 [config.md](config.md)）。HTTP 会话不因空闲关闭（它们不占本机进程，保留下来才能继续订阅 `list_changed`），随 daemon 退出而结束。socket 文件被删除或被别的 daemon 替换后，旧 daemon 在几秒内自行退出，避免出现无法连上的常驻进程。
5. daemon 异常（拉起失败、握手被拒、连接中断）时，CLI 回退为进程内模式完成本次调用，并在 stderr 提示一次（`warning: <原因>; continuing without the daemon (VIA_NO_DAEMON=1 silences this)`）。回退只对**没有副作用**的请求自动发生：列目录、校验、以及只读工具（`readOnlyHint`）的调用。其他调用若在请求已经写出之后连接中断，它可能已经执行，via 不重放，而是以退出码 6 报告 `lost the connection to the via daemon while calling …; it may or may not have run`，`next: via daemon status`。请求写出之前的失败（拉起失败、连不上）则对所有请求都回退。

### 启动竞争与陈旧 socket

多个 CLI 可能同时发现没有 daemon 并各自拉起一个。`via daemon run` 启动时先取启动锁（`O_EXCL` 创建的 `via.sock.lock`，写入自己的 pid；持有者已退出或锁超过 10 秒视为遗留，可接管），在锁内依次：探测现有 socket 是否有 daemon 在应答（有则静默退出，请求由先到者处理）→ 删除无人应答的陈旧 socket → 绑定 → 写入令牌 → 释放锁。因此同时发起的 CLI 最终只会留下一个 daemon，陈旧 socket（上一个 daemon 被 SIGKILL 后遗留）也会被下一个启动的 daemon 清理。

### 环境与工作目录

CLI 在每个请求里带上它加载好的 server 定义（只含凭证**引用**）、自己的工作目录、`daemon.serverIdleTimeout`，daemon 自己不读配置文件，所以项目级 `.via.yaml` 随调用目录变化，不会被某个 daemon 的启动目录固化。

- stdio server 没有写 `cwd` 时，以调用方的工作目录启动；`file:` 引用的相对路径同样相对调用方的目录（daemon 内换算成绝对路径）。会话按「server 名 + 传输 + 鉴权 + `exclusive` + `concurrency`」的哈希区分，所以不同目录下的同名 stdio server 是不同的会话。
- `env:` 引用在 **daemon 自己的环境**里解析（它由第一个启动它的 CLI 继承环境），解析值不经过 socket。为了不让 daemon 用着过期的环境变量，每个请求带 `envStamp`：对该 server 所有 `env:` 引用的变量名与调用方当前取值取单向摘要。daemon 用自己的环境算同一个摘要，不一致就回复 `stale`（不执行请求），CLI 随即让 daemon 退出（处理完在途请求）、拉起新的并重试一次；重试后仍不一致则回退为进程内模式。摘要不可逆，协议里仍然没有凭证值。
- daemon 里解析过的凭证（`file:`、`keychain:`、`env:` 的结果）缓存 10 分钟后丢弃，之后重新解析，所以轮换过的密钥无需重启 daemon；丢弃的值仍保留在脱敏名单里。

## daemon 持有的状态

- MCP 会话：stdio 子进程、HTTP 的 session id、OAuth 会话（登录与登出由 CLI 完成，daemon 在下一次请求时读到存储里的新状态，见 [auth.md](auth.md#oauth)）。
- 工具目录的内存副本（同时持久化到磁盘缓存，写入的是与进程内模式相同的 `catalog/` 文件，两种模式共享），以及 `list_changed` 订阅：收到 `notifications/tools/list_changed` 后 50 毫秒内（合并连发的通知）重新 `tools/list`，同时替换内存副本和磁盘缓存，所以下一次浏览、`find` 或调用就能看到变化；刷新失败时丢弃副本与磁盘缓存，下一次请求重新向 server 拉取。内存副本的有效期与磁盘缓存相同（24 小时）。stdio server 因空闲被停止后订阅随之结束，之后只靠 TTL。
- 凭证解析结果与 OAuth token 刷新。
- 截断结果的游标（内存，30 分钟）。daemon 退出（空闲 10 分钟）后游标随之失效，`via more` 报告过期（退出码 3）；进程内模式的游标仍在缓存目录里。`via more` 先问已经在运行的 daemon（不会为它拉起新的），再看缓存目录。
- 编译好的 JSON Schema（见下「校验」）。

## CLI 与 daemon 的协议

socket 上的 JSON Lines，一行一个消息（单条上限 256 MB）。参数解析和输出渲染在 CLI 侧完成，daemon 只返回结构化结果，这样渲染逻辑只有一份，进程内模式也能复用同一组类型（`src/protocol.ts`，以它为准）。目录的拆分、分域、索引都由 CLI 从原始 `tools/list` 结果计算（计算结果由 CLI 存成磁盘上的预构建缓存，见 [discovery.md](discovery.md#预构建缓存)），daemon 只提供原始列表，因此没有 `ls`、`find`、`describe` 请求。

握手：CLI 连接后先发 `hello`，其他消息在握手前一律断开连接。

```ts
type Hello = { type: "hello"; version: string; pid: number; token?: string };
type HelloAck = { type: "hello"; version: string; ok: boolean; pid?: number; reason?: "version" | "token" | "draining" };
```

请求（`id` 由 CLI 生成，同一连接上的请求可以重叠，应答按 `id` 对应）：

```ts
type ServerTarget = {
  server: ServerConfig;   // 配置里的定义：只有凭证引用，没有值
  cwd: string;            // CLI 的工作目录
  idleTimeout: number;    // stdio 会话空闲秒数
  envStamp: string;       // 见「环境与工作目录」
};

type Request =
  | { id; type: "status" }
  | ({ id; type: "list"; timeoutMs: number; refresh?: boolean; have?: number } & ServerTarget)
  | ({ id; type: "call"; rawName: string; args: object; timeoutMs?: number; retry?: boolean; progress?: boolean } & ServerTarget)
  | { id; type: "validate"; schema: unknown; label: string; data?: unknown; compileOnly?: boolean }
  | { id; type: "redact"; text: string }
  | { id; type: "cursor-put"; record: CursorRecord }
  | { id; type: "cursor-get"; cursor: string }
  | { id; type: "shutdown" }
  | { id; type: "batch" | "auth" /* 保留，daemon 返回 exitCode 7 */ };
```

应答：

```ts
type Event = { id; type: "event"; event: "progress" | "log"; data: unknown };   // 零到多次
type Response =
  | { id; type: "result"; ok: true; result: unknown; meta: { elapsedMs: number } }
  | { id; type: "result"; ok: false; error: ErrorInfo };
type Stale = { id; type: "stale"; reason: "environment" };                      // 未执行，见上
type ErrorInfo = {
  exitCode: 1 | 2 | 3 | 4 | 5 | 6 | 7;   // 与 output.md 的退出码一致
  message: string;
  next?: string;
  candidates?: string[];
};
```

各请求：

| 请求 | 行为 |
| --- | --- |
| `list` | 返回 `{ tools, fetchedAt, fromCache }`。先在 daemon 里解析该 server 的凭证（缺失则退出码 4，不发任何请求），再依次看内存副本、磁盘缓存、server；`refresh` 跳过前两者（`via sync`、`via doctor`）。未信任的项目级 server 退出码 5。`have` 是 CLI 手里已有预构建目录的那份列表的 `fetchedAt`：daemon 的列表恰好是这一份时，应答为 `{ unchanged: true, fetchedAt, fromCache: true }`，不带 `tools`（凭证与信任检查照常先做；带 `refresh` 时忽略 `have`）。CLI 只在磁盘缓存里的列表也是这一份时才带 `have`，收到 `unchanged` 后需要工具时从那个缓存文件读，所以浏览类命令不必让 daemon 把整份列表再传一遍 |
| `call` | 返回 server 的原始 `tools/call` 结果。`progress: true` 时，进度作为 `event` 推送。结果中的凭证值在 daemon 里替换为 `***` 后才发出，错误信息同样 |
| `validate` | 编译 JSON Schema（按内容缓存）并校验 `data`，返回 ajv 的错误与 `format` 警告；`compileOnly` 只编译。这样 CLI 进程不加载 ajv |
| `redact` | 把文本里 daemon 已知的凭证值换成 `***`；CLI 在打印可能回显用户输入的文本（错误、`--dry-run`、校验警告）前用它补上本地没有的脱敏。只在已有连接时发，不为它拉起 daemon |
| `cursor-put` / `cursor-get` | 存取游标记录（内容已脱敏），返回 id 或记录 |
| `status` | 返回 pid、版本、socket、运行时间、距空闲退出的时间、请求数、游标数、内存和各会话（server 名、传输、是否连接、子进程 pid、目录中的工具数、调用数、空闲时间）。不含 URL、参数和任何凭证 |
| `shutdown` | 先停止监听、删除 socket，应答，处理完在途请求后退出 |

约定：

- `call` 的 `result` 是清理前的结构化数据（MCP content 与 structuredContent），截断与渲染在 CLI 侧做，渲染所需的游标写入 daemon。
- 协议中不得出现解析后的凭证值：server 定义里只有引用；`env:` 的差异只以摘要交换；`call` 的结果、进度和错误在 daemon 内先脱敏。CLI 在 daemon 模式下本地不解析凭证，脱敏靠 daemon 的结果和 `redact`。
- `auth` 请求的 `login` 不经过 daemon：登录需要浏览器或终端交互，由 CLI 在自己的进程里完成并写入共用存储（[auth.md](auth.md#oauth)）；daemon 里的会话在下一次请求前读取存储，所以新的登录、登出和刷新结果无需通知。
- 未知消息类型返回 `exitCode: 7` 的错误，不断开连接。

## 校验

`validate` 把参数校验放在 daemon 里：CLI 在 daemon 模式下既不加载 MCP SDK 也不加载 ajv（[实现说明](../development/implementation.md#启动速度)），daemon 则复用已编译的 schema。联系 daemon 失败时 CLI 回退为本地 ajv，校验没有副作用，不需要提示。

## 并发

- agent 可能并行启动多个 `via` 进程，daemon 对每个连接独立处理。
- 同一 server 上的多个请求复用一个 MCP 会话，通过 JSON-RPC id 多路复用。
- 可按 server 配置并发上限（`concurrency`），超出时排队。上限在会话上执行，因此跨 CLI 进程、跨连接共同生效。
- `via batch` 在 CLI 侧把每一行当作一个独立的 `call` 请求并发发出：参数校验、危险操作确认、渲染和输出排序都在 CLI 侧完成，daemon 只看到并发的 `call`，由上述 `concurrency` 限流。协议草案里的 `batch` 请求因此不是 0.2 的必需项，保留消息类型但 daemon 不处理。

## 独占资源的 server

有些 server 会锁定同一个 SQLite 文件、浏览器 profile 或固定端口，和框架里仍在运行的同名实例冲突。配置 `exclusive: true` 后：

- 启动失败时 via 给出明确提示：可能与 agent 框架中的同名 server 冲突，运行 `via doctor` 查看关闭方法。
- daemon 不为这类 server 保持空闲会话：最后一个在途请求结束后立即停止 stdio 子进程（每次调用重新拉起，与进程内模式一致），让 daemon 不长期占着框架需要的锁。工具目录的副本仍然保留，浏览和 `find` 不需要拉起它。

## 无 daemon 模式

设置 `VIA_NO_DAEMON=1`（任何非空且不是 `0`、`false` 的值）时在进程内直连，适用于 CI 或不允许常驻进程的沙箱；Windows 在 0.3 之前总是如此。HTTP server 基本不受影响；stdio server 每次调用都会重新拉起；游标保存在用户缓存目录。`via daemon status` 报告 `daemon: disabled (VIA_NO_DAEMON)`，不去连接 socket。

## socket 安全

- 目录与文件：daemon 创建的 socket 权限 0600（绑定前把 umask 设为 0177，不存在更宽的瞬间），令牌文件 0600，缓存目录回退路径下的目录 0700。内核据此拒绝其他用户 `connect`。
- CLI 连接前检查：目录属于当前用户且其他人不可写，socket 是当前用户的 socket 且没有 group/other 权限位；否则拒绝使用并回退为进程内模式（提示 `not using the via daemon: … is accessible to other users`），避免连上别人在共享目录里预先放好的 socket。
- 令牌：daemon 每次启动生成 32 字节随机令牌写入 `via.sock.token`（0600），`hello` 必须带上它，常量时间比较。它不依赖文件系统是否执行 socket 权限位。
- 对端 uid：规范原本要求用 `SO_PEERCRED`（Linux）/`getpeereid`（macOS）校验对端 uid。Node 内置的 `net` 不暴露这两个接口，0.2 不为此引入原生依赖，用上面三项（所有权检查、权限位、令牌）代替；它们防的是同机其他用户。真正的 peer uid 校验作为后续项（需要原生扩展）。
- 同一用户下的其他进程本来就能读环境和配置，这不在防护范围内（[security.md](security.md)）。
