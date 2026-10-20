// Module-load tracer: the hooks thread appends every module URL the loader reads to the file
// named by VIA_TRACE_FILE. Plain ESM with no dependencies, so it can be handed to `node --import`
// next to the shipped bundle (see load-trace.mjs). Used by `npm run bench:perf` and the dist test.
import { appendFileSync } from 'node:fs';

export async function load(url, context, nextLoad) {
  const file = process.env.VIA_TRACE_FILE;
  if (file) appendFileSync(file, `${url}\n`);
  return nextLoad(url, context);
}
