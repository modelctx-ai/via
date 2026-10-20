// MCP client, in-process mode (docs/spec/daemon.md "无 daemon 模式", auth.md). The MCP SDK behind
// it is loaded with dynamic import() on first connection only; importing this module is cheap.
export { InProcessClient, type McpClient } from './client';
export { McpSession, type CallOptions, type ListOptions, type SessionHooks } from './session';
export { ClientError, mapError, untrustedServer, type ErrorContext, type Phase } from './errors';
export { resolveConnection, type ResolvedConnection, type ResolvedHttp, type ResolvedStdio } from './credentials';
export { baseEnvironment } from './env';
export { Limiter } from './limiter';
