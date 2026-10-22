// Resources and prompts as text (ADR 0010; cli.md, `via resources|read|prompts`): the pure part.
// Everything here turns MCP results into the shapes the render pipeline already handles, so the
// budget, cursors, media files and redaction apply without a second implementation.
import type { JsonSchema, McpTool } from '../catalog/types';
import { extractParams, formatSignature, shortDescription } from '../catalog/signature';
import type { CompletionResult, GetPromptResult, McpPrompt, ReadResourceResult, ResourceListing } from '../protocol';
import type { ContentBlock, OutputFormat, ToolResult } from '../render/types';
import { shellWords, visibleText } from '../render/shell';
import { alignRows } from '../render/width';

// Resources ------------------------------------------------------------------------------

/** `via resources <provider>`: one row per resource, then the templates (uri, type, name, description). */
export function resourceListing(listing: ResourceListing, provider: string, format: OutputFormat): ToolResult {
  if (format === 'json') return { content: [], structuredContent: { resources: listing.resources, templates: listing.templates } };
  const row = (uri: string, item: { mimeType?: string; name: string; title?: string; description?: string }): string[] => [
    uri,
    item.mimeType ?? '-',
    item.title ?? item.name,
    item.description ? shortDescription(item.description) : '',
  ];
  const lines: string[] = [];
  if (listing.resources.length === 0 && listing.templates.length === 0) lines.push('(no resources)');
  lines.push(...alignRows(listing.resources.map((r) => row(r.uri, r))));
  if (listing.templates.length > 0) {
    lines.push('templates:', ...alignRows(listing.templates.map((t) => row(t.uriTemplate, t))));
  }
  if (listing.resources.length + listing.templates.length > 0) {
    lines.push(`→ via read ${shellWords(provider)} <uri>${listing.templates.length > 0 ? ' (replace the {placeholders} of a template)' : ''}`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

/** `via read`: each content becomes a `resource` block; several contents get a `# <uri>` line each. */
export function readResult(result: ReadResourceResult): ToolResult {
  const many = result.contents.length > 1;
  const content: ContentBlock[] = [];
  for (const item of result.contents) {
    if (many) content.push({ type: 'text', text: `# ${item.uri}` });
    content.push({
      type: 'resource',
      resource: { uri: item.uri, ...(item.mimeType ? { mimeType: item.mimeType } : {}), ...(item.text !== undefined ? { text: item.text } : {}), ...(item.blob !== undefined ? { blob: item.blob } : {}) },
    });
  }
  return { content };
}

// Prompts --------------------------------------------------------------------------------

/**
 * A prompt's arguments (a flat list of named strings) as the object schema of a tool, so the
 * tool argument parser, `-h` and local validation serve prompts too (arguments.md).
 */
export function promptTool(prompt: McpPrompt): McpTool {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const arg of prompt.arguments ?? []) {
    const description = arg.description ?? arg.title;
    properties[arg.name] = { type: 'string', ...(description ? { description } : {}) };
    if (arg.required) required.push(arg.name);
  }
  return {
    name: prompt.name,
    ...(prompt.description ? { description: prompt.description } : {}),
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}

/** `via prompts <provider>`: name, signature, description. */
export function promptListing(prompts: readonly McpPrompt[], provider: string, format: OutputFormat): ToolResult {
  if (format === 'json') return { content: [], structuredContent: prompts };
  if (prompts.length === 0) return { content: [{ type: 'text', text: '(no prompts)' }] };
  const rows = prompts.map((p) => {
    const row = [visibleText(p.name), formatSignature(extractParams(promptTool(p).inputSchema))];
    const description = p.description ? shortDescription(p.description) : '';
    if (description) row.push(description);
    return row;
  });
  return { content: [{ type: 'text', text: [...alignRows(rows), `→ via prompts ${shellWords(provider)} <name> -h for usage`].join('\n') }] };
}

/**
 * `via prompts <provider> <name>`: the messages. Text mode and `-o raw` print `[role]` followed by
 * the content; `-o json` gives `{description?, messages: [{role, content}]}` where binary content is
 * described, never inlined.
 */
export function promptResult(result: GetPromptResult, format: OutputFormat): ToolResult {
  if (format === 'json') {
    const messages = result.messages.map((m) => ({ role: m.role, content: jsonContent(m.content) }));
    return { content: [], structuredContent: { ...(result.description ? { description: result.description } : {}), messages } };
  }
  const content: ContentBlock[] = [];
  for (const message of result.messages) {
    if (message.content.type === 'text') content.push({ type: 'text', text: `[${message.role}]\n${message.content.text}` });
    else content.push({ type: 'text', text: `[${message.role}]` }, message.content);
  }
  return { content };
}

function jsonContent(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
    case 'audio':
      return { type: block.type, mimeType: block.mimeType };
    case 'resource_link':
      return block;
    case 'resource':
      return { type: 'resource', uri: block.resource.uri, ...(block.resource.mimeType ? { mimeType: block.resource.mimeType } : {}), ...(block.resource.text !== undefined ? { text: block.resource.text } : {}) };
  }
}

// Completion -----------------------------------------------------------------------------

/**
 * The variable names of an RFC 6570 URI template, in order and without repeats: `{+path}`, `{/a,b*}` and
 * `{?q:3}` name `path`, `a`, `b` and `q`. These are the argument names `completion/complete` knows for a
 * resource template.
 */
export function templateVariables(uriTemplate: string): string[] {
  const names: string[] = [];
  for (const expression of uriTemplate.matchAll(/\{([^{}]*)\}/g)) {
    for (const part of expression[1]!.replace(/^[+#./;?&=,!@|]/, '').split(',')) {
      const name = part.replace(/(\*|:\d+)$/, '').trim();
      if (name !== '' && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** A resource template's variables as the string-only tool schema the argument parser takes (the way {@link promptTool} does for a prompt). */
export function templateTool(template: { uriTemplate: string; description?: string }): McpTool {
  const properties: Record<string, JsonSchema> = {};
  for (const name of templateVariables(template.uriTemplate)) properties[name] = { type: 'string' };
  return { name: template.uriTemplate, ...(template.description ? { description: template.description } : {}), inputSchema: { type: 'object', properties, required: [], additionalProperties: false } };
}

/** `--complete`: the server's suggestions, one per line in its order (`-o json`: `{values, total?, hasMore?}`). */
export function completionResult(result: CompletionResult, format: OutputFormat): ToolResult {
  if (format === 'json') return { content: [], structuredContent: result };
  const lines = result.values.map((v) => visibleText(v));
  if (lines.length === 0) lines.push('(no suggestions)');
  else if (result.hasMore === true || (result.total !== undefined && result.total > result.values.length)) {
    lines.push(`(${result.values.length}${result.total !== undefined ? ` of ${result.total}` : ''} shown; more match, type more of the value)`);
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
