import { describe, expect, it } from 'vitest';
import { githubIssues, manyRows } from '../fixtures/results';
import { MemoryCursorStore, renderMore, type RenderOutput } from '../../src/render';
import { jsonBody, takeJsonPage } from '../../src/render/json-pages';
import { plainText, render, structured } from '../helpers/render';

// `-o json` over the budget (output.md, "JSON 的分页"): every page is a JSON document, and the
// pages put together level by level are the whole result.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** What a reader does with the pages: items go to the array, keys to the object, text to the string. */
function append(into: Json | undefined, page: Json): Json {
  if (into === undefined) return page;
  if (typeof into === 'string' && typeof page === 'string') return into + page;
  if (Array.isArray(into) && Array.isArray(page)) {
    // The first item of a page continues the last item of the page before when that one was cut.
    return [...into, ...page];
  }
  if (into !== null && page !== null && typeof into === 'object' && typeof page === 'object' && !Array.isArray(into) && !Array.isArray(page)) {
    const out: { [key: string]: Json } = { ...into };
    for (const [key, value] of Object.entries(page)) out[key] = key in out ? append(out[key], value) : value;
    return out;
  }
  throw new Error(`pages do not fit together: ${JSON.stringify(into).slice(0, 40)} + ${JSON.stringify(page).slice(0, 40)}`);
}

/** All pages of a document at a budget, straight from the pager. */
function pagesOf(value: Json, budget: number): { pages: string[]; parsed: Json[] } {
  const body = jsonBody(JSON.stringify(value, null, 2).split('\n'), budget);
  const pages: string[] = [];
  for (let at = 0; at < body.lines.length; ) {
    const page = takeJsonPage(body, at, budget);
    expect(page.next).toBeGreaterThan(at);
    pages.push(page.lines.join('\n'));
    at = page.next;
  }
  return { pages, parsed: pages.map((p) => JSON.parse(p) as Json) };
}

const issue = (n: number, extra: Record<string, Json> = {}): Json => ({ number: n, title: `Issue number ${n}`, state: 'open', labels: [{ name: 'bug' }, { name: 'p1' }], user: { login: 'octocat', id: n }, ...extra });

