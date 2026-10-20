import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CredentialError, createCredentialResolver, isCredentialRef, parseCredentialRef, type ConfigOrigin, type KeyringModule } from '../../src/config';
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

    if (process.getuid?.() !== 0) {
      chmodSync(join(dir, 'locked'), 0o000);
      const denied = await failure(resolver.resolve('file:~/locked', user));
      expect(denied.message).toContain('EACCES');
      expect(denied.message).not.toContain(FAKE);
    }
    expect((await failure(resolver.resolve('file:', user))).message).toContain('expected file:PATH');
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
    const error = await failure(createCredentialResolver({ loadKeyring: keyring({}).loader }).resolve('keychain:via/github', user));
    expect(error.message).toContain('service "via", account "github"');
    expect(error.next).toContain('keychain');
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

describe('cmd:', () => {
  it('is not supported yet in the user config', async () => {
    const error = await failure(createCredentialResolver().resolve('cmd:op read op://dev/exa/key', user));
    expect(error.message).toContain('not supported yet');
    expect(error.ref).toBe('cmd:op read op://dev/exa/key');
  });

  it.each(['project', 'framework-project', 'framework-user'] as const)('is refused outside the user config (%s)', async (scope) => {
    const error = await failure(createCredentialResolver().resolve('cmd:echo hi', { scope, path: '/fake/.via.yaml' }));
    expect(error.message).toContain('only allowed in the user config');
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
