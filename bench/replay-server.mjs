// Replay MCP server (bench/README.md): serves the `tools/list` of a fixture file and answers
// `tools/call` from the canned results in a task file. It is the shared back end of the token
// benchmark and of the later agent-eval harness, so it knows nothing about either: the server
// name, the tools and the canned calls are all inputs.
//
//   node bench/replay-server.mjs --tools test/fixtures/tools/github.json \
//        --server github --task bench/tasks/github-triage.yaml [--task ...] [--port 0] [--stdio]
//
// HTTP mode (Streamable HTTP, stateless, JSON responses) prints one JSON line to stdout once it
// listens: {"server":"github","url":"http://127.0.0.1:41234/mcp"}. `GET /__replay/calls` returns the
// log of every call received so far. Plain ESM so it runs without a build step.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parse as parseYaml } from 'yaml';

/** Read a `tools/list` fixture: `{ "tools": [...] }`. */
export function readTools(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.tools)) throw new Error(`${file}: expected {"tools": [...]}`);
  return parsed.tools;
}

/** Read a task file (YAML, or JSON which is a subset of it). */
export function readTaskFile(file) {
  return parseYaml(readFileSync(file, 'utf8'));
}

/**
 * Deep subset match: every key of `expected` must be present in `actual` with a matching value;
 * extra keys in `actual` are ignored. Arrays and scalars must be equal. This is how a canned
 * call's optional `args` selects among several results for the same tool.
 */
export function matchArgs(expected, actual) {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => matchArgs(v, actual[i]));
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) => key in actual && matchArgs(value, actual[key]));
}

/** MCP `CallToolResult` for one canned entry (see "Canned calls" in bench/README.md). */
function toResult(entry, baseDir) {
  const fromFile = (path) => readFileSync(isAbsolute(path) ? path : resolve(baseDir, path), 'utf8');
  let content;
  if (entry.content !== undefined) content = entry.content;
  else if (entry.text !== undefined) content = [{ type: 'text', text: String(entry.text) }];
  else if (entry.textFile !== undefined) content = [{ type: 'text', text: fromFile(entry.textFile) }];
  else if (entry.resultFile !== undefined) content = [{ type: 'text', text: JSON.stringify(JSON.parse(fromFile(entry.resultFile))) }];
  else if (entry.result !== undefined) content = [{ type: 'text', text: JSON.stringify(entry.result) }];
  else throw new Error(`canned call ${entry.tool}: needs one of result, resultFile, text, textFile, content`);
  return { content, ...(entry.isError ? { isError: true } : {}) };
}

/**
 * Canned calls of one server taken from task objects: `[{ tool, args?, result: CallToolResult }]`
 * in task order. File references resolve against `baseDir` (the `bench/` directory).
 */
export function cannedCalls(tasks, server, baseDir) {
  const out = [];
  for (const task of tasks) {
    for (const entry of task.calls ?? []) {
      if (entry.server !== server) continue;
      out.push({ tool: entry.tool, ...(entry.args !== undefined ? { args: entry.args } : {}), result: toResult(entry, baseDir) });
    }
  }
  return out;
}

/**
 * The MCP server. Unknown tools and calls without a matching canned entry answer `isError`
 * (never a protocol error), so a model that guesses wrong sees an ordinary tool failure. Entries
 * are tried in order and the first match wins; a call is not "used up" by being answered.
 *
 * @param {{ name?: string, tools: object[], calls?: Array<{ tool: string, args?: object, result: object }>, log?: Array<object> }} options
 */
export function createReplayServer({ name = 'replay', tools, calls = [], log = [] }) {
  const server = new Server({ name, version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: tool, arguments: args = {} } = request.params;
    const hit = calls.find((c) => c.tool === tool && (c.args === undefined || matchArgs(c.args, args)));
    log.push({ tool, args, matched: hit !== undefined });
    if (hit) return hit.result;
    const known = tools.some((t) => t.name === tool);
    const reason = known ? `no canned result for ${tool} with these arguments` : `unknown tool: ${tool}`;
    return { content: [{ type: 'text', text: `replay: ${reason}: ${JSON.stringify(args)}` }], isError: true };
  });
  return server;
}

/**
 * Streamable HTTP front end on a localhost port (0 = ephemeral). Stateless: a Server and a
 * transport per request, like the mocks in test/fixtures/mcp/.
 *
 * @returns {Promise<{ url: string, log: Array<object>, close(): Promise<void> }>}
 */
export async function startReplayHttp({ port = 0, host = '127.0.0.1', ...options }) {
  const log = options.log ?? [];
  const http = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        if (req.method === 'GET' && req.url === '/__replay/calls') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(log));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const server = createReplayServer({ ...options, log });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })().catch((error) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(error));
      });
    });
  });
  await new Promise((done) => http.listen(port, host, done));
  return {
    url: `http://${host}:${http.address().port}/mcp`,
    log,
    close: () =>
      new Promise((done) => {
        http.closeAllConnections();
        http.close(() => done());
      }),
  };
}

// CLI ----------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { tasks: [], stdio: false, port: 0, server: undefined, tools: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--tools') opts.tools = argv[++i];
    else if (arg === '--task') opts.tasks.push(argv[++i]);
    else if (arg === '--server') opts.server = argv[++i];
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--stdio') opts.stdio = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.tools) throw new Error('--tools <tools.json> is required');
  return opts;
}

// Runs only when started as a script, not when imported (or bundled into another script).
if (process.argv[1] && basename(process.argv[1]) === 'replay-server.mjs') {
  const opts = parseArgs(process.argv.slice(2));
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const server = opts.server ?? opts.tools.replace(/^.*\//, '').replace(/\.json$/, '');
  const options = {
    name: server,
    tools: readTools(opts.tools),
    calls: cannedCalls(opts.tasks.map(readTaskFile), server, baseDir),
  };
  if (opts.stdio) {
    await createReplayServer(options).connect(new StdioServerTransport());
  } else {
    const running = await startReplayHttp({ ...options, port: opts.port });
    process.stdout.write(`${JSON.stringify({ server, url: running.url })}\n`);
  }
}
