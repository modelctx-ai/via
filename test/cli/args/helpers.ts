import type { JsonSchema, McpTool } from '../../../src/catalog/types';
import { argsErrorLines, parseToolArgs, ToolArgsError, type ParsedToolArgs, type ParseToolArgsOptions, type ToolArgsContext, type ToolArgsIO } from '../../../src/cli/args';
import { createRedactor } from '../../../src/render/redact';
import { FAKE_SECRET } from '../../helpers/render';

export { FAKE_SECRET };

export interface MemoryIO extends ToolArgsIO {
  stdinReads: number;
  fileReads: string[];
}

/** In-memory files and stdin; a missing file rejects like fs does. */
export function memoryIO(files: Record<string, string> = {}, stdin = ''): MemoryIO {
  const io: MemoryIO = {
    stdinReads: 0,
    fileReads: [],
    async readFile(path) {
      io.fileReads.push(path);
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
      return text;
    },
    async readStdin() {
      io.stdinReads++;
      return stdin;
    },
  };
  return io;
}

/** Test schemas are written inline; they are checked at run time, not by the compiler. */
export type SchemaLike = object | undefined;

export function makeTool(inputSchema: SchemaLike, extra: Partial<McpTool> = {}): McpTool {
  return { name: 'thing_do', description: 'Do the thing', inputSchema: inputSchema as McpTool['inputSchema'], ...extra };
}

export const CTX: ToolArgsContext = { provider: 'acme', ref: 'acme thing:do', rawName: 'thing_do', readOnly: false, destructive: false };

export interface RunOptions extends Partial<ParseToolArgsOptions> {
  files?: Record<string, string>;
  stdin?: string;
  ctx?: Partial<ToolArgsContext>;
}

export function parse(schema: SchemaLike, argv: string[], opts: RunOptions = {}): Promise<ParsedToolArgs> {
  const io = opts.io ?? memoryIO(opts.files, opts.stdin);
  return parseToolArgs(argv, makeTool(schema), { ...CTX, ...opts.ctx }, { io, validate: opts.validate ?? true, redact: opts.redact });
}

export async function args(schema: SchemaLike, argv: string[], opts: RunOptions = {}): Promise<Record<string, unknown>> {
  return (await parse(schema, argv, opts)).args;
}

/** The ToolArgsError a call throws. */
export async function failure(schema: SchemaLike, argv: string[], opts: RunOptions = {}): Promise<ToolArgsError> {
  try {
    await parse(schema, argv, opts);
  } catch (e) {
    if (e instanceof ToolArgsError) return e;
    throw e;
  }
  throw new Error('expected parseToolArgs to fail');
}

export const redactFake = createRedactor([FAKE_SECRET]);

// Schemas shaped like the examples in arguments.md ---------------------------------------------

export const ISSUE_LIST: JsonSchema = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    repo: { type: 'string' },
    state: { type: 'string', enum: ['open', 'closed', 'all'] },
    per_page: { type: 'integer', maximum: 100 },
    title: { type: 'string', maxLength: 256 },
  },
  required: ['owner', 'repo'],
  additionalProperties: false,
};

export const ISSUE_READ: JsonSchema = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    repo: { type: 'string' },
    issue_number: { type: 'integer' },
    method: {
      type: 'string',
      enum: ['get', 'get_comments', 'get_sub_issues', 'get_parent', 'get_labels'],
      description:
        'Possible values:\n1. get - Get issue details\n2. get_comments - Get issue comments\n3. get_sub_issues - Get sub-issues\n4. get_parent - Get the parent issue\n5. get_labels - Get labels',
    },
    page: { type: 'integer' },
    perPage: { type: 'integer' },
  },
  required: ['owner', 'repo', 'issue_number', 'method'],
  additionalProperties: false,
};

/** Notion-like create-pages: `parent` is one of three shapes told apart by their id field. */
export const NOTION_PARENT: JsonSchema = {
  type: 'object',
  properties: {
    parent: {
      oneOf: [
        {
          type: 'object',
          properties: { type: { type: 'string', const: 'page_id' }, page_id: { type: 'string' } },
          required: ['type', 'page_id'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { type: { type: 'string', const: 'database_id' }, database_id: { type: 'string' } },
          required: ['type', 'database_id'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { type: { type: 'string', enum: ['data_source_id'] }, data_source_id: { type: 'string' } },
          required: ['type', 'data_source_id'],
          additionalProperties: false,
        },
      ],
    },
    pages: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    },
  },
  required: ['pages'],
};

/** What the CLI prints for a ToolArgsError (output.md, "错误"): reason, detail lines, usage, next. */
export function renderError(err: ToolArgsError): string {
  return [`error: ${err.message}`, ...argsErrorLines(err), ...(err.next ? [`next: ${err.next}`] : [])].join('\n');
}
