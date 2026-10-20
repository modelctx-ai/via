// Entry point. Kept thin on purpose: argument parsing and socket communication only.
// Heavy dependencies (MCP SDK, ajv) must be loaded lazily by the subcommands that need them.
import pkg from '../../package.json';

const HELP = `via ${pkg.version}
usage: via <provider> [<resource>[:<verb>]] [args]
       via find <query>

The command surface is not implemented yet.
`;

function main(argv: string[]): number {
  const first = argv[0];
  if (first === '--version' || first === '-V') {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  process.stdout.write(HELP);
  return first === undefined || first === '-h' || first === '--help' ? 0 : 2;
}

process.exitCode = main(process.argv.slice(2));
