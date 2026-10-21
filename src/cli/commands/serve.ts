// `via serve` (cli.md, "via serve"): the meta-tool MCP server on this process's stdin and stdout,
// until the client closes stdin. The MCP SDK server is loaded only here.
import type { App } from '../app';
import { usageFailure } from '../failure';
import { COMMAND_USAGE } from '../help';

export async function serveCommand(app: App, argv: readonly string[]): Promise<number> {
  if (argv.length > 0) throw usageFailure(COMMAND_USAGE.serve!, 'via serve -h');
  const [{ createServeServer }, { StdioServerTransport }, { run }] = await Promise.all([
    import('../serve'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('../run'),
  ]);
  const server = await createServeServer(app.io, run);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  const transport = new StdioServerTransport();
  // StdioServerTransport does not report the end of stdin; the client going away ends the server.
  process.stdin.once('end', () => void server.close());
  await server.connect(transport);
  await closed;
  return 0;
}
