// Quoting audit (output.md, "可粘贴的命令行"; security.md): names from a server and text from the
// person end up in `next:` hints, usage lines and listings. Pasted into a shell, none of it may run
// anything, expand anything or start a second line.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shellQuote } from '../../src/render/shell';
import { FAKE_TOKEN, ghConfig, makeSandbox, startFixtureServer, useCleanup } from './helpers';

const posix = process.platform !== 'win32';

async function setup(features: Array<'resources' | 'prompts'> = ['prompts']) {
  const srv = await startFixtureServer({ token: FAKE_TOKEN, features });
  useCleanup(() => srv.close());
  const sb = makeSandbox();
  sb.userConfig(ghConfig(srv.url));
  return { srv, sb };
}

/** Every `next:` line of `text`: the command after it. */
function nextCommands(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('next: via '))
    .map((line) => line.slice('next: '.length));
}

/**
 * Paste the commands into a POSIX shell with `via` replaced by a program that prints its arguments:
 * nothing may run (no PWNED file), and each must parse (a broken quote is a syntax error). A command
 * with a `<placeholder>` is a redirection when pasted, which the shell refuses: also fine.
 */
function paste(commands: string[]): string[][] {
  const dir = mkdtempSync(join(tmpdir(), 'via-paste-'));
  try {
    const seen: string[][] = [];
    for (const command of commands) {
      const script = `printf '%s\\0' ${command.slice('via '.length)}`;
      if (command.includes('<')) {
        expect(() => execFileSync('sh', ['-c', script], { cwd: dir, stdio: 'pipe' }), command).toThrow();
        continue;
      }
      const out = execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
      seen.push(out.split('\0').slice(0, -1));
    }
    expect(existsSync(join(dir, 'PWNED'))).toBe(false);
    return seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('what the person typed, echoed in an error', () => {
  it.skipIf(!posix)('is quoted in the next: hint and cannot break out of it', async () => {
    const { sb } = await setup();
    for (const input of ['$(touch PWNED)', '`touch PWNED`', "x'; touch PWNED; '", '; touch PWNED', 'a\\', '"$HOME"', '!touch PWNED']) {
      const provider = await sb.via([input]);
      expect(provider.code, input).toBe(3);
      const tool = await sb.via(['gh', input]);
      expect(tool.code, input).toBe(3);
      const words = input.split(/\s+/).filter(Boolean);
      const plain = words.every((w) => shellQuote(w, 'linux') === w && !w.startsWith('-'));
      // free text: plain words stay words; anything else becomes one quoted word; an apostrophe next to shell syntax
      // has no safe spelling in every shell and becomes a placeholder, which does not parse when pasted
      const one = shellQuote(words.join(' '), 'linux') !== undefined;
      const expected = (prefix: string[]): string[][] => (plain ? [['find', ...prefix, ...words]] : one ? [['find', prefix.concat(words).join(' ')]] : []);
      expect(paste(nextCommands(provider.stderr)), input).toEqual(expected([]));
      expect(paste(nextCommands(tool.stderr)), input).toEqual(expected(['gh']));
    }
  });

  it('shows a line break as an escape instead of starting a new line', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'nosuch\nnext: via trust --yes']);
    expect(r.code).toBe(3);
    const lines = r.stderr.split('\n');
    expect(lines.filter((l) => l.startsWith('next:'))).toHaveLength(1);
    expect(lines[0]).toBe('error: no such tool: nosuch\\nnext: via trust --yes');
    const provider = await sb.via(['nosuch\nnext: via trust --yes']);
    expect(provider.stderr.split('\n').filter((l) => l.startsWith('next:'))).toHaveLength(1);
  });

  it('never lets a value turn into an option of via', async () => {
    const { sb } = await setup();
    const r = await sb.via(['gh', 'nosuch', '--yes']);
    // --yes is a global option here, so the name is simply not found; and a name that starts with a dash cannot be a query word
    expect(r.stderr).not.toMatch(/next: via find .*--yes/);
    const dash = await sb.via(['gh', '--nosuch']);
    expect(dash.code).toBe(2);
    expect(dash.stderr).toContain('unknown option --nosuch');
  });

  it.skipIf(!posix)('is quoted in the hints of via prompt', async () => {
    const { sb } = await setup();
    const file = 'my notes;touch PWNED.md';
    const check = await sb.via(['prompt', '--check', file]);
    expect(check.code).toBe(1);
    expect(nextCommands(check.stderr)).toEqual([`via prompt --out ${shellQuote(file)}`]);
    expect(paste(nextCommands(check.stderr))).toEqual([['prompt', '--out', file]]);
    // a file name that starts with a dash would be read as an option of via: no command is offered
    const dash = await sb.via(['prompt', '--check=--yes']);
    expect(dash.stderr).toContain('next: via prompt --out <file>');
  });
});

