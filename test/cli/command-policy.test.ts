// `commands` (ADR 0028): which built-in subcommands may run and which are shown.
import { describe, expect, it } from 'vitest';
import { HELP } from '../../src/cli/help';
import { PROMPT_INSTRUCTIONS } from '../../src/cli/prompt';
import { serveTools } from '../../src/cli/serve';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

async function setup(commands: string) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN, features: ['resources', 'prompts'] });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(`${ghConfig(srv.url)}${commands}`);
  return { srv, sb };
}

describe('commands.deny and commands.allow', () => {
  it('a denied command is refused before anything runs, with exit code 5', async () => {
    const { sb } = await setup('commands:\n  deny: [serve, sync]\n');
    const r = await sb.via(['sync']);
    expect(r.code).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('error: via sync is turned off in the via config (commands.deny)\nnext: via help\n');
    // Its usage too, in any spelling.
    expect((await sb.via(['SYNC', '-h'])).code).toBe(5);
    expect((await sb.via(['help', 'sync'])).code).toBe(5);
    // The rest works.
    expect((await sb.via(['gh'])).code).toBe(0);
  });

  it('-o json gives the refusal as the error envelope', async () => {
    const { sb } = await setup('commands:\n  deny: [find]\n');
    const r = await sb.via(['find', 'issue', '-o', 'json']);
    expect(r.code).toBe(5);
    expect(JSON.parse(r.stderr)).toEqual({ error: { code: 5, message: 'via find is turned off in the via config (commands.deny)', next: 'via help' } });
  });

  it('allow lists the only commands that run; the provider grammar is not a built-in and still works', async () => {
    const { sb } = await setup('commands:\n  allow: [find, call]\n');
    const refused = await sb.via(['servers']);
    expect(refused.code).toBe(5);
    expect(refused.stderr).toContain('via servers is not among the commands the via config allows (commands.allow)');
    expect((await sb.via(['find', 'issue'])).code).toBe(0);
    expect((await sb.via(['gh', 'issue'])).code).toBe(0);
    expect((await sb.via(['help'])).code).toBe(0);
  });

  it('a project config can take commands away but not give them back', async () => {
    const { sb } = await setup('commands:\n  deny: [sync]\n');
    sb.projectConfig('commands:\n  deny: [find]\n  allow: [sync, find, servers]\n');
    expect((await sb.via(['find', 'issue'])).code).toBe(5);
    expect((await sb.via(['sync'])).code).toBe(5);
    expect((await sb.via(['servers'])).code).toBe(0);
    expect((await sb.via(['doctor'])).code).toBe(5);
  });

  it('a misspelt deny stops every command but the ones that show the problem (fail closed)', async () => {
    const { sb } = await setup('commands:\n  deny: [sevre]\n');
    const r = await sb.via(['gh']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: invalid configuration: .*config\.yaml: commands\.deny\[0\]: "sevre" is not a via command/);
    expect(r.stderr).toContain('next: via doctor');
    const servers = await sb.via(['servers']);
    expect(servers.code).toBe(0);
    expect(servers.stdout + servers.stderr).toContain('commands.deny[0]');
  });

  it('a next: hint that names a refused command is left out', async () => {
    const { sb } = await setup('commands:\n  deny: [doctor]\n');
    sb.userConfig('sources: false\nservers:\n  dead:\n    url: http://127.0.0.1:9/mcp\ncommands:\n  deny: [doctor]\n');
    const r = await sb.via(['dead']);
    expect(r.code).toBe(6);
    expect(r.stderr).not.toContain('next: via doctor');
  });
});

describe('commands.hide and commands.show', () => {
  it('help leaves out what is hidden or refused; a hidden command still runs', async () => {
    const { sb } = await setup('commands:\n  hide: [daemon, batch]\n  deny: [serve]\n');
    const help = await sb.via(['-h']);
    expect(help.code).toBe(0);
    expect(help.stdout).not.toMatch(/via (batch|serve)\b/);
    expect(help.stdout).toContain('  find call more servers sync doctor prompt trust auth resources read prompts skills tasks\n');
    expect(help.stdout).toContain('  via find <query>');
    expect((await sb.via(['help'])).stdout).toBe(help.stdout);
    // Asked for by name, a hidden command's usage is shown, and it runs.
    expect((await sb.via(['help', 'daemon'])).stdout).toMatch(/^usage: via daemon/);
    expect((await sb.via(['daemon', 'status'])).code).toBe(0);
  });

  it('without any restriction the help is the fixed text', async () => {
    const { sb } = await setup('');
    expect((await sb.via(['-h'])).stdout).toBe(HELP);
  });

  it('show keeps only the commands it names', async () => {
    const { sb } = await setup('commands:\n  show: [find, more]\n');
    const help = (await sb.via(['-h'])).stdout;
    expect(help).toContain('commands:\n  find more\n');
    expect(help).toContain('  via <provider> <resource>:<verb> [args]');
  });

  it('via prompt does not mention a hidden find or more', async () => {
    const { sb } = await setup('commands:\n  hide: [find, more]\n');
    const r = await sb.via(['prompt']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('via find');
    expect(r.stdout).not.toContain('via more');
    expect(r.stdout).toContain('- Errors print the next command to run.');
    expect(r.stdout).toContain('Never run `via trust` yourself');
    // Unrestricted, the text is the one in agent-integration.md.
    const plain = makeSandbox();
    plain.userConfig('sources: false\n');
    expect((await plain.via(['prompt'])).stdout).toContain(PROMPT_INSTRUCTIONS);
  });

  it('the provider view offers only the commands that are shown', async () => {
    const { sb } = await setup('commands:\n  hide: [resources]\n');
    const r = await sb.via(['gh']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('via resources gh');
    expect(r.stdout).toContain('also: via prompts gh\n');
  });

  it('via serve lists the meta-tools of the commands that are shown', () => {
    const visible = (command: string): boolean => !['call', 'more', 'tasks'].includes(command);
    expect(serveTools(visible).map((t) => t.name)).toEqual(['via_browse', 'via_find', 'via_resources', 'via_read', 'via_prompts', 'via_skills']);
    expect(serveTools().length).toBe(9);
  });
});
