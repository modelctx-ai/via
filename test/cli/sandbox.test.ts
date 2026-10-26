// `sandbox` (ADR 0027): with it on, `via <args>` runs as `<sandbox command> --settings <file> -- <via> <args>`.
// A fake srt (test/fixtures/sandbox/fake-srt.mjs) records what it was given and confines nothing.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sandboxSettings } from '../../src/cli/sandbox';
import { builtCli } from '../helpers/daemon';
import { FAKE_TOKEN, ghConfig, homeEnv, makeSandbox, startFixtureServer, useCleanup } from './helpers';

const FAKE_SRT = fileURLToPath(new URL('../fixtures/sandbox/fake-srt.mjs', import.meta.url));

interface Record_ {
  options: string[];
  command: string[];
  settings: { network: Record<string, unknown>; filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] } } & Record<string, unknown>;
  env: { VIA_SANDBOXED?: string; VIA_NO_DAEMON?: string };
}

function setup(sandbox: string) {
  const sb = makeSandbox();
  const log = join(sb.root, 'srt.log');
  sb.userConfig(`sources: false\nsandbox:\n  enabled: true\n  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(FAKE_SRT)}, --debug]\n${sandbox}`);
  const records = (): Record_[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record_) : []);
  return { sb, log, records };
}

describe('sandbox: how via starts itself inside', () => {
  it('the whole command line goes after --, with the settings file, the markers and the exit code of the inside', async () => {
    const { sb, log, records } = setup('  policy:\n    network:\n      allowedDomains: [registry.npmjs.org]\n    filesystem:\n      allowWrite: ["."]\n');
    const self = { command: '/opt/node', args: ['/opt/via/dist/via.js'] };
    const r = await sb.via(['gh', 'issue:read', '--number', '1', '-h'], { env: { FAKE_SRT_LOG: log, FAKE_SRT_EXIT: '3' }, daemonCommand: self });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('inside the fake sandbox\n');
    const [rec] = records();
    expect(rec!.options[0]).toBe('--debug');
    expect(rec!.options[1]).toBe('--settings');
    expect(rec!.command).toEqual(['/opt/node', '/opt/via/dist/via.js', 'gh', 'issue:read', '--number', '1', '-h']);
    expect(rec!.env).toEqual({ VIA_SANDBOXED: '1', VIA_NO_DAEMON: '1' });
    // The user's policy, plus via's own entries.
    expect(rec!.settings.network).toEqual({ allowedDomains: ['registry.npmjs.org'], deniedDomains: [] });
    expect(rec!.settings.filesystem.allowWrite).toEqual(['.', sb.cacheDir, join(sb.home, '.local', 'share', 'via', 'oauth')]);
    expect(rec!.settings.filesystem.denyWrite).toEqual([join(sb.home, '.config', 'via'), join(sb.home, '.local', 'share', 'via', 'trust.json')]);
    // The settings file is in via's cache, readable by its owner only.
    const file = rec!.options[2]!;
    expect(file.startsWith(join(sb.cacheDir, 'sandbox'))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('a policy file is read and extended the same way', async () => {
    const { sb, log, records } = setup('  policy: srt.json\n');
    sb.write('home/.config/via/srt.json', JSON.stringify({ network: { allowedDomains: ['api.example.com'] }, enableWeakerNestedSandbox: true }));
    expect((await sb.via(['servers'], { env: { FAKE_SRT_LOG: log, FAKE_SRT_EXIT: '0' } })).code).toBe(0);
    expect(records()[0]!.settings).toMatchObject({ enableWeakerNestedSandbox: true, network: { allowedDomains: ['api.example.com'] }, filesystem: { denyRead: [] } });
  });

  it('a policy file that cannot be read stops the command (exit 2), nothing runs unconfined', async () => {
    const { sb, log, records } = setup('  policy: missing.json\n');
    const r = await sb.via(['servers'], { env: { FAKE_SRT_LOG: log, FAKE_SRT_EXIT: '0' } });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: sandbox\.policy: cannot read .*missing\.json \(ENOENT\)/);
    expect(records()).toEqual([]);
  });

  it('a sandbox program that is not installed fails closed (exit 6) with a message for the user', async () => {
    const sb = makeSandbox();
    sb.userConfig('sources: false\nsandbox:\n  enabled: true\n  command: definitely-not-installed-srt-xyz\n');
    const r = await sb.via(['servers']);
    expect(r.code).toBe(6);
    expect(r.stderr).toBe(
      'error: cannot start the sandbox: definitely-not-installed-srt-xyz was not found\nnext: ask the user: definitely-not-installed-srt-xyz is not installed (needed by sandbox.enabled in the via config)\n',
    );
  });

  it('what runs outside: sandbox.exclude (auth, trust, daemon by default), help and usage texts, and a via already inside', async () => {
    const { sb, log, records } = setup('');
    const env = { FAKE_SRT_LOG: log, FAKE_SRT_EXIT: '9' };
    expect((await sb.via(['auth', 'status'], { env })).code).toBe(0);
    expect((await sb.via(['trust', '--list'], { env })).code).toBe(0);
    expect((await sb.via(['daemon', 'status'], { env })).code).toBe(0);
    expect((await sb.via(['-h'], { env })).code).toBe(0);
    expect((await sb.via(['help', 'find'], { env })).code).toBe(0);
    expect((await sb.via(['find', '-h'], { env })).code).toBe(0);
    expect((await sb.via(['servers'], { env: { ...env, VIA_SANDBOXED: '1' } })).code).toBe(0);
    expect(records()).toEqual([]);
    // Everything else goes in, the root listing included.
    expect((await sb.via([], { env })).code).toBe(9);
    expect((await sb.via(['find', 'x'], { env })).code).toBe(9);
    expect(records()).toHaveLength(2);
  });

  it('a project config cannot switch it off', async () => {
    const { sb, log, records } = setup('');
    sb.projectConfig('sandbox:\n  enabled: false\n');
    expect((await sb.via(['servers'], { env: { FAKE_SRT_LOG: log, FAKE_SRT_EXIT: '0' } })).code).toBe(0);
    expect(records()).toHaveLength(1);
  });

  it('a refused command is refused before the sandbox starts', async () => {
    const { sb, log, records } = setup('commands:\n  deny: [sync]\n');
    expect((await sb.via(['sync'], { env: { FAKE_SRT_LOG: log, FAKE_SRT_EXIT: '0' } })).code).toBe(5);
    expect(records()).toEqual([]);
  });
});

describe('sandbox: settings', () => {
  const dirs = { cache: '/c', oauth: '/d/oauth', config: '/cfg', trust: '/d/trust.json' };

  it('without a policy: no network, writes only to via\'s cache and OAuth files', () => {
    expect(sandboxSettings({ enabled: true, command: ['srt'], exclude: [] }, dirs)).toEqual({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ['/c', '/d/oauth'], denyWrite: ['/cfg', '/d/trust.json'] },
    });
  });

  it('keeps every key it does not know, and does not change the inline policy it was given', () => {
    const inline = { network: { allowedDomains: ['a'], allowLocalBinding: true }, filesystem: { denyWrite: ['.env'] }, ignoreViolations: { '*': ['/usr'] } };
    const out = sandboxSettings({ enabled: true, command: ['srt'], exclude: [], policy: { inline } }, dirs);
    expect(out).toEqual({
      network: { allowedDomains: ['a'], allowLocalBinding: true, deniedDomains: [] },
      filesystem: { denyWrite: ['.env', '/cfg', '/d/trust.json'], denyRead: [], allowWrite: ['/c', '/d/oauth'] },
      ignoreViolations: { '*': ['/usr'] },
    });
    expect(inline.filesystem.denyWrite).toEqual(['.env']);
  });
});

describe('sandbox: end to end through the built CLI', () => {
  it('the via inside does the work in its own process and says so in via doctor', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    useCleanup(() => srv.close());
    const { sb, log, records } = setup('');
    sb.userConfig(`${ghConfig(srv.url)}sandbox:\n  enabled: true\n  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(FAKE_SRT)}]\n`);
    const self = { command: process.execPath, args: [await builtCli()] };
    // The child is a real process: its home directory comes from the environment.
    const env = { ...homeEnv(sb.home), FAKE_SRT_LOG: log, GH_TOKEN: FAKE_TOKEN, VIA_NO_DAEMON: '0' };
    const listing = await sb.via(['gh', 'issue'], { env, daemonCommand: self });
    expect(listing.code).toBe(0);
    expect(listing.stdout).toContain('issue:read');
    const doctor = await sb.via(['doctor'], { env, daemonCommand: self });
    expect(doctor.stdout).toMatch(/^sandbox {3}.*fake-srt\.mjs · its own default settings · this check ran inside it$/m);
    expect(records().map((r) => r.env)).toEqual([
      { VIA_SANDBOXED: '1', VIA_NO_DAEMON: '1' },
      { VIA_SANDBOXED: '1', VIA_NO_DAEMON: '1' },
    ]);
    expect(listing.stdout + listing.stderr + doctor.stdout + doctor.stderr).not.toContain(FAKE_TOKEN);
  });
});
