import verbsData from '../../data/verbs.json';
import type { SingularRules } from './singularize';

/** Shape of `data/verbs.json` (data-files.md). */
export interface VerbsData {
  version: number;
  verbs: string[];
  conjunctions: string[];
  singularExceptions: string[];
  singularIrregular?: Record<string, string>;
}

/** Compiled rules used by name splitting. */
export interface SplitRules extends SingularRules {
  verbs: ReadonlySet<string>;
  conjunctions: ReadonlySet<string>;
}

export function compileSplitRules(data: VerbsData): SplitRules {
  return {
    verbs: new Set(data.verbs),
    conjunctions: new Set(data.conjunctions),
    exceptions: new Set(data.singularExceptions),
    irregular: new Map(Object.entries(data.singularIrregular ?? {})),
  };
}

let defaults: SplitRules | undefined;

/** Rules compiled from the bundled `data/verbs.json`. */
export function defaultSplitRules(): SplitRules {
  defaults ??= compileSplitRules(verbsData as VerbsData);
  return defaults;
}
