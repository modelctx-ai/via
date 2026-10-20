// End-to-end harness: a sandbox (home, project, cache) with a config tree, fixture MCP servers
// over HTTP in this process, and `run()` driven with injected env, cwd, home and writers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach } from 'vitest';
import { run } from '../../src/cli/run';
import { createCliServer, createCliState, type CliState } from '../fixtures/mcp/cli-server.mjs';

/**
 * Variables a child process needs in order to start properly on Windows (`SystemRoot` above all);
 * nothing on other platforms. A sandbox hands its own small environment to `run()` and would
 * otherwise leave the stdio servers and `cmd:` helpers it starts without them.
 */
export const SYSTEM_ENV: Record<string, string> = {};
if (process.platform === 'win32') {
  for (const name of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) SYSTEM_ENV[name] = value;
  }
}

/**
 * Environment for a real `via` child process whose home directory is `home`: HOME on POSIX; on
 * Windows the variables Node and `via` read instead (`USERPROFILE`, `%APPDATA%\\via\\config.yaml`
 * placed where the sandboxes write `.config/via/config.yaml`, `%LOCALAPPDATA%` for caches).
 */
export function homeEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    ...SYSTEM_ENV,
    ...(process.platform === 'win32' ? { USERPROFILE: home, APPDATA: join(home, '.config'), LOCALAPPDATA: join(home, '.local', 'app') } : {}),
  };
}

export const CLI_STDIO_SERVER = fileURLToPath(new URL('../fixtures/mcp/cli-stdio-server.mjs', import.meta.url));

/** Obviously fake; the credential scan must never find it in a snapshot. */
export const FAKE_TOKEN = 'fake-gh-token-for-cli-tests-0001';

export interface FixtureServer {
  url: string;
  state: CliState;
  requests: IncomingHttpHeaders[];
  close(): Promise<void>;
}

/** Streamable HTTP fixture; requests need `Authorization: Bearer <token>` when `token` is set. */
export async function startFixtureServer(options: { token?: string } = {}): Promise<FixtureServer> {
  const state = createCliState();
  const result: FixtureServer = { url: '', state, requests: [], close: async () => undefined };
  const http: HttpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
          res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        result.requests.push(req.headers);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        const server = createCliServer({ state, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  result.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  result.close = () =>
    new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  return result;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Questions put to the person (only with `RunOptions.answer`). */
  asked: string[];
  /** Both streams in the order they were written, as a terminal (or `2>&1`) would show them. */
  combined: string;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdin?: string;
  /** Pretend a person sits at a terminal and types this at the next question (`via trust`); the questions are collected in `CliResult.asked`. */
  answer?: string;
  now?: number;
  /** Answers the prompt of a manual OAuth login; sees what has been printed so far. Default: the first line of `stdin`. */
  readLine?: (printed: { stdout: string; stderr: string }) => Promise<string | undefined>;
  /** Stands in for the browser; the default opens nothing. */
  openUrl?: (url: string) => Promise<{ opened: boolean; reason?: string }>;
}

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  cacheDir: string;
  /** Write a file below the sandbox root. */
  write(relative: string, content: string): string;
  /** `~/.config/via/config.yaml` */
  userConfig(yaml: string): void;
  /** `<project>/.via.yaml` */
  projectConfig(yaml: string): void;
  /** Run `via` with `argv`. The clock stands still unless `options.now` is given. */
  via(argv: string[], options?: RunOptions): Promise<CliResult>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

export function useCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

export function makeSandbox(env: Record<string, string> = { GH_TOKEN: FAKE_TOKEN }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'via-cli-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const write = (relative: string, content: string): string => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  return {
    root,
    home,
    project,
    cacheDir: join(home, '.cache', 'via'),
    write,
    userConfig: (yaml) => void write('home/.config/via/config.yaml', yaml),
    projectConfig: (yaml) => void write('project/.via.yaml', yaml),
    via: async (argv, options = {}) => {
      let stdout = '';
      let stderr = '';
      const asked: string[] = [];
      let combined = '';
      const code = await run(argv, {
        interactive: options.answer !== undefined || options.readLine !== undefined,
        ask: async (question) => {
          asked.push(question);
          if (options.readLine) return (await options.readLine({ stdout, stderr })) ?? '';
          return options.answer ?? options.stdin?.split('\n')[0] ?? '';
        },
        // OAuth logins go to files in the sandbox, never to the real keychain.
        env: { PATH: process.env.PATH, ...SYSTEM_ENV, VIA_OAUTH_STORE: 'file', ...env, ...options.env },
        cwd: options.cwd ?? project,
        home,
        platform: 'linux',
        stdout: { write: (s) => void ((stdout += s), (combined += s)) },
        stderr: { write: (s) => void ((stderr += s), (combined += s)) },
        readStdin: async () => options.stdin ?? '',
        openUrl: options.openUrl ?? (async () => ({ opened: false, reason: 'tests do not open browsers' })),
        now: () => options.now ?? 1_800_000_000_000,
      });
      return { code, stdout, stderr, asked, combined };
    },
  };
}

/** Timings and ports differ between runs; snapshots and comparisons mask them. */
export function normalize(text: string): string {
  return text
    .replace(/(· )(\d+ms|\d+\.\ds)( ·)/g, '$1<t>$3')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
}

/** Config for one HTTP server named `gh` that needs the fake bearer token. */
export function ghConfig(url: string, extra = ''): string {
  return `sources: false\nservers:\n  gh:\n    url: ${url}\n    auth: { bearer: "env:GH_TOKEN" }\n${extra}`;
}
