// The CLI fixture server over stdio: `node test/fixtures/mcp/cli-stdio-server.mjs`.
// Needed where the transport matters (progress notifications cannot stream over the JSON-response
// HTTP fixture). Tool calls are appended to the file named by CLI_FIXTURE_LOG, one JSON per line.
import { appendFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCliServer, createCliState } from './cli-server.mjs';

const state = createCliState();
const log = process.env.CLI_FIXTURE_LOG;
if (log) appendFileSync(log, `${JSON.stringify({ spawn: process.pid })}\n`);
// CLI_FIXTURE_FEATURES=resources,prompts switches the optional capabilities on.
const features = (process.env.CLI_FIXTURE_FEATURES ?? '').split(',').filter(Boolean);
const server = createCliServer({ state, features });
await server.connect(new StdioServerTransport());
