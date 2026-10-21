import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inertText, shellArg, shellQuote, shellWord, shellWords, visibleText } from '../../src/render/shell';

/** Texts a server or a person could put into a name, a value or a path. */
export const HOSTILE = [
  '$(touch PWNED)',
  '`touch PWNED`',
  '${IFS}',
  '$HOME',
  '; touch PWNED',
  'a && touch PWNED',
  'a | touch PWNED',
  "x'; touch PWNED; '",
  '"; touch PWNED; "',
  "it's",
  'a b',
  '\\',
  'trailing\\',
  'a\\ b',
  '!touch PWNED',
  '~',
  '~root/x',
  '*',
  '{a,b}',
  '=touch',
  '#comment',
  '--yes',
  '-o',
  '@file',
  '%PATH%',
  '^&',
  '<tag>',
  '(sub)',
  '',
  ' ',
  'tab\there',
  'line\nbreak',
  'carriage\rreturn',
  'nul\u0000byte',
  'esc\u001b[31m',
  'bidi\u202eevil',
  'zero\u200bwidth',
  '\u2018smart\u2019',
  '\u201cdouble\u201d; touch PWNED',
  '日本語',
  'päth/ünï',
];

describe('shellQuote on POSIX', () => {
  it('leaves plain words alone and single-quotes the rest', () => {
    expect(shellQuote('issue:read', 'linux')).toBe('issue:read');
    expect(shellQuote('--per-page', 'linux')).toBe('--per-page');
    expect(shellQuote('/a/b.json', 'linux')).toBe('/a/b.json');
    expect(shellQuote('日本語', 'linux')).toBe('日本語');
    expect(shellQuote('rust mcp', 'linux')).toBe("'rust mcp'");
    expect(shellQuote('$(touch x)', 'linux')).toBe("'$(touch x)'");
    expect(shellQuote('`id`', 'linux')).toBe("'`id`'");
    expect(shellQuote('a\\b', 'linux')).toBe("'a\\b'");
    expect(shellQuote('!x', 'linux')).toBe("'!x'");
    expect(shellQuote('~', 'linux')).toBe("'~'");
    expect(shellQuote('', 'linux')).toBe('""');
  });

  it('writes an apostrophe the POSIX way, unless something else in the text could run in a shell that reads it differently', () => {
    expect(shellQuote("it's", 'linux')).toBe("'it'\\''s'");
    expect(shellQuote("x'; touch PWNED; '", 'linux')).toBeUndefined();
    expect(shellQuote("it's $HOME", 'linux')).toBeUndefined();
  });

  it('refuses control characters, line breaks and look-alike or invisible characters', () => {
    for (const text of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u202eb', 'a\u200bb', 'a\u2028b', 'a\ufeffb']) {
      expect(shellQuote(text, 'linux'), JSON.stringify(text)).toBeUndefined();
    }
  });
});