describe('takeJsonPage', () => {
  it('pages a wrapped list between whole items; every page parses, keeps the nesting and stays within the budget', () => {
    const doc = { issues: Array.from({ length: 40 }, (_, i) => issue(i + 1)), totalCount: 40, pageInfo: { hasNextPage: false } };
    const { pages, parsed } = pagesOf(doc, 2048);
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) expect(Buffer.byteLength(page) + 1).toBeLessThanOrEqual(2048);
    // whole issues only: every item on every page has all its keys
    const items = parsed.flatMap((p) => (p as { issues: Json[] }).issues);
    expect(items).toEqual(doc.issues);
    // the keys after the list come on the last page, once
    expect(parsed.slice(0, -1).every((p) => Object.keys(p as object).join() === 'issues')).toBe(true);
    expect(parsed[parsed.length - 1]).toMatchObject({ totalCount: 40, pageInfo: { hasNextPage: false } });
    expect(parsed.reduce<Json | undefined>(append, undefined)).toEqual(doc);
  });

  it('pages a bare array and an object of many keys the same way', () => {
    const list = Array.from({ length: 30 }, (_, i) => issue(i));
    const a = pagesOf(list, 1500);
    expect(a.parsed.every(Array.isArray)).toBe(true);
    expect(a.parsed.flat()).toEqual(list);

    const map: Json = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`path_${i}`, { get: true, post: i % 2 === 0 }]));
    const o = pagesOf(map, 1024);
    expect(o.pages.length).toBeGreaterThan(5);
    expect(o.parsed.reduce<Json | undefined>(append, undefined)).toEqual(map);
    for (const page of o.pages) expect(Buffer.byteLength(page) + 1).toBeLessThanOrEqual(1024);
  });

  it('continues a string that does not fit on a page under the same key, never two parts on one page', () => {
    const content = Array.from({ length: 400 }, (_, i) => `line ${i}: "quoted" \\ back\tslash and 中文 ${'x'.repeat(i % 7)}`).join('\n');
    const doc = { path: 'src/a.ts', content, sha: 'abc' };
    const { pages, parsed } = pagesOf(doc, 2048);
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) expect(Buffer.byteLength(page) + 1).toBeLessThanOrEqual(2048);
    expect(parsed[0]).toMatchObject({ path: 'src/a.ts' });
    expect(parsed.every((p) => typeof (p as { content?: Json }).content === 'string' || 'sha' in (p as object))).toBe(true);
    expect(parsed.reduce<Json | undefined>(append, undefined)).toEqual(doc);

    // a result that is one string: each page is a JSON string
    const bare = pagesOf(content, 1024);
    expect(bare.parsed.every((p) => typeof p === 'string')).toBe(true);
    expect(bare.parsed.join('')).toBe(content);
  });

  it('continues an item that is larger than a page inside its array, and goes back to whole items after it', () => {
    const huge = issue(2, { body: 'b'.repeat(300), notes: Array.from({ length: 60 }, (_, i) => `note ${i}`) });
    const doc = [issue(1), huge, issue(3), issue(4)];
    const { parsed } = pagesOf(doc, 700);
    expect(parsed.every(Array.isArray)).toBe(true);
    // put back together: pieces of the cut item are consecutive objects, merged by key
    const merged: Json[] = [];
    for (const item of parsed.flat() as Array<{ [key: string]: Json }>) {
      const last = merged[merged.length - 1] as { [key: string]: Json } | undefined;
      if (last && !('number' in item)) merged[merged.length - 1] = append(last, item);
      else merged.push(item);
    }
    expect(merged).toEqual(doc);
  });

  it('does not end a page on an opening line, and never starts one with a closing line', () => {
    const doc = { a: { b: { c: Array.from({ length: 50 }, (_, i) => ({ id: i, tags: ['x', 'y'] })) } }, z: 1 };
    const body = jsonBody(JSON.stringify(doc, null, 2).split('\n'), 400);
    for (let at = 0; at < body.lines.length; ) {
      const page = takeJsonPage(body, at, 400);
      expect(body.lines[at]).not.toMatch(/^\s*[}\]]/);
      if (page.next < body.lines.length) expect(body.lines[page.next - 1]).not.toMatch(/[{[]$/);
      JSON.parse(page.lines.join('\n'));
      at = page.next;
    }
  });

  it('takes one line even when nothing fits, and leaves a line whose key alone is too long whole', () => {
    const doc = { ['k'.repeat(300)]: 'v'.repeat(300), small: 1 };
    const { pages, parsed } = pagesOf(doc, 128);
    expect(parsed.reduce<Json | undefined>(append, undefined)).toEqual(doc);
    expect(Math.max(...pages.map((p) => Buffer.byteLength(p)))).toBeGreaterThan(128);
  });

  it('is not confused by brackets, quotes and commas inside strings and keys', () => {
    const doc = { 'we{ird [key': ['}', ']', '{', '[', '",', 'a,', '\\"', ''], 'k": "v': { '}': '],', n: -1.5e3, t: true, nil: null, empty: {}, none: [] } };
    const text = JSON.stringify(doc, null, 2).split('\n');
    for (const budget of [64, 96, 160, 4096]) {
      const body = jsonBody(text, budget);
      let whole: Json | undefined;
      for (let at = 0; at < body.lines.length; ) {
        const page = takeJsonPage(body, at, budget);
        whole = append(whole, JSON.parse(page.lines.join('\n')) as Json);
        at = page.next;
      }
      expect(whole).toEqual(doc);
    }
  });
});

