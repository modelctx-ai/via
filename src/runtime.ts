// Which JavaScript runtime hosts this process, and how to start another copy of via.
// Kept free of imports: the entry point loads it on every run.

/** Entry paths inside a `bun build --compile` executable: `/$bunfs/root/<name>` or `B:\~BUN\root\<name>`. */
const BUN_VIRTUAL_ENTRY = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;

/** True when running from the single-file executable (`npm run build:bin`), not `node dist/via.js`. */
export function isCompiledBinary(argv1: string | undefined = process.argv[1], bunVersion: string | undefined = process.versions.bun): boolean {
  return bunVersion !== undefined && argv1 !== undefined && BUN_VIRTUAL_ENTRY.test(argv1);
}

/**
 * Command line that starts this same program again, for the daemon. A script run by Node or Bun is
 * `<runtime> <script>`; the compiled executable is the program itself, and its `argv[1]` is a path in
 * a virtual filesystem that no other process could open.
 */
export function selfCommand(execPath: string = process.execPath, argv1: string | undefined = process.argv[1], bunVersion: string | undefined = process.versions.bun): { command: string; args: string[] } {
  return isCompiledBinary(argv1, bunVersion) ? { command: execPath, args: [] } : { command: execPath, args: [argv1 ?? ''] };
}
