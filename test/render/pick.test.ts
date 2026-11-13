import { describe, expect, it } from 'vitest';
import { githubIssue, githubIssues } from '../fixtures/results';
import { parsePick } from '../../src/cli/options';
import { pickValue } from '../../src/render/pick';
import { formatMetaLine } from '../../src/render/meta';
import { jsonText, plainText, render, structured } from '../helpers/render';

// `--pick` (output.md, "选字段"): the fields of a result to print.

const linear = {
  issues: [
    { id: 'u-1', identifier: 'PLT-300', title: 'Rate limiter fails closed', priority: { value: 2, name: 'High' }, status: 'In Progress', labels: [{ name: 'Bug', color: 'red' }, { name: 'P1', color: 'blue' }], createdAt: '2026-09-21' },
    { id: 'u-2', identifier: 'PLT-304', title: 'Migrate billing webhooks', priority: { value: 3, name: 'Medium' }, status: 'In Progress', labels: [{ name: 'Chore', color: 'grey' }], createdAt: '2026-09-22' },
  ],
  hasNextPage: false,
};

describe('parsePick', () => {
  it('splits on commas, trims and drops repeats and empty names', () => {
    expect(parsePick('title, state,,title ,priority.name')).toEqual(['title', 'state', 'priority.name']);
    expect(parsePick(' , ')).toEqual([]);
  });
});

describe('pickValue', () => {
  it('cuts the rows of a table down to the names, in the order asked for', () => {
    const out = pickValue(linear.issues, ['status', 'identifier'], true);
    expect(out.value).toEqual([
      { status: 'In Progress', identifier: 'PLT-300' },
      { status: 'In Progress', identifier: 'PLT-304' },
    ]);
    expect(out.tables.get(out.value as object)).toEqual(['status', 'identifier']);
    expect(out.unknown).toEqual([]);
  });

  it('goes one level down when a wrapper has none of the names, and keeps the wrapper', () => {
    const out = pickValue(linear, ['identifier', 'title'], false);
    expect(out.value).toEqual({
      issues: [
        { identifier: 'PLT-300', title: 'Rate limiter fails closed' },
        { identifier: 'PLT-304', title: 'Migrate billing webhooks' },
      ],
      hasNextPage: false,
    });
  });

  it('applies at the outermost match only: a picked key keeps its whole value', () => {
    const out = pickValue({ id: 1, labels: [{ id: 7, name: 'bug' }, { id: 8, name: 'p1' }], state: 'open' }, ['id', 'labels'], false);
    expect(out.value).toEqual({ id: 1, labels: [{ id: 7, name: 'bug' }, { id: 8, name: 'p1' }] });
  });

  it('reaches into objects and through arrays with a dotted name', () => {
    const flat = pickValue(linear.issues, ['identifier', 'priority.name', 'labels.name'], true);
    expect(flat.value).toEqual([
      { identifier: 'PLT-300', 'priority.name': 'High', 'labels.name': ['Bug', 'P1'] },
      { identifier: 'PLT-304', 'priority.name': 'Medium', 'labels.name': ['Chore'] },
    ]);
    const nested = pickValue(linear.issues, ['priority.name', 'priority.value', 'labels.name'], false);
    expect((nested.value as unknown[])[0]).toEqual({ priority: { name: 'High', value: 2 }, labels: [{ name: 'Bug' }, { name: 'P1' }] });
  });

  it('matches a name whatever its case and separators, and prefers the exact key', () => {
    expect(pickValue({ createdAt: 'a', html_url: 'b' }, ['created-at', 'HTML_URL'], false).value).toEqual({ createdAt: 'a', html_url: 'b' });
    expect(pickValue({ 'a.b': 1, a: { b: 2 } }, ['a.b'], false).value).toEqual({ 'a.b': 1 });
    expect(pickValue({ created_at: 1, createdAt: 2 }, ['createdAt'], false).value).toEqual({ createdAt: 2 });
  });

  it('reports a name that matched nothing, with the fields of the place it looked in', () => {
    const typo = pickValue(linear, ['identifier', 'priorty'], true);
    expect(typo.unknown).toEqual(['priorty']);
    expect(typo.available).toEqual(['id', 'identifier', 'title', 'priority', 'status', 'labels', 'createdAt']);

    const none = pickValue(linear, ['nope'], true);
    expect(none.value).toBe(linear);
    expect(none.unknown).toEqual(['nope']);
    // the rows of the first table, not the wrapper's keys
    expect(none.available).toEqual(['id', 'identifier', 'title', 'priority', 'status', 'labels', 'createdAt']);

    expect(pickValue({ a: 1, b: 2 }, ['c'], true).available).toEqual(['a', 'b']);
    expect(pickValue('text', ['c'], true)).toMatchObject({ value: 'text', unknown: ['c'], available: [] });
  });

  it('leaves non-object items of an array alone and gives a row without the fields no keys', () => {
    expect(pickValue([{ a: 1, b: 2 }, 'x', { b: 3 }], ['a'], false).value).toEqual([{ a: 1 }, 'x', {}]);
  });
});

