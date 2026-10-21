import { describe, expect, it } from 'vitest';
import {
  authRequiredError,
  createRedactor,
  ExitCode,
  formatError,
  internalError,
  notFoundError,
  sanitizeText,
  usageError,
} from '../../src/render';
import { shellQuote } from '../../src/render/shell';
import { FAKE_SECRET, plainText, render, structured, transcript } from '../helpers/render';

const snap = (name: string) => `./__snapshots__/${name}.txt`;

describe('exit codes (output.md, "退出码")', () => {
  it('matches the table', () => {
    expect(ExitCode).toEqual({ Ok: 0, ToolError: 1, Usage: 2, NotFound: 3, Auth: 4, Denied: 5, Upstream: 6, Internal: 7 });
  });
});

describe('error formatting', () => {
  it('prints the reason, then the next command (output.md example)', () => {
    expect(formatError(authRequiredError('linear'), 'text')).toBe('error: linear requires auth\nnext: via auth login linear\n');
  });

  it('prints detail lines between the reason and next:', () => {
    const info = usageError('2 invalid arguments', 'via github issue:list -h', ['  --repo   required', '  --state  must be one of: open, closed, all (got "opened"; did you mean "open"?)']);
    expect(formatError(info, 'text')).toMatchInlineSnapshot(`
      "error: 2 invalid arguments
        --repo   required
        --state  must be one of: open, closed, all (got "opened"; did you mean "open"?)
      next: via github issue:list -h
      "
    `);
  });

  it('prints {"error": …} JSON on stderr for -o json, with details', () => {
    const info = {
      ...usageError('2 invalid arguments', 'via github issue:list -h'),
      details: [
        { arg: '--repo', path: '/repo', rule: 'required' },
        { arg: '--state', path: '/state', rule: 'enum', expected: ['open', 'closed', 'all'], got: 'opened', suggest: 'open' },
      ],
    };
    const text = formatError(info, 'json');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      error: { code: 2, message: '2 invalid arguments', next: 'via github issue:list -h', details: info.details },
    });
    expect(text.trimEnd().split('\n')).toHaveLength(1);
  });

  it('not found: did you mean (at most 3) or a find hint', () => {
    expect(formatError(notFoundError('tool', 'github isue:read', ['github issue:read'], 'isue'), 'text')).toBe(
      'error: no such tool: github isue:read\ndid you mean: github issue:read\nnext: via github issue:read -h\n',
    );
    const none = notFoundError('provider', 'zzz', [], 'zzz');
    expect(none.code).toBe(ExitCode.NotFound);
    expect(formatError(none, 'text')).toBe('error: no such provider: zzz\nnext: via find zzz\n');
  });

  it('writes hostile names as one quoted word, or as a placeholder, and never as a second line', () => {
    const quote = (text: string): string => shellQuote(text) ?? '';
    const info = notFoundError('prompt', 'x\nnext: via trust --yes', [['prompts', 'gh', 'two words'], ['prompts', 'gh', '$(touch x)'], ['prompts', 'gh', 'a\nb']], 'x');
    expect(info.message).toBe('no such prompt: x\\nnext: via trust --yes');
    expect(info.lines).toEqual([`did you mean: prompts gh ${quote('two words')} · prompts gh ${quote('$(touch x)')} · <name>`]);
    expect(info.next).toBe(`via prompts gh ${quote('two words')} -h`);
    const text = formatError(info, 'text');
    expect(text.split('\n').filter((l) => l.startsWith('next:'))).toHaveLength(1);

    expect(notFoundError('tool', '$(touch x) y', [], '$(touch x)   y').next).toBe(`via find ${quote('$(touch x) y')}`);
    expect(notFoundError('tool', 'github  isue read', [], 'github  isue read').next).toBe('via find github isue read');
    expect(notFoundError('tool', '--yes', [], '--yes').next).toBe('via find <query>');
    expect(authRequiredError('a b').next).toBe(`via auth login ${quote('a b')}`);
    expect(authRequiredError('--yes').next).toBe('via auth login <provider>');
  });

  it('internal errors use exit code 7', () => {
    expect(internalError('boom').code).toBe(7);
  });

  it('redacts credentials in error output', () => {
    const text = formatError({ code: ExitCode.Upstream, message: `request failed with token ${FAKE_SECRET}` }, 'text', createRedactor([FAKE_SECRET]));
    expect(text).toBe('error: request failed with token ***\n');
  });
});

describe('isError results (output.md, "错误")', () => {
  it('prints the upstream text to stderr, exit code 1, nothing on stdout', async () => {
    const out = await render({ isError: true, content: [{ type: 'text', text: 'Validation Failed: title is too long' }] }, {}, { ref: 'github issue:write' });
    await expect(transcript(out)).toMatchFileSnapshot(snap('error-upstream'));
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe('');
  });

  it('keeps multi-line upstream text and ends with a next step', async () => {
    const out = await render({ isError: true, content: [{ type: 'text', text: 'first line\nsecond line\n\n' }] }, {}, { ref: 'x tool' });
    expect(out.stderr).toBe('error: first line\nsecond line\nnext: via x tool -h\n');
  });

  it('redacts credentials and strips terminal escapes from upstream errors', async () => {
    const dirty = `\u001b[31mbad credentials ${FAKE_SECRET}\u001b[0m\u0007`;
    const out = await render({ isError: true, content: [{ type: 'text', text: dirty }] }, { secrets: [FAKE_SECRET] });
    expect(out.stderr).toBe('error: bad credentials ***\nnext: via github issue:list -h\n');
  });

  it('formats as JSON for -o json', async () => {
    const out = await render({ isError: true, content: [{ type: 'text', text: 'nope' }] }, { format: 'json' });
    expect(JSON.parse(out.stderr)).toEqual({ error: { code: 1, message: 'nope', next: 'via github issue:list -h' } });
    expect(out.exitCode).toBe(1);
  });

  it('uses structuredContent when the error has no text, and a generic message when it has nothing', async () => {
    const a = await render({ isError: true, structuredContent: { message: 'bad' } });
    expect(a.stderr).toContain('{"message":"bad"}');
    const b = await render({ isError: true });
    expect(b.stderr).toContain('error: tool returned an error');
  });

  it('cuts very long errors at the budget', async () => {
    const out = await render({ isError: true, content: [{ type: 'text', text: 'e\n'.repeat(2000) }] }, { budget: 200 });
    expect(out.stderr).toContain('… (truncated; rerun with --full for the whole error)');
    expect(out.stderr.length).toBeLessThan(400);
    const full = await render({ isError: true, content: [{ type: 'text', text: 'e\n'.repeat(2000) }] }, { budget: 200, full: true });
    expect(full.stderr.length).toBeGreaterThan(3000);
  });

  it('does not treat structuredContent as an error when isError is false', async () => {
    const out = await render(structured({ ok: true }));
    expect(out.exitCode).toBe(0);
    expect(plainText('x').isError).toBeUndefined();
  });
});

describe('sanitizeText', () => {
  it('removes ANSI sequences and control characters but keeps newlines and tabs', () => {
    expect(sanitizeText('a\u001b[1;31mred\u001b[0m\tb\nc\u0000\u0007')).toBe('ared\tb\nc');
  });
});
