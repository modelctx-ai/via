import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CredentialError, createCredentialResolver, isCredentialRef, parseCredentialRef, splitCommandLine, type ConfigOrigin, type KeyringModule } from '../../src/config';
import { createRedactor } from '../../src/render';
import { tempDir } from '../helpers/config';

// Obviously fake values; none of them has the shape of a real credential.
const FAKE = 'fake-value-for-tests-1234';
const user: ConfigOrigin = { scope: 'user', path: '/fake/config.yaml' };

function keyring(entries: Record<string, string | null>, fail?: string): { loader: () => Promise<KeyringModule>; calls: string[] } {
  const calls: string[] = [];
  class AsyncEntry {
    constructor(private service: string, private account: string) {}
    async getPassword(): Promise<string | null> {
      calls.push(`${this.service}/${this.account}`);
      if (fail) throw new Error(fail);
      return entries[`${this.service}/${this.account}`] ?? null;
    }
  }
  return { loader: async () => ({ AsyncEntry }), calls };
}

async function failure(promise: Promise<unknown>): Promise<CredentialError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CredentialError);
  return error as CredentialError;
}

describe('parseCredentialRef', () => {
  it.each([
    ['env:EXA_KEY', 'env', 'EXA_KEY'],
    ['file:~/.secrets/x', 'file', '~/.secrets/x'],
    ['keychain:via/github', 'keychain', 'via/github'],
    ['cmd:op read op://dev/exa/key', 'cmd', 'op read op://dev/exa/key'],
    ['plain-literal', 'literal', 'plain-literal'],
    ['ENV:NOT_A_PREFIX', 'literal', 'ENV:NOT_A_PREFIX'],
    ['https://example.invalid', 'literal', 'https://example.invalid'],
  ])('%s', (value, kind, arg) => {
    expect(parseCredentialRef(value)).toEqual({ kind, arg });
    expect(isCredentialRef(value)).toBe(kind !== 'literal');
  });
});

describe('env:', () => {
  it('reads the injected environment, not the real one', async () => {
    process.env.VIA_TEST_REAL_ENV = 'real-env-must-not-leak';
    try {
      const resolver = createCredentialResolver({ env: { EXA_KEY: FAKE } });
      expect(await resolver.resolve('env:EXA_KEY', user)).toBe(FAKE);
      await failure(resolver.resolve('env:VIA_TEST_REAL_ENV', user));
    } finally {
      delete process.env.VIA_TEST_REAL_ENV;
    }
  });

  it('names the variable to set when it is missing or empty', async () => {
    const resolver = createCredentialResolver({ env: { EMPTY: '' } });
    for (const name of ['MISSING_KEY', 'EMPTY']) {
      const error = await failure(resolver.resolve(`env:${name}`, user));
      expect(error.message).toContain(name);
      expect(error.message).toContain('not set');
      expect(error.message).toContain('/fake/config.yaml');
      expect(error.ref).toBe(`env:${name}`);
      expect(error.next).toContain(`export ${name}=`);
    }
  });

  it('rejects a malformed name', async () => {
    const error = await failure(createCredentialResolver({ env: {} }).resolve('env:', user));
    expect(error.message).toContain('expected env:NAME');
    await failure(createCredentialResolver({ env: {} }).resolve('env:A B', user));
  });
});

describe('file:', () => {
  it('trims surrounding whitespace and expands ~', async () => {
    const home = tempDir();
    mkdirSync(join(home, '.secrets'));
    writeFileSync(join(home, '.secrets', 'exa'), `  ${FAKE}\n\n`);
    const resolver = createCredentialResolver({ home, env: {} });
    expect(await resolver.resolve('file:~/.secrets/exa', user)).toBe(FAKE);
    expect(await resolver.resolve(`file:${join(home, '.secrets', 'exa')}`, user)).toBe(FAKE);
  });

  it('resolves relative paths against cwd', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'key.txt'), FAKE);
    expect(await createCredentialResolver({ cwd: dir, env: {} }).resolve('file:key.txt', user)).toBe(FAKE);
  });

  it('fails with the path when the file is missing, empty or unreadable', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'empty'), ' \n');
    writeFileSync(join(dir, 'locked'), FAKE);
    const resolver = createCredentialResolver({ home: dir, env: {} });

    const missing = await failure(resolver.resolve('file:~/nope', user));
    expect(missing.message).toContain(join(dir, 'nope'));
    expect(missing.message).toContain('does not exist');
    expect(missing.next).toContain('create');

    const empty = await failure(resolver.resolve('file:~/empty', user));
    expect(empty.message).toContain('is empty');

    const directory = await failure(resolver.resolve(`file:${dir}`, user));
    expect(directory.message).toContain('cannot read credential file');

    // Mode bits do not deny access on Windows; root ignores them.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(join(dir, 'locked'), 0o000);
      const denied = await failure(resolver.resolve('file:~/locked', user));
      expect(denied.message).toContain('EACCES');
      expect(denied.message).not.toContain(FAKE);
    }
    expect((await failure(resolver.resolve('file:', user))).message).toContain('expected file:PATH');
  });
});