describe('rendering with --pick', () => {
  it('shows a table of exactly the picked columns, without the column limit and without +N cols', async () => {
    const out = await render(structured(githubIssues), { pick: ['number', 'title', 'state', 'comments', 'created_at', 'updated_at', 'html_url', 'user.login'] });
    const header = out.stdout.split('\n')[0]!.trim().split(/\s{2,}/);
    expect(header).toEqual(['number', 'title', 'state', 'comments', 'created_at', 'updated_at', 'html_url', 'user.login']);
    expect(out.stderr).not.toContain('cols');
    expect(out.stderr).toMatch(/^· github issue:list · 318ms · 3 rows\n$/);
  });

  it('keeps a wrapper around a picked table, a dotted name as its own column and a missing cell as -', async () => {
    const out = await render(structured({ ...linear, issues: [...linear.issues, { identifier: 'PLT-305', title: 'No priority yet' }] }), { pick: ['identifier', 'priority.name', 'labels.name'] });
    expect(out.stdout).toBe(
      ['issues:', '  identifier  priority.name  labels.name', '  PLT-300     High           Bug, P1', '  PLT-304     Medium         Chore', '  PLT-305     -              -', 'hasNextPage: false', ''].join('\n'),
    );
  });

  it('keeps a one-column table a table, and a single row an object', async () => {
    const one = await render(structured({ rows: [{ a: 'x', b: 1 }, { a: 'y', b: 2 }] }), { pick: ['a'] });
    expect(one.stdout).toBe('rows:\n  a\n  x\n  y\n');
    const single = await render(structured([{ a: 'x', b: 1 }]), { pick: ['b', 'a'] });
    expect(single.stdout).toBe('b: 1\na: x\n');
  });

  it('cuts an object down to the picked keys, in the order asked for', async () => {
    const out = await render(structured(githubIssue), { pick: ['state', 'number', 'user.login'] });
    expect(out.stdout).toBe(`state: ${githubIssue.state}\nnumber: ${githubIssue.number}\nuser.login: ${githubIssue.user.login}\n`);
  });

  it('applies to -o json and keeps the nesting', async () => {
    const out = await render(jsonText(linear), { format: 'json', pick: ['identifier', 'priority.name'] });
    expect(JSON.parse(out.stdout)).toEqual({
      issues: [
        { identifier: 'PLT-300', priority: { name: 'High' } },
        { identifier: 'PLT-304', priority: { name: 'Medium' } },
      ],
      hasNextPage: false,
    });
  });

  it('warns about a name that matched nothing, lists the fields, and still prints the result', async () => {
    const typo = await render(structured(linear), { pick: ['identifier', 'priorty'] });
    expect(typo.exitCode).toBe(0);
    expect(typo.stdout).toContain('PLT-300');
    expect(typo.stderr).toMatch(/^warning: --pick: no field named priorty \(fields: id, identifier, title, priority, status, labels, createdAt\)\n· /);
    expect(typo.warnings).toEqual(['--pick: no field named priorty (fields: id, identifier, title, priority, status, labels, createdAt)']);

    const none = await render(structured(linear), { pick: ['nope'] });
    const plain = await render(structured(linear));
    expect(none.stdout).toBe(plain.stdout);

    const text = await render(plainText('just text'), { pick: ['title'] });
    expect(text.stdout).toBe('just text\n');
    expect(text.stderr).toMatch(/^warning: --pick chooses fields of a structured result; this one has none\n/);
  });

  it('lists at most 24 fields in the warning and never a control character', async () => {
    const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, i]));
    const out = await render(structured({ ...wide, 'bad\u001b[31mname': 1 }), { pick: ['zzz'] });
    expect(out.warnings![0]).toMatch(/field23, …\)$/);
    expect(out.stderr).not.toMatch(/\u001b/);
  });
});

