// The stderr meta line (output.md, "元信息行"):
//   · <canonical ref> · <elapsed> · <rows or bytes> [· +N cols: a, b (--pick a,b or -o json)] [· <flag>…] [· next: <command>]

import { visibleText } from './shell';

/** Names of hidden columns the meta line lists; the rest is `…`. */
export const MAX_HIDDEN_NAMES = 8;
/**
 * A column name is a key of the server's result. Only a plain word is repeated in the meta line:
 * anything else (spaces, `·`, `:`) could pass for a field or a `next:` hint of the line itself.
 */
const PLAIN_NAME = /^[\p{L}\p{N}_.$@-]{1,40}$/u;

export interface MetaInfo {
  /** Canonical tool reference, e.g. `github issue:list`. */
  ref: string;
  elapsedMs: number;
  /** Table rows or list items shown, when the result is a list. */
  rows?: number;
  /** Bytes shown / total bytes; `total` greater than `shown` means truncated. */
  bytes: { shown: number; total: number };
  hiddenColumns?: number;
  /** Names of the hidden columns, in the order they appear in the result. */
  hiddenNames?: string[];
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

/** `+8 cols: priority, assignee, … (--pick a,b or -o json)`: what the tables left out and how to get it. */
function hiddenField(count: number, names: readonly string[]): string {
  const plain = names.filter((name) => PLAIN_NAME.test(name));
  const listed = plain.slice(0, MAX_HIDDEN_NAMES);
  if (listed.length === 0) return `+${count} cols (--pick a,b or -o json)`;
  return `+${count} cols: ${listed.join(', ')}${count > listed.length ? ', …' : ''} (--pick a,b or -o json)`;
}

export function formatMetaLine(info: MetaInfo): string {
  const truncated = info.bytes.total > info.bytes.shown;
  const size = truncated
    ? `${formatBytes(info.bytes.shown)}/${formatBytes(info.bytes.total)} bytes`
    : info.rows !== undefined
      ? `${info.rows} ${info.rows === 1 ? 'row' : 'rows'}`
      : `${formatBytes(info.bytes.total)} bytes`;
  const fields = [visibleText(info.ref), formatElapsed(info.elapsedMs), size];
  if (info.hiddenColumns && info.hiddenColumns > 0) fields.push(hiddenField(info.hiddenColumns, info.hiddenNames ?? []));
  for (const flag of info.flags ?? []) fields.push(flag);
  if (info.next) fields.push(`next: ${info.next}`);
  return `· ${fields.join(' · ')}`;
}