describe('values written by Windows tools', () => {
  it('reads file: credentials saved as UTF-8 with a BOM or as UTF-16 (PowerShell 5.1 `>`), with CRLF line ends', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'bom'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${FAKE}\r\n`)]));
    writeFileSync(join(dir, 'utf16'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${FAKE}\r\n`, 'utf16le')]));
    const resolver = createCredentialResolver({ home: dir, env: {} });
    expect(await resolver.resolve(`file:${join(dir, 'bom')}`, user)).toBe(FAKE);
    expect(await resolver.resolve(`file:${join(dir, 'utf16')}`, user)).toBe(FAKE);
  });

  it('looks environment variables up case-insensitively on Windows only', async () => {
    const win = createCredentialResolver({ env: { GitHub_Token: FAKE }, platform: 'win32' });
    expect(await win.resolve('env:GITHUB_TOKEN', user)).toBe(FAKE);
    const posix = createCredentialResolver({ env: { GitHub_Token: FAKE }, platform: 'linux' });
    expect((await failure(posix.resolve('env:GITHUB_TOKEN', user))).message).toContain('GITHUB_TOKEN is not set');
  });
});

describe('keychain:', () => {
  it('imports the module lazily and splits service/account at the first slash', async () => {
    const { loader, calls } = keyring({ 'via/github': FAKE, 'via/team/bot': 'second-fake-value-9876' });
    const load = vi.fn(loader);
    const resolver = createCredentialResolver({ loadKeyring: load });
    expect(load).not.toHaveBeenCalled();
    expect(await resolver.resolve('keychain:via/github', user)).toBe(FAKE);
    expect(await resolver.resolve('keychain:via/team/bot', user)).toBe('second-fake-value-9876');
    expect(calls).toEqual(['via/github', 'via/team/bot']);
  });

  it('is looked up once per reference', async () => {
    const { loader, calls } = keyring({ 'via/github': FAKE });
    const resolver = createCredentialResolver({ loadKeyring: loader });
    await resolver.resolve('keychain:via/github', user);
    await resolver.resolve('keychain:via/github', user);
    expect(calls).toHaveLength(1);
  });

  it('explains a missing entry', async () => {
    const error = await failure(createCredentialResolver({ platform: 'linux', loadKeyring: keyring({}).loader }).resolve('keychain:via/github', user));
    expect(error.message).toContain('service "via", account "github"');
    expect(error.next).toContain('keychain');
  });

  it('names Windows Credential Manager, and the Windows config path, in the hints on Windows', async () => {
    const missing = await failure(createCredentialResolver({ platform: 'win32', loadKeyring: keyring({}).loader }).resolve('keychain:via/github', user));
    expect(missing.message).toContain('service "via", account "github"');
    expect(missing.next).toContain('Windows Credential Manager');
    const broken = await failure(createCredentialResolver({ platform: 'win32', loadKeyring: keyring({}, 'A required privilege is not held by the client').loader }).resolve('keychain:via/github', user));
    expect(broken.message).toContain('cannot read the system keychain: A required privilege is not held by the client');
    expect(broken.next).toContain('Credential Manager');
    const project = await failure(createCredentialResolver({ platform: 'win32' }).resolve('cmd:op read x', { scope: 'project', path: 'C:\\repo\\.via.yaml' }));
    expect(project.next).toContain('%APPDATA%\\via\\config.yaml');
  });

  it('turns a keychain failure into a CredentialError that suggests env: or file:', async () => {
    const resolver = createCredentialResolver({ loadKeyring: keyring({}, 'The name org.freedesktop.secrets was not provided\nmore detail').loader });
    const error = await failure(resolver.resolve('keychain:via/github', user));
    expect(error.message).toContain('cannot read the system keychain: The name org.freedesktop.secrets was not provided');
    expect(error.message).not.toContain('more detail');
    expect(error.next).toContain('env:');
  });

  it('turns a failing import (no native module for this platform) into a CredentialError', async () => {
    const resolver = createCredentialResolver({
      loadKeyring: async () => {
        throw new Error('Cannot find native binding');
      },
    });
    expect((await failure(resolver.resolve('keychain:via/github', user))).message).toContain('Cannot find native binding');
  });

  it.each(['keychain:', 'keychain:via', 'keychain:via/', 'keychain:/github'])('rejects %s', async (ref) => {
    const error = await failure(createCredentialResolver({ loadKeyring: keyring({}).loader }).resolve(ref, user));
    expect(error.message).toContain('expected keychain:service/account');
  });

  it('loads the real @napi-rs/keyring module shape', async () => {
    const mod = await import('@napi-rs/keyring');
    expect(typeof mod.AsyncEntry).toBe('function');
  });
});

