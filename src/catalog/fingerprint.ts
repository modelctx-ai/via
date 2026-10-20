// Identifies the rules a catalog was built with: the data files and the code that turns tool
// lists into catalogs. A cached build (src/cli/view-cache.ts) is only reused under the same
// fingerprint, so changing a verb table, a domain table, the lexicon or the naming code never
// serves a stale build.
import domainsData from '../../data/domains.json';
import lexiconData from '../../data/domain-lexicon.json';
import verbsData from '../../data/verbs.json';
import { sha256Hex } from '../sha256';

/** Set by the build (tsup.config.ts): version plus a hash of data/*.json and src/catalog/*. */
declare const __VIA_RULES_ID__: string | undefined;

let computed: string | undefined;

export function rulesFingerprint(): string {
  if (typeof __VIA_RULES_ID__ === 'string') return __VIA_RULES_ID__;
  // Running from source (tests, tools): no build step ran, so hash the data the rules come from.
  computed ??= `source-${sha256Hex(JSON.stringify([verbsData, domainsData, lexiconData])).slice(0, 16)}`;
  return computed;
}
