// MCP `tools/call` result shapes, as far as rendering needs them.

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string; description?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface ToolResult {
  content?: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type OutputFormat = 'text' | 'json' | 'raw';
