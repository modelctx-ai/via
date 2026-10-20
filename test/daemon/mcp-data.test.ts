// Resources, prompts and roots through a real daemon (a spawned child, as in production), and the
// session-key rules for roots (ADR 0010; daemon.md).
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { effectiveServer, sessionKey } from '../../src/daemon/target';
import { CLI_STDIO_SERVER, FAKE_TOKEN } from '../cli/helpers';
import { stdioServer } from '../helpers/client';
import { alive, daemonSandbox, waitFor } from '../helpers/daemon';

const sandbox = (yaml: string) => daemonSandbox(yaml, { GH_TOKEN: FAKE_TOKEN });

const config = (extra = '', features = 'resources,prompts,roots') =>
  `sources: false\nservers:\n  fs:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_FEATURES: "${features}", FIXTURE_SECRET: "env:GH_TOKEN" }\n${extra}`;

describe('resources and prompts through the daemon', () => {
  it('serves list, read, prompts and get from one session, with the same output as in-process', async () => {
    const d = await sandbox(config());
    const list = await d.via(['resources', 'fs']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('file:///project/README.md');
    expect(list.stdout).toContain('file:///project/logs/{date}.log');

    const read = await d.via(['read', 'fs', 'file:///project/README.md']);
    expect(read.stdout).toBe('# Project\nHello from the readme.\n');
    const prompts = await d.via(['prompts', 'fs']);
    expect(prompts.stdout).toContain('review      code, [lang]  Review a piece of code');
    const got = await d.via(['prompts', 'fs', 'review', '--code', 'x']);
    expect(got.stdout).toBe('[user]\nPlease review this code:\nx\n');

    const status = (await d.status())!;
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({ server: 'fs', connected: true });

    const inProcess = await d.via(['read', 'fs', 'file:///project/README.md'], { env: { VIA_NO_DAEMON: '1' } });
    expect(inProcess.stdout).toBe(read.stdout);
  });

  it('redacts credentials in what the daemon returns, and sends none over the socket', async () => {
    const d = await sandbox(config());
    const r = await d.via(['read', 'fs', 'file:///project/credentials.txt']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('authorization: ***\n');
    expect(r.combined).not.toContain(FAKE_TOKEN);
  });

  it('keeps the full text of a truncated read in the daemon for via more', async () => {
    const d = await sandbox(config());
    const first = await d.via(['read', 'fs', 'file:///project/big.txt']);
    const cursor = /next: via more ([0-9a-f]+)/.exec(first.stderr)?.[1];
    expect(cursor).toBeDefined();
    const more = await d.via(['more', cursor!]);
    expect(more.code).toBe(0);
    expect(more.stdout).toMatch(/^line \d+ of the long text\n/);
  });

  it('reports a missing capability and an unknown URI with exit code 3', async () => {
    const d = await sandbox(config('', 'prompts'));
    const none = await d.via(['resources', 'fs']);
    expect(none.code).toBe(3);
    expect(none.stderr).toBe('error: fs does not offer MCP resources\nnext: via fs\n');

    const d2 = await sandbox(config());
    const unknown = await d2.via(['read', 'fs', 'file:///project/missing.txt']);
    expect(unknown.code).toBe(3);
    expect(unknown.stderr).toContain('error: no such resource: file:///project/missing.txt');
    expect(unknown.stderr).toContain('next: via resources fs');
    expect(await d2.via(['prompts', 'fs', 'review', '--no-validate'])).toMatchObject({ code: 1 });
  });

  it('shows what the server offers in the provider view, from the daemon and from the cache', async () => {
    const d = await sandbox(config());
    const first = await d.via(['fs']);
    expect(first.stdout).toContain('also: via resources fs · via prompts fs');
    const second = await d.via(['fs']);
    expect(second.stdout).toContain('also: via resources fs · via prompts fs');
    const cold = await d.via(['fs'], { env: { VIA_NO_DAEMON: '1' } });
    expect(cold.stdout).toContain('also: via resources fs · via prompts fs');
  });

  it('runs the request itself and says so when the daemon cannot be started', async () => {
    const d = await sandbox(config());
    const r = await d.via(['read', 'fs', 'file:///project/README.md'], { daemonCommand: { command: '/nonexistent/via-node', args: [] } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('# Project\nHello from the readme.\n');
    expect(r.stderr).toMatch(/^warning: cannot start the via daemon: ENOENT; continuing without the daemon/);
    const roots = await d.via(['fs', 'list-roots'], { daemonCommand: { command: '/nonexistent/via-node', args: [] } });
    expect(roots.stdout).toContain('did not declare');
  });

  it('refuses a server from an untrusted project file before anything is sent', async () => {
    const d = await sandbox('sources: false\n');
    d.sb.projectConfig(`servers:\n  fs:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { CLI_FIXTURE_FEATURES: "resources" }\n`);
    for (const argv of [['resources', 'fs'], ['read', 'fs', 'file:///x'], ['prompts', 'fs']]) {
      const r = await d.via(argv);
      expect(r.code).toBe(5);
      expect(r.stderr).toContain('untrusted project config');
    }
    expect((await d.status())?.sessions ?? []).toHaveLength(0);
  });
});

describe('roots through the daemon', () => {
  it('gives each working directory a session of its own, never the roots of another directory', async () => {
    const d = await sandbox(config('    roots: ["."]\n'));
    const a = d.sb.project;
    const b = dirname(d.sb.write('other/.keep', ''));
    const ask = (cwd: string) => d.via(['fs', 'list-roots'], { cwd });
    const first = await ask(a);
    expect(first.stdout).toContain(pathToFileURL(a).href);
    const pidA = (await d.status())!.sessions[0]!.pid!;

    const second = await ask(b);
    expect(second.stdout).toContain(pathToFileURL(b).href);
    expect(second.stdout).not.toContain(pathToFileURL(a).href);
    await waitFor(() => !alive(pidA), 3000, 'the session of the first directory to be replaced');
    expect((await d.status())!.sessions).toHaveLength(1);
  });

  it('shares one session between directories when neither roots nor cwd depend on them', async () => {
    const d = await sandbox(config(`    cwd: ${JSON.stringify(tmpdir())}\n    roots: ["/shared/place"]\n`));
    const b = dirname(d.sb.write('other/.keep', ''));
    const first = await d.via(['fs', 'list-roots']);
    const pid = (await d.status())!.sessions[0]!.pid;
    const second = await d.via(['fs', 'list-roots'], { cwd: b });
    expect(second.stdout).toBe(first.stdout);
    expect((await d.status())!.sessions[0]!.pid).toBe(pid);
  });

  it('declares nothing without roots', async () => {
    const d = await sandbox(config());
    const r = await d.via(['fs', 'list-roots']);
    expect(r.stdout).toBe('roots: the client did not declare the capability\n');
  });
});

describe('the session key', () => {
  it('turns relative roots into absolute URIs and tells directories apart only when roots need them', () => {
    const relative = stdioServer({ roots: ['.', '~/notes', '/abs', 'file:///already'] });
    const here = effectiveServer(relative, '/work/a', '/home/u');
    expect(here.roots).toEqual([pathToFileURL('/work/a').href, pathToFileURL('/home/u/notes').href, pathToFileURL('/abs').href, 'file:///already']);
    expect(effectiveServer(here, '/elsewhere', '/home/u').roots).toEqual(here.roots);
    // A different directory is a different session (stdio servers also get the directory as `cwd`)...
    expect(sessionKey(effectiveServer(relative, '/work/b', '/home/u'))).not.toBe(sessionKey(here));
    // ...but a roots-only difference counts too, for servers with a fixed `cwd`.
    const fixed = (roots: string[]) => effectiveServer(stdioServer({ transport: { type: 'stdio', command: 'x', args: [], env: {}, cwd: '/fixed' }, roots }), '/work/a', '/home/u');
    expect(sessionKey(fixed(['.']))).not.toBe(sessionKey(effectiveServer(stdioServer({ transport: { type: 'stdio', command: 'x', args: [], env: {}, cwd: '/fixed' }, roots: ['.'] }), '/work/b', '/home/u')));
    expect(sessionKey(fixed(['/x']))).not.toBe(sessionKey(fixed([])));
    expect(sessionKey(fixed(['/x']))).toBe(sessionKey(fixed(['/x'])));
  });
});
