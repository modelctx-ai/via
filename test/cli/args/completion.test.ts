import { describe, expect, it } from 'vitest';
import { NOTION_PARENT, args, failure } from './helpers';

const PAGES = ['--pages', '[{"title":"Roadmap"}]'];

// arguments.md, "anyOf / oneOf 自动补齐": a Notion-like `parent` told apart by its id field.
describe('anyOf / oneOf completion', () => {
  it('fills in type: "page_id" once page_id picks the branch', async () => {
    expect(await args(NOTION_PARENT, [...PAGES, '--parent.page-id', 'abc'])).toEqual({
      pages: [{ title: 'Roadmap' }],
      parent: { page_id: 'abc', type: 'page_id' },
    });
  });

  it('works for JSON input and for every branch (const and single-value enum)', async () => {
    expect((await args(NOTION_PARENT, [...PAGES, '--parent', '{"database_id":"d"}'])).parent).toEqual({ database_id: 'd', type: 'database_id' });
    expect((await args(NOTION_PARENT, [...PAGES, '--parent', '{"data_source_id":"s"}'])).parent).toEqual({ data_source_id: 's', type: 'data_source_id' });
    expect((await args(NOTION_PARENT, ['--args', '{"pages":[{"title":"t"}],"parent":{"page_id":"p"}}'])).parent).toEqual({ page_id: 'p', type: 'page_id' });
  });

  it('keeps an explicit type', async () => {
    expect((await args(NOTION_PARENT, [...PAGES, '--parent.page_id', 'a', '--parent.type', 'page_id'])).parent).toEqual({ page_id: 'a', type: 'page_id' });
  });

  it('does nothing when the branch is not uniquely determined', async () => {
    const both = await failure(NOTION_PARENT, [...PAGES, '--parent', '{"page_id":"a","database_id":"b"}']);
    expect(both.issues[0]?.arg).toBe('--parent');
    expect(both.details.some((d) => d.path === '/parent/type')).toBe(false);
  });

  it('does nothing without any field to decide on, and reports the options', async () => {
    const err = await failure(NOTION_PARENT, [...PAGES, '--parent', '{}']);
    expect(err.issues).toEqual([{ arg: '--parent', message: 'must provide one of: page_id, database_id, data_source_id' }]);
  });

  it('leaves a parameter alone that was not given', async () => {
    expect(await args(NOTION_PARENT, PAGES)).toEqual({ pages: [{ title: 'Roadmap' }] });
  });

  it('conflicting explicit values are not overwritten', async () => {
    const err = await failure(NOTION_PARENT, [...PAGES, '--parent.page-id', 'a', '--parent.type', 'database_id']);
    expect(err.issues.map((i) => i.arg)).toContain('--parent');
  });

  it('completes inside array elements and at the root', async () => {
    const nested = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            anyOf: [
              { type: 'object', properties: { kind: { const: 'text' }, text: { type: 'string' } }, required: ['kind', 'text'] },
              { type: 'object', properties: { kind: { const: 'image' }, url: { type: 'string' } }, required: ['kind', 'url'] },
            ],
          },
        },
      },
    };
    expect((await args(nested, ['--items', '[{"text":"hi"},{"url":"u"}]'])).items).toEqual([
      { text: 'hi', kind: 'text' },
      { url: 'u', kind: 'image' },
    ]);
    const rooted = {
      type: 'object',
      oneOf: [
        { properties: { action: { const: 'start' }, job: { type: 'string' } }, required: ['action', 'job'] },
        { properties: { action: { const: 'stop' }, all: { type: 'boolean' } }, required: ['action', 'all'] },
      ],
    };
    expect(await args(rooted, ['--job', 'j'])).toEqual({ job: 'j', action: 'start' });
    expect(await args(rooted, ['--all'])).toEqual({ all: true, action: 'stop' });
  });

  it('follows $ref into the branches', async () => {
    const s = {
      type: 'object',
      $defs: {
        byPage: { type: 'object', properties: { type: { const: 'page' }, page: { type: 'string' } }, required: ['page'] },
        byDb: { type: 'object', properties: { type: { const: 'db' }, db: { type: 'string' } }, required: ['db'] },
      },
      properties: { parent: { oneOf: [{ $ref: '#/$defs/byPage' }, { $ref: '#/$defs/byDb' }] } },
    };
    expect((await args(s, ['--parent.db', 'x'])).parent).toEqual({ db: 'x', type: 'db' });
  });
});
