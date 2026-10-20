import claudeCode from '../../data/frameworks/claude-code.json';
import claudeDesktop from '../../data/frameworks/claude-desktop.json';
import codex from '../../data/frameworks/codex.json';
import cursor from '../../data/frameworks/cursor.json';
import vscode from '../../data/frameworks/vscode.json';
import windsurf from '../../data/frameworks/windsurf.json';

export type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'yaml';

/** One config file of a framework (data-files.md, "frameworks"). */
export interface FrameworkConfigFile {
  path: string;
  format: ConfigFormat;
  /** JSON Pointer to the server map. */
  pointer: string;
  scope: 'user' | 'project';
  /** Absent means every platform. */
  platforms?: NodeJS.Platform[];
}

/** Shape of `data/frameworks/<id>.json`. */
export interface FrameworkDef {
  id: string;
  name: string;
  configs: FrameworkConfigFile[];
  disableHint: string;
  /** `YYYY-MM` of the last check against an installed version; null when never checked. */
  verifiedAt: string | null;
  notes?: string;
}

/** Bundled frameworks. The order is the `auto` probe order, which decides conflicts (config.md). */
export const BUNDLED_FRAMEWORKS: readonly FrameworkDef[] = [
  claudeCode,
  claudeDesktop,
  cursor,
  codex,
  vscode,
  windsurf,
] as FrameworkDef[];

/** Server-map locations tried, in order, for a file given by path in `sources` (no pointer known). */
export const DEFAULT_POINTERS: readonly string[] = ['/mcpServers', '/servers', '/mcp_servers'];

export function findFramework(id: string, frameworks: readonly FrameworkDef[] = BUNDLED_FRAMEWORKS): FrameworkDef | undefined {
  return frameworks.find((f) => f.id === id);
}
