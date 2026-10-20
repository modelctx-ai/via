import { createMemoryOAuthStore } from '../../src/client/oauth';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ClientError, InProcessClient } from '../../src/client';
import { isErrorInfo } from '../../src/protocol';
import { TOOLS } from '../fixtures/mcp/mock-server.mjs';
import { FAKE_KEY, FAKE_TOKEN, FakeResolver, httpServer, startHttpServer, stdioServer, type MockHttp } from '../helpers/client';
import type { ServerConfig } from '../../src/config/types';

const clients: InProcessClient[] = [];

function makeClient(servers: ServerConfig[], env: Record<string, string> = {}): InProcessClient {
  const client = new InProcessClient(servers, new FakeResolver(env), { oauthStore: createMemoryOAuthStore() });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function failure(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ClientError);
    return err as ClientError;
  }
  throw new Error('expected the promise to reject');
}

const textOf = (result: { content?: Array<{ type: string; text?: string }> }): string | undefined => result.content?.[0]?.text;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

describe('stdio', () => {
  it('lists tools, following nextCursor across pages', async () => {
    const client = makeClient([stdioServer({ env: { MOCK_PAGE_SIZE: '3' } })]);
    const tools = await client.listTools('mock');
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools[0]?.inputSchema?.type).toBe('object');
  });

  it('returns the raw result of a successful call', async () => {
    const client = makeClient([stdioServer()]);
    const result = await client.callTool('mock', 'echo', { message: 'hi' });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'echo: hi' }] });
    expect(result.isError).toBeUndefined();
  });

  it('passes structuredContent through unrendered', async () => {
    const client = makeClient([stdioServer()]);
    const result = await client.callTool('mock', 'structured');
    expect(result.structuredContent).toEqual({ items: [{ id: 1 }, { id: 2 }] });
  });

  it('passes isError results through instead of throwing', async () => {
    const client = makeClient([stdioServer()]);
    const result = await client.callTool('mock', 'fail');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('boom');
  });

  it('resolves env references and injects them into the child, without leaking the rest of the parent env', async () => {
    process.env.VIA_TEST_UNRELATED = 'should-not-leak';
    try {
      const client = makeClient([stdioServer({ env: { MOCK_SECRET: 'env:MOCK_KEY', MOCK_LITERAL: 'plain' } })], { MOCK_KEY: FAKE_KEY });
      expect(textOf(await client.callTool('mock', 'read_env', { name: 'MOCK_SECRET' }))).toBe(FAKE_KEY);
      expect(textOf(await client.callTool('mock', 'read_env', { name: 'MOCK_LITERAL' }))).toBe('plain');
      expect(textOf(await client.callTool('mock', 'read_env', { name: 'VIA_TEST_UNRELATED' }))).toBe('<unset>');
      expect(textOf(await client.callTool('mock', 'read_env', { name: 'PATH' }))).not.toBe('<unset>');
    } finally {
      delete process.env.VIA_TEST_UNRELATED;
    }
  });

  it('reuses one session per server and kills the child on close', async () => {
    const client = makeClient([stdioServer()]);
    const first = Number(textOf(await client.callTool('mock', 'pid')));
    const second = Number(textOf(await client.callTool('mock', 'pid')));
    expect(second).toBe(first);
    expect(alive(first)).toBe(true);
    await client.close();
    await waitUntil(() => !alive(first));
    expect(alive(first)).toBe(false);
  });

  it('accepts the provider name as well as the config key', async () => {
    const client = makeClient([stdioServer({ name: 'mock-key', provider: 'alias' })]);
    expect(textOf(await client.callTool('alias', 'echo', { message: 'x' }))).toBe('echo: x');
    expect(textOf(await client.callTool('mock-key', 'echo', { message: 'y' }))).toBe('echo: y');
  });

  it('serializes errors as protocol ErrorInfo', async () => {
    const client = makeClient([stdioServer()]);
    const err = await failure(client.callTool('nope', 'echo'));
    expect(isErrorInfo(err.info)).toBe(true);
    expect(JSON.parse(JSON.stringify(err.info))).toEqual(err.info);
  });
});

