#!/usr/bin/env node
// Adapter between the official MCP conformance suite (`@modelcontextprotocol/conformance`, client scenarios)
// and the `via` CLI: the suite starts a purpose-built server per scenario and runs this script with the
// server's URL as the last argument and the scenario name in MCP_CONFORMANCE_SCENARIO (the scenario's data
// in MCP_CONFORMANCE_CONTEXT, a JSON object). The script drives the built CLI (`dist/via.js`) the way a user
// would, in an empty home, and the suite judges what the server saw on the wire (docs/development/testing.md,
// "官方一致性测试").
//
//   npm run build && npx -y @modelcontextprotocol/conformance client --command "node test/conformance/client.mjs" --scenario initialize
//
// A scenario this adapter does not drive exits non-zero, so the suite records it as a failure rather than a pass.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
const serverUrl = process.argv.at(-1);
if (!scenario) fail('MCP_CONFORMANCE_SCENARIO is not set');
if (!serverUrl || !/^https?:\/\//i.test(serverUrl)) fail(`missing or invalid server URL (got: ${serverUrl ?? ''})`);

// Scenario data (a pre-registered client, …). Absent for most scenarios.
const context = (() => {
  try {
    return JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT || '{}');
  } catch {
    return {};
  }
})();
const oauth = scenario.startsWith('auth/');

const here = dirname(fileURLToPath(import.meta.url));
const via = resolve(here, '..', '..', 'dist', 'via.js');
const home = mkdtempSync(join(tmpdir(), 'via-conformance-'));
mkdirSync(join(home, '.config', 'via'), { recursive: true });
// `sources: false`: nothing from the machine running the suite leaks in; no daemon: one process, one connection.
// The CIMD scenario expects the client id `https://conformance-test.local/client-metadata.json`, a document that does not
// exist: via's own hosted document is replaced through `auth.oauth.clientMetadataUrl`, the same setting a person would use.
const oauthFields = [];
if (context.client_id) oauthFields.push(`clientId: ${JSON.stringify(context.client_id)}`);
if (scenario === 'auth/basic-cimd') oauthFields.push('clientMetadataUrl: "https://conformance-test.local/client-metadata.json"');
// Secrets reach via the way a person would hand them over, as `env:` references (never in the config file).
const secrets = {};
const machine = scenario.startsWith('auth/client-credentials-');
if (machine) oauthFields.push('grant: client_credentials');
if (context.client_secret) {
  oauthFields.push('clientSecret: "env:VIA_CONF_CLIENT_SECRET"');
  secrets.VIA_CONF_CLIENT_SECRET = context.client_secret;
}
if (context.private_key_pem) {
  oauthFields.push('privateKey: "env:VIA_CONF_PRIVATE_KEY"', `keyAlgorithm: ${JSON.stringify(context.signing_algorithm ?? 'RS256')}`);
  secrets.VIA_CONF_PRIVATE_KEY = context.private_key_pem;
}
const auth = oauth ? `    auth: { oauth: { ${oauthFields.join(', ')} } }\n` : '';
writeFileSync(join(home, '.config', 'via', 'config.yaml'), `sources: false\nservers:\n  conf:\n    url: ${serverUrl}\n    timeout: 30\n${auth}`);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_DATA_HOME: join(home, 'data'),
  VIA_NO_DAEMON: '1',
  VIA_OAUTH_STORE: 'file',
  ...secrets,
};

/** Run the CLI; resolves with its exit code, output goes to the suite's log. */
function runVia(args, { stdin } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [via, ...args], { env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun(code ?? 1));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

/**
 * Run the CLI with a terminal on stdin and stderr, as a person has it, and type `answers` (one line each) as
 * soon as it has said anything: the lines wait in the terminal and are read by the questions as they come, which
 * is what typing ahead does. The terminal is a pseudo-terminal from util-linux `script` (the suite runs on
 * Linux); what the CLI prints goes to the suite's log. Resolves with the CLI's exit code.
 */
function runViaOnTerminal(args, answers) {
  return new Promise((resolveRun, reject) => {
    const quote = (word) => `'${word.replace(/'/g, `'\\''`)}'`;
    const command = [process.execPath, via, ...args].map(quote).join(' ');
    const child = spawn('script', ['-qec', command, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let typed = false;
    child.stdout.on('data', (chunk) => {
      process.stderr.write(chunk);
      if (typed) return;
      typed = true;
      child.stdin.write(answers.map((line) => `${line}\n`).join(''));
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveRun(code ?? 1));
  });
}

/**
 * `via auth login conf --manual` without a browser: the suite's authorization endpoint approves by redirecting,
 * so this script fetches the URL via prints, takes the redirect target and hands it to via on stdin, which
 * is what a person does by pasting the page the browser ended up on.
 */
function login() {
  return new Promise((resolveLogin, reject) => {
    const child = spawn(process.execPath, [via, 'auth', 'login', 'conf', '--manual'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    let answered = false;
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const url = /https?:\/\/\S+/.exec(out)?.[0];
      if (!url || answered) return;
      answered = true;
      fetch(url, { redirect: 'manual' }).then(
        (response) => child.stdin.end(`${response.headers.get('location') ?? ''}\n`),
        (error) => {
          console.error(`could not follow the authorization URL: ${error.message}`);
          child.kill();
        },
      );
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolveLogin() : reject(new Error(`via auth login exited with code ${code}`))));
  });
}

async function expectOk(args, options) {
  const code = await runVia(args, options);
  if (code !== 0) throw new Error(`via ${args.join(' ')} exited with code ${code}`);
}

try {
  switch (scenario) {
    case 'initialize':
      // The handshake (or the probe, then the handshake), then the tool list: the scenario's server only
      // answers `initialize` and `tools/list`.
      await expectOk(['conf']);
      break;
    case 'tools_call':
      // The server has an `add_numbers` tool and records a check when it is called with numbers.
      await expectOk(['conf']);
      await expectOk(['conf', 'add_numbers', '--a', '2', '--b', '3']);
      break;
    case 'sse-retry':
      // The server closes the event stream in the middle of a tool call and expects the client to reconnect
      // within the retry time it announced. Only the reconnect matters here, so the call is cut short.
      await expectOk(['conf']);
      await runVia(['conf', 'test_reconnection', '--timeout', '20']);
      break;
    case 'elicitation-sep1034-client-defaults':
      // The server asks the person, mid-call, for five fields that all have defaults, and checks that the answer
      // carries every one of them. A person takes the defaults with the Enter key (five empty lines), then says
      // yes to sending them.
      await expectOk(['conf']);
      if ((await runViaOnTerminal(['conf', 'test-client-elicitation-defaults'], ['', '', '', '', '', 'y'])) !== 0) throw new Error('via conf test-client-elicitation-defaults did not succeed');
      break;
    default:
      if (machine) {
        // The machine grant: no browser, no redirect; `login` makes the token request and `conf` uses the token.
        await expectOk(['auth', 'login', 'conf']);
        await expectOk(['conf']);
        break;
      }
      if (oauth) {
        // Authorization scenarios: log in (discovery, registration, PKCE), then use the token.
        await login();
        await expectOk(['conf']);
        break;
      }
      fail(`scenario not driven by the via adapter: ${scenario}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
