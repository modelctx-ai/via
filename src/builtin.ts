// Node built-ins loaded on first use, synchronously.
//
// A static `import ... from 'node:crypto'` is evaluated when the importing chunk loads, whether or
// not the code that needs it ever runs. For modules that cost milliseconds (`crypto`, `tty`, `net`)
// and sit on the path of every browse command, the import moves to the call that needs it
// (implementation.md, "启动速度"). `process.getBuiltinModule` (Node 20.16+, 22.3+) returns the
// module without building an ESM facade; older runtimes fall back to `require`.
import { createRequire } from 'node:module';

let nodeRequire: NodeRequire | undefined;

export function builtin<T>(id: `node:${string}`): T {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const found = getBuiltin?.call(process, id);
  if (found !== undefined) return found as T;
  nodeRequire ??= createRequire(import.meta.url);
  return nodeRequire(id) as T;
}