describe('takeJsonPage on generated documents', () => {
  // A fixed pseudo-random sequence: the same documents on every run.
  let seed = 12345;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const POOL = ['a', '"', '\\', '{', '}', '[', ']', ',', ':', ' ', '\n', '中', '😀', 'xyz', '",', '": {'];
  const text = (): string => {
    let out = '';
    for (let i = rnd(6) === 0 ? rnd(600) : rnd(12); i > 0; i -= 1) out += POOL[rnd(POOL.length)];
    return out;
  };
  const value = (depth: number): Json => {
    const kind = rnd(depth > 3 ? 4 : 7);
    if (kind === 0) return rnd(1000) - 500;
    if (kind === 1) return text();
    if (kind === 2) return rnd(2) === 0;
    if (kind === 3) return null;
    if (kind < 6) return Array.from({ length: rnd(8) }, () => value(depth + 1));
    return Object.fromEntries(Array.from({ length: rnd(8) }, () => [text() || 'k', value(depth + 1)]));
  };

  it('every page is valid JSON, paging always advances, and a page fits a budget of 500 bytes or more', () => {
    let pages = 0;
    for (let n = 0; n < 3000; n += 1) {
      const doc = value(0);
      const budget = [48, 64, 100, 200, 500, 2000][rnd(6)]!;
      const body = jsonBody(JSON.stringify(doc, null, 2).split('\n'), budget);
      for (let at = 0; at < body.lines.length; pages += 1) {
        const page = takeJsonPage(body, at, budget);
        expect(page.next).toBeGreaterThan(at);
        const joined = page.lines.join('\n');
        expect(() => JSON.parse(joined), joined).not.toThrow();
        if (budget >= 500) expect(Buffer.byteLength(joined) + 1).toBeLessThanOrEqual(budget);
        at = page.next;
      }
    }
    expect(pages).toBeGreaterThan(3000);
  });
});

describe('-o json over the budget', () => {
  const all = async (first: RenderOutput, cursors: MemoryCursorStore): Promise<RenderOutput[]> => {
    const outs = [first];
    for (;;) {
      const id = /next: via more (\w+)/.exec(outs[outs.length - 1]!.stderr)?.[1];
      if (!id) return outs;
      outs.push(await renderMore(id, { elapsedMs: 0, cursors }, { format: 'json', secrets: [] }));
    }
  };

  it('prints a JSON document on every page, with the bytes shown so far in the meta line', async () => {
    const cursors = new MemoryCursorStore();
    const outs = await all(await render(structured(manyRows), { budget: 1500, format: 'json' }, { cursors }), cursors);
    expect(outs.length).toBeGreaterThan(2);
    const rows = outs.flatMap((o) => JSON.parse(o.stdout) as unknown[]);
    expect(rows).toHaveLength(manyRows.length);
    expect(rows[rows.length - 1]).toEqual(JSON.parse(JSON.stringify(manyRows[manyRows.length - 1])));
    for (const o of outs) expect(Buffer.byteLength(o.stdout)).toBeLessThanOrEqual(1500);
    expect(outs[0]!.stderr).toMatch(/^· github issue:list · 318ms · [\d.k]+\/[\d.k]+ bytes · next: via more \w+\n$/);
    // the last page: nothing left, the total as shown
    const total = /\/([\d.k]+) bytes/.exec(outs[0]!.stderr)![1];
    expect(outs[outs.length - 1]!.stderr).toBe(`· github issue:list · 0ms · ${total} bytes\n`);
  });

  it('is the plain document when it fits, and with --full', async () => {
    const fits = await render(structured(githubIssues), { format: 'json' });
    expect(fits.stdout).toBe(`${JSON.stringify(JSON.parse(fits.stdout), null, 2)}\n`);
    expect(fits.stderr).not.toContain('next:');
    const full = await render(structured(manyRows), { budget: 500, format: 'json', full: true });
    expect(JSON.parse(full.stdout)).toHaveLength(manyRows.length);
    expect(full.stderr).not.toContain('next:');
  });

  it('pages a long text result as JSON strings', async () => {
    const text = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i};`).join('\n');
    const cursors = new MemoryCursorStore();
    const outs = await all(await render(plainText(text), { budget: 1024, format: 'json' }, { cursors }), cursors);
    expect(outs.length).toBeGreaterThan(3);
    expect(outs.map((o) => JSON.parse(o.stdout) as string).join('')).toBe(text);
  });

  it('keeps redacting on every page', async () => {
    const secret = 'fake-credential-value-0123456789';
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i, note: `token ${secret} in row ${i}` }));
    const cursors = new MemoryCursorStore();
    const outs = await all(await render(structured(rows), { budget: 800, format: 'json', secrets: [secret] }, { cursors }), cursors);
    expect(outs.length).toBeGreaterThan(2);
    for (const o of outs) {
      expect(o.stdout).not.toContain(secret);
      expect(o.stdout).toContain('token *** in row');
    }
  });
});