describe('shellQuote on Windows', () => {
  it('leaves a path alone and double-quotes what both PowerShell and cmd.exe read the same way', () => {
    expect(shellQuote('C:\\Users\\Me\\x.json', 'win32')).toBe('C:\\Users\\Me\\x.json');
    expect(shellQuote('C:\\Users\\RUNNER~1\\x.json', 'win32')).toBe('C:\\Users\\RUNNER~1\\x.json');
    expect(shellQuote('~\\x.json', 'win32')).toBe('"~\\x.json"');
    expect(shellQuote('/tmp/RUNNER~1', 'linux')).toBe("'/tmp/RUNNER~1'");
    expect(shellQuote('C:\\Users\\Me Too\\x.json', 'win32')).toBe('"C:\\Users\\Me Too\\x.json"');
    expect(shellQuote('rust mcp', 'win32')).toBe('"rust mcp"');
    expect(shellQuote("it's here", 'win32')).toBe('"it\'s here"');
    expect(shellQuote('', 'win32')).toBe('""');
    // inside double quotes cmd.exe reads these as plain characters
    expect(shellQuote('a & b | c ^ d <e> (f)', 'win32')).toBe('"a & b | c ^ d <e> (f)"');
  });

  it('uses PowerShell single quotes only when cmd.exe has nothing to act on', () => {
    expect(shellQuote('a $b c', 'win32')).toBe("'a $b c'");
    expect(shellQuote('a `b` c', 'win32')).toBe("'a `b` c'");
    expect(shellQuote("a $b's", 'win32')).toBe("'a $b''s'");
    expect(shellQuote('a!b c', 'win32')).toBe("'a!b c'");
    // a trailing backslash would escape the closing double quote
    expect(shellQuote('dir \\', 'win32')).toBe("'dir \\'");
  });

  it('refuses what has no safe spelling in all shells', () => {
    for (const text of [
      '$(touch x)', // PowerShell would run it inside double quotes, cmd.exe would see the parentheses
      '%PATH%', // cmd.exe expands it in any quoting that PowerShell shares
      'a "quoted" b',
      'a & "b"',
      '$(a) & b',
      '%x% & b',
      '\u2018smart\u2019', // PowerShell reads curly quotes as quotes
      '\u201cdouble\u201d; calc',
      'line\nbreak',
    ]) {
      expect(shellQuote(text, 'win32'), JSON.stringify(text)).toBeUndefined();
    }
  });

  it('never produces a word in which cmd.exe or PowerShell would find syntax', () => {
    for (const text of HOSTILE) {
      const word = shellQuote(text, 'win32');
      if (word === undefined) continue;
      if (word.startsWith('"')) {
        const body = word.slice(1, -1);
        expect(body, JSON.stringify(text)).not.toMatch(/["$`%!]/);
        expect(body.endsWith('\\')).toBe(false);
      } else if (word.startsWith("'")) {
        expect(word.slice(1, -1).replace(/''/g, ''), JSON.stringify(text)).not.toMatch(/['"%^&|<>()]/);
      } else {
        expect(word, JSON.stringify(text)).toMatch(/^[\p{L}\p{N}_./\\:+=@-]+$/u);
      }
    }
  });
});

describe('shellArg, shellWord and shellWords', () => {
  it('put a placeholder where there is no safe spelling', () => {
    expect(shellArg('a\nb', { placeholder: 'query' })).toBe('<query>');
    expect(shellArg('ok')).toBe('ok');
    expect(shellArg('--yes', { positional: true, placeholder: 'provider' })).toBe('<provider>');
    expect(shellArg('--yes', { placeholder: 'provider' })).toBe('--yes');
    expect(shellWord('/tmp/a\nb', 'linux')).toBe('<path>');
    expect(shellWord('/tmp/a b', 'linux')).toBe("'/tmp/a b'");
  });

  it('quote each word of a reference and give up on the whole reference when one word cannot be written', () => {
    expect(shellWords('github issue:read')).toBe('github issue:read');
    expect(shellWords('github  $(x)', { placeholder: 'ref', platform: 'linux' })).toBe("github '$(x)'");
    expect(shellWords('github  $(x)', { placeholder: 'ref', platform: 'win32' })).toBe('<ref>');
    expect(shellWords(['prompts', 'github', 'review code'], { platform: 'linux' })).toBe("prompts github 'review code'");
    expect(shellWords(['prompts', 'github', 'review code'], { platform: 'win32' })).toBe('prompts github "review code"');
    expect(shellWords(['prompts', 'github', 'a\nb'], { placeholder: 'ref' })).toBe('<ref>');
    expect(shellWords('  ', { placeholder: 'ref' })).toBe('<ref>');
    expect(shellWords('github -x', { positional: true })).toBe('<name>');
  });
});

describe('visibleText and inertText', () => {
  it('turn line breaks and control characters into visible escapes', () => {
    expect(visibleText('a\nnext: rm -rf ~')).toBe('a\\nnext: rm -rf ~');
    expect(visibleText('a\u001b[2Jb\u202ec')).toBe('a\\u001b[2Jb\\u202ec');
    expect(visibleText('plain')).toBe('plain');
  });

  it('write a text that cannot be quoted so that pasting it runs nothing', () => {
    const text = '$(touch x)`id`"\\!%\n\'';
    const shown = inertText(text);
    expect(shown).toBe('"\\u0024(touch x)\\u0060id\\u0060\\u0022\\u005c\\u0021\\u0025\\u000a\\u0027"');
    expect(shown.slice(1, -1)).not.toMatch(/["$`!%'\n]/);
  });
});

/** Real shells: whatever the helper quotes comes back as exactly one argument, and nothing runs. */
describe.skipIf(process.platform === 'win32')('quoted words read by a real POSIX shell', () => {
  const shells = ['sh', 'bash', 'dash', 'zsh', 'ksh'].filter((name) => {
    try {
      execFileSync(name, ['-c', 'true'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });

  it('has at least one shell to try', () => {
    expect(shells.length).toBeGreaterThan(0);
  });

  for (const shell of shells) {
    it(`${shell} gets back the text as one argument and runs nothing`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'via-shell-'));
      try {
        for (const text of HOSTILE) {
          const word = shellQuote(text, 'linux');
          if (word === undefined) continue;
          // A script that prints its arguments NUL-separated; the word is pasted after it as a person would.
          const out = execFileSync(shell, ['-c', `printf '%s\\0' ${word} -- tail`], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
          expect(out, JSON.stringify(text)).toBe(`${text}\0--\0tail\0`);
        }
        expect(existsSync(join(dir, 'PWNED'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
