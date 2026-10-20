import { describe, expect, it } from 'vitest';
import { chineseIssues, githubIssue, githubIssues, linearIssue, manyRows, PNG_1X1_BASE64, webResults } from '../fixtures/results';
import { compileNoise, displayWidth } from '../../src/render';
import { jsonText, plainText, render, structured, transcript } from '../helpers/render';

const snap = (name: string) => `./__snapshots__/${name}.txt`;

describe('shapes (output.md, step 3)', () => {
  it('renders an array of objects as an aligned table with noise removed', async () => {
    const out = await render(structured(githubIssues), {}, { ref: 'github issue:list' });
    await expect(transcript(out)).toMatchFileSnapshot(snap('table-github-issues'));
    // noise fields never show up
    expect(out.stdout).not.toMatch(/node_id|_links|_api_url|gravatar/);
  });

  it('prefers name/title/id/number/state/url columns and reports the rest as +N cols', async () => {
    const out = await render(structured(githubIssues));
    const header = out.stdout.split('\n')[0]!;
    for (const col of ['number', 'title', 'state', 'url']) expect(header).toContain(col);
    expect(out.stdout.split('\n')[0]!.trim().split(/\s{2,}/).length).toBeLessThanOrEqual(6);
    expect(out.stderr).toMatch(/\+\d+ cols \(-o json\)/);
  });

  it('parses JSON text content when there is no structuredContent', async () => {
    const a = await render(structured(githubIssues));
    const b = await render(jsonText(githubIssues));
    expect(b.stdout).toBe(a.stdout);
  });

  it('renders a single object as key: value lines', async () => {
    const out = await render(structured(linearIssue), {}, { ref: 'linear issue:create' });
    await expect(transcript(out)).toMatchFileSnapshot(snap('object-linear-issue'));
    expect(out.stdout).toBe(
      'id: ENG-123\nurl: https://linear.app/acme/issue/ENG-123\nstate: Backlog\n',
    );
  });

  it('indents nested objects, shows multi-line strings as blocks and nested lists as tables', async () => {
    const out = await render(structured(githubIssue), {}, { ref: 'github issue:read' });
    await expect(transcript(out)).toMatchFileSnapshot(snap('object-github-issue'));
  });

  it('renders a one-element array like a single object', async () => {
    const one = await render(structured([linearIssue]));
    const obj = await render(structured(linearIssue));
    expect(one.stdout).toBe(obj.stdout);
  });

  it('prints plain text as is', async () => {
    const out = await render(plainText('line one\nline two\n'), {}, { ref: 'github pull-request:read' });
    await expect(transcript(out)).toMatchFileSnapshot(snap('text-plain'));
    expect(out.stdout).toBe('line one\nline two\n');
  });

  it('keeps text that merely looks like JSON but is not', async () => {
    const out = await render(plainText('{not json'));
    expect(out.stdout).toBe('{not json\n');
  });

  it('renders several content blocks in order', async () => {
    const out = await render({ content: [{ type: 'text', text: 'first' }, { type: 'text', text: JSON.stringify({ a: 1 }) }, { type: 'text', text: 'last' }] });
    expect(out.stdout).toBe('first\n\na: 1\n\nlast\n');
    const compact = await render({ content: [{ type: 'text', text: 'one' }, { type: 'resource_link', uri: 'file:///a' }, { type: 'text', text: 'two' }] });
    expect(compact.stdout).toBe('one\nfile:///a\ntwo\n');
  });

  it('prints a list of scalars one per line', async () => {
    const out = await render(structured(['a', 'b', 'c']));
    expect(out.stdout).toBe('a\nb\nc\n');
  });

  it('prints nothing for an empty result and says so in the meta line', async () => {
    const out = await render(structured({ items: [], total: null, note: '' }));
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('· github issue:list · 318ms · 0 bytes\n');
  });
});

describe('cleaning (output.md, step 2)', () => {
  it('drops null, empty strings, empty arrays and empty objects but keeps 0 and false', async () => {
    const out = await render(structured({ a: null, b: '', c: [], d: {}, e: 0, f: false, g: { h: null, i: 'x' }, j: [null, 'k', ''] }));
    expect(out.stdout).toBe('e: 0\nf: false\ng:\n  i: x\nj: k\n');
  });

  it('honours extra per-server noise fields and the keep list', async () => {
    const noise = compileNoise({ version: 1, fields: ['node_id', '*_url'], keep: ['html_url'] }, ['secret_*']);
    const out = await render(structured({ node_id: 1, html_url: 'h', api_url: 'a', secret_thing: 's', keep_me: 'k' }), { noise });
    expect(out.stdout).toBe('html_url: h\nkeep_me: k\n');
  });
});

describe('display width (output.md: CJK counts double)', () => {
  it('aligns columns by display width', async () => {
    const out = await render(structured(chineseIssues), {}, { ref: 'github issue:list' });
    await expect(transcript(out)).toMatchFileSnapshot(snap('table-cjk'));
    const lines = out.stdout.trimEnd().split('\n');
    // the second column starts at the same display column on every line
    const starts = lines.map((l) => {
      const m = /^(\S+\s+)/.exec(l)!;
      return displayWidth(m[1]!);
    });
    expect(new Set(starts).size).toBe(1);
    const stateStarts = lines.map((l) => displayWidth(l.slice(0, l.search(/\b(open|closed|state)\b/))));
    expect(new Set(stateStarts).size).toBe(1);
  });
});

