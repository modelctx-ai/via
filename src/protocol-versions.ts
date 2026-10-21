// The MCP protocol versions via knows about (docs/spec/config.md `protocolVersion`, cli.md `via servers`).
// Dependency-free on purpose: the config loader validates `protocolVersion` against these lists on every
// command, so this module must not pull in the MCP SDK (implementation.md, "启动速度"). `test/protocol-versions.test.ts`
// checks the lists against what the SDK in node_modules actually negotiates, so an SDK upgrade that adds or
// drops a revision fails a test instead of drifting silently.

/** Revisions of the stateless era (2026-07-28 and later), newest first: no `initialize` handshake, no server-side session. */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28'];

/** Revisions negotiated with the `initialize` handshake, newest first; the SDK's `SUPPORTED_PROTOCOL_VERSIONS`. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

/** Every revision `protocolVersion` may name, newest first. */
export const PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS];

/** `_meta` key under which a stateless-era server stamps its identity on responses; the SDK's `SERVER_INFO_META_KEY`. */
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

export function isProtocolVersion(value: string): boolean {
  return PROTOCOL_VERSIONS.includes(value);
}

export function isModernProtocolVersion(value: string): boolean {
  return MODERN_PROTOCOL_VERSIONS.includes(value);
}
