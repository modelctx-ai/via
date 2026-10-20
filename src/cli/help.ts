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

commands:
  find call more servers sync doctor prompt auth
  batch trust daemon (not available until 0.2)

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
  batch: 'usage: via batch (not available until 0.2)',
  auth: 'usage: via auth login <provider> [--manual] | via auth status [<provider>] | via auth logout <provider>',
  trust: 'usage: via trust [<path>] (not available until 0.2)',
  daemon: 'usage: via daemon status|stop|run (not available until 0.2)',
};
