// `node --require scripts/lib/builtin-trace.cjs dist/via.js …` with VIA_BUILTIN_TRACE set writes
// the names of the Node-internal modules the run loaded (one per line) to that file on exit.
// A cold start pays for each of them (`crypto`, `net`, `tty`, `internal/fs/promises`...), so the
// dist test and `npm run bench:perf` list the ones a command should not need.
process.on('exit', () => {
  const file = process.env.VIA_BUILTIN_TRACE;
  if (file) require('node:fs').writeFileSync(file, `${process.moduleLoadList.join('\n')}\n`);
});
