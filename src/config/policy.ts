// `commands` and `sandbox` (config.md; ADR 0027, ADR 0028): which built-in subcommands may run and
// which are shown, and whether via runs inside a sandbox program. Both are read before a command is
// dispatched, so this module stays free of the heavy parts of config/.
import { dirname } from 'node:path';
import type { ConfigDiagnostic } from './diagnostics';
import type { CommandsLayer, ConfigLayerData, SandboxLayer } from './layer';
import { resolveAgainst, type PathContext } from './paths';
import type { ConfigOrigin } from './types';

/** The merged `commands` lists. An absent `allow` or `show` means every command. */
export interface CommandPolicy {
  allow?: ReadonlySet<string>;
  deny: ReadonlySet<string>;
  hide: ReadonlySet<string>;
  show?: ReadonlySet<string>;
}

/** The sandbox settings from the user config (and command-line overrides). */
export interface SandboxSettings {
  enabled: boolean;
  /** The sandbox program and the words before via's own options: `srt`, or `[srt, --debug]`. */
  command: string[];
  /** The settings handed to the program: inline, or a JSON file (an absolute path). Absent: the program's built-in defaults plus via's own entries. */
  policy?: { inline: Record<string, unknown> } | { file: string };
  /** Built-in subcommands that run outside the sandbox. */
  exclude: string[];
  /** The file that enabled it, for messages; absent when nothing did. */
  origin?: ConfigOrigin;
}

export interface Policy {
  commands: CommandPolicy;
  sandbox: SandboxSettings;
}

/** Subcommands that run outside the sandbox unless `sandbox.exclude` says otherwise (ADR 0027). */
export const DEFAULT_SANDBOX_EXCLUDE: readonly string[] = ['auth', 'trust', 'daemon'];

export const DEFAULT_SANDBOX_COMMAND: readonly string[] = ['srt'];

/** Set in the environment of the via that runs inside the sandbox, so it does not wrap itself again. */
export const SANDBOX_MARKER = 'VIA_SANDBOXED';

export function emptyPolicy(): Policy {
  return { commands: { deny: new Set(), hide: new Set() }, sandbox: { enabled: false, command: [...DEFAULT_SANDBOX_COMMAND], exclude: [...DEFAULT_SANDBOX_EXCLUDE] } };
}

function intersect(current: ReadonlySet<string> | undefined, next: readonly string[]): Set<string> {
  return new Set(current === undefined ? next : next.filter((name) => current.has(name)));
}

/**
 * Merge the layers, lowest priority first (user, project, command line). `deny` and `hide` are
 * unions and `allow` and `show` intersections, so a later layer (a project's `.via.yaml`) can only
 * take commands away, never give one back. `sandbox` is read from the user config and the command
 * line only: a repository must not be able to switch it off or widen what it lets through.
 */
export function mergePolicy(layers: ReadonlyArray<{ origin: ConfigOrigin; data: ConfigLayerData }>, ctx: PathContext, cwd: string): { policy: Policy; diagnostics: ConfigDiagnostic[] } {
  const policy = emptyPolicy();
  const diagnostics: ConfigDiagnostic[] = [];
  const commands = { deny: new Set<string>(), hide: new Set<string>() } as { allow?: Set<string>; deny: Set<string>; hide: Set<string>; show?: Set<string> };
  for (const { origin, data } of layers) {
    mergeCommands(commands, data.commands);
    if (Object.keys(data.sandbox).length === 0) continue;
    if (origin.scope !== 'user' && origin.scope !== 'cli') {
      diagnostics.push({ level: 'warning', code: 'sandbox-forbidden', message: 'sandbox is only read from the user config; it was ignored', ...(origin.path ? { file: origin.path } : {}) });
      continue;
    }
    mergeSandbox(policy.sandbox, data.sandbox, origin, ctx, cwd);
  }
  policy.commands = commands;
  return { policy, diagnostics };
}

function mergeCommands(into: { allow?: Set<string>; deny: Set<string>; hide: Set<string>; show?: Set<string> }, layer: CommandsLayer): void {
  for (const name of layer.deny ?? []) into.deny.add(name);
  for (const name of layer.hide ?? []) into.hide.add(name);
  if (layer.allow !== undefined) into.allow = intersect(into.allow, layer.allow);
  if (layer.show !== undefined) into.show = intersect(into.show, layer.show);
}

function mergeSandbox(into: SandboxSettings, layer: SandboxLayer, origin: ConfigOrigin, ctx: PathContext, cwd: string): void {
  if (layer.enabled !== undefined) {
    into.enabled = layer.enabled;
    into.origin = origin;
  }
  if (layer.command !== undefined) into.command = [...layer.command];
  if (layer.exclude !== undefined) into.exclude = [...layer.exclude];
  if (layer.policy !== undefined) {
    into.policy = typeof layer.policy === 'string' ? { file: resolveAgainst(layer.policy, origin.path ? dirname(origin.path) : cwd, ctx) } : { inline: layer.policy };
  }
}

/** `daemon run` is how via starts its own daemon; the policy never stands in its way (ADR 0028). */
export function isInternalCommand(command: string, argv: readonly string[]): boolean {
  return command === 'daemon' && argv[0]?.toLowerCase() === 'run';
}

/** Why a built-in may not run: the list that says so, or undefined when it may. `help` always may. */
export function refusedBy(policy: CommandPolicy, command: string): 'deny' | 'allow' | undefined {
  if (command === 'help') return undefined;
  if (policy.deny.has(command)) return 'deny';
  if (policy.allow !== undefined && !policy.allow.has(command)) return 'allow';
  return undefined;
}

/** Whether a built-in is listed in help, `via prompt` and `via serve`: it may run, and neither `hide` nor `show` leaves it out. */
export function isVisible(policy: CommandPolicy, command: string): boolean {
  if (command === 'help') return true;
  if (refusedBy(policy, command) !== undefined) return false;
  if (policy.hide.has(command)) return false;
  return policy.show === undefined || policy.show.has(command);
}

/** Whether any list restricts anything: callers skip their filtering when none does. */
export function restrictsCommands(policy: CommandPolicy): boolean {
  return policy.allow !== undefined || policy.show !== undefined || policy.deny.size > 0 || policy.hide.size > 0;
}
