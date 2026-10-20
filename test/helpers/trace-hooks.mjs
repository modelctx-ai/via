import { appendFileSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  const file = process.env.TRACE_FILE;
  const names = (process.env.TRACE_IMPORTS ?? '').split(',').filter(Boolean);
  if (file && names.some((n) => specifier === n || specifier.startsWith(`${n}/`))) appendFileSync(file, `${specifier}\n`);
  return nextResolve(specifier, context);
}
