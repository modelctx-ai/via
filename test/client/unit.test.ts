import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { baseEnvironment, ClientError, Limiter, mapError, resolveConnection } from '../../src/client';
import { CredentialError } from '../../src/config/types';
import { isErrorInfo, isErrorResponse, type Response } from '../../src/protocol';
import { createRedactor } from '../../src/render/redact';
import { FAKE_TOKEN, FakeResolver, httpServer, stdioServer } from '../helpers/client';

describe('baseEnvironment', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    LC_ALL: 'C',
    XDG_RUNTIME_DIR: '/run/u',
    HTTPS_PROXY: 'http://proxy:3128',
    https_proxy: 'http://proxy:3128',
    NODE_EXTRA_CA_CERTS: '/ca.pem',
    GITHUB_TOKEN: 'not-for-children',
    AWS_SECRET_ACCESS_KEY: 'not-for-children',
    BASH_FUNC_x: '() { :; }',
    SHELL: '() { evil; }',
  };

  it('passes only locale, path, proxy and XDG variables', () => {
    const env = baseEnvironment(source, 'linux');
    expect(Object.keys(env).sort()).toEqual(
      ['HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'PATH', 'XDG_RUNTIME_DIR', 'https_proxy'].sort(),
    );
  });

  it('matches Windows variable names case-insensitively', () => {
    expect(baseEnvironment({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', GITHUB_TOKEN: 'x' }, 'win32')).toEqual({
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
    });
  });
});

describe('resolveConnection', () => {
  it('merges the resolved env onto the base env, resolved values winning', async () => {
    const server = stdioServer({ env: { PATH: 'literal-path', KEY: 'env:K' } });
    // The base environment is the host's own (env.ts): the home variable is USERPROFILE on Windows, HOME elsewhere.
    const home = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const resolved = await resolveConnection(server, new FakeResolver({ K: 'fake-value' }), { PATH: '/usr/bin', [home]: '/h', OTHER: 'x' });
    expect(resolved).toMatchObject({ type: 'stdio', env: { PATH: 'literal-path', [home]: '/h', KEY: 'fake-value' } });
    expect(resolved.type === 'stdio' && 'OTHER' in resolved.env).toBe(false);
  });

  it('builds headers in order: transport headers, auth headers, then bearer', async () => {
    const server = httpServer('http://127.0.0.1/mcp', {
      headers: { 'X-One': '1', authorization: 'old' },
      auth: { type: 'bearer', bearer: 'env:T' },
    });
    const resolved = await resolveConnection(server, new FakeResolver({ T: FAKE_TOKEN }));
    expect(resolved).toEqual({ type: 'http', url: 'http://127.0.0.1/mcp', headers: { 'X-One': '1', Authorization: `Bearer ${FAKE_TOKEN}` } });
  });
});

describe('Limiter', () => {
  it('runs at most `limit` tasks, in arrival order', async () => {
    const limiter = new Limiter(2);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        limiter.run(async () => {
          order.push(i);
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.running).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it('keeps going after a failing task', async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects a limit below 1', () => {
    expect(() => new Limiter(0)).toThrow(RangeError);
  });
});

describe('mapError', () => {
  const server = httpServer('http://127.0.0.1/mcp', { provider: 'acme', name: 'acme' });
  const ctx = { server, phase: 'request' as const, timeoutMs: 60000, redact: createRedactor([FAKE_TOKEN]) };

  it('passes ClientError through unchanged', () => {
    const original = new ClientError({ exitCode: 5, message: 'denied' });
    expect(mapError(original, ctx)).toBe(original);
  });

  it('maps CredentialError to exit 4 with its own next, or auth login', () => {
    expect(mapError(new CredentialError('missing', 'env:X', 'export X=…'), ctx)).toMatchObject({ exitCode: 4, next: 'export X=…' });
    expect(mapError(new CredentialError('missing', 'env:X'), ctx)).toMatchObject({ exitCode: 4, next: 'via auth login acme' });
  });

  it('maps an SDK-shaped HTTP error and redacts and flattens its text', () => {
    const err = Object.assign(new Error(`Streamable HTTP error: Error POSTing to endpoint: oops\n\u001b[31m${FAKE_TOKEN}\u001b[0m`), { code: 502 });
    const mapped = mapError(err, ctx);
    expect(mapped.exitCode).toBe(6);
    expect(mapped.message).toBe('acme returned HTTP 502: oops ***');
  });

  it('caps long upstream text', () => {
    const err = Object.assign(new Error(`Streamable HTTP error: ${'x'.repeat(5000)}`), { code: 500 });
    expect(mapError(err, ctx).message.length).toBeLessThan(400);
  });

  it('maps an unknown failure while connected to exit 6', () => {
    expect(mapError(new Error('weird'), ctx)).toMatchObject({ exitCode: 6, message: 'acme: weird' });
  });
});

describe('protocol', () => {
  it('guards error responses and ErrorInfo values', () => {
    const bad: Response = { id: '1', type: 'result', ok: false, error: { exitCode: 4, message: 'x' } };
    const good: Response = { id: '2', type: 'result', ok: true, result: {}, meta: { elapsedMs: 1 } };
    expect(isErrorResponse(bad)).toBe(true);
    expect(isErrorResponse(good)).toBe(false);
    expect(isErrorInfo(bad.ok ? undefined : bad.error)).toBe(true);
    expect(isErrorInfo(new Error('x'))).toBe(false);
    expect(isErrorInfo(null)).toBe(false);
  });
});

// implementation.md, "启动速度": the MCP SDK may only be reached through dynamic import().
describe('lazy loading of the MCP SDK', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  it('has no static runtime import of the SDK in src/', () => {
    const offenders = sources(join(root, 'src')).filter((file) =>
      /^\s*(import|export)\s+(?!type\b)[^;]*?from\s+['"]@modelcontextprotocol\//m.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the SDK out of the entry chunk when bundled with splitting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'via-lazy-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(entry, `export * from ${JSON.stringify(join(root, 'src/client/index.ts'))};`);
      const result = await build({
        entryPoints: [entry],
        outdir: join(dir, 'out'),
        bundle: true,
        splitting: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        metafile: true,
        write: false,
        // A native addon; the real build leaves dependencies external as well.
        external: ['@napi-rs/keyring'],
        logLevel: 'silent',
      });
      const outputs = Object.entries(result.metafile.outputs);
      const entryOutput = outputs.find(([, o]) => o.entryPoint !== undefined);
      expect(entryOutput).toBeDefined();
      const sdkOf = (o: { inputs: Record<string, unknown> }): boolean => Object.keys(o.inputs).some((i) => i.includes('@modelcontextprotocol/sdk'));
      expect(sdkOf(entryOutput![1])).toBe(false);
      // Every chunk the entry statically imports is SDK-free as well.
      const staticChunks = entryOutput![1].imports.filter((i) => i.kind === 'import-statement' && !i.external).map((i) => i.path);
      for (const path of staticChunks) expect(sdkOf(result.metafile.outputs[path]!)).toBe(false);
      // And the SDK is reachable through dynamic imports.
      expect(outputs.some(([, o]) => sdkOf(o))).toBe(true);
      expect(entryOutput![1].imports.some((i) => i.kind === 'dynamic-import')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
