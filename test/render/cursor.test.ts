import { describe, expect, it } from 'vitest';
import { CURSOR_TTL_MS, MemoryCursorStore, renderMore, renderOptions, renderToolResult } from '../../src/render';
import { manyRows, webResults } from '../fixtures/results';
import { makeContext, plainText, render, sequentialIds, structured, transcript } from '../helpers/render';

const snap = (name: string) => `./__snapshots__/${name}.txt`;

describe('budget and cursors (output.md, step 4 and "游标")', () => {
  it('truncates a table at the budget, keeps the header and offers a cursor', async () => {
    const out = await render(structured(manyRows), { budget: 600 }, { ref: 'cloud service:list' });
    await expect(transcript(out)).toMatchFileSnapshot(snap('cursor-page-1'));
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(600);
    expect(out.stderr).toMatch(/· \d+(\.\d)?k?\/\d+(\.\d)?k? bytes · next: via more [0-9a-f]{4}\n$/);
  });

  it('continues from the truncation point in the same format, until the end', async () => {
    const ctx = makeContext({ ref: 'cloud service:list' });
    const first = await renderToolResult(structured(manyRows), renderOptions({ budget: 600 }), ctx);
    const id1 = /via more ([0-9a-f]+)/.exec(first.stderr)![1]!;

    const second = await renderMore(id1, ctx);
    await expect(transcript(second)).toMatchFileSnapshot(snap('cursor-page-2'));
    // same header as the first page, rows continue where the first stopped
    const firstLines = first.stdout.trimEnd().split('\n');
    const secondLines = second.stdout.trimEnd().split('\n');
    expect(secondLines[0]).toBe(firstLines[0]);
    const lastShown = firstLines.at(-1)!.split(/\s+/)[0]!;
    const firstOfSecond = secondLines[1]!.split(/\s+/)[0]!;
    expect(Number(firstOfSecond)).toBe(Number(lastShown) + 1);

    // follow the chain to the end: every row exactly once, last page has no cursor
    const seen = new Set<string>([...firstLines.slice(1), ...secondLines.slice(1)].map((l) => l.split(/\s+/)[0]!));
    let stderr = second.stderr;
    let pages = 2;
    while (/via more ([0-9a-f]+)/.test(stderr)) {
      const next = await renderMore(/via more ([0-9a-f]+)/.exec(stderr)![1]!, ctx);
      for (const l of next.stdout.trimEnd().split('\n').slice(1)) seen.add(l.split(/\s+/)[0]!);
      stderr = next.stderr;
      pages += 1;
      expect(pages).toBeLessThan(50);
    }
    expect(seen.size).toBe(manyRows.length);
    expect(stderr).not.toContain('next:');
    expect(stderr).toMatch(/bytes/);
  });

  it('reports cumulative shown bytes against the total', async () => {
    const ctx = makeContext();
    const first = await renderToolResult(structured(manyRows), renderOptions({ budget: 600 }), ctx);
    const total = /\/(\S+) bytes/.exec(first.stderr)![1]!;
    const second = await renderMore(/via more ([0-9a-f]+)/.exec(first.stderr)![1]!, ctx);
    expect(/\/(\S+) bytes/.exec(second.stderr)![1]).toBe(total);
    const shown = (s: string) => {
      const m = /· ([\d.]+)(k?)\//.exec(s)!;
      return Number(m[1]) * (m[2] ? 1024 : 1);
    };
    expect(shown(second.stderr)).toBeGreaterThan(shown(first.stderr));
  });

  it('lays out a 38k listing like the exa example in output.md', async () => {
    const out = await render(structured(webResults.concat(webResults, webResults, webResults, webResults, webResults)), { budget: 2048 }, { ref: 'exa web:search', elapsedMs: 612 });
    await expect(transcript(out)).toMatchFileSnapshot(snap('cursor-exa-search'));
  });

  it('does not truncate with --full and issues no cursor', async () => {
    const out = await render(structured(manyRows), { budget: 600, full: true });
    expect(out.stdout.trimEnd().split('\n')).toHaveLength(61);
    expect(out.stderr).not.toContain('next:');
  });

  it('truncates plain text at a line boundary', async () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const out = await render(plainText(text), { budget: 100 });
    expect(out.stdout.endsWith('\n')).toBe(true);
    expect(out.stdout.split('\n').at(-2)).toMatch(/^line \d+$/);
    expect(out.stderr).toContain('next: via more ');
  });

  it('splits a single huge line across pages instead of looping or dropping it', async () => {
    const ctx = makeContext();
    const first = await renderToolResult(plainText('x'.repeat(1000)), renderOptions({ budget: 300 }), ctx);
    let collected = first.stdout;
    let stderr = first.stderr;
    while (/via more ([0-9a-f]+)/.test(stderr)) {
      const next = await renderMore(/via more ([0-9a-f]+)/.exec(stderr)![1]!, ctx);
      collected += next.stdout;
      stderr = next.stderr;
    }
    expect(collected.replace(/\n/g, '')).toBe('x'.repeat(1000));
  });

  it('applies the budget to -o json as well', async () => {
    const out = await render(structured(manyRows), { budget: 500, format: 'json' });
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(500);
    expect(out.stderr).toContain('next: via more ');
  });

  it('a cursor never encodes arguments or credentials: ids are random hex', async () => {
    const out = await render(structured(manyRows), { budget: 600 }, { cursors: new MemoryCursorStore() });
    expect(/via more ([0-9a-f]{4})\n$/.test(out.stderr)).toBe(true);
  });

  it('answers with exit code 3 and a next step for unknown or expired cursors', async () => {
    const out = await renderMore('beef', makeContext());
    expect(out.exitCode).toBe(3);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('error: cursor beef not found or expired (cursors are kept for 30 minutes)\nnext: rerun the original command\n');
  });

  it('expires cursors after 30 minutes', async () => {
    let now = 1_000;
    const cursors = new MemoryCursorStore({ now: () => now, generateId: sequentialIds() });
    const ctx = makeContext({ cursors, now: () => now });
    const first = await renderToolResult(structured(manyRows), renderOptions({ budget: 600 }), ctx);
    const id = /via more ([0-9a-f]+)/.exec(first.stderr)![1]!;
    now += CURSOR_TTL_MS - 1;
    expect((await renderMore(id, ctx)).exitCode).toBe(0);
    now += 2;
    expect((await renderMore(id, ctx)).exitCode).toBe(3);
  });
});
