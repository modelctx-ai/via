// Agent evaluation (testing.md, "agent 评测"; roadmap gate 1): a live model does the benchmark
// tasks with native MCP tools, with `via` and with mcp2cli against the same replay servers, and
// success is judged from the servers' call logs. Run `npm run build` first, then
// `npm run bench:eval` (needs ANTHROPIC_API_KEY) or `npm run bench:eval -- --fake-model`.
// Options: `npm run bench:eval -- --help`; details in bench/README.md.
import { main } from '../bench/eval/main';

main(process.argv.slice(2), { stdout: (s) => void process.stdout.write(s), stderr: (s) => void process.stderr.write(s) }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`bench:eval: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
