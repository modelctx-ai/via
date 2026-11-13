// `via servers add` (cli.md, "via servers add"; ADR 0032): the one command that writes the via
// config. A person at a terminal confirms what is written; a secret never is.
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_TOKEN, makeSandbox, startFixtureServer, useCleanup } from './helpers';

const configOf = (sb: { home: string }): string => join(sb.home, '.config', 'via', 'config.yaml');
const HTTP = ['servers', 'add', 'github', 'https://api.example.test/mcp/', '--bearer', 'env:GITHUB_TOKEN'];

describe('via servers add: what is written', () => {
  it('shows the lines, asks, writes a new file and says what to run next', async () => {
    const sb = makeSandbox();
    const r = await sb.via(HTTP, { answer: 'y' });
    expect(r.code).toBe(0);
    expect(r.asked).toEqual(['add this server to ~/.config/via/config.yaml? [y/N] ']);
    expect(r.stdout).toBe(
      ['~/.config/via/config.yaml  (new file)', '+ servers:', '+   github:', '+     url: https://api.example.test/mcp/', '+     auth:', '+       bearer: env:GITHUB_TOKEN', '→ via github to see its tools', ''].join('\n'),
    );
    expect(r.stderr).toBe('· added github to ~/.config/via/config.yaml\n');
    expect(readFileSync(configOf(sb), 'utf8')).toBe('servers:\n  github:\n    url: https://api.example.test/mcp/\n    auth:\n      bearer: env:GITHUB_TOKEN\n');
    if (process.platform !== 'win32') expect(statSync(configOf(sb)).mode & 0o777).toBe(0o600);
    // and the server is there for the next command
    expect((await sb.via(['servers'])).stdout).toMatch(/^github\s+http https:\/\/api\.example\.test\s/);
  });

  it('keeps what the file already has: other servers, other keys, comments and its mode', async () => {
    const sb = makeSandbox();
    const before = '# my servers\nsources: false\nservers:\n  linear: # tracker\n    url: https://linear.example.test/mcp\n    auth: oauth\ndeny: ["^linear/.*:delete$"]\n';
    sb.userConfig(before);
    const r = await sb.via(['servers', 'add', 'docs', 'https://docs.example.test/mcp', '--oauth', '--header', 'X-Org=acme'], { answer: 'yes' });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('(new file)');
    expect(r.stdout).toContain('→ via auth login docs to sign in\n');
    expect(readFileSync(configOf(sb), 'utf8')).toBe(
      '# my servers\nsources: false\nservers:\n  linear: # tracker\n    url: https://linear.example.test/mcp\n    auth: oauth\n  docs:\n    url: https://docs.example.test/mcp\n    auth: oauth\n    headers:\n      X-Org: acme\ndeny: ["^linear/.*:delete$"]\n',
    );
    expect((await sb.via(['servers'])).stdout).toMatch(/^linear .*\ndocs /);
  });

  it('puts the entry where the servers block ends and leaves every other byte alone', async () => {
    const ADDED = (indent: string): string => `${indent}docs:\n${indent}  url: https://docs.example.test/mcp\n`;
    const cases: Array<[label: string, before: string, after: string]> = [
      ['no trailing newline', 'sources: false\nservers:\n  a:\n    url: https://a.test/mcp', `sources: false\nservers:\n  a:\n    url: https://a.test/mcp\n${ADDED('  ')}`],
      ['four spaces', 'sources: false\nservers:\n    a:\n        url: https://a.test/mcp\n', `sources: false\nservers:\n    a:\n        url: https://a.test/mcp\n${ADDED('    ')}`],
      [
        'a comment and another section after the block',
        'sources: false\nservers:\n  a:\n    url: https://a.test/mcp  # here\n\n# what the agent must not touch\ndeny: [ "^a/.*:delete$" ]\n',
        `sources: false\nservers:\n  a:\n    url: https://a.test/mcp  # here\n${ADDED('  ')}\n# what the agent must not touch\ndeny: [ "^a/.*:delete$" ]\n`,
      ],
      [
        'a last entry that ends in a nested list',
        'sources: false\nservers:\n  a:\n    command: npx\n    args:\n      - x\n      - y\n# end\n',
        `sources: false\nservers:\n  a:\n    command: npx\n    args:\n      - x\n      - y\n${ADDED('  ')}# end\n`,
      ],
      ['no servers key', '# only settings\nsources: false\n', '# only settings\nsources: false\nservers:\n  docs:\n    url: https://docs.example.test/mcp\n'],
      ['comments only', '# nothing yet\n', '# nothing yet\nservers:\n  docs:\n    url: https://docs.example.test/mcp\n'],
    ];
    for (const [label, before, after] of cases) {
      const sb = makeSandbox();
      sb.userConfig(before);
      const r = await sb.via(['servers', 'add', 'docs', 'https://docs.example.test/mcp'], { answer: 'y' });
      expect(r.code, label).toBe(0);
      expect(readFileSync(configOf(sb), 'utf8'), label).toBe(after);
    }
  });

  it('writes the document out again where the text has no place for the entry, and it still holds the same', async () => {
    const { parse } = await import('yaml');
    for (const before of ['sources: false\nservers:\n', 'sources: false\nservers: {}\n', 'sources: false\nservers: { a: { url: "https://a.test/mcp" } } # inline\n']) {
      const sb = makeSandbox();
      sb.userConfig(before);
      const r = await sb.via(['servers', 'add', 'docs', 'https://docs.example.test/mcp'], { answer: 'y' });
      expect(r.code, before).toBe(0);
      const was = parse(before) as { servers?: Record<string, unknown> | null };
      expect(parse(readFileSync(configOf(sb), 'utf8')), before).toEqual({ ...was, servers: { ...(was.servers ?? {}), docs: { url: 'https://docs.example.test/mcp' } } });
    }
  });

  it('adds a stdio server: everything after -- is its command line, word for word', async () => {
    const sb = makeSandbox();
    sb.userConfig('sources: false\n');
    // -y, --yes, -h and -o are the command's own: via takes none of them
    const r = await sb.via(['servers', 'add', 'fs', '--env', 'LOG_LEVEL=debug', '--env', 'FS_TOKEN=keychain:via/fs', '--', 'npx', '-y', '@scope/server', '--yes', '-h', '-o', 'json', '--', '/tmp/a b'], { answer: 'y' });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/^usage:/);
    const written = readFileSync(configOf(sb), 'utf8');
    expect(written).toBe(
      'sources: false\nservers:\n  fs:\n    command: npx\n    args:\n      - -y\n      - "@scope/server"\n      - --yes\n      - -h\n      - -o\n      - json\n      - --\n      - /tmp/a b\n    env:\n      LOG_LEVEL: debug\n      FS_TOKEN: keychain:via/fs\n',
    );
    expect((await sb.via(['servers'])).stdout).toMatch(/^fs\s+stdio npx\s/);
  });

  it('writes through a symbolic link instead of replacing it', async () => {
    if (process.platform === 'win32') return;
    const sb = makeSandbox();
    const real = sb.write('dotfiles/via.yaml', 'sources: false\n');
    mkdirSync(join(sb.home, '.config', 'via'), { recursive: true });
    symlinkSync(real, configOf(sb));
    const r = await sb.via(HTTP, { answer: 'y' });
    expect(r.code).toBe(0);
    expect(readFileSync(real, 'utf8')).toContain('  github:\n    url: https://api.example.test/mcp/\n');
    expect(readFileSync(configOf(sb), 'utf8')).toBe(readFileSync(real, 'utf8'));
  });

  it('--dry-run shows the lines and writes nothing, with or without a terminal', async () => {
    const sb = makeSandbox();
    const r = await sb.via([...HTTP, '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('+   github:\n');
    expect(r.stderr).toBe('· dry run: nothing was written\n');
    expect(existsSync(configOf(sb))).toBe(false);
  });
});

describe('via servers add: who may confirm', () => {
  it('is refused without a terminal, --yes or not, and tells the agent to ask the user', async () => {
    const sb = makeSandbox();
    for (const argv of [HTTP, [...HTTP, '--yes']]) {
      const r = await sb.via(argv);
      expect(r.code).toBe(5);
      expect(r.stderr).toBe(
        'error: the server was not added: confirmation needs a terminal\nnext: ask the user to run this in a terminal: via servers add github https://api.example.test/mcp/ --bearer env:GITHUB_TOKEN\n',
      );
      expect(existsSync(configOf(sb))).toBe(false);
    }
  });

  it('writes nothing when the answer is not yes', async () => {
    const sb = makeSandbox();
    for (const answer of ['n', '', 'maybe']) {
      const r = await sb.via(HTTP, { answer });
      expect(r.code).toBe(5);
      expect(r.stderr).toContain('error: the server was not added\n');
      expect(existsSync(configOf(sb))).toBe(false);
    }
  });

  it('is refused inside the sandbox, where the via configuration is read-only', async () => {
    const sb = makeSandbox();
    const r = await sb.via(HTTP, { answer: 'y', env: { VIA_SANDBOXED: '1' } });
    expect(r.code).toBe(5);
    expect(r.asked).toEqual([]);
    expect(r.stderr).toContain('error: the server was not added: via runs in its sandbox, which keeps the via configuration read-only\nnext: ask the user: run it outside the sandbox');
    expect(existsSync(configOf(sb))).toBe(false);
  });
});

describe('via servers add: what is refused', () => {
  const SECRET = 'ghp_ThisIsATokenThatMustNotAppear0123';

  it('never writes or repeats a secret given in place of a reference', async () => {
    const sb = makeSandbox();
    const cases: string[][] = [
      ['servers', 'add', 'gh', 'https://api.example.test/mcp', '--bearer', SECRET],
      ['servers', 'add', 'gh', 'https://api.example.test/mcp', `--bearer=${SECRET}`],
      ['servers', 'add', 'gh', 'https://api.example.test/mcp', '--header', `X-Api-Key=${SECRET}`],
      ['servers', 'add', 'gh', `https://api.example.test/mcp?api_key=${SECRET}`],
      ['servers', 'add', 'gh', `https://user:${SECRET}@api.example.test/mcp`],
      ['servers', 'add', 'gh', '--env', `GITHUB_TOKEN=${SECRET}`, '--', 'npx', 'server'],
    ];
    for (const argv of cases) {
      const r = await sb.via(argv, { answer: 'y' });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.asked).toEqual([]);
      expect(r.stdout + r.stderr).not.toContain(SECRET);
      expect(r.stderr).toMatch(/reference|do not go into the URL|does not go into the config/);
      expect(existsSync(configOf(sb))).toBe(false);
    }
    // a reference under the same names is what is asked for; a plain value under a plain name is fine
    const ok = await sb.via(['servers', 'add', 'gh', 'https://api.example.test/mcp', '--header', 'X-Api-Key=env:GH_KEY', '--header', 'X-Org=acme', '--dry-run']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('+       X-Api-Key: env:GH_KEY\n+       X-Org: acme\n');
  });

  it('refuses a name that is taken, wherever the server is defined, and a name of a via command', async () => {
    const srv = await startFixtureServer({ token: FAKE_TOKEN });
    useCleanup(() => srv.close());
    const sb = makeSandbox();
    sb.userConfig(`sources: false\nservers:\n  gh:\n    url: ${srv.url}\n  off:\n    url: ${srv.url}\n    disabled: true\n`);
    const before = readFileSync(configOf(sb), 'utf8');
    for (const name of ['gh', 'GH', 'off']) {
      const r = await sb.via(['servers', 'add', name, 'https://other.example.test/mcp'], { answer: 'y' });
      expect(r.code, name).toBe(2);
      expect(r.stderr).toMatch(/is already (defined in|in) ~\/\.config\/via\/config\.yaml/);
      expect(r.asked).toEqual([]);
    }
    for (const name of ['find', 'Servers', 'help']) {
      const r = await sb.via(['servers', 'add', name, 'https://other.example.test/mcp'], { answer: 'y' });
      expect(r.code, name).toBe(2);
      expect(r.stderr).toContain(`${name} is the name of a via command; choose another name`);
    }
    expect(readFileSync(configOf(sb), 'utf8')).toBe(before);
  });

  it('refuses what is not a usable definition, with the usage', async () => {
    const sb = makeSandbox();
    const cases: Array<[string[], RegExp]> = [
      [['servers', 'add'], /a name is required/],
      [['servers', 'add', 'x'], /a URL, or a command after --, is required/],
      [['servers', 'add', 'x', 'not a url'], /the URL does not parse/],
      [['servers', 'add', 'x', 'ftp://example.test/'], /the URL must be http or https/],
      [['servers', 'add', 'x', 'https://a.test/mcp', '--'], /a command is required after --/],
      [['servers', 'add', 'x', 'https://a.test/mcp', '--', 'npx', 's'], /give a URL or a command after --, not both/],
      [['servers', 'add', 'x', 'https://a.test/mcp', 'extra'], /unexpected argument "extra"/],
      [['servers', 'add', 'x', 'https://a.test/mcp', '--bearer', 'env:A', '--oauth'], /--bearer and --oauth cannot be combined/],
      [['servers', 'add', 'x', 'https://a.test/mcp', '--env', 'A=b'], /--env is for a command/],
      [['servers', 'add', 'x', '--oauth', '--', 'npx', 's'], /are for an HTTP server/],
      [['servers', 'add', 'x', 'https://a.test/mcp', '--bogus'], /unknown option --bogus/],
      [['servers', 'add', 'x', 'https://a.test/mcp', '--header', 'novalue'], /--header needs <name>=<value>/],
      [['servers', 'add', 'bad name', 'https://a.test/mcp'], /the name may hold letters, digits/],
    ];
    for (const [argv, message] of cases) {
      const r = await sb.via(argv, { answer: 'y' });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(r.stderr).toContain('usage: via servers add <name> <url>');
      expect(r.asked).toEqual([]);
    }
    expect(existsSync(configOf(sb))).toBe(false);
  });

  it('leaves a file it cannot read as a mapping untouched', async () => {
    const sb = makeSandbox();
    for (const broken of ['servers: [unclosed\n', '- a\n- b\n', 'servers: nope\n']) {
      writeFileSync(sb.write('.keep', ''), '');
      sb.userConfig(broken);
      const r = await sb.via(['servers', 'add', 'x', 'https://a.test/mcp'], { answer: 'y' });
      expect(r.code, broken).toBe(2);
      expect(r.stderr).toMatch(/nothing was written/);
      expect(r.asked).toEqual([]);
      expect(readFileSync(configOf(sb), 'utf8')).toBe(broken);
    }
  });
});

describe('via servers', () => {
  it('still takes no other argument, and its usage shows add', async () => {
    const sb = makeSandbox();
    const r = await sb.via(['servers', 'remove', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('via servers takes no arguments (to add a server: via servers add <name> <url>)');
    expect((await sb.via(['servers', '-h'])).stdout).toContain('via servers add <name> [--env <KEY>=<value>]… -- <command> [args…]');
    // `--` passes through only for `servers add`: elsewhere options after it are still via's
    expect((await sb.via(['find', 'x', '--', '-h'])).stdout).toMatch(/^usage: via find/);
  });
});