/** A credential helper written as a Node script, so the tests need no particular program on the machine. */
function helper(dir: string): { ref: (...args: string[]) => string; counter: string } {
  const script = join(dir, 'helper.mjs');
  const counter = join(dir, 'runs');
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs';
const [mode, value = ''] = process.argv.slice(2);
if (process.env.HELPER_COUNTER) appendFileSync(process.env.HELPER_COUNTER, 'x');
if (mode === 'print') process.stdout.write(value + '\\n');
else if (mode === 'env') process.stdout.write(process.env[value] ?? '');
else if (mode === 'fail') { process.stdout.write(value); process.stderr.write(value); process.exit(3); }
else if (mode === 'empty') process.stdout.write('  \\n');
else if (mode === 'big') process.stdout.write('x'.repeat(200 * 1024));
else if (mode === 'hang') setInterval(() => {}, 1000);
`,
  );
  return { ref: (...args) => `cmd:'${process.execPath}' '${script}' ${args.join(' ')}`, counter };
}

describe('splitCommandLine', () => {
  it.each([
    ['op read op://dev/exa/key', ['op', 'read', 'op://dev/exa/key']],
    ['  a   b  ', ['a', 'b']],
    [`sh -c 'echo "$HOME" | cat'`, ['sh', '-c', 'echo "$HOME" | cat']],
    ['say "hello \\"you\\" \\\\ x"', ['say', 'hello "you" \\ x']],
    ['a\\ b c', ['a b', 'c']],
    ["a '' b", ['a', '', 'b']],
    ['$HOME ~ * | >', ['$HOME', '~', '*', '|', '>']],
  ])('%j', (text, words) => {
    expect(splitCommandLine(text, 'linux')).toEqual(words); // the POSIX rules; Windows has its own block below
  });

  it.each(['', '   ', "a 'b", 'a "b', "''"])('rejects %j', (text) => {
    expect(splitCommandLine(text, 'linux')).toBeUndefined();
  });
});

// A backslash is a path separator on Windows: quoting follows the C runtime (CommandLineToArgvW).
describe('splitCommandLine on Windows', () => {
  const win = (text: string): string[] | undefined => splitCommandLine(text, 'win32');

  it.each([
    ['C:\\Tools\\op.exe read op://dev/exa/key', ['C:\\Tools\\op.exe', 'read', 'op://dev/exa/key']],
    ['"C:\\Program Files\\1Password CLI\\op.exe" read x', ['C:\\Program Files\\1Password CLI\\op.exe', 'read', 'x']],
    ["'C:\\Program Files\\node.exe' 'C:\\a b\\script.mjs' print", ['C:\\Program Files\\node.exe', 'C:\\a b\\script.mjs', 'print']],
    ['say "hello \\"you\\" x"', ['say', 'hello "you" x']],
    ['a\\\\"b c" d', ['a\\b c', 'd']],
    ['"C:\\dir\\\\" x', ['C:\\dir\\', 'x']],
    ['a\\ b', ['a\\', 'b']],
    ['\\\\server\\share\\tool.exe', ['\\\\server\\share\\tool.exe']],
  ])('%j', (text, words) => {
    expect(win(text)).toEqual(words);
  });

  it('still rejects an empty command and an unterminated quote', () => {
    expect(win('')).toBeUndefined();
    expect(win('"C:\\dir\\" x')).toBeUndefined(); // the backslash escapes the closing quote
    expect(win("a 'b")).toBeUndefined();
  });

  it('leaves POSIX parsing alone when asked for another platform', () => {
    expect(splitCommandLine('a\\ b c', 'linux')).toEqual(['a b', 'c']);
    expect(splitCommandLine('C:\\Tools\\op.exe', 'darwin')).toEqual(['C:Toolsop.exe']);
  });
});

describe('cmd:', () => {
  it('runs the command without a shell and returns its trimmed stdout', async () => {
    const h = helper(tempDir());
    const resolver = createCredentialResolver();
    expect(await resolver.resolve(h.ref('print', FAKE), user)).toBe(FAKE);
    expect(resolver.resolvedValues()).toContain(FAKE);
  });

  it('does not expand variables, pipes or globs', async () => {
    const h = helper(tempDir());
    expect(await createCredentialResolver({ env: { ...process.env, HOME: '/nope' } }).resolve(h.ref('print', "'$HOME|*'"), user)).toBe('$HOME|*');
  });

  it('gives the command the resolver environment', async () => {
    const h = helper(tempDir());
    expect(await createCredentialResolver({ env: { ...process.env, PASS_THROUGH: FAKE } }).resolve(h.ref('env', 'PASS_THROUGH'), user)).toBe(FAKE);
  });

  it('is allowed for the command-line layer too', async () => {
    const h = helper(tempDir());
    expect(await createCredentialResolver().resolve(h.ref('print', FAKE), { scope: 'cli' })).toBe(FAKE);
  });

  it.each(['project', 'framework-project', 'framework-user'] as const)('is refused outside the user config (%s) and never runs', async (scope) => {
    const h = helper(tempDir());
    const env = { ...process.env, HELPER_COUNTER: h.counter };
    const error = await failure(createCredentialResolver({ env }).resolve(h.ref('print', FAKE), { scope, path: '/fake/.via.yaml' }));
    expect(error.message).toContain('only allowed in the user config');
    expect(existsSync(h.counter)).toBe(false);
  });

  it('a cached value is not handed to a project origin either', async () => {
    const h = helper(tempDir());
    const resolver = createCredentialResolver();
    await resolver.resolve(h.ref('print', FAKE), user);
    const error = await failure(resolver.resolve(h.ref('print', FAKE), { scope: 'project', path: '/fake/.via.yaml' }));
    expect(error.message).toContain('only allowed in the user config');
    expect(error.message).not.toContain(FAKE);
  });

  it('runs once per reference within the TTL, and again after it', async () => {
    const h = helper(tempDir());
    let clock = 1_000;
    const resolver = createCredentialResolver({ env: { ...process.env, HELPER_COUNTER: h.counter }, now: () => clock, cmdTtlMs: 5_000 });
    const runs = (): number => readFileSync(h.counter, 'utf8').length;
    await resolver.resolve(h.ref('print', FAKE), user);
    await resolver.resolve(h.ref('print', FAKE), user);
    expect(runs()).toBe(1);
    clock += 4_999;
    await resolver.resolve(h.ref('print', FAKE), user);
    expect(runs()).toBe(1);
    clock += 2;
    await resolver.resolve(h.ref('print', FAKE), user);
    expect(runs()).toBe(2);
  });

  it('concurrent resolves share one run; a TTL of 0 disables the cache', async () => {
    const h = helper(tempDir());
    const env = { ...process.env, HELPER_COUNTER: h.counter };
    const shared = createCredentialResolver({ env });
    await Promise.all([1, 2, 3].map(() => shared.resolve(h.ref('print', FAKE), user)));
    expect(readFileSync(h.counter, 'utf8')).toBe('x');

    const uncached = createCredentialResolver({ env, cmdTtlMs: 0 });
    await uncached.resolve(h.ref('print', FAKE), user);
    await uncached.resolve(h.ref('print', FAKE), user);
    expect(readFileSync(h.counter, 'utf8')).toBe('xxx');
  });

  it('a failure is not cached', async () => {
    const dir = tempDir();
    const marker = join(dir, 'ready');
    const script = join(dir, 'flaky.mjs');
    writeFileSync(script, `import { existsSync } from 'node:fs'; if (existsSync(${JSON.stringify(marker)})) process.stdout.write(${JSON.stringify(FAKE)}); else process.exit(1);`);
    const resolver = createCredentialResolver();
    const ref = `cmd:'${process.execPath}' '${script}'`;
    await failure(resolver.resolve(ref, user));
    writeFileSync(marker, '');
    expect(await resolver.resolve(ref, user)).toBe(FAKE);
  });

  it('a nonzero exit is a credential error that shows neither stdout nor stderr', async () => {
    const h = helper(tempDir());
    const resolver = createCredentialResolver();
    const error = await failure(resolver.resolve(h.ref('fail', FAKE), user));
    expect(error.message).toContain('exited with status 3');
    expect(error.message).toContain('its output is not shown');
    expect(`${error.message}\n${error.next ?? ''}`).not.toContain(FAKE);
    expect(resolver.resolvedValues()).not.toContain(FAKE);
  });

  it('empty output is a missing credential', async () => {
    const error = await failure(createCredentialResolver().resolve(helper(tempDir()).ref('empty'), user));
    expect(error.message).toContain('printed nothing');
  });

  it('refuses output that is far too large to be a credential', async () => {
    const error = await failure(createCredentialResolver().resolve(helper(tempDir()).ref('big'), user));
    expect(error.message).toContain('more than 64 KiB');
  });

  it('kills a command that hangs', async () => {
    const started = Date.now();
    const error = await failure(createCredentialResolver({ cmdTimeoutMs: 300 }).resolve(helper(tempDir()).ref('hang'), user));
    expect(error.message).toContain('did not finish');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a missing program by its name only', async () => {
    const error = await failure(createCredentialResolver().resolve('cmd:/no/such/dir/via-no-such-helper --token abcdefgh12345', user));
    expect(error.message).toContain('"via-no-such-helper" was not found');
    expect(error.message).not.toContain('abcdefgh12345');
    expect(error.message).not.toContain('/no/such/dir');
  });

  it.each(['cmd:', 'cmd:   ', "cmd:op 'unterminated"])('rejects %j as invalid', async (ref) => {
    const error = await failure(createCredentialResolver().resolve(ref, user));
    expect(error.message).toContain('invalid cmd: credential reference');
  });

  it('the resolved value is redacted from text that mentions it', async () => {
    const resolver = createCredentialResolver();
    await resolver.resolve(helper(tempDir()).ref('print', FAKE), user);
    expect(createRedactor(resolver.resolvedValues())(`Authorization: Bearer ${FAKE}`)).toBe('Authorization: Bearer ***');
  });
});

describe('literals and redaction', () => {
  it('returns unprefixed values as they are', async () => {
    const resolver = createCredentialResolver();
    expect(await resolver.resolve('just-a-literal-value', user)).toBe('just-a-literal-value');
    expect(await resolver.resolve('', user)).toBe('');
  });

  it('records every resolved value, and long literals, for redaction', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'k'), 'value-from-file-0001\n');
    const resolver = createCredentialResolver({
      env: { A: 'value-from-env-0002' },
      home: dir,
      loadKeyring: keyring({ 'svc/acct': 'value-from-keychain-0003' }).loader,
    });
    await resolver.resolve('env:A', user);
    await resolver.resolve('file:~/k', user);
    await resolver.resolve('keychain:svc/acct', user);
    await resolver.resolve('literal-secret-0004', user);
    await resolver.resolve('short', user);
    expect(resolver.resolvedValues()).toEqual(['value-from-env-0002', 'value-from-file-0001', 'value-from-keychain-0003', 'literal-secret-0004']);

    const redact = createRedactor(resolver.resolvedValues());
    expect(redact('a value-from-env-0002 b literal-secret-0004 short')).toBe('a *** b *** short');
  });

  it('never puts a value or a ref argument into an error message', async () => {
    const resolver = createCredentialResolver({ env: { A: FAKE }, loadKeyring: keyring({}, 'boom').loader });
    await resolver.resolve('env:A', user);
    for (const ref of ['env:NOPE', 'file:/definitely/not/here', 'keychain:svc/acct']) {
      const error = await failure(resolver.resolve(ref, user));
      expect(`${error.message} ${error.next}`).not.toContain(FAKE);
    }
  });
});
