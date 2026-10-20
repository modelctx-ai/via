# Daemon 与连接管理

CLI 是短进程，每次调用都重新握手、重新拉起 stdio server 会慢到不可用；因此由一个按需自动拉起、空闲自动退出的 per-user daemon 持有 MCP 会话。用户感知不到它的存在。

## 生命周期

1. CLI 检查 socket：Linux 为 `$XDG_RUNTIME_DIR/via.sock`（未设置时退回用户缓存目录），macOS 为用户缓存目录下的 `via.sock`，Windows 为 named pipe `\\.\pipe\via-<用户名>`。
2. 不存在则以 `via daemon run` 分离启动，最多等待 2 秒就绪，然后转发请求。
3. 握手时交换版本；CLI 与 daemon 版本不一致时，daemon 处理完在途请求后退出，由本次 CLI 重新拉起。
4. daemon 空闲 10 分钟退出；单个 stdio server 空闲 5 分钟停止子进程（均可配置，见 [config.md](config.md)）。
5. daemon 异常（拉起失败、连接中断）时，CLI 回退为进程内模式完成本次调用，并在 stderr 提示一次。

## daemon 持有的状态

- MCP 会话：stdio 子进程、HTTP 的 session id。
- 工具目录的内存副本（同时持久化到磁盘缓存），以及 `list_changed` 订阅。
- 凭证解析结果与 OAuth token 刷新。
- 截断结果的游标。

## CLI 与 daemon 的协议

socket 上的 JSON Lines，一行一个消息。参数解析和输出渲染在 CLI 侧完成，daemon 只返回结构化结果，这样渲染逻辑只有一份，进程内模式也能复用同一组类型（`src/protocol.ts`）。

以下是协议草案，以实现时的 `protocol.ts` 为准：

```ts
// 握手：CLI 连接后先发 hello
type Hello = { type: "hello"; version: string; pid: number };
type HelloAck = { type: "hello"; version: string; ok: boolean };

type ToolRef = string; // 单字符串形式："linear/issue:create"

type Request =
  | { id: string; type: "status" }
  | { id: string; type: "ls"; provider?: string; resource?: string; all?: boolean }
  | { id: string; type: "find"; query: string; domain?: string; limit?: number }
  | { id: string; type: "describe"; tool: ToolRef }
  | { id: string; type: "call"; tool: ToolRef; args: unknown; timeoutMs?: number; confirm?: boolean; dryRun?: boolean }
  | { id: string; type: "more"; cursor: string }
  | { id: string; type: "batch"; calls: { tool: ToolRef; args: unknown }[] }
  | { id: string; type: "auth"; action: "login" | "status" | "logout"; provider: string }
  | { id: string; type: "sync"; provider?: string };

// 进度等中间事件，可出现零到多次
type Event = { id: string; type: "event"; event: "progress" | "log"; data: unknown };

type Response =
  | { id: string; type: "result"; ok: true; result: unknown; meta: ResultMeta }
  | { id: string; type: "result"; ok: false; error: ErrorInfo };

type ResultMeta = {
  tool?: ToolRef;        // 规范写法
  elapsedMs: number;
  cursor?: string;       // 被截断时
  totalBytes?: number;
};

type ErrorInfo = {
  exitCode: 1 | 2 | 3 | 4 | 5 | 6 | 7; // 与 output.md 的退出码一致
  message: string;
  next?: string;         // 下一步命令
  candidates?: string[]; // 歧义或 did you mean
};
```

约定：

- `result` 中是清理前的结构化数据（MCP content 与 structuredContent），截断与渲染在 CLI 侧做；游标保存在 daemon。
- 协议中不得出现解析后的凭证值。
- 未知消息类型返回 `exitCode: 7` 的错误，不断开连接。

## 并发

- agent 可能并行启动多个 `via` 进程，daemon 对每个连接独立处理。
- 同一 server 上的多个请求复用一个 MCP 会话，通过 JSON-RPC id 多路复用。
- 可按 server 配置并发上限（`concurrency`），超出时排队。
- `via batch` 在 CLI 侧把每一行当作一个独立的 `call` 请求并发发出：参数校验、危险操作确认、渲染和输出排序都在 CLI 侧完成，daemon 只看到并发的 `call`，由上述 `concurrency` 限流。协议草案里的 `batch` 请求因此不是 0.2 的必需项。

## 独占资源的 server

有些 server 会锁定同一个 SQLite 文件、浏览器 profile 或固定端口，和框架里仍在运行的同名实例冲突。配置 `exclusive: true` 后，启动失败时 via 给出明确提示：可能与 agent 框架中的同名 server 冲突，运行 `via doctor` 查看关闭方法。

## 无 daemon 模式

设置 `VIA_NO_DAEMON=1` 时在进程内直连，适用于 CI 或不允许常驻进程的沙箱。HTTP server 基本不受影响；stdio server 每次调用都会重新拉起；游标保存在用户缓存目录。

## socket 安全

socket 文件权限 0600，daemon 校验对端 uid 与自身一致（Linux `SO_PEERCRED`，macOS `getpeereid`）。见 [security.md](security.md)。
