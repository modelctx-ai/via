// A server that takes seconds to start is `starting`, not `failed` (discovery.md, "浏览视图"): through
// the daemon the browse commands wait `discovery.wait` and the daemon goes on connecting and writes the
// cache; in-process there is nothing to go on, so the row says to run `via sync`. A server that cannot
// run at all is `failed`, with the reason.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultGeneration, fixtureScript } from '../helpers/generation';
import { daemonSandbox, isWindows, waitFor } from '../helpers/daemon';

const CLI_SERVER = fixtureScript('cli-stdio-server', defaultGeneration());
const DELAY_MS = 2500;

/** Starts the CLI fixture only after `delayMs`, the way `npx -y …` takes its time before the server runs. */
function slowServer(name: string, delayMs: number, extra = ''): string {
  const boot = `setTimeout(() => import(${JSON.stringify(pathToFileURL(CLI_SERVER).href)}), ${delayMs})`;
  return `  ${name}:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", ${JSON.stringify(boot)}]\n${extra}`;
}

const quick = (name: string): string => `  ${name}:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_SERVER)}]\n`;
const dead = (name: string): string => `  ${name}:\n    command: definitely-not-installed-xyz\n    args: []\n`;

const config = (wait = 1): string => `sources: false\ndiscovery:\n  wait: ${wait}\nservers:\n${quick('ok')}${slowServer('slow', DELAY_MS)}${dead('dead')}`;

describe.skipIf(isWindows)('starting and failed, through the daemon', () => {
  it('answers after discovery.wait, marks the slow server starting and the missing one failed with its reason', async () => {
    const d = await daemonSandbox(config());
    const began = Date.now();
    const r = await d.via([]);
    const took = Date.now() - began;
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    // Not the 10 seconds it used to be, and not the whole startup of the slow server either.
    expect(took).toBeLessThan(DELAY_MS + 5000);
    const lines = r.stdout.split('\n');
    expect(lines[0]).toMatch(/^3 providers · \d+ tools · 1 starting \(slow\) · 1 failed \(dead\)$/);
    expect(r.stdout).toMatch(/^dead\s+failed · cannot run definitely-not-installed-xyz \(ENOENT\)$/m);
    expect(r.stdout).toMatch(/^slow\s+starting · retry in a moment$/m);
    expect(r.stdout).toMatch(/^ok\s+\d+ tools$/m);
  });

  it('keeps connecting behind the command: a moment later the provider is listed and the cache is written', async () => {
    const d = await daemonSandbox(config());
    const first = await d.via([]);
    expect(first.stdout).toMatch(/^slow\s+starting/m);
    await waitFor(async () => /^slow\s+\d+ tools$/m.test((await d.via([])).stdout), DELAY_MS + 8000, 'the slow server to be listed');
    const files = readdirSync(join(d.cacheDir, 'catalog')).filter((n) => /^[0-9a-f]{32}\.json$/.test(n));
    expect(files).toHaveLength(2); // ok and slow; dead has nothing to cache
    const second = await d.via([]);
    expect(second.stdout.split('\n')[0]).toMatch(/ · 1 failed \(dead\)$/);
    expect(second.stdout).not.toContain('starting');
  });

  it('asks the daemon once for a server that is already starting', async () => {
    const d = await daemonSandbox(config());
    await d.via([]);
    await d.via([]);
    const status = (await d.status())!;
    // One session per server, one connection attempt: the second command joined the fetch.
    expect(status.sessions.filter((s) => s.server === 'slow')).toHaveLength(1);
  });

  it('via find: warns about starting and failed providers on separate lines', async () => {
    const d = await daemonSandbox(config());
    const r = await d.via(['find', 'echo']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(r.stderr).toContain('warning: 1 provider still starting: slow (retry in a moment)\n');
    expect(r.stderr).toContain('warning: 1 provider could not be searched: dead (see via, via doctor)\n');
    expect(r.stderr).not.toContain('slow (see via');
  });

  it('via prompt: lists the starting provider like any other', async () => {
    const d = await daemonSandbox(config());
    const r = await d.via(['prompt']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Providers: .*dead.*ok.*slow/s);
  });

  it('--timeout overrides the wait', async () => {
    const d = await daemonSandbox(config(1));
    const r = await d.via(['--timeout', String(DELAY_MS / 1000 + 5)]);
    expect(r.stdout).toMatch(/^slow\s+\d+ tools$/m);
    expect(r.stdout.split('\n')[0]).not.toContain('starting');
  });

  it('via sync waits for the server instead of giving up at the discovery wait', async () => {
    const d = await daemonSandbox(config(1));
    const r = await d.via(['sync', 'slow']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^slow\s+\d+ tools\n$/);
    expect((await d.via([])).stdout).toMatch(/^slow\s+\d+ tools$/m);
  });
});

describe.skipIf(isWindows)('starting and failed, in this process (VIA_NO_DAEMON)', () => {
  const env = { VIA_NO_DAEMON: '1' };
  // Nothing continues after the command, so the wait is the server's `timeout` (capped at 10 s) and the row says what to run.
  const inProcess = `sources: false\nservers:\n${quick('ok')}${slowServer('slow', DELAY_MS, '    timeout: 1\n')}${dead('dead')}`;

  it('marks a server that ran out of time starting, with the command that waits for it', async () => {
    const d = await daemonSandbox(inProcess);
    const r = await d.via([], { env });
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toMatch(/ · 1 starting \(slow\) · 1 failed \(dead\)$/);
    expect(r.stdout).toMatch(/^slow\s+starting · via sync slow$/m);
    expect(r.stdout).toMatch(/^dead\s+failed · cannot run definitely-not-installed-xyz \(ENOENT\)$/m);
    expect(existsSync(d.socket)).toBe(false);
  });

  it('via find says that no daemon keeps connecting', async () => {
    const d = await daemonSandbox(inProcess);
    const r = await d.via(['find', 'echo'], { env });
    expect(r.stderr).toContain('warning: 1 provider still starting: slow (no daemon keeps connecting: via sync slow)\n');
    expect(r.stderr).toContain('warning: 1 provider could not be searched: dead (see via, via doctor)\n');
  });

  it('the command it names works: via sync waits for the whole startup', async () => {
    const d = await daemonSandbox(`sources: false\nservers:\n${slowServer('slow', DELAY_MS)}`);
    const r = await d.via(['sync', 'slow'], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^slow\s+\d+ tools\n$/);
    expect((await d.via([], { env })).stdout).toMatch(/^slow\s+\d+ tools$/m);
  });
});
