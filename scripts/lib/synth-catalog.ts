// Deterministic synthetic catalogs for the performance benchmark and its tests. The real
// `tools/list` fixtures hold fewer than 300 tools; this multiplies them into an arbitrary size by
// cloning providers under new names and perturbing tool names and descriptions with a seeded
// PRNG, so the same options always produce byte-identical output on every machine.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { McpTool, ProviderInput } from '../../src/catalog';

export interface SynthOptions {
  /** Total number of tools; default 1000. */
  tools?: number;
  /** Number of providers the tools are spread over; default 50. */
  providers?: number;
  /** PRNG seed; default 1. */
  seed?: number;
}

/** A real provider's `tools/list` to derive tools from. */
export interface BaseProvider {
  provider: string;
  tools: McpTool[];
}

// Suffixes for tool names and provider clones, and filler sentences for descriptions. Plain nouns,
// so perturbed names still split into a sensible `resource:verb`.
const NOUNS = ['label', 'milestone', 'webhook', 'snapshot', 'template', 'archive', 'token', 'workspace', 'schedule', 'report', 'channel', 'invoice'];
const CLONE_SUFFIX = ['eu', 'staging', 'labs', 'edge', 'prod', 'beta', 'internal', 'mirror'];
const FILLER = [
  'Works across every workspace the account can reach.',
  'Returns at most one page of results.',
  'Requires the caller to hold write access.',
  'Results are cached for a short time.',
];

/** mulberry32: tiny seeded PRNG, enough for reproducible perturbation. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `options.tools` tools in `options.providers` providers (the first ones take the remainder).
 * Provider i clones `bases[i % bases.length]`; tools are taken in order and, once a base runs out
 * (or on a clone), renamed with a seeded noun suffix and given an extra description sentence.
 */
export function synthesizeProviders(bases: readonly BaseProvider[], options: SynthOptions = {}): ProviderInput[] {
  const total = options.tools ?? 1000;
  const count = options.providers ?? 50;
  const random = prng(options.seed ?? 1);
  const sorted = [...bases].filter((b) => b.tools.length > 0).sort((a, b) => (a.provider < b.provider ? -1 : 1));
  if (sorted.length === 0) throw new Error('synthesizeProviders needs at least one base provider with tools');

  const out: ProviderInput[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = sorted[i % sorted.length]!;
    const round = Math.floor(i / sorted.length);
    const size = Math.floor(total / count) + (i < total % count ? 1 : 0);
    const names = new Set<string>();
    const tools: McpTool[] = [];
    for (let j = 0; j < size; j += 1) {
      const index = j + round * 7;
      const source = base.tools[index % base.tools.length]!;
      const perturbed = round > 0 || index >= base.tools.length;
      let name = source.name;
      if (perturbed) {
        name = `${source.name}_${NOUNS[Math.floor(random() * NOUNS.length)]!}`;
        for (let n = 2; names.has(name); n += 1) name = `${source.name}_${NOUNS[Math.floor(random() * NOUNS.length)]!}${n}`;
      }
      names.add(name);
      const description = perturbed ? `${source.description ?? ''} ${FILLER[Math.floor(random() * FILLER.length)]!}`.trim() : source.description;
      tools.push({ ...source, name, ...(description === undefined ? {} : { description }) });
    }
    const suffix = round === 0 ? '' : `-${CLONE_SUFFIX[(round - 1) % CLONE_SUFFIX.length]!}${round > CLONE_SUFFIX.length ? round : ''}`;
    out.push({ provider: `${base.provider}${suffix}`, tools });
  }
  return out;
}

/** Every `tools/list` snapshot under `<fixtures>/tools` and `<fixtures>/other`. */
export function loadBaseProviders(fixturesDir: string): BaseProvider[] {
  const bases: BaseProvider[] = [];
  for (const dir of ['tools', 'other']) {
    for (const file of readdirSync(join(fixturesDir, dir)).filter((f) => f.endsWith('.json')).sort()) {
      const tools = (JSON.parse(readFileSync(join(fixturesDir, dir, file), 'utf8')) as { tools: McpTool[] }).tools;
      bases.push({ provider: basename(file, '.json'), tools });
    }
  }
  return bases;
}