describe('errors', () => {
  it('missing credential: exit 4 with the credential error and its own next, nothing spawned', async () => {
    // A command that cannot run: if the client tried to spawn it, the exit code would be 6.
    const client = makeClient([stdioServer({ command: '/nonexistent/never-run', env: { TOKEN: 'env:NOT_SET' } })]);
    const err = await failure(client.callTool('mock', 'echo', { message: 'x' }));
    expect(err.exitCode).toBe(4);
    expect(err.message).toBe('environment variable NOT_SET is not set');
    expect(err.next).toBe('export NOT_SET=<value>');
  });

  it('missing credential without a next of its own falls back to auth login', async () => {
    const resolver = {
      resolve: async (ref: string) => {
        const { CredentialError } = await import('../../src/config/types');
        throw new CredentialError('keychain entry not found', ref);
      },
      resolvedValues: () => [],
    };
    const client = new InProcessClient([httpServer('http://127.0.0.1:1/mcp', { auth: { type: 'bearer', bearer: 'keychain:via/mock' } })], resolver);
    const err = await failure(client.listTools('mock'));
    expect(err.exitCode).toBe(4);
    expect(err.next).toBe('via auth login mock');
  });

  it('untrusted server: exit 5 before spawning, pointing at via trust', async () => {
    const client = makeClient([
      stdioServer({
        command: '/nonexistent/never-run',
        trusted: false,
        origin: { scope: 'project', path: '/work/repo/.via.yaml' },
      }),
    ]);
    const err = await failure(client.listTools('mock'));
    expect(err.exitCode).toBe(5);
    expect(err.next).toBe('via trust /work/repo/.via.yaml');
  });

  it('disabled and unknown servers are not found (exit 3)', async () => {
    const client = makeClient([stdioServer({ disabled: true }), stdioServer({ name: 'other', provider: 'other' })]);
    const disabled = await failure(client.listTools('mock'));
    expect(disabled.exitCode).toBe(3);
    const unknown = await failure(client.callTool('missing', 'echo'));
    expect(unknown.exitCode).toBe(3);
    expect(unknown.message).toBe('no such server: missing');
  });

  it('oauth servers without a saved login fail with exit 4 before any request (login flow: oauth.test.ts)', async () => {
    const client = makeClient([httpServer('http://127.0.0.1:1/mcp', { provider: 'linear', name: 'linear', auth: { type: 'oauth' } })]);
    const err = await failure(client.listTools('linear'));
    expect(err.exitCode).toBe(4);
    expect(err.message).toBe('linear requires auth');
    expect(err.next).toBe('via auth login linear');
  });

  it('a call that outlasts its timeout fails with exit 6 and the session stays usable', async () => {
    const client = makeClient([stdioServer()]);
    const err = await failure(client.callTool('mock', 'slow', { ms: 3000 }, { timeoutMs: 200 }));
    expect(err.exitCode).toBe(6);
    expect(err.message).toContain('did not answer within 0.2s');
    expect(err.next).toBe('rerun with a larger --timeout');
    expect(err.retryable).toBe(true);
    expect(textOf(await client.callTool('mock', 'echo', { message: 'still here' }))).toBe('echo: still here');
  });

  it('uses ServerConfig.timeout (seconds) when no per-call timeout is given', async () => {
    const client = makeClient([stdioServer({ timeout: 0.2 })]);
    const err = await failure(client.callTool('mock', 'slow', { ms: 3000 }));
    expect(err.exitCode).toBe(6);
  });

  it('spawn failure: exit 6 naming the command', async () => {
    const client = makeClient([stdioServer({ command: '/nonexistent/never-run' })]);
    const err = await failure(client.listTools('mock'));
    expect(err.exitCode).toBe(6);
    expect(err.message).toBe('cannot start mock: cannot run /nonexistent/never-run (ENOENT)');
    expect(err.next).toBe('via doctor');
  });

  it('exclusive server that dies at startup gets the framework-conflict hint', async () => {
    const args = ['-e', 'process.exit(3)'];
    const exclusive = makeClient([stdioServer({ args, exclusive: true })]);
    const err = await failure(exclusive.listTools('mock'));
    expect(err.exitCode).toBe(6);
    expect(err.message).toContain('process exited before the MCP handshake finished');
    expect(err.message).toContain('same-named server still running in an agent framework');
    expect(err.next).toBe('via doctor');

    const plain = makeClient([stdioServer({ args })]);
    const plainErr = await failure(plain.listTools('mock'));
    expect(plainErr.exitCode).toBe(6);
    expect(plainErr.message).not.toContain('agent framework');
  });

  it('redacts resolved credentials from error messages, including child stderr', async () => {
    const script = 'console.error("startup failed, key=" + process.env.MOCK_SECRET); process.exit(1)';
    const client = makeClient([stdioServer({ args: ['-e', script], env: { MOCK_SECRET: 'env:MOCK_KEY' } })], { MOCK_KEY: FAKE_KEY });
    const err = await failure(client.listTools('mock'));
    expect(err.exitCode).toBe(6);
    expect(err.message).toContain('stderr: startup failed, key=***');
    expect(JSON.stringify(err.info)).not.toContain(FAKE_KEY);
  });

  it('retries a read-only call once after a lost connection, and not otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-client-'));
    try {
      const retrying = makeClient([stdioServer({ env: { MOCK_MARKER: join(dir, 'a') } })]);
      expect(textOf(await retrying.callTool('mock', 'crash_once', {}, { retry: true }))).toBe('recovered');

      const plain = makeClient([stdioServer({ env: { MOCK_MARKER: join(dir, 'b') } })]);
      const err = await failure(plain.callTool('mock', 'crash_once'));
      expect(err.exitCode).toBe(6);
      expect(err.message).toContain('lost the connection to mock');
      expect(err.retryable).toBe(true);
      // The next operation reconnects with a fresh child.
      expect(textOf(await plain.callTool('mock', 'crash_once'))).toBe('recovered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('concurrency', () => {
  it('never runs more calls at once than ServerConfig.concurrency, queueing the rest', async () => {
    const client = makeClient([stdioServer({ concurrency: 2 })]);
    const results = await Promise.all(Array.from({ length: 6 }, () => client.callTool('mock', 'busy')));
    expect(results.map(textOf)).toEqual(Array(6).fill('ok'));
    expect(textOf(await client.callTool('mock', 'max_busy'))).toBe('2');
  });

  it('runs calls in parallel up to the limit', async () => {
    const client = makeClient([stdioServer({ concurrency: 4 })]);
    await Promise.all(Array.from({ length: 4 }, () => client.callTool('mock', 'busy')));
    expect(Number(textOf(await client.callTool('mock', 'max_busy')))).toBeGreaterThan(1);
  });
});

describe('streamable http', () => {
  let http: MockHttp;
  const servers: MockHttp[] = [];

  beforeAll(async () => {
    http = await startHttpServer({ token: FAKE_TOKEN, pageSize: 3 });
    servers.push(http);
  });
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  it('sends the bearer token and lists tools across pages', async () => {
    const client = makeClient([httpServer(http.url, { auth: { type: 'bearer', bearer: 'env:MOCK_TOKEN' } })], { MOCK_TOKEN: FAKE_TOKEN });
    const tools = await client.listTools('mock');
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(http.requests.every((h) => h.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
  });

  it('calls a tool over HTTP', async () => {
    const client = makeClient([httpServer(http.url, { auth: { type: 'bearer', bearer: 'env:MOCK_TOKEN' } })], { MOCK_TOKEN: FAKE_TOKEN });
    expect(textOf(await client.callTool('mock', 'echo', { message: 'over http' }))).toBe('echo: over http');
    const failed = await client.callTool('mock', 'fail');
    expect(failed.isError).toBe(true);
  });

  it('401 without credentials: exit 4, requires auth, next auth login', async () => {
    const client = makeClient([httpServer(http.url, { provider: 'linear', name: 'linear' })]);
    const err = await failure(client.listTools('linear'));
    expect(err.exitCode).toBe(4);
    expect(err.message).toBe('linear requires auth');
    expect(err.next).toBe('via auth login linear');
  });

  it('401 with a wrong token: exit 4 and the token is not echoed', async () => {
    const client = makeClient([httpServer(http.url, { auth: { type: 'bearer', bearer: 'env:MOCK_TOKEN' } })], { MOCK_TOKEN: 'fake-wrong-token' });
    const err = await failure(client.callTool('mock', 'echo', { message: 'x' }));
    expect(err.exitCode).toBe(4);
    expect(err.message).toBe('mock rejected the credentials (HTTP 401)');
    expect(err.message).not.toContain('fake-wrong-token');
  });

  it('403 maps to exit 4 as well', async () => {
    const forbidden = await startHttpServer({ status: 403 });
    servers.push(forbidden);
    const client = makeClient([httpServer(forbidden.url)]);
    const err = await failure(client.listTools('mock'));
    expect(err.exitCode).toBe(4);
    expect(err.message).toBe('mock denied access (HTTP 403)');
  });

  it('sends auth.headers and transport.headers, auth.bearer wins over a static Authorization header', async () => {
    const open = await startHttpServer();
    servers.push(open);
    const client = makeClient(
      [
        httpServer(open.url, {
          headers: { 'X-Static': 'static-value', Authorization: 'Bearer should-be-replaced' },
          auth: { type: 'bearer', bearer: 'env:MOCK_TOKEN' },
        }),
        httpServer(open.url, {
          name: 'keyed',
          provider: 'keyed',
          auth: { type: 'headers', headers: { 'X-Api-Key': 'env:MOCK_KEY' } },
        }),
      ],
      { MOCK_TOKEN: FAKE_TOKEN, MOCK_KEY: FAKE_KEY },
    );
    await client.listTools('mock');
    expect(open.requests.at(-1)).toMatchObject({ 'x-static': 'static-value', authorization: `Bearer ${FAKE_TOKEN}` });
    await client.listTools('keyed');
    expect(open.requests.at(-1)).toMatchObject({ 'x-api-key': FAKE_KEY });
  });

  it('upstream HTTP errors: exit 6, and echoed credentials are redacted', async () => {
    const broken = await startHttpServer({ status: 500, echoAuth: true });
    servers.push(broken);
    const client = makeClient([httpServer(broken.url, { auth: { type: 'bearer', bearer: 'env:MOCK_TOKEN' } })], { MOCK_TOKEN: FAKE_TOKEN });
    const err = await failure(client.callTool('mock', 'echo', { message: 'x' }));
    expect(err.exitCode).toBe(6);
    expect(err.message).toContain('HTTP 500');
    expect(err.message).toContain('Bearer ***');
    expect(err.message).not.toContain(FAKE_TOKEN);
  });

  it('connection refused: exit 6 naming the origin only', async () => {
    const gone = await startHttpServer();
    const url = gone.url;
    await gone.close();
    const client = makeClient([httpServer(`${url}?apikey=in-the-url`)]);
    const err = await failure(client.listTools('mock'));
    expect(err.exitCode).toBe(6);
    expect(err.message).toMatch(/^cannot start mock: cannot reach http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)$/);
    expect(err.message).not.toContain('in-the-url');
    expect(err.retryable).toBe(true);
  });

  it('call timeout over HTTP: exit 6', async () => {
    const client = makeClient([httpServer(http.url, { auth: { type: 'bearer', bearer: 'env:MOCK_TOKEN' } })], { MOCK_TOKEN: FAKE_TOKEN });
    const err = await failure(client.callTool('mock', 'slow', { ms: 3000 }, { timeoutMs: 200 }));
    expect(err.exitCode).toBe(6);
  });
});
