// The stderr meta line (output.md, "元信息行"):
//   · <canonical ref> · <elapsed> · <rows or bytes> [· +N cols (-o json)] [· <flag>…] [· next: <command>]

import { visibleText } from './shell';

export interface MetaInfo {
  /** Canonical tool reference, e.g. `github issue:list`. */
  ref: string;
  elapsedMs: number;
  /** Table rows or list items shown, when the result is a list. */
  rows?: number;
  /** Bytes shown / total bytes; `total` greater than `shown` means truncated. */
  bytes: { shown: number; total: number };
  hiddenColumns?: number;
  /** Extra markers such as `unvalidated`. */
  flags?: string[];
  next?: string;
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 812 -> `812`, 8192 -> `8.0k` (1024-based, as in the examples of output.md). */
export function formatBytes(n: number): string {
  return n < 1024 ? String(n) : `${(n / 1024).toFixed(1)}k`;
}

export function formatMetaLine(info: MetaInfo): string {
  const truncated = info.bytes.total > info.bytes.shown;
  const size = truncated
    ? `${formatBytes(info.bytes.shown)}/${formatBytes(info.bytes.total)} bytes`
    : info.rows !== undefined
      ? `${info.rows} ${info.rows === 1 ? 'row' : 'rows'}`
      : `${formatBytes(info.bytes.total)} bytes`;
  const fields = [visibleText(info.ref), formatElapsed(info.elapsedMs), size];
  if (info.hiddenColumns && info.hiddenColumns > 0) fields.push(`+${info.hiddenColumns} cols (-o json)`);
  for (const flag of info.flags ?? []) fields.push(flag);
  if (info.next) fields.push(`next: ${info.next}`);
  return `· ${fields.join(' · ')}`;
}
