// Shared catalog types. Terminology follows docs/overview/glossary.md.

/** Subset of an MCP `tools/list` entry that the catalog reads. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  [key: string]: unknown;
}

/** One top-level tool parameter, as shown in signatures. */
export interface ParamInfo {
  /** Name exactly as declared in the input schema. */
  name: string;
  /** kebab-case command-line spelling (arguments.md). */
  arg: string;
  required: boolean;
}

/** A tool after name splitting (naming.md). */
export interface CatalogTool {
  provider: string;
  /** Original MCP tool name. Always valid as an alias. */
  rawName: string;
  /** Resource part; null for leaf tools. */
  resource: string | null;
  /** Verb part; null for leaf tools. */
  verb: string | null;
  /** Tool part of the canonical form: `issue:create`, or the leaf name `search`. */
  name: string;
  /** Canonical command-line form: `github issue:create`. */
  ref: string;
  /** Single-string form used by `deny`, `via call` and logs: `github/issue:create`. */
  singleRef: string;
  description: string;
  params: ParamInfo[];
  readOnly: boolean;
  destructive: boolean;
  /** True when the canonical form came from a user `rename` entry. */
  renamed: boolean;
  def: McpTool;
}

export interface ResourceGroup {
  name: string;
  /** Tools of this resource, in `tools/list` order. */
  tools: CatalogTool[];
}

export type DomainSource = 'config' | 'builtin' | 'heuristic' | 'other';

export interface DomainScore {
  score: number;
  /** Highest-contributing terms, best first. */
  terms: string[];
}

export interface DomainAssignment {
  source: DomainSource;
  /** Always at least one entry; `other` when nothing matched. */
  domains: Array<{ domain: string; /** Set when a provider is split across domains by resource. */ resources?: string[] }>;
  /** Normalised confidence of the winning domain (heuristic only). */
  confidence?: number;
  /** Per-domain evidence (heuristic only), best first. For `via servers --why`. */
  scores?: Record<string, DomainScore>;
}

export interface ProviderCatalog {
  provider: string;
  tools: CatalogTool[];
  /** Resource groups sorted by name. */
  resources: ResourceGroup[];
  /** Leaf tools in `tools/list` order. */
  leaves: CatalogTool[];
  domain: DomainAssignment;
}

export interface CatalogWarning {
  provider: string;
  code: 'reserved-name' | 'duplicate-provider';
  message: string;
}

export interface Catalog {
  providers: ProviderCatalog[];
  warnings: CatalogWarning[];
}
