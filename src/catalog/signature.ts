import type { JsonSchema, ParamInfo } from './types';
import { kebab } from './tokenize';

/** Maximum parameters shown in a one-line signature; required ones are never cut. */
export const SIGNATURE_MAX_PARAMS = 6;

/**
 * Top-level parameters of an input schema: required first, then optional, each group in
 * schema `properties` order. Names are kebab-cased unless two parameters would collide
 * after normalisation, in which case both keep their original names (arguments.md).
 */
export function extractParams(schema: JsonSchema | undefined): ParamInfo[] {
  const props = schema?.properties ?? {};
  const requiredSet = new Set(schema?.required ?? []);
  const names = [...Object.keys(props), ...[...requiredSet].filter((n) => !(n in props))];

  const kebabCount = new Map<string, number>();
  for (const n of names) kebabCount.set(kebab(n), (kebabCount.get(kebab(n)) ?? 0) + 1);

  const all = names.map((name): ParamInfo => {
    const k = kebab(name);
    return { name, arg: (kebabCount.get(k) ?? 0) > 1 ? name : k, required: requiredSet.has(name) };
  });
  return [...all.filter((p) => p.required), ...all.filter((p) => !p.required)];
}

/** `owner, repo, [state], [labels]` — required first, optional in brackets. */
export function formatSignature(params: readonly ParamInfo[], maxParams = SIGNATURE_MAX_PARAMS): string {
  const required = params.filter((p) => p.required);
  const optional = params.filter((p) => !p.required);
  const room = Math.max(0, maxParams - required.length);
  const shown = optional.slice(0, room);
  const parts = [...required.map((p) => p.arg), ...shown.map((p) => `[${p.arg}]`)];
  if (shown.length < optional.length) parts.push('…');
  return parts.join(', ');
}

/** First non-empty line of a description, whitespace collapsed, cut to `max` characters. */
export function shortDescription(description: string, max = 60): string {
  const line =
    description
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const chars = Array.from(line.replace(/\s+/g, ' '));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}
