// How the negotiated MCP protocol version of a server is shown (cli.md, `via servers` and `via doctor`).
import type { ProtocolInfo } from '../protocol';

/**
 * `2026-07-28 stateless`, `2025-11-25 stateful`; `pinned` appended when `protocolVersion` fixes it. With
 * no connection on record only a pin is known (`2025-11-25 (pinned)`); otherwise `undefined`.
 */
export function protocolLabel(info: ProtocolInfo | undefined, pin: string | undefined): string | undefined {
  if (info && info.version !== '') return `${info.version} ${info.stateful ? 'stateful' : 'stateless'}${pin !== undefined ? ' (pinned)' : ''}`;
  return pin !== undefined ? `${pin} (pinned)` : undefined;
}
