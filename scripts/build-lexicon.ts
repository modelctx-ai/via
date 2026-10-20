// Generates data/domain-lexicon.json from tools/list fixtures of servers with a known domain.
// Run with `npm run lexicon`. Not part of the shipped CLI.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildProviderCatalog, defaultCatalogRules } from '../src/catalog/provider';
import { matchBuiltin } from '../src/catalog/domain';
import { buildLexicon, formatLexicon } from '../src/catalog/lexicon';
import type { McpTool } from '../src/catalog/types';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
const dir = args.find((a, i) => !a.startsWith('--') && i !== outIndex + 1) ?? 'test/fixtures/tools';

const rules = defaultCatalogRules();
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const hash = createHash('sha256');
const samples = [];
for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  hash.update(file).update(text);
  const provider = basename(file, '.json');
  const domains = matchBuiltin(provider, undefined, rules.domains);
  if (domains.length !== 1) {
    process.stderr.write(`skip ${provider}: not in the built-in table\n`);
    continue;
  }
  const tools = (JSON.parse(text) as { tools: McpTool[] }).tools;
  samples.push({ domain: domains[0]!, tools: buildProviderCatalog({ provider, tools }, rules).tools });
}

const lexicon = {
  version: 1,
  generatedFrom: `${dir.replace(/\/$/, '')}/@sha256:${hash.digest('hex').slice(0, 12)}`,
  ...buildLexicon(samples, rules.domains, rules.split),
};
const text = formatLexicon(lexicon);
if (out) writeFileSync(out, text);
else process.stdout.write(text);
