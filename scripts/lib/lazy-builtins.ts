// esbuild plugin: Node built-ins without the ESM facade cost.
//
// `import { readFileSync } from 'node:fs'` makes Node build an ES module facade for the whole of
// `fs`, which reads every property of `fs`, including the lazy `fs.promises` getter. That pulls in
// `internal/fs/promises`, streams, `readline` and more: about 12 ms on a cold start, paid by every
// command that touches a file (measured with `npm run bench:perf`, implementation.md, "启动速度").
// `process.getBuiltinModule('node:fs')` returns the same module without the facade.
//
// The plugin rewrites imports of `fs` and `fs/promises` in the bundle to a generated module that
// reads the built-in that way and re-exports its functions by name. Source code, types and the
// tests keep importing `node:fs` as usual. The exports are enumerated at build time from the
// running Node, so the shim always matches what the code can import.
import { createRequire } from 'node:module';
import type { Plugin } from 'esbuild';

const require = createRequire(import.meta.url);

const NAMESPACE = 'via-builtin';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(['default']);

/** Built-ins rewritten by the plugin, with how their exports are forwarded. */
const TARGETS = ['fs', 'fs/promises'] as const;
type Target = (typeof TARGETS)[number];

function shimFor(id: Target): string {
  const real = require(`node:${id}`) as Record<string, unknown>;
  // Lazy getters (`ReadStream`, `promises`...) would load their modules the moment the shim reads
  // them, so they are not re-exported by name; `promises` is forwarded on first use below.
  const names = Object.keys(real).filter((k) => IDENTIFIER.test(k) && !RESERVED.has(k) && !Object.getOwnPropertyDescriptor(real, k)?.get);
  const header = [
    `const getBuiltin = process.getBuiltinModule;`,
    `import { createRequire } from 'node:module';`,
    `const load = () => (getBuiltin ? getBuiltin.call(process, 'node:${id}') : undefined) ?? createRequire(import.meta.url)('node:${id}');`,
  ];
  const lines: string[] = [];
  if (id === 'fs') {
    // Plain properties are read eagerly; `promises` forwards on first use.
    header.push(`const m = load();`, `export default m;`);
    lines.push(`export const promises = new Proxy({}, { get: (_, key) => m.promises[key] });`);
    for (const name of names) lines.push(`export const ${name} = m.${name};`);
  } else {
    // fs/promises: loading the module itself is the cost, so each function loads it when called.
    header.push(`let cached; const m = () => (cached ??= load());`, `export default new Proxy({}, { get: (_, key) => m()[key] });`);
    for (const name of names) {
      const value = real[name];
      if (typeof value === 'function') lines.push(`export const ${name} = (...args) => m().${name}(...args);`);
      // Plain objects (`constants`) load the module when something is read from them.
      else if (typeof value === 'object' && value !== null) lines.push(`export const ${name} = new Proxy({}, { get: (_, key) => m().${name}[key] });`);
    }
  }
  return [...header, ...lines].join('\n');
}

export function lazyBuiltins(): Plugin {
  return {
    name: 'lazy-builtins',
    setup(build) {
      const filter = /^(?:node:)?(?:fs|fs\/promises)$/;
      build.onResolve({ filter }, (args) => ({ path: args.path.replace(/^node:/, ''), namespace: NAMESPACE }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({ contents: shimFor(args.path as Target), loader: 'js' }));
    },
  };
}
