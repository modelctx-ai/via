// Starting `.cmd` files for real, through cmd.exe. Only meaningful on Windows (CI's windows-latest);
// the quoting and PATHEXT rules themselves are tested on every host in command.test.ts.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InProcessClient } from '../../src/client';
import { createMemoryOAuthStore } from '../../src/client/oauth';
import { CredentialError, createCredentialResolver, type ConfigOrigin } from '../../src/config';
import { TOOLS } from '../fixtures/mcp/mock-server.mjs';
import { FakeResolver, STDIO_SERVER, stdioServer } from '../helpers/client';

const user: ConfigOrigin = { scope: 'user', path: 'C:\\fake\\config.yaml' };
const crlf = (lines: string[]): string => `${lines.join('\r\n')}\r\n`;

describe.skipIf(process.platform !== 'win32')('batch files on Windows', () => {
  let dir = '';
  let savedPath: string | undefined;
  const clients: InProcessClient[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'via win launch-')); // a space in the path, on purpose
    savedPath = process.env.PATH;
    process.env.PATH = `${dir};${process.env.PATH ?? ''}`;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await Promise.all(clients.splice(0).map((c) => c.close()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A launcher like npx.cmd: runs node with the server script and passes the arguments on. */
  function shim(name: string, script = STDIO_SERVER): void {
    writeFileSync(join(dir, `${name}.cmd`), crlf(['@echo off', `"${process.execPath}" "${script}" %*`]));
  }

  it('starts a stdio server whose command is a .cmd shim found through PATH and PATHEXT', async () => {
    shim('via-test-npx');
    const client = new InProcessClient([stdioServer({ command: 'via-test-npx', args: [] })], new FakeResolver(), { oauthStore: createMemoryOAuthStore() });
    clients.push(client);
    expect((await client.listTools('mock')).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });

  it('does not run a shim that only exists in the working directory', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const marker = join(dir, 'ran.txt');
    writeFileSync(join(repo, 'via-test-planted.cmd'), crlf(['@echo off', `echo planted> "${marker}"`]));
    const server = stdioServer({ transport: { type: 'stdio', command: 'via-test-planted', args: [], env: {}, cwd: repo } });
    const client = new InProcessClient([server], new FakeResolver(), { oauthStore: createMemoryOAuthStore() });
    clients.push(client);
    await expect(client.listTools('mock')).rejects.toThrow('cannot run via-test-planted (ENOENT)');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses to start a shim with an argument cmd.exe cannot carry', async () => {
    shim('via-test-args');
    const client = new InProcessClient([stdioServer({ command: 'via-test-args', args: ['--note', '100%'] })], new FakeResolver(), { oauthStore: createMemoryOAuthStore() });
    clients.push(client);
    await expect(client.listTools('mock')).rejects.toThrow('batch file');
  });

  // The helper prints its first argument without any further expansion, so what comes back is what cmd.exe handed over.
  // `set /p` reading from NUL leaves ERRORLEVEL 1, which would become the exit status of the whole batch file;
  // `exit /b 0` makes the helper succeed so that a failure here means via started it wrongly.
  function printer(): string {
    const file = join(dir, 'print arg.cmd');
    writeFileSync(file, crlf(['@echo off', 'setlocal', 'set "V=%~1"', '<nul set /p "=%V%"', 'exit /b 0']));
    return file;
  }

  it('cmd: runs a .cmd helper, and metacharacters in its arguments stay literal text', async () => {
    const file = printer();
    const marker = join(dir, 'injected.txt');
    const hostile = `a & echo pwned> "${marker}" | b ^ (c)`.replace(/"/g, ''); // no double quote: those are refused, below
    const resolver = createCredentialResolver({ platform: 'win32', env: { ...process.env } });
    expect(await resolver.resolve(`cmd:"${file}" '${hostile}'`, user)).toBe(hostile);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, 'injected.txt'))).toBe(false);
  });

  it('cmd: resolves a bare .cmd name through PATH and refuses a double quote or a percent sign in the arguments', async () => {
    printer();
    shim('via-test-helper');
    const resolver = createCredentialResolver({ platform: 'win32', env: { ...process.env } });
    expect(await resolver.resolve("cmd:'print arg' value-1234567", user)).toBe('value-1234567');
    for (const ref of [`cmd:via-test-helper 'say "hi"'`, 'cmd:via-test-helper %PATH%']) {
      const error = await resolver.resolve(ref, user).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(CredentialError);
      expect((error as CredentialError).message).toContain('is a batch file');
      expect((error as CredentialError).message).not.toContain('say');
    }
  });

  it('cmd: does not find a helper that only exists in the working directory', async () => {
    writeFileSync(join(dir, 'via-test-cwd.cmd'), crlf(['@echo off', 'echo should-not-run']));
    const elsewhere = mkdtempSync(join(tmpdir(), 'via-no-path-'));
    try {
      const resolver = createCredentialResolver({ platform: 'win32', cwd: dir, env: { ...process.env, PATH: elsewhere } });
      await expect(resolver.resolve('cmd:via-test-cwd', user)).rejects.toThrow('was not found');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
