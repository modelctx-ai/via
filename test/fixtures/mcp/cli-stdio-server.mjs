// The CLI fixture server over stdio: `node test/fixtures/mcp/cli-stdio-server.mjs`.
// Needed where the transport matters (progress notifications cannot stream over the JSON-response
// HTTP fixture). Tool calls are appended to the file named by CLI_FIXTURE_LOG, one JSON per line.
// CLI_FIXTURE_PROTOCOL=modern serves the stateless `2026-07-28` protocol (2.x SDK); anything else is a
// server of the old generation (1.x SDK) that has never heard of `server/discover`.
import { appendFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createCliServer, createCliState } from './cli-server.mjs';

const state = createCliState();
const log = process.env.CLI_FIXTURE_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ spawn: process.pid })}\n`);
// CLI_FIXTURE_FEATURES=resources,prompts switches the optional capabilities on.
const features = (process.env.CLI_FIXTURE_FEATURES ?? '').split(',').filter(Boolean);
// CLI_FIXTURE_ABOUT is a JSON object `{description?, websiteUrl?, instructions?}` the server announces about itself.
const about = process.env.CLI_FIXTURE_ABOUT ? JSON.parse(process.env.CLI_FIXTURE_ABOUT) : {};
if (process.env.CLI_FIXTURE_PROTOCOL === 'modern') {
  serveStdio(() => createCliServer({ state, features, about, flavor: 'modern' }));
} else {
  const server = createCliServer({ state, features, about });
  await server.connect(new StdioServerTransport());
}