describe('hidden column names in the meta line', () => {
  it('names the columns a table left out, eight at most', async () => {
    const out = await render(structured(githubIssues));
    expect(out.meta?.hiddenNames).toEqual(['labels', 'comments', 'created_at', 'updated_at', 'assignee']);
    expect(out.stderr).toContain('· +5 cols: labels, comments, created_at, updated_at, assignee (--pick a,b or -o json)\n');

    const wide = (i: number) => ({ name: `n${i}`, title: 't', id: i, number: i, state: 's', url: 'u', ...Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`extra${k}`, k])) });
    const many = await render(structured([wide(1), wide(2)]));
    expect(many.stderr).toContain('· +10 cols: extra0, extra1, extra2, extra3, extra4, extra5, extra6, extra7, … (--pick a,b or -o json)\n');
  });

  it('lists every name when there are few, and none of them under -o json', async () => {
    const rows = [{ name: 'a', title: 't', id: 1, number: 1, state: 's', url: 'u', extra: 1, more: 2 }, { name: 'b', title: 't', id: 2, number: 2, state: 's', url: 'u', extra: 1, more: 2 }];
    expect((await render(structured(rows))).stderr).toContain('· +2 cols: extra, more (--pick a,b or -o json)\n');
    expect((await render(structured(rows), { format: 'json' })).stderr).not.toContain('cols');
  });

  it('only repeats plain words: a name that could pass for part of the line is counted, not shown', () => {
    const line = formatMetaLine({ ref: 'x y', elapsedMs: 1, rows: 2, bytes: { shown: 1, total: 1 }, hiddenColumns: 3, hiddenNames: ['ok_name', 'x · next: via trust', 'a b'] });
    expect(line).toBe('· x y · 1ms · 2 rows · +3 cols: ok_name, … (--pick a,b or -o json)');
    expect(formatMetaLine({ ref: 'x y', elapsedMs: 1, rows: 2, bytes: { shown: 1, total: 1 }, hiddenColumns: 1, hiddenNames: ['a: b'] })).toBe('· x y · 1ms · 2 rows · +1 cols (--pick a,b or -o json)');
    // cursors written before the names were kept
    expect(formatMetaLine({ ref: 'x y', elapsedMs: 1, rows: 2, bytes: { shown: 1, total: 1 }, hiddenColumns: 4 })).toBe('· x y · 1ms · 2 rows · +4 cols (--pick a,b or -o json)');
  });

  it('keeps the names on the pages of a truncated table', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ name: `row ${i}`, title: 't', id: i, number: i, state: 's', url: 'u', extra: 1, more: 2 }));
    const { MemoryCursorStore, renderMore } = await import('../../src/render');
    const cursors = new MemoryCursorStore();
    const first = await render(structured(rows), { budget: 1024 }, { cursors });
    expect(first.stderr).toContain('+2 cols: extra, more (--pick a,b or -o json)');
    const id = /via more (\w+)/.exec(first.stderr)![1]!;
    const second = await renderMore(id, { elapsedMs: 0, cursors });
    expect(second.stderr).toContain('+2 cols: extra, more (--pick a,b or -o json)');
  });
});
