// Static texts. Imported by the entry point, so nothing heavy may be imported here.
import pkg from '../../package.json';

export const VERSION: string = pkg.version;

export const HELP = `via ${VERSION}: call MCP servers as \`via <provider> <resource>:<verb>\`

usage:
  via                                        providers and their tool counts
  via <provider> [--all]                     resources and actions of a provider
  via <provider> <resource>                  actions of a resource, with signatures
  via <provider> <resource>:<verb> -h        usage of a tool
  via <provider> <resource>:<verb> [args]    call a tool
  via find <query> [-n 10]                   search tools across providers
  via batch [--concurrency <n>]              JSON Lines on stdin: concurrent calls, results in input order
  via resources <provider>                   resources and resource templates of a server
  via read <provider> <uri>                  read a resource
  via prompts <provider> [<name> [args]]     prompts of a server; with a name, get that prompt
  via skills <provider> [<name> [<file>]]    skills of a server (MCP 2026-07-28); with a name, read it, checked against its manifest
  via tasks <provider> [<task-id>]           tasks of a server; with an id, wait for the task and print its result (--status, --cancel)
  via serve                                  MCP server over stdio with via's meta-tools, for agents without a shell

commands:
  find call more batch servers sync doctor prompt trust auth daemon resources read prompts serve skills tasks

options:
  -o text|json|raw  --full  --all  --yes  --dry-run  --no-validate  --detach  --timeout <seconds>  -h
  --schema-snapshot <file>  --schema-mode compatible|strict

docs: docs/spec/cli.md
`;

/** Usage of each built-in subcommand, for \`via <command> -h\`. */
export const COMMAND_USAGE: Readonly<Record<string, string>> = {
  find: 'usage: via find [<query>] [-n <count>]',
  call: 'usage: via call <provider>/<resource>:<verb> [--args <json>|@file|-] [--<arg> <value>…]',
  more: 'usage: via more <cursor>',
  servers: 'usage: via servers',
  sync: 'usage: via sync [<provider>]',
  doctor: 'usage: via doctor',
  prompt: 'usage: via prompt [--skill] [--out <file> | --check <file>] [--replace]',
  batch: 'usage: via batch [--concurrency <n>]  (JSON Lines on stdin: {"tool":"<provider>/<resource>:<verb>","args":{…}})',
  auth: 'usage: via auth login <provider> [--manual] | via auth status [<provider>] | via auth logout <provider>',
  trust: 'usage: via trust [<path>] [--dry-run] | via trust <path> --yes (scripts only: needs VIA_ALLOW_NONINTERACTIVE_TRUST=1) | via trust --list | via trust --revoke <path>',
  daemon: 'usage: via daemon status|stop|run [--socket <path>] [--idle-timeout <seconds>] | via daemon logs [<provider>] [-n <lines>] [--follow] [--since <duration>]',
  resources: 'usage: via resources <provider>  (resources and resource templates; read one with via read <provider> <uri>; via resources <provider> <template> --complete <variable> asks for values)',
  read: 'usage: via read <provider> <uri>',
  skills: 'usage: via skills <provider> [<name> [<file>]]  (without a name: list; with one: read its SKILL.md; with a file: read that file of the skill; content is checked against the server\'s manifest before it is printed)',
  tasks: 'usage: via tasks <provider> [<task-id>] [--status | --cancel]  (without an id: list; with one: wait for the task and print its result; a tool call with --detach prints the id)',
  serve: 'usage: via serve  (MCP server on stdin/stdout; register it in the agent framework as a stdio server)',
  prompts: 'usage: via prompts <provider> [<name> [--arg <value>…]]  (without a name: list; via prompts <provider> <name> -h: usage of one prompt; --complete <argument> asks the server for its values)',
};
