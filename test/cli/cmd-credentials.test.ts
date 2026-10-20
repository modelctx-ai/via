import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, makeSandbox, startFixtureServer, useCleanup } from './helpers';

/** The `cmd:` helper prints the token the fixture server expects, and counts its runs. */
function setup(mode = 'print') {
  const sb = makeSandbox();
  const script = sb.write('helper.mjs', `import { appendFileSync } from 'node:fs';
const [mode, value = ''] = process.argv.slice(2);
appendFileSync(process.env.HELPER_COUNTER, 'x');
if (mode === 'print') process.stdout.write(value + '\\n');
else { process.stdout.write(value); process.stderr.write(value); process.exit(3); }
`);
  const counter = join(sb.root, 'runs');
  const ref = `cmd:'${process.execPath}' '${script}' ${mode} ${FAKE_TOKEN}`;
  const env = { HELPER_COUNTER: counter };
  const runs = (): number => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0);
  return { sb, ref, env, runs };
}

async function server() {
  const srv = await startFixtureServer({ token: FAKE_TOKEN });
  useCleanup(() => srv.close());
  return srv;
}

describe('cmd: credentials', () => {
  it('authenticates a call and the command runs once per process', async () => {
    const srv = await server();
    const { sb, ref, env, runs } = setup();
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: ${JSON.stringify(ref)} }\n`);
    const r = await sb.via(['gh', 'whoami'], { env });
    expect(r.code).toBe(0);
    expect(runs()).toBe(1);
    expect(srv.requests.at(-1)?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    // The server echoes what it saw; the value is replaced in every stream.
    expect(r.stdout).toContain('***');
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
  });

  it('works in headers too', async () => {
    const srv = await server();
    const { sb, ref, env } = setup();
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    headers: { Authorization: "env:AUTH_HEADER" }\n    auth: { headers: { X-Extra: ${JSON.stringify(ref)} } }\n`);
    const r = await sb.via(['gh', 'whoami'], { env: { ...env, AUTH_HEADER: `Bearer ${FAKE_TOKEN}` } });
    expect(r.code).toBe(0);
    expect(srv.requests.at(-1)?.['x-extra']).toBe(FAKE_TOKEN);
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
  });

  it('via servers lists the server without running the command', async () => {
    const srv = await server();
    const { sb, ref, env, runs } = setup();
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: ${JSON.stringify(ref)} }\n`);
    const r = await sb.via(['servers'], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^gh {2}http http:\/\/127\.0\.0\.1:<port>|^gh {2}http http:\/\/127\.0\.0\.1:\d+ {2}bearer {2}/);
    expect(r.stdout).not.toContain('missing');
    expect(runs()).toBe(0);
  });

  it('via doctor runs it (once, however many servers share it) and reports the server usable', async () => {
    const srv = await server();
    const { sb, ref, env, runs } = setup();
    const entry = (name: string): string => `  ${name}:\n    url: ${srv.url}\n    auth: { bearer: ${JSON.stringify(ref)} }\n`;
    sb.userConfig(`sources: false\nservers:\n${entry('one')}${entry('two')}`);
    const r = await sb.via(['doctor'], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/servers {3}2 ok/);
    expect(runs()).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
  });

  it('a failing command is an auth error (exit 4) that shows neither stdout nor stderr', async () => {
    const srv = await server();
    const { sb, ref, env } = setup('fail');
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: ${JSON.stringify(ref)} }\n`);
    for (const argv of [['gh', 'whoami'], ['gh'], ['doctor'], ['sync']]) {
      const r = await sb.via(argv, { env });
      expect(r.code, argv.join(' ')).toBe(argv[0] === 'doctor' || argv[0] === 'sync' ? 4 : 4);
      expect(r.stdout + r.stderr).not.toContain(FAKE_TOKEN);
      expect(r.stdout + r.stderr).toContain('exited with status 3');
    }
    expect(srv.requests).toHaveLength(0);
  });

  it('a missing program is reported by name, exit 4', async () => {
    const srv = await server();
    const sb = makeSandbox();
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: "cmd:via-no-such-helper --flag" }\n`);
    const r = await sb.via(['gh', 'whoami']);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('"via-no-such-helper" was not found');
  });

  it('in the project config it is refused at load: the definition is ignored, nothing runs, and via stops (exit 2)', async () => {
    const srv = await server();
    const { sb, ref, env, runs } = setup();
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n`);
    sb.projectConfig(`servers:\n  gh:\n    auth: { bearer: ${JSON.stringify(ref)} }\n  extra:\n    url: ${srv.url}\n    headers: { X-Key: ${JSON.stringify(ref)} }\n`);
    const call = await sb.via(['gh', 'whoami'], { env });
    expect(call.code).toBe(2);
    expect(call.stderr).toContain('cmd: credential references are only allowed in the user config');
    const doctor = await sb.via(['doctor'], { env });
    expect(doctor.code).toBe(2);
    expect(doctor.stdout).toContain('error: ');
    expect(doctor.stdout).toContain('next: define the server in the user config');
    expect(doctor.stdout).toMatch(/servers {3}1 ok/);
    expect(runs()).toBe(0);
  });

  it('in a project-level framework file it is refused too', async () => {
    const { sb, ref, env, runs } = setup();
    sb.write('project/.mcp.json', JSON.stringify({ mcpServers: { fw: { url: 'https://example.invalid/mcp', headers: { 'X-Key': ref } } } }));
    sb.userConfig('sources: [claude-code]\n');
    const servers = await sb.via(['servers'], { env });
    expect(servers.stdout).toContain('cmd: credential references are only allowed in the user config');
    expect(servers.stdout).not.toMatch(/^fw /m);
    expect(runs()).toBe(0);
  });

  it('a project file that re-points a user server with a cmd: credential needs trust before the command runs', async () => {
    const srv = await server();
    const { sb, ref, env, runs } = setup();
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: ${JSON.stringify(ref)} }\n`);
    sb.projectConfig('servers:\n  gh:\n    url: https://elsewhere.invalid/mcp\n');
    const r = await sb.via(['gh', 'whoami'], { env });
    expect(r.code).toBe(5);
    expect(runs()).toBe(0);
    const shown = await sb.via(['trust'], { env });
    expect(shown.stdout).toContain('auth.bearer: cmd:node …');
    expect(shown.stdout).not.toContain(FAKE_TOKEN);
  });

  it('the command-line value never lands in the cache directory', async () => {
    const srv = await server();
    const { sb, ref, env } = setup();
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n    auth: { bearer: ${JSON.stringify(ref)} }\n`);
    expect((await sb.via(['gh'], { env })).code).toBe(0);
    const { readdirSync, statSync } = await import('node:fs');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    for (const file of walk(sb.home)) {
      if (file.endsWith('config.yaml')) continue;
      expect(readFileSync(file, 'utf8'), file).not.toContain(FAKE_TOKEN);
    }
    writeFileSync(join(sb.root, 'unused'), '');
  });
});
