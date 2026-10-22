// How to start another copy of via. Kept free of imports: the entry point loads it on every run.

/**
 * Command line that starts this same program again, for the daemon: `<runtime> <script>`, the
 * runtime being the Node.js that runs `dist/via.js`.
 */
export function selfCommand(execPath: string = process.execPath, argv1: string | undefined = process.argv[1]): { command: string; args: string[] } {
  return { command: execPath, args: [argv1 ?? ''] };
}
