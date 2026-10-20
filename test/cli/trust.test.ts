import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_STDIO_SERVER, FAKE_TOKEN, makeSandbox, startFixtureServer, useCleanup, type Sandbox } from './helpers';

// Obviously fake; must never show up in any output.
const LITERAL = 'literal-env-value-0001-fake';
const HEADER_LITERAL = 'literal-header-value-0002-fake';
const QUERY_TOKEN = 'query-token-0003-fake';

/** A project-level stdio server that really starts (the fixture MCP server), with env keys of each kind. */
function stdioProject(sb: Sandbox, extra = ''): string {
  sb.projectConfig(
    `sources: false\nservers:\n  job:\n    command: ${JSON.stringify(process.execPath)}\n    args: [${JSON.stringify(CLI_STDIO_SERVER)}]\n    env: { PLAIN: ${JSON.stringify(LITERAL)}, REFERENCED: "env:GH_TOKEN" }\n${extra}`,
  );
  return join(sb.project, '.via.yaml');
}

/** The environment opt-in for non-interactive trust (security.md, "via trust"). */
const ALLOW = { env: { VIA_ALLOW_NONINTERACTIVE_TRUST: '1' } };

function trustStore(sb: Sandbox): string {
  return join(sb.home, '.local', 'share', 'via', 'trust.json');
}

