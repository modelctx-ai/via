// Static texts. Imported by the entry point, so nothing heavy may be imported here.
import pkg from '../../package.json';

export const VERSION: string = pkg.version;

export const HELP = `via ${VERSION}: call MCP servers as \`via <provider> <resource>:<verb>\`

usage:
  via                                        providers, grouped by domain
  via <provider> [--all]                     resources and actions of a provider
  via <provider> <resource>                  actions of a resource, with signatures
  via <provider> <resource>:<verb> -h        usage of a tool
  via <provider> <resource>:<verb> [args]    call a tool
  via find <query> [--domain <d>] [-n 10]    search tools across providers
  via batch [--concurrency <n>]              JSON Lines on stdin: concurrent calls, results in input order

commands:
  find call more batch servers sync doctor prompt trust
  auth daemon (not available until 0.2)

options:
  -o text|json|raw  --full  --all  --yes  --dry-run  --no-validate  --timeout <seconds>  -h

docs: docs/spec/cli.md
`;

/** Usage of each built-in subcommand, for \`via <command> -h\`. */
export const COMMAND_USAGE: Readonly<Record<string, string>> = {
  find: 'usage: via find [<query>] [--domain <domain>] [-n <count>]',
  call: 'usage: via call <provider>/<resource>:<verb> [--args <json>|@file|-] [--<arg> <value>…]',
  more: 'usage: via more <cursor>',
  servers: 'usage: via servers [--why <provider>]',
  sync: 'usage: via sync [<provider>]',
  doctor: 'usage: via doctor',
  prompt: 'usage: via prompt [--out <file>]',
  batch: 'usage: via batch [--concurrency <n>]  (JSON Lines on stdin: {"tool":"<provider>/<resource>:<verb>","args":{…}})',
  auth: 'usage: via auth login|status|logout <provider> (not available until 0.2)',
  trust: 'usage: via trust [<path>] [--dry-run] [--yes] | via trust --list | via trust --revoke <path>',
  daemon: 'usage: via daemon status|stop|run (not available until 0.2)',
};
