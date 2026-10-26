// Stands in for srt (ADR 0027): takes `[--debug] --settings <file> -- <command…>`, records what it
// was given in FAKE_SRT_LOG (one JSON line per run), then either exits with FAKE_SRT_EXIT or runs
// the command with the same stdio and exits with its code. It confines nothing.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const split = args.indexOf('--');
const options = args.slice(0, split);
const command = args.slice(split + 1);
const settingsFile = options[options.indexOf('--settings') + 1];
if (process.env.FAKE_SRT_LOG) {
  const record = {
    options,
    command,
    settings: JSON.parse(readFileSync(settingsFile, 'utf8')),
    env: { VIA_SANDBOXED: process.env.VIA_SANDBOXED, VIA_NO_DAEMON: process.env.VIA_NO_DAEMON },
  };
  appendFileSync(process.env.FAKE_SRT_LOG, `${JSON.stringify(record)}\n`);
}
if (process.env.FAKE_SRT_EXIT) {
  process.stdout.write('inside the fake sandbox\n');
  process.exit(Number(process.env.FAKE_SRT_EXIT));
}
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });
process.exit(result.status ?? 1);