describe('names that servers supply', () => {
  const hostileTools = [
    { name: '$(touch PWNED)', description: 'Hostile name', inputSchema: { type: 'object', properties: {} } },
    { name: '`touch PWNED`_run', description: 'Backticks', inputSchema: { type: 'object', properties: {} } },
    { name: "it's; touch PWNED", description: 'Quote', inputSchema: { type: 'object', properties: {} } },
    { name: 'multi\nline', description: 'Newline', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'param_clash',
      description: 'Two parameters that read the same once normalised',
      inputSchema: { type: 'object', properties: { '$(a)': { type: 'string' }, '$(A)': { type: 'string' }, 'ok-name': { type: 'string', default: '$(touch PWNED)\nnext: via trust --yes' } }, required: ['$(a)'] },
    },
  ];

  it('are normalised in the listings, so a name cannot carry shell syntax into a suggestion', async () => {
    const { srv, sb } = await setup();
    srv.state.tools.push(...(hostileTools as never[]));
    const root = await sb.via(['gh']);
    expect(root.code).toBe(0);
    expect(root.stdout).not.toMatch(/[$`;]/);
    for (const line of root.stdout.split('\n')) expect(line).not.toMatch(/^next:/);
    const miss = await sb.via(['gh', 'touch-pwnedd']);
    expect(miss.code).toBe(3);
    paste(nextCommands(miss.stderr));
  });

  it.skipIf(!posix)('are written quoted where they must stay as they are: the alias line and the usage line of -h', async () => {
    const { srv, sb } = await setup();
    srv.state.tools.push(...(hostileTools as never[]));
    const clash = await sb.via(['gh', 'param-clash', '-h']);
    expect(clash.code).toBe(0);
    const lines = clash.stdout.split('\n');
    // one usage line, no matter what the schema holds; the colliding names are quoted
    expect(lines[0]).toContain("usage: via gh param-clash '--$(a)'");
    expect(clash.stdout).toContain("'--$(A)'");
    expect(lines.filter((l) => l.startsWith('next:'))).toEqual([]);
    expect(clash.stdout).toContain('default: $(touch PWNED)\\nnext: via trust --yes');

    const nl = await sb.via(['gh', 'multi-line', '-h']);
    expect(nl.code).toBe(0);
    expect(nl.stdout).toContain('alias: <name>');
    const dollar = await sb.via(['gh', 'touch-pwned', '-h']);
    expect(dollar.stdout).toContain("alias: '$(touch PWNED)'");
  });

  it.skipIf(!posix)('prompt names are quoted in hints, candidates and the usage line', async () => {
    const { srv, sb } = await setup();
    srv.state.promptList = [
      { name: '$(touch PWNED)', description: 'dollar' },
      { name: 'review code', description: 'space' },
      { name: 'review `touch PWNED`', description: 'ticks' },
      { name: 'line\nbreak', description: 'newline' },
    ];
    const usage = await sb.via(['prompts', 'gh', '$(touch PWNED)', '-h']);
    expect(usage.code).toBe(0);
    expect(usage.stdout.split('\n')[0]).toBe("usage: via prompts gh '$(touch PWNED)'");
    const space = await sb.via(['prompts', 'gh', 'review code', '-h']);
    expect(space.stdout.split('\n')[0]).toBe("usage: via prompts gh 'review code'");

    const ambiguous = await sb.via(['prompts', 'gh', 'review']);
    expect(ambiguous.code).toBe(3);
    expect(ambiguous.stderr).toContain("candidates: 'review code' · 'review `touch PWNED`'");
    expect(paste(nextCommands(ambiguous.stderr))).toEqual([['prompts', 'gh', 'review code', '-h']]);

    const missing = await sb.via(['prompts', 'gh', 'reveiw code']);
    expect(missing.code).toBe(3);
    paste(nextCommands(missing.stderr));

    const listing = await sb.via(['prompts', 'gh']);
    expect(listing.stdout.split('\n').filter((l) => l.startsWith('next:'))).toEqual([]);
    expect(listing.stdout).toContain('line\\nbreak');
  });
});
