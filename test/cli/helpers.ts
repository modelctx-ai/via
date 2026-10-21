// End-to-end harness: a sandbox (home, project, cache) with a config tree, fixture MCP servers
// over HTTP in this process, and `run()` driven with injected env, cwd, home and writers.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach } from 'vitest';
import { run } from '../../src/cli/run';
import { createCliServer, createCliState, type CliState } from '../fixtures/mcp/cli-server.mjs';
import { modernEndpoint } from '../fixtures/mcp/modern-http.mjs';
import { defaultGeneration, fixtureScript, type Generation } from '../helpers/generation';

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

/** The CLI stdio fixture in the default protocol generation (helpers/generation.ts). */
export const CLI_STDIO_SERVER = fixtureScript('cli-stdio-server', defaultGeneration());

/** Obviously fake; the credential scan must never find it in a snapshot. */
export const FAKE_TOKEN = 'fake-gh-token-for-cli-tests-0001';

export type { Generation };

/** What else the fixture server offers or announces (`createCliServer` options): its self-description, tasks, skills. */
export type FixtureExtras = Pick<NonNullable<Parameters<typeof createCliServer>[0]>, 'about'> & Record<string, unknown>;

export interface FixtureServer {
  url: string;
  state: CliState;
  requests: IncomingHttpHeaders[];
  /** Stateless servers: publish `notifications/tools/list_changed` to every open `subscriptions/listen` stream. */
  notifyToolsChanged(): void;
  close(): Promise<void>;
}

/** Streamable HTTP fixture; requests need `Authorization: Bearer <token>` when `token` is set. */
export async function startFixtureServer(
  options: { token?: string; features?: Array<'resources' | 'prompts' | 'roots' | 'completions' | 'skills'>; protocol?: Generation; ttlMs?: number; fixture?: FixtureExtras } = {},
): Promise<FixtureServer> {
  const state = createCliState();
  const generation = options.protocol ?? defaultGeneration();
  const result: FixtureServer = { url: '', state, requests: [], notifyToolsChanged: () => undefined, close: async () => undefined };
  // The stateless endpoint builds a server per request itself; the credential the request carried reaches it through `authorization`.
  let currentAuthorization: string | undefined;
  const modern =
    generation === 'modern'
      ? modernEndpoint((notifier) => createCliServer({ state, flavor: 'modern', notifier, ...(options.fixture ?? {}), ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}), ...(options.features ? { features: options.features } : {}), ...(currentAuthorization ? { authorization: currentAuthorization } : {}) }))
      : undefined;
  if (modern) result.notifyToolsChanged = () => modern.notifier.toolsChanged();
  const http: HttpServer = createServer((req, res) => {
    if (modern) {
      if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
        return;
      }
      result.requests.push(req.headers);
      currentAuthorization = req.headers.authorization;
      void modern.handle(req, res);
      return;
    }
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
        const server = createCliServer({ state, ...(options.fixture ?? {}), ...(options.features ? { features: options.features } : {}), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
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
  result.close = async () => {
    await modern?.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    });
  };
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

// One list, run last-in first-out: whatever a test registers after making its sandbox (stopping a
// daemon, closing a server) runs before the sandbox directory is removed. Every step runs even if
// an earlier one throws; the first error is reported afterwards.
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  let failure: unknown;
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
});

/** Run `fn` when the test ends, before the cleanups registered earlier (the sandbox directory is the first of them). */
export function useCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}

/**
 * Remove a sandbox directory, retrying while Windows still reports it busy: a directory that a
 * process has only just left (its working directory, or a server killed a moment ago) is briefly
 * locked. Node's own `maxRetries` does not cover this: `rmSync` retries only the top directory and
 * only for "not empty", and throws an EBUSY from an entry inside it at once. If the directory is
 * still busy at the deadline, the error lists the processes started in the last two minutes, so
 * the one left running can be named instead of guessed.
 */
export async function removeSandbox(dir: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      if (process.platform !== 'win32') throw error;
      let processes: string;
      try {
        processes = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -gt (Get-Date).AddMinutes(-2) } | ForEach-Object { "$($_.ProcessId) parent=$($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }'],
          { encoding: 'utf8', timeout: 15_000 },
        );
      } catch (listing) {
        processes = `(could not list processes: ${(listing as Error).message})`;
      }
      throw new Error(`${(error as Error).message}\nprocesses started in the last two minutes:\n${processes}`, { cause: error });
    }
  }
}

export function makeSandbox(env: Record<string, string> = { GH_TOKEN: FAKE_TOKEN }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'via-cli-'));
  cleanups.push(() => removeSandbox(root));
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
