// The one line each control column adds to its program's own instruction text, telling the agent
// which servers it can reach (the counterpart of the Providers line of `via prompt`). Shared by the
// token benchmark and the agent evaluation so both count and show the same text.

/**
 * mcp2cli: the aliases `bake create` set up beforehand. mcpc: the entries of `./mcp.json` in the
 * working directory, none connected yet, because a session has to be created with `mcpc connect`
 * before any call (the agent runs, and pays for, those commands).
 */
export function serversLine(program: 'mcp2cli' | 'mcpc', mounted: readonly string[]): string {
  return program === 'mcp2cli' ? `Servers: ${mounted.map((s) => `@${s}`).join(' ')}` : `Servers (entries of ./mcp.json, not connected yet): ${mounted.join(' ')}`;
}
