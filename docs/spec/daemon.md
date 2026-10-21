# Daemon 与连接管理

CLI 是短进程，每次调用都重新握手、重新拉起 stdio server 会慢到不可用；因此由一个按需自动拉起、空闲自动退出的 per-user daemon 持有 MCP 会话。用户感知不到它的存在。

## 生命周期

1. CLI 检查 socket：Linux 为 `$XDG_RUNTIME_DIR/via.sock`（未设置时退回用户缓存目录），macOS 为用户缓存目录下的 `via.sock`，Windows 为 named pipe（见下「Windows」，名字由握手令牌派生）。同目录下还有 `via.sock.lock`（启动锁）、`via.sock.token`（握手令牌）、`via.sock.log`（分离启动的 daemon 的 stderr，只在启动失败时读来拼错误信息，超过 64 KB 在下次启动时清空）。Windows 上没有 socket 文件，这三个文件在用户缓存目录 `%LOCALAPPDATA%\via\Cache` 下，名为 `via.lock`、`via.token`、`via-daemon.log`。
2. 不存在则以 `via daemon run` 分离启动（`--socket`、`--idle-timeout` 由 CLI 传入），最多等待 2 秒就绪（Windows 上 5 秒，冷启动的 node.exe 与杀毒扫描更慢），然后转发请求。运行时是 Node 时，CLI 另给它 `--max-semi-space-size=2`（Node 文档列出的 V8 选项；新生代上限 2 MiB，默认会在加载 MCP SDK 的那一阵分配后涨到 16 MiB 并一直留着），Linux 上再设 `MALLOC_ARENA_MAX=2`（glibc 默认每个线程一个 arena）；两者合计让建立会话之后的常驻内存少 5 到 10 MiB。Bun 或编译出的单文件可执行不收到 Node 的选项。启动出错（可执行文件不存在、进程立即退出）时不必等满 2 秒，直接回退。拉起的是当前程序自身，而不是 PATH 上的 `via` 或 `node`：以脚本运行时为 `<node 或 bun> <入口脚本> daemon run …`，以单文件可执行运行时为 `<该可执行文件> daemon run …`（它的入口脚本只存在于可执行文件内部，无法再传给别的进程）。
3. 握手时交换版本；CLI 与 daemon 版本不一致时，daemon 回复 `ok: false, reason: "version"`，**先停止监听并删除 socket**，处理完在途请求后退出，由本次 CLI 重新拉起一个版本一致的 daemon（旧 daemon 与新 daemon 因此可以短暂并存）。
4. daemon 空闲 10 分钟退出（没有连接、没有在途请求）；单个 stdio server 空闲 5 分钟停止子进程（均可配置，见 [config.md](config.md)）。HTTP 会话不因空闲关闭（它们不占本机进程，保留下来才能继续订阅 `list_changed`），随 daemon 退出而结束。socket 文件被删除或被别的 daemon 替换后，旧 daemon 在几秒内自行退出，避免出现无法连上的常驻进程。
5. daemon 异常（拉起失败、握手被拒、连接中断）时，CLI 回退为进程内模式完成本次调用，并在 stderr 提示一次（`warning: <原因>; continuing without the daemon (VIA_NO_DAEMON=1 silences this)`）。回退只对**没有副作用**的请求自动发生：列目录、校验、MCP 资源与 prompt 的列出和读取（协议上都是只读的），以及只读工具（`readOnlyHint`）的调用。其他调用若在请求已经写出之后连接中断，它可能已经执行，via 不重放，而是以退出码 6 报告 `lost the connection to the via daemon while calling …; it may or may not have run`，`next: via daemon status`。请求写出之前的失败（拉起失败、连不上）则对所有请求都回退。
   - **请求的期限**：CLI 给每个转发的请求一个期限，即请求自己的超时（`list` 的 `timeoutMs`，`call` 的超时，只读工具重试时加倍）再加 30 秒。daemon 按同一个超时完成请求（排队、建立会话、请求本身都算在内，见 [arguments.md](arguments.md#调用过程)），所以正常情况下期限不会到。期限到了也不立刻判定 daemon 失效：同一条连接上还有发给其他 server 的请求。CLI 先在这条连接上发 `status`，2 秒内有应答，说明 daemon 还在工作，只有这个请求按上面的规则处理（只读的在进程内重做，提示 `warning: the via daemon did not answer in time while <操作>; running it in this process (VIA_NO_DAEMON=1 silences this)`，本次运行的其余请求照常走 daemon；其他调用以退出码 6 报告 `the via daemon did not answer in time while calling …; it may or may not have run`）；`status` 也没有应答才断开连接，按连接中断整体回退。

### 进程记录

socket 只能说明有没有 daemon 在接受连接。还在启动（取锁、绑定之前）和正在收尾（收到 `shutdown` 或版本不一致后已经删掉 socket、在处理在途请求）的 daemon 进程连不上，却仍在运行。因此每个 `via daemon run` 进程在活着的时候都在 socket 旁的记录目录里留一个以自己 pid 命名的文件（`via.sock.pids/<pid>.json`，Windows 为缓存目录下的 `via.pids\<pid>.json`；目录 0700、文件 0600），内容只有 `{ pid, state }`，`state` 为 `starting`、`running`、`stopping`。进程在状态变化时重写它、每 5 秒更新一次修改时间，退出前删除。

- `via daemon status` 与 `via daemon stop` 在 socket 上没有应答时读这个目录（[cli.md](cli.md)），从而报告并结束正在启动或收尾的 daemon，而不是报告「没有运行」。
- 进程已不存在、或 15 秒没有更新修改时间（被 `SIGKILL`、来不及删除）的记录被读取方删除并忽略：这样一个已被系统分配给无关进程的 pid 永远不会收到信号。只认当前用户能发信号的进程。
- 记录里只有 pid 与状态，没有路径、命令行或凭证。

### 启动竞争与陈旧 socket

多个 CLI 可能同时发现没有 daemon 并各自拉起一个。`via daemon run` 启动时先取启动锁（`O_EXCL` 创建的 `via.sock.lock`，写入自己的 pid；持有者已退出或锁超过 10 秒视为遗留，可接管），在锁内依次：探测现有 socket 是否有 daemon 在应答（有则静默退出，请求由先到者处理）→ 删除无人应答的陈旧 socket → 写入令牌 → 绑定 → 释放锁。因此同时发起的 CLI 最终只会留下一个 daemon，陈旧 socket（上一个 daemon 被 SIGKILL 后遗留）也会被下一个启动的 daemon 清理。Windows 上同样先取锁，「探测现有 daemon」是读令牌文件、算出管道名再连接（见下）；陈旧的令牌文件（daemon 被强杀后遗留）指向一个不存在的管道，探测失败，被新 daemon 的令牌覆盖。

### 环境与工作目录

CLI 在每个请求里带上它加载好的 server 定义（只含凭证**引用**）、自己的工作目录、`daemon.serverIdleTimeout`，daemon 自己不读配置文件，所以项目级 `.via.yaml` 随调用目录变化，不会被某个 daemon 的启动目录固化。

- stdio server 没有写 `cwd` 时，以调用方的工作目录启动；`file:` 引用的相对路径同样相对调用方的目录（daemon 内换算成绝对路径）。会话按「server 名 + 传输 + 鉴权 + `exclusive` + `concurrency` + `roots`」的哈希区分，所以不同目录下的同名 stdio server 是不同的会话。
- `roots`（[config.md](config.md#roots)）里的相对路径和 `~` 同样由 daemon 按调用方的目录与家目录换成绝对 `file://` URI，换算后的列表参与会话键：写了 `roots: ["."]` 的 server 在两个目录里是两个会话，一个会话的 roots 在它的生命周期里不变，所以 via 声明 `roots` 能力时 `listChanged` 为 `false`，不需要发 `notifications/roots/list_changed`。没有 `cwd` 的 HTTP server 因 roots 而按目录分会话，代价与 stdio 的 `cwd` 相同：两个目录交替使用时，后到的会话替换先到的（同名 server 只保留最新定义的会话）。
- `env:` 引用在 **daemon 自己的环境**里解析（它由第一个启动它的 CLI 继承环境），解析值不经过 socket，协议里始终没有凭证值。每个请求带 `envStamp`：对该 server 所有 `env:` 引用的变量名与调用方当前取值取单向摘要（没有 `env:` 引用时为空串）。daemon 用自己的环境算同一个摘要，不一致就回复 `stale`（不执行请求）。
  - 收到 `stale` 的 CLI **只对这个 server 的这一个请求**改用进程内模式完成：不重启 daemon，也不把取值告诉 daemon；daemon 里按自己环境建立的会话继续服务摘要一致的调用方，对同一次运行里的其他 server 照常使用 daemon。`stale` 的请求没有执行过，所以不论是否只读都可以安全地在进程内重做，也不打印回退提示。
  - 因此两个 shell 里 `GH_TOKEN` 取值不同、交替调用时：与 daemon 环境一致的那个 shell 用 daemon，另一个 shell 的该 server 每次调用都在进程内完成，两边各用自己的取值，daemon 不会反复重启。调用方没有设置该变量时摘要同样不一致，由进程内的凭证解析报缺失（退出码 4），永远不会拿到 daemon 环境里的同名变量。
  - 代价：这是用共存换「凭证不过 socket」。取值不一致的 shell 失去 daemon 的好处：HTTP 每次重新握手，stdio server 每次调用都重新拉起子进程（与进程内模式一致）。想让某个 shell 也用上 daemon，可以让它的环境与 daemon 一致（`via daemon stop` 后由该 shell 重新拉起），或者用 `file:` / `keychain:` 引用代替 `env:`——这两种由 daemon 自己解析，与调用方的环境无关。
- daemon 里解析过的凭证（`file:`、`keychain:`、`env:` 的结果）缓存 10 分钟后丢弃，之后重新解析，所以轮换过的密钥无需重启 daemon；丢弃的值仍保留在脱敏名单里。

## daemon 持有的状态

- MCP 会话：stdio 子进程、HTTP 的 session id、OAuth 会话（登录与登出由 CLI 完成，daemon 在下一次请求时读到存储里的新状态，见 [auth.md](auth.md#oauth)）。
- 工具目录的副本，连同 server 在 `initialize` 里声明的 `resources` / `prompts` 能力，以及 `list_changed` 订阅：副本就是磁盘缓存（与进程内模式相同的 `catalog/` 文件，两种模式共享，能力声明一并写入）；daemon 在内存里只记下它的 `fetchedAt`、能力声明和工具个数，不留解析后的工具对象（几百个工具是几 MB），有人不带 `have` 来要列表时才从文件读出来发送；只有磁盘写不进去时才把列表留在内存里。订阅：收到 `notifications/tools/list_changed` 后 50 毫秒内（合并连发的通知）重新 `tools/list`，同时替换内存副本和磁盘缓存，所以下一次浏览、`find` 或调用就能看到变化；刷新失败时丢弃副本与磁盘缓存，下一次请求重新向 server 拉取。内存副本的有效期与磁盘缓存相同（24 小时）。stdio server 因空闲被停止后订阅随之结束，之后只靠 TTL。
- 凭证解析结果与 OAuth token 刷新。
- 截断结果的游标。daemon 与进程内模式一样把游标写入用户缓存目录（`cursors/`，目录 0700、文件 0600，内容已脱敏，TTL 30 分钟，按文件修改时间清理），所以 daemon 空闲退出（10 分钟）不会让游标提前失效；只有 TTL 到期或 id 不存在才报告过期（退出码 3）。`via more` 先问已经在运行的 daemon（不会为它拉起新的），再看缓存目录。
- 编译好的 JSON Schema（见下「校验」）。

## CLI 与 daemon 的协议

socket 上的 JSON Lines，一行一个消息（单条上限 256 MB）。参数解析和输出渲染在 CLI 侧完成，daemon 只返回结构化结果，这样渲染逻辑只有一份，进程内模式也能复用同一组类型（`src/protocol.ts`，以它为准）。目录的拆分与索引都由 CLI 从原始 `tools/list` 结果计算（计算结果由 CLI 存成磁盘上的预构建缓存，见 [discovery.md](discovery.md#预构建缓存)），daemon 只提供原始列表，因此没有 `ls`、`find`、`describe` 请求。

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
  | ({ id; type: "resources-list"; timeoutMs: number } & ServerTarget)
  | ({ id; type: "resource-read"; uri: string; timeoutMs: number } & ServerTarget)
  | ({ id; type: "prompts-list"; timeoutMs: number } & ServerTarget)
  | ({ id; type: "prompt-get"; name: string; args: Record<string, string>; timeoutMs: number } & ServerTarget)
  | { id; type: "validate"; schema: unknown; label: string; data?: unknown; compileOnly?: boolean }
  | { id; type: "redact"; text: string }
  | { id; type: "redact"; value: unknown }
  | { id; type: "cursor-put"; record: CursorRecord }
  | { id; type: "cursor-get"; cursor: string }
  | { id; type: "shutdown"; force?: boolean }
  | { id; type: "batch" | "auth" /* 保留，daemon 返回 exitCode 7 */ };
```

应答：

```ts
type Event = { id; type: "event"; event: "progress" | "log"; data: unknown };   // 零到多次
// log 事件的 data 是 { level: "warning", message: string }：发给触发它的那个请求（list 或 call），CLI 把 message 打印为 stderr 的 `warning: …`；message 已脱敏。目前只有「刷新后的 OAuth 登录存不下来」这一种（auth.md）
type Response =
  | { id; type: "result"; ok: true; result: unknown; meta: { elapsedMs: number } }
  | { id; type: "result"; ok: false; error: ErrorInfo };
type Stale = { id; type: "stale"; reason: "environment" };                      // 未执行，见「环境与工作目录」
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
| `list` | 返回 `{ tools, fetchedAt, fromCache, features? }`，`features` 是 `{ resources, prompts }`（server 是否声明了这两种能力，缓存里没有记录时省略）。先在 daemon 里解析该 server 的凭证（缺失则退出码 4，不发任何请求），再依次看内存副本、磁盘缓存、server；`refresh` 跳过前两者（`via sync`、`via doctor`）。未信任的项目级 server 退出码 5。`have` 是 CLI 手里已有预构建目录的那份列表的 `fetchedAt`：daemon 的列表恰好是这一份时，应答为 `{ unchanged: true, fetchedAt, fromCache: true, features? }`，不带 `tools`（凭证与信任检查照常先做；带 `refresh` 时忽略 `have`）。CLI 只在磁盘缓存里的列表也是这一份时才带 `have`，收到 `unchanged` 后需要工具时从那个缓存文件读，所以浏览类命令不必让 daemon 把整份列表再传一遍 |
| `call` | 返回 server 的原始 `tools/call` 结果。`progress: true` 时，进度作为 `event` 推送。结果中的凭证值在 daemon 里替换为 `***` 后才发出，错误信息同样 |
| `resources-list` | 返回 `{ resources, templates }`：`resources/list` 与 `resources/templates/list` 分页拉全（server 没有实现模板方法时 `templates` 为空）。不缓存。server 没有声明 `resources` 能力时不发请求，退出码 3 |
| `resource-read` | 返回 `{ contents }`（`resources/read` 的原始结果：`text` 或 base64 的 `blob`）。server 不认识这个 URI（`-32002`，或把它报告为 `-32602` 的 server）退出码 3，信息带 server 的说明；没有声明 `resources` 时同 `resources-list` |
| `prompts-list` | 返回 `prompts/list` 分页拉全的数组。没有声明 `prompts` 能力时退出码 3，不发请求 |
| `prompt-get` | 返回 `{ description?, messages }`（`prompts/get` 的原始结果）。参数都是字符串；server 用 `-32602` 拒绝参数时退出码 1，与工具一致 |
| `validate` | 编译 JSON Schema（按内容缓存）并校验 `data`，返回 ajv 的错误与 `format` 警告；`compileOnly` 只编译。这样 CLI 进程不加载 ajv |
| `redact` | 把 daemon 已知的凭证值换成 `***`，只在已有连接时发，不为它拉起 daemon。`text` 是 CLI 拼好的文字（错误、校验警告），只替换 8 个字符以上的凭证；`value` 是 CLI 回显的内容（`--dry-run` 的 `args`，任意 JSON），其中每个字符串里的任何长度的凭证都替换，键与结构不变（[脱敏的范围](output.md#脱敏的范围)） |
| `cursor-put` / `cursor-get` | 存取游标记录（内容已脱敏），返回 id 或记录；记录落在用户缓存目录，不随 daemon 退出而丢失 |
| `status` | 返回 pid、版本、socket、运行时间、距空闲退出的时间、请求数、游标数、内存和各会话（server 名、传输、是否连接、子进程 pid、目录中的工具数、调用数、空闲时间）。不含 URL、参数和任何凭证 |
| `shutdown` | 先停止监听、删除 socket，应答，处理完在途请求后退出。带 `force: true` 时应答后放弃在途请求（关闭会话与 stdio 子进程，它们的 CLI 看到连接中断）立即退出；`via daemon stop` 在 5 秒宽限之后发它 |

约定：

- `call` 的 `result` 是清理前的结构化数据（MCP content 与 structuredContent），截断与渲染在 CLI 侧做，渲染所需的游标写入 daemon。四个资源与 prompt 请求同样返回原始结果，凭证值在 daemon 内逐个字符串值替换为 `***` 后才发出，也受 `envStamp` 与未信任检查约束。替换保持协议结构：不改写键，也不改写内容块的 `type`、`mimeType`、`role`、`audience`、`lastModified` 和 base64 的 `data`、`blob`；`structuredContent` 与 `_meta` 不享受这些豁免（[脱敏的范围](output.md#脱敏的范围)）。
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

设置 `VIA_NO_DAEMON=1`（任何非空且不是 `0`、`false` 的值）时在进程内直连，适用于 CI 或不允许常驻进程的沙箱，各平台一致。HTTP server 基本不受影响；stdio server 每次调用都会重新拉起；游标保存在用户缓存目录。`via daemon status` 报告 `daemon: disabled (VIA_NO_DAEMON)`，不去连接 socket。

## socket 安全

- 目录与文件（POSIX；Windows 见下「Windows」）：daemon 创建的 socket 权限 0600（绑定前把 umask 设为 0177，不存在更宽的瞬间），令牌文件 0600，缓存目录回退路径下的目录 0700。内核据此拒绝其他用户 `connect`。
- CLI 连接前检查：目录属于当前用户且其他人不可写，socket 是当前用户的 socket 且没有 group/other 权限位；否则拒绝使用并回退为进程内模式（提示 `not using the via daemon: … is accessible to other users`），避免连上别人在共享目录里预先放好的 socket。
- 令牌：daemon 每次启动生成 32 字节随机令牌写入 `via.sock.token`（0600），`hello` 必须带上它，常量时间比较。它不依赖文件系统是否执行 socket 权限位。
- 对端 uid：规范原本要求用 `SO_PEERCRED`（Linux）/`getpeereid`（macOS）校验对端 uid。Node 内置的 `net` 不暴露这两个接口，0.2 不为此引入原生依赖，用上面三项（所有权检查、权限位、令牌）代替；它们防的是同机其他用户。真正的 peer uid 校验作为后续项（需要原生扩展）。
- 同一用户下的其他进程本来就能读环境和配置，这不在防护范围内（[security.md](security.md)）。

## Windows

Node 的 `net` 模块直接支持 named pipe，协议、握手、启动锁与 POSIX 上完全一致；差异只在三处：管道怎么命名、谁能连上、没有文件权限位可查。

- **命名**：默认管道名是 `\\.\pipe\via-<用户名>-<令牌摘要>`。`<用户名>` 取 `%USERNAME%`（只留字母、数字和 `._-`，其余换成 `_`，最长 40 个字符），仅便于排查；`<令牌摘要>` 是 `SHA-256("via-pipe\0" + 令牌)` 的前 128 位（32 个十六进制字符）。令牌是 daemon 每次启动生成的 32 字节随机数，写入 `%LOCALAPPDATA%\via\Cache\via.token`。所以管道名**每次启动都不同**，且只有能读该文件的人才知道。
- **发现**：CLI 读令牌文件、算出管道名、连接。令牌文件不存在，或指向的管道不存在（陈旧文件），都等于「没有 daemon」（`absent`），随后按常规拉起新的；新 daemon 先写令牌再监听，CLI 的重试循环（2 秒内）会读到新令牌。`--socket` 显式给出的管道名原样使用，不做派生，令牌、锁、日志文件以管道名命名（`via-<名>.token` 等），供测试和多实例使用。
- **为什么派生**：Windows 上任何本地用户都能列出 `\\.\pipe\` 里的管道名，并在 daemon 退出后抢先创建同名管道，让下一个 CLI 把握手令牌与请求（参数）交给它。名字取决于每次启动才生成、只存在用户目录里的令牌，攻击者既无法预先占位，也无法从管道列表里得知下一个名字。管道由 libuv 以 `FILE_FLAG_FIRST_PIPE_INSTANCE` 创建，名字已被占用时 daemon 绑定失败而不是共用。
- **谁能连**：管道使用默认安全描述符（libuv 不传自定义 ACL）：创建者、SYSTEM 和管理员可读写，Everyone 只有读取权限，其他普通用户因此写不进握手消息；这是纵深防御，不是唯一屏障（Windows 版本之间的默认值略有差异，via 不依赖它）。真正的门槛仍是握手令牌（`hello` 常量时间比较，所有平台一致），它放在用户配置文件所在的用户目录下，默认 ACL 只允许该用户、SYSTEM 与管理员读取。
- **不做的检查**：Windows 上没有 `st_uid` 和模式位，CLI 不做 POSIX 那样的属主与权限位检查；也没有可从 Node 调用的 `GetNamedPipeClientProcessId` / 客户端 SID 校验，peer 身份校验同样留作后续（需要原生扩展）。残留风险：(1) 管理员（及 SYSTEM）本来就能读任何用户的文件和进程内存，不在防护范围；(2) 如果用户把 `%LOCALAPPDATA%` 重定向到其他用户可读的共享位置，令牌文件就暴露了，via 无法发现（不读 ACL）；(3) 令牌文件由 `0600` 创建，该模式在 Windows 上不产生任何效果，权限完全来自目录继承。
- **清理**：daemon 退出时删除令牌文件（内容仍是自己的令牌才删）。它还每隔几秒检查令牌文件，文件被删除或换成别的 daemon 的令牌后，客户端再也找不到这个管道，daemon 自行退出。管道本身随进程消失，没有残留文件；强杀（`taskkill /f`）只会留下一个陈旧的令牌文件，下次启动覆盖。强杀也不会带走 daemon 的 stdio 子进程（Windows 不在父进程结束时结束子进程，via 没有为它们建立 job object）：它们读到 stdin 关闭后通常自行退出，但在此之前仍以调用方的目录为工作目录，该目录在此期间无法删除（`EBUSY`）。正常退出（空闲、`daemon stop`）会先停止子进程，不受影响。
- **其他**：`SIGTERM` 不会发给 Windows 进程，`via daemon stop` 对应答的 daemon 走 `shutdown` 请求，不依赖信号；对不在监听的 daemon 进程（[进程记录](#进程记录)）用 Node 的 `process.kill`，它在 Windows 上直接结束进程，与 `taskkill /f` 一样不带走 stdio 子进程（见上「清理」）；分离启动使用 `windowsHide`，不弹控制台窗口；启动锁与令牌文件的原子替换在被杀毒软件短暂占用时会退回直接写入。
