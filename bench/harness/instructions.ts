// The one line each control column adds to its program's own instruction text, telling the agent
// which servers it can reach (the counterpart of the Providers line of `via prompt`). Shared by the
// token benchmark and the agent evaluation so both count and show the same text.

/**
 * mcp2cli: the aliases `bake create` set up beforehand. mcpc: the entries of `./mcp.json` in the
 * working directory, none connected yet, because a session has to be created with `mcpc connect`
 * before any call (the agent runs, and pays for, those commands).
 */
export function serversLine(program: 'mcp2cli' | 'mcpc', mounted: readonly string[]): string {
  if (program === 'mcpc') return `Servers (entries of ./mcp.json, not connected yet): ${mounted.join(' ')}`;
  // Aliases are baked before the agent starts. Say so: otherwise the model passes `--mcp @name`
  // (not a URL) or points `--mcp` at a real server and never calls the replay.
  return `Servers: ${mounted.map((s) => `@${s}`).join(' ')}\nThese aliases already exist. Run \`@name --search <word>\` and then \`@name <command>\`. Do not pass --mcp, --oauth, or a server URL of your own.`;
}