describe('via trust', () => {
  it('an untrusted project server is refused (exit 5) with next: via trust <path>', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    const r = await sb.via(['job']);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain(`next: via trust ${file}`);
  });

  it('shows what would be trusted without values, and refuses to record without a terminal or --yes (exit 5)', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    const r = await sb.via(['trust']);
    expect(r.code).toBe(5);
    expect(r.stdout).toContain(file);
    expect(r.stdout).toContain('not trusted');
    expect(r.stdout).toContain(`job  stdio  ${process.execPath} ${CLI_STDIO_SERVER}`);
    expect(r.stdout).toContain('env: PLAIN=(literal), REFERENCED=env:GH_TOKEN');
    expect(r.stderr).toMatch(/^error: trust was not recorded: confirmation needs a terminal\nnext: ask the user to run this in a terminal: via trust \S+\n$/);
    expect(r.stdout + r.stderr).not.toContain(LITERAL);
    expect(existsSync(trustStore(sb))).toBe(false);
    expect((await sb.via(['job'])).code).toBe(5);
  });

  it('--yes records the file; the server then starts, with the store at 0600', async () => {
    const sb = makeSandbox();
    stdioProject(sb);
    const r = await sb.via(['trust', '.via.yaml', '--yes'], ALLOW);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^· trusted \S+\.via\.yaml · sha256 [0-9a-f]{12} · job\n$/);
    if (process.platform !== 'win32') expect(statSync(trustStore(sb)).mode & 0o777).toBe(0o600);
    const use = await sb.via(['job']);
    expect(use.code).toBe(0);
    expect(use.stdout).toContain('issue');
    expect((await sb.via(['trust'])).stdout).toBe('nothing to trust: the project-level file is already trusted\n');
  });

  it('--yes alone never records: it needs an explicit path and VIA_ALLOW_NONINTERACTIVE_TRUST=1', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    const noPath = await sb.via(['trust', '--yes'], ALLOW);
    expect(noPath.code).toBe(2);
    expect(noPath.stderr).toContain('--yes needs an explicit <path>');
    const noEnv = await sb.via(['trust', file, '--yes']);
    expect(noEnv.code).toBe(5);
    expect(noEnv.stderr).toContain('--yes is disabled unless the user opts in');
    expect(noEnv.stderr).not.toContain('VIA_ALLOW_NONINTERACTIVE_TRUST');
    const wrongValue = await sb.via(['trust', file, '--yes'], { env: { VIA_ALLOW_NONINTERACTIVE_TRUST: '0' } });
    expect(wrongValue.code).toBe(5);
    expect(existsSync(trustStore(sb))).toBe(false);
    expect((await sb.via(['job'])).code).toBe(5);
    expect((await sb.via(['trust', file, '--yes'], ALLOW)).code).toBe(0);
    expect((await sb.via(['job'])).code).toBe(0);
  });

  it('--yes without the opt-in is refused even on a terminal, and no hint suggests it', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    const r = await sb.via(['trust', file, '--yes'], { answer: 'y' });
    expect(r.code).toBe(5);
    expect(r.asked).toEqual([]);
    expect(existsSync(trustStore(sb))).toBe(false);
    const hint = await sb.via(['trust']);
    expect(hint.stderr).not.toContain('--yes');
    expect(hint.stderr).not.toContain('VIA_ALLOW_NONINTERACTIVE_TRUST');
  });

  it('asks on a terminal: y records, anything else does not', async () => {
    const sb = makeSandbox();
    stdioProject(sb);
    const no = await sb.via(['trust'], { answer: 'n' });
    expect(no.code).toBe(5);
    expect(no.asked).toEqual(['trust this file? [y/N] ']);
    expect(no.stderr).toContain('error: trust was not recorded');
    expect((await sb.via(['job'])).code).toBe(5);

    expect((await sb.via(['trust'], { answer: '' })).code).toBe(5);
    const yes = await sb.via(['trust'], { answer: 'Yes' });
    expect(yes.code).toBe(0);
    expect((await sb.via(['job'])).code).toBe(0);
  });

  it('--dry-run shows the same list and records nothing', async () => {
    const sb = makeSandbox();
    stdioProject(sb);
    const r = await sb.via(['trust', '--dry-run', '--yes']); // a dry run records nothing, so --yes needs no opt-in
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('job  stdio');
    expect(r.stderr).toBe('· dry run: nothing was recorded\n');
    expect(existsSync(trustStore(sb))).toBe(false);
  });

  it('a changed file must be trusted again, and says so', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    await sb.via(['trust', '.via.yaml', '--yes'], ALLOW);
    expect((await sb.via(['job'])).code).toBe(0);

    writeFileSync(file, readFileSync(file, 'utf8').replace('REFERENCED', 'SWAPPED'));
    const stale = await sb.via(['job']);
    expect(stale.code).toBe(5);
    expect(stale.stderr).toContain('untrusted project config');
    const again = await sb.via(['trust']);
    expect(again.stdout).toContain('changed since it was trusted');
    expect(again.stdout).toContain('SWAPPED=env:GH_TOKEN');
    expect((await sb.via(['trust', '.via.yaml', '--yes'], ALLOW)).code).toBe(0);
    expect((await sb.via(['job'])).code).toBe(0);
  });

  it('trusts exactly the bytes it showed: a file edited afterwards is untrusted again', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    // The hash comes from the load that produced the list, so an edit made after it cannot be vouched for.
    const { loadConfig, recordTrustHash, userDataDir, pathContext } = await import('../../src/config');
    const config = await loadConfig({ cwd: sb.project, home: sb.home, env: {}, platform: 'linux' });
    const loaded = config.files.find((f) => f.path === file)!;
    writeFileSync(file, `${readFileSync(file, 'utf8')}# edited after the prompt\n`);
    recordTrustHash(userDataDir(pathContext({ home: sb.home, env: {}, platform: 'linux' })), file, loaded.sha256);
    expect((await sb.via(['job'])).code).toBe(5);
  });

  it('takes a path, relative or absolute; a path that is no loaded project file is a usage error', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    const other = sb.write('project/other.yaml', 'servers: {}\n');
    const bad = await sb.via(['trust', other, '--yes'], ALLOW);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('is not a project-level config file loaded from');
    expect((await sb.via(['trust', 'missing.yaml', '--yes'], ALLOW)).code).toBe(2);

    const r = await sb.via(['trust', '.via.yaml', '--yes'], ALLOW);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('· trusted');
    const again = await sb.via(['trust', file]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already trusted');
  });

  it('a file whose servers need no trust is reported, not recorded', async () => {
    const sb = makeSandbox();
    sb.userConfig('sources: false\nservers:\n  web:\n    url: https://example.invalid/mcp\n');
    sb.projectConfig('servers:\n  web:\n    timeout: 5\n');
    const r = await sb.via(['trust', '.via.yaml', '--yes'], ALLOW);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no server definition in this file needs trust');
    expect(existsSync(trustStore(sb))).toBe(false);
    expect((await sb.via(['trust'])).stdout).toBe('no project-level config needs trust\n');
  });

  it('lists HTTP endpoints and header names, hides query strings, userinfo and values', async () => {
    const sb = makeSandbox();
    sb.projectConfig(
      `sources: false\nservers:\n  api:\n    url: "https://user:${HEADER_LITERAL}@api.example.invalid/mcp?token=${QUERY_TOKEN}"\n    headers: { X-Api-Key: ${JSON.stringify(HEADER_LITERAL)}, X-Ref: "keychain:via/api" }\n    auth: { bearer: "env:GH_TOKEN" }\n`,
    );
    const r = await sb.via(['trust']);
    expect(r.stdout).toContain('api  http  https://api.example.invalid/mcp (userinfo and query hidden)');
    expect(r.stdout).toContain('headers: X-Api-Key=(literal), X-Ref=keychain:via/api');
    expect(r.stdout).toContain('auth.bearer: env:GH_TOKEN');
    for (const secret of [HEADER_LITERAL, QUERY_TOKEN, FAKE_TOKEN]) expect(r.stdout + r.stderr).not.toContain(secret);
  });

  it('covers a user-defined server that a project file re-points', async () => {
    const sb = makeSandbox();
    sb.userConfig('sources: false\nservers:\n  api:\n    url: https://api.example.invalid/mcp\n    auth: { bearer: "env:GH_TOKEN" }\n');
    sb.projectConfig('servers:\n  api:\n    url: https://elsewhere.invalid/mcp\n');
    const refused = await sb.via(['api']);
    expect(refused.code).toBe(5);
    const shown = await sb.via(['trust']);
    expect(shown.stdout).toContain('api  http  https://elsewhere.invalid/mcp');
    expect(shown.stdout).toContain('auth.bearer: env:GH_TOKEN');
  });

  it('shows a project-level framework file (.mcp.json) and trusts it by its own hash', async () => {
    const sb = makeSandbox();
    const file = sb.write('project/.mcp.json', JSON.stringify({ mcpServers: { fw: { command: process.execPath, args: [CLI_STDIO_SERVER] } } }));
    sb.userConfig('sources: [claude-code]\n');
    const r = await sb.via(['trust', '.mcp.json', '--yes'], ALLOW);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`· trusted ${file}`);
    expect((await sb.via(['fw'])).code).toBe(0);
  });

  it('writes a hostile command line in a form that cannot forge the display', async () => {
    const sb = makeSandbox();
    sb.projectConfig('servers:\n  evil:\n    command: "sh"\n    args: ["-c", "echo ok\\n\\u001b[2Jtrusted: yes", "a b"]\n');
    const r = await sb.via(['trust']);
    expect(r.stdout).not.toContain('\u001b');
    expect(r.stdout).toContain('evil  stdio  sh -c "echo ok\\n\\u001b[2Jtrusted: yes" "a b"');
    expect(r.stdout.split('\n').filter((l) => l.startsWith('trusted'))).toEqual([]);
  });

  it('lists and revokes records', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    expect((await sb.via(['trust', '--list'])).stdout).toBe('no trust records\n');
    await sb.via(['trust', '.via.yaml', '--yes'], ALLOW);
    const listed = await sb.via(['trust', '--list']);
    expect(listed.stdout).toMatch(/^trusted {2}\S+\.via\.yaml {2}[0-9a-f]{12} {2}\d{4}-\d\d-\d\d\n$/);

    writeFileSync(file, `${readFileSync(file, 'utf8')}# edit\n`);
    expect((await sb.via(['trust', '--list'])).stdout).toMatch(/^changed /);

    const revoked = await sb.via(['trust', '--revoke', '.via.yaml']);
    expect(revoked.code).toBe(0);
    expect(revoked.stderr).toMatch(/^· revoked \S+\.via\.yaml\n$/);
    const missing = await sb.via(['trust', '--revoke', '.via.yaml']);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain('next: via trust --list');
    expect((await sb.via(['trust', '--list'])).stdout).toBe('no trust records\n');
  });

  it('usage errors: --list with a path, --revoke without one, both together, extra paths', async () => {
    const sb = makeSandbox();
    for (const argv of [['trust', '--list', 'x'], ['trust', '--revoke'], ['trust', '--list', '--revoke'], ['trust', 'a', 'b'], ['trust', '--nope']]) {
      const r = await sb.via(argv);
      expect(r.code, argv.join(' ')).toBe(2);
    }
    const help = await sb.via(['trust', '-h']);
    expect(help.stdout).toContain('usage: via trust');
  });

  it('a corrupt trust store trusts nothing, warns, and can be replaced', async () => {
    const sb = makeSandbox();
    stdioProject(sb);
    sb.write('home/.local/share/via/trust.json', '{ not json');
    const r = await sb.via(['trust']);
    expect(r.stderr).toContain('warning:');
    expect(r.stdout).toContain('not trusted');
    expect((await sb.via(['trust', '.via.yaml', '--yes'], ALLOW)).code).toBe(0);
    expect((await sb.via(['job'])).code).toBe(0);
  });

  it('via servers and via doctor point at via trust', async () => {
    const sb = makeSandbox();
    const file = stdioProject(sb);
    const servers = await sb.via(['servers']);
    expect(servers.stdout).toContain(`untrusted (via trust ${file})`);
    const doctor = await sb.via(['doctor']);
    expect(doctor.code).toBe(5);
    expect(doctor.stdout).toContain(`next: via trust ${file}`);
  });

  it('quotes a path with spaces in the next: hint', async () => {
    const sb = makeSandbox();
    const dir = join(sb.root, 'my project');
    sb.write('my project/.via.yaml', 'servers:\n  job:\n    command: node\n');
    const r = await sb.via(['job'], { cwd: dir });
    expect(r.code).toBe(5);
    expect(r.stderr).toContain(`next: via trust '${join(dir, '.via.yaml')}'`);
  });

  it('works with a project HTTP server end to end', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    useCleanup(() => srv.close());
    const sb = makeSandbox();
    sb.projectConfig(`sources: false\nservers:\n  web:\n    url: ${srv.url}\n    auth: { bearer: "env:GH_TOKEN" }\n`);
    expect((await sb.via(['web'])).code).toBe(5);
    expect(srv.requests).toHaveLength(0);
    expect((await sb.via(['trust', '.via.yaml', '--yes'], ALLOW)).code).toBe(0);
    expect((await sb.via(['web'])).code).toBe(0);
  });
});