describe('cell truncation', () => {
  const long = [
    { id: 1, summary: 'x'.repeat(200) },
    { id: 2, summary: 'short' },
  ];

  it('cuts cells at 80 characters with an ellipsis', async () => {
    const out = await render(structured(long));
    const row = out.stdout.split('\n')[1]!;
    expect(Array.from(row.split(/\s{2,}/)[1]!)).toHaveLength(80);
    expect(row.endsWith('…')).toBe(true);
  });

  it('--full keeps cells whole', async () => {
    const out = await render(structured(long), { full: true });
    expect(out.stdout).toContain('x'.repeat(200));
  });

  it('collapses newlines inside cells', async () => {
    const out = await render(structured([{ id: 1, note: 'a\nb' }, { id: 2, note: 'c' }]));
    expect(out.stdout.split('\n')[1]).toBe('1   a b');
  });
});

describe('formats (output.md, "输出格式")', () => {
  it('-o json prints cleaned, pretty JSON', async () => {
    const out = await render(structured(githubIssues.slice(0, 2)), { format: 'json' }, { ref: 'github issue:list' });
    await expect(transcript(out)).toMatchFileSnapshot(snap('json-github-issues'));
    const parsed = JSON.parse(out.stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).not.toHaveProperty('node_id');
    expect(parsed[0]).not.toHaveProperty('assignee'); // null removed
    expect(parsed[0]).toHaveProperty('html_url'); // kept despite *_url noise
    expect(out.stderr).toBe('· github issue:list · 318ms · 2 rows\n');
  });

  it('-o raw prints upstream text untouched', async () => {
    const payload = JSON.stringify({ node_id: 'x', empty: '', n: null }, null, 1);
    const out = await render(plainText(payload), { format: 'raw' });
    expect(out.stdout).toBe(`${payload}\n`);
  });

  it('-o raw falls back to structuredContent when there is no content', async () => {
    const out = await render({ structuredContent: { a: 1 } }, { format: 'raw' });
    expect(JSON.parse(out.stdout)).toEqual({ a: 1 });
  });

  it('-o raw is not truncated', async () => {
    const big = 'line\n'.repeat(5000);
    const out = await render(plainText(big), { format: 'raw' });
    expect(out.stdout.length).toBe(big.length);
    expect(out.stderr).not.toContain('next:');
  });
});

describe('media (output.md, step 5)', () => {
  it('stores images and prints only the path; resource links print the URI', async () => {
    const out = await render(
      {
        content: [
          { type: 'text', text: 'Screenshot taken' },
          { type: 'image', data: PNG_1X1_BASE64, mimeType: 'image/png' },
          { type: 'resource_link', uri: 'file:///tmp/report.pdf', name: 'report' },
          { type: 'resource', resource: { uri: 'file:///tmp/a.bin', mimeType: 'application/pdf', blob: PNG_1X1_BASE64 } },
          { type: 'resource', resource: { uri: 'file:///tmp/a.txt', text: 'embedded text' } },
        ],
      },
      {},
      { ref: 'playwright browser-take-screenshot' },
    );
    await expect(transcript(out)).toMatchFileSnapshot(snap('media'));
    expect(out.stdout).not.toContain(PNG_1X1_BASE64);
  });

  it('represents media as objects in -o json', async () => {
    const out = await render(
      { content: [{ type: 'image', data: PNG_1X1_BASE64, mimeType: 'image/png' }, { type: 'resource_link', uri: 'https://x.test/a' }] },
      { format: 'json' },
    );
    const parsed = JSON.parse(out.stdout) as Array<Record<string, string>>;
    expect(parsed[0]).toMatchObject({ type: 'image' });
    expect(parsed[0]!.path).toMatch(/\.png$/);
    expect(parsed[1]).toEqual({ type: 'resource_link', uri: 'https://x.test/a' });
  });
});

describe('meta line (output.md, "元信息行")', () => {
  it('shows ref, elapsed time and rows, with a +N cols hint', async () => {
    const out = await render(structured(githubIssues));
    expect(out.stderr).toBe('· github issue:list · 318ms · 3 rows · +8 cols (-o json)\n');
  });

  it('shows bytes for non-list results and seconds for slow calls', async () => {
    const out = await render(plainText('hello'), {}, { elapsedMs: 1840 });
    expect(out.stderr).toBe('· github issue:list · 1.8s · 6 bytes\n');
  });

  it('carries flags and warnings', async () => {
    const out = await render(plainText('x'), {}, { flags: ['unvalidated'], warnings: ['output does not match outputSchema'] });
    expect(out.stderr).toBe(
      'warning: output does not match outputSchema\n· github issue:list · 318ms · 2 bytes · unvalidated\n',
    );
  });

  it('always starts with the fixed marker', async () => {
    for (const result of [structured(manyRows), plainText('x'), structured(webResults)]) {
      const out = await render(result, { budget: 300 });
      expect(out.stderr.trimEnd().split('\n').at(-1)).toMatch(/^· /);
    }
  });
});
