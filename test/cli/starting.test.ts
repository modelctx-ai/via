// The reason after `failed ·` in `via` (discovery.md, "浏览视图"): one line, short, redacted, inert.
import { describe, expect, it } from 'vitest';
import { ClientError } from '../../src/client/client-error';
import { failureReason, statusOf } from '../../src/cli/directory';
import { ExitCode } from '../../src/render/exit-codes';
import { makeSandbox } from './helpers';

describe('failureReason', () => {
  it('drops the "cannot start <provider>:" lead and keeps the first line only', () => {
    expect(failureReason('cannot start dead: cannot run xyz (ENOENT)\nsecond line', 'dead')).toBe('cannot run xyz (ENOENT)');
    expect(failureReason('cannot start other: boom', 'dead')).toBe('cannot start other: boom');
  });

  it('folds whitespace, escapes controls and bidi characters, and cuts at 80 characters', () => {
    expect(failureReason('a \t  b\u001b[31m red \u202e rtl', 'p')).toBe('a b red \\u202e rtl');
    const long = failureReason('x'.repeat(200), 'p');
    expect([...long]).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('statusOf', () => {
  it('is starting for a timeout, failed for other upstream errors, and keeps needs-auth and untrusted', () => {
    const timeout = new ClientError({ exitCode: ExitCode.Upstream, message: 'timed out after 3s connecting to slow' }, true);
    timeout.kind = 'timeout';
    expect(statusOf(timeout)).toBe('starting');
    expect(statusOf(new ClientError({ exitCode: ExitCode.Upstream, message: 'cannot start dead: x' }))).toBe('failed');
    expect(statusOf(new ClientError({ exitCode: ExitCode.Auth, message: 'requires auth' }))).toBe('needs-auth');
    expect(statusOf(new ClientError({ exitCode: ExitCode.Denied, message: 'x is defined in an untrusted project config' }))).toBe('untrusted');
    expect(statusOf(new Error('anything else'))).toBe('failed');
  });
});

describe('via: the reason of a server that exits', () => {
  it('never shows a credential value that the server printed on its way out', async () => {
    const secret = 'leaky-credential-value-0123456789';
    const sb = makeSandbox({ LEAK: secret });
    const script = `console.error('${secret}'); process.exit(1)`;
    sb.userConfig(`sources: false\nservers:\n  boom:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", ${JSON.stringify(script)}]\n    env: { TOKEN: "env:LEAK" }\n`);
    const r = await sb.via([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^boom\s+failed · the process exited before the MCP handshake finished/m);
    expect(r.stdout).toContain('(stderr: ***)');
    expect(r.combined).not.toContain(secret);
  });
});
