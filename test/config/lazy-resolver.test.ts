import { describe, expect, it } from 'vitest';
import { CredentialError, createCredentialResolver, type ConfigOrigin } from '../../src/config';
import { createLazyCredentialResolver } from '../../src/config/lazy-resolver';
import { tempDir } from '../helpers/config';

// The lazy resolver (lazy-resolver.ts) stands in for the real one in a browse, which resolves
// nothing for most servers: it must behave the same, and remember secrets from before it loaded.

const FAKE = 'fake-value-for-tests-1234';
const user: ConfigOrigin = { scope: 'user', path: '/fake/config.yaml' };

describe('createLazyCredentialResolver', () => {
  const options = { env: { EXA_KEY: FAKE, OTHER_KEY: 'another-fake-value-5678' }, platform: 'linux' as const, home: '/home/nobody' };

  it('resolves like the real resolver and reports the same redaction list', async () => {
    const lazy = createLazyCredentialResolver(options);
    const real = createCredentialResolver(options);
    for (const ref of ['env:EXA_KEY', 'env:OTHER_KEY', 'a-literal-longer-than-eight', 'short']) {
      expect(await lazy.resolve(ref, user), ref).toBe(await real.resolve(ref, user));
    }
    expect(lazy.resolvedValues()).toEqual(real.resolvedValues());
    expect(lazy.resolvedValues()).toContain(FAKE);
    expect(lazy.resolvedValues()).not.toContain('short');
  });

  it('passes the real resolver errors through', async () => {
    const lazy = createLazyCredentialResolver(options);
    const error = await lazy.resolve('env:NOT_SET', user).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CredentialError);
    expect((error as CredentialError).message).toContain('NOT_SET');
  });

  it('keeps secrets tracked before the real resolver exists, in order, ignoring short ones', async () => {
    const lazy = createLazyCredentialResolver(options);
    lazy.track?.('oauth-token-from-the-store');
    lazy.track?.('tiny');
    expect(lazy.resolvedValues()).toEqual(['oauth-token-from-the-store']);
    await lazy.resolve('env:EXA_KEY', user);
    expect(lazy.resolvedValues()).toEqual(['oauth-token-from-the-store', FAKE]);
    lazy.track?.('a-token-after-loading');
    expect(lazy.resolvedValues()).toEqual(['oauth-token-from-the-store', FAKE, 'a-token-after-loading']);
  });

  it('shares one real resolver between concurrent resolves (one cmd: run per reference)', async () => {
    const dir = tempDir();
    const lazy = createLazyCredentialResolver({ ...options, cwd: dir });
    const [a, b] = await Promise.all([lazy.resolve('env:EXA_KEY', user), lazy.resolve('env:EXA_KEY', user)]);
    expect(a).toBe(b);
    expect(lazy.resolvedValues().filter((v) => v === FAKE)).toHaveLength(1);
  });
});
