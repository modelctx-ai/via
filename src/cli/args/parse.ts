// parseToolArgs: command line -> merged argument object -> completion -> local validation.
import type { McpTool } from '../../catalog/types';
import { completeAlternatives } from './complete';
import { isCommonFlag } from './common-flags';
import { allowsBoolean, convertValue, isArrayTarget, isBooleanOnly, targetOf, type Target } from './convert';
import { describeJsonFailure, parseJson, type JsonResult } from './json';
import { buildToolArgsError, formatWarnings, pointerOf, problemsFromAjv, type Problem, unknownArgument } from './report';
import { isPlainObject, type Pos, SchemaModel } from './schema';
import type { ParsedToolArgs, ParseToolArgsOptions, ToolArgsContext } from './types';
import { compileSchema } from '../../schema/validate';
import { formatUsage } from './help';
import { shellWords } from '../../render/shell';

type Resolution =
  | { kind: 'ok'; path: string[]; pos: Pos; negate: boolean; /** The first segment is not declared (the schema takes extra fields). */ extraRoot: boolean }
  | { kind: 'unknown'; problem: Problem }
  | { kind: 'ambiguous'; typed: string; names: string[] };

interface Source {
  text: string;
  /** `@bug.md` or `stdin`; null for text typed on the command line. */
  label: string | null;
}

export async function parseToolArgs(
  argv: readonly string[],
  tool: McpTool,
  ctx: ToolArgsContext,
  options: ParseToolArgsOptions,
): Promise<ParsedToolArgs> {
  return new Parser(tool, ctx, options).run(argv);
}

function define(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k];
    if (isPlainObject(v) && isPlainObject(cur) && Object.hasOwn(target, k)) deepMerge(cur, v);
    else define(target, k, v);
  }
}

function fileError(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return 'no such file';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EISDIR':
      return 'is a directory';
    case 'ENOTDIR':
      return 'not a directory';
  }
  const text = e instanceof Error ? e.message : String(e);
  return text.split('\n')[0]!.slice(0, 100);
}

class Parser {
  private readonly model: SchemaModel;
  private readonly root: Pos;
  private readonly redact: (s: string) => string;
  private readonly args: Record<string, unknown> = {};
  private readonly problems: Problem[] = [];
  /** JSON pointers whose value could not be read or parsed: later "required"/type errors for them are noise. */
  private readonly failed: string[] = [];
  /** Paths being built by repeated `--tag a --tag b`. */
  private readonly accumulating = new Set<string>();
  /** `--args` could not be read: required-field errors would only be noise. */
  private baseFailed = false;
  private stdinUsed = false;
  private positionalParam: string | undefined;
  private positionalSeen = false;
  /** Undeclared top-level keys written as `--name`, in command-line order (`--dry-run` lists them). */
  private readonly extraFields: string[] = [];
  /** One warning per common flag that went out as an extra field. */
  private readonly extraWarnings: string[] = [];

  constructor(
    private readonly tool: McpTool,
    private readonly ctx: ToolArgsContext,
    private readonly options: ParseToolArgsOptions,
  ) {
    this.model = new SchemaModel(tool.inputSchema ?? {});
    this.root = [this.model.root];
    this.redact = options.redact ?? ((s) => s);
    const required = this.model.requiredOf(this.root);
    if (required.length === 1) {
      const name = required[0]!;
      const t = this.model.typeInfoPos(this.model.child(this.root, name));
      if (t.known && t.types.has('string')) this.positionalParam = name;
    }
  }

  async run(argv: readonly string[]): Promise<ParsedToolArgs> {
    // `--args` is the base whatever its position; everything else is applied on top, in order.
    const bases: string[] = [];
    const rest: string[] = [];
    let dashDash = false;
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i]!;
      if (dashDash || t === '--') {
        dashDash = true;
        rest.push(t);
      } else if (t === '--args') {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) this.add(0, '--args', 'requires a value', 'value', '');
        else {
          bases.push(next);
          i++;
        }
      } else if (t.startsWith('--args=')) bases.push(t.slice('--args='.length));
      else rest.push(t);
    }
    for (const raw of bases) await this.applyBase(raw);
    await this.applyTokens(rest);

    completeAlternatives(this.model, this.args);

    const warnings: string[] = [...this.extraWarnings];
    let validated = false;
    if (this.options.validate && this.tool.inputSchema) {
      const result = await (this.options.compile ?? compileSchema)(this.tool.inputSchema, this.ctx.ref);
      if (!result.ok) {
        warnings.push(...result.warnings, `schema of ${this.ctx.ref} cannot be compiled (${result.reason}); local validation skipped`);
      } else {
        validated = true;
        warnings.push(...result.compiled.warnings);
        const errors = await result.compiled.check(this.args);
        if (errors.length > 0) {
          for (const p of problemsFromAjv(this.model, errors, this.args, this.redact)) {
            const pointer = String(p.detail.path ?? '');
            if (this.baseFailed && p.detail.rule === 'required') continue;
            if (!this.failed.some((f) => pointer === f || pointer.startsWith(`${f}/`))) this.problems.push(p);
          }
        } else {
          const formats = await result.compiled.formats(this.args);
          warnings.push(...formatWarnings(this.model, formats, this.args, this.redact));
        }
      }
    } else if (this.options.validate) {
      validated = true;
    }

    if (this.problems.length > 0) {
      throw buildToolArgsError(this.problems, formatUsage(this.tool, this.ctx, { maxOptional: 8 }), shellWords(this.ctx.refWords ?? this.ctx.ref), this.redact);
    }
    // Echoed values (`got`) were redacted where they were written; the rest of a warning is ours.
    return { args: this.args, warnings, validated, extraFields: this.extraFields };
  }

  // Problems --------------------------------------------------------------------------------

  private add(group: Problem['group'], arg: string, message: string, rule: string, path: string, single?: string): void {
    this.problems.push({ group, arg, message, ...(single ? { single } : {}), detail: { arg, path, rule } });
  }

  private jsonProblem(path: string[], failure: Extract<JsonResult, { ok: false }>, source: string | null): void {
    const arg = this.model.displayArg(path);
    const pointer = pointerOf(path);
    this.failed.push(pointer);
    this.add(0, arg, describeJsonFailure(failure, source), 'json', pointer);
  }

  // Sources: inline text, @file, stdin -------------------------------------------------------

  private async expand(raw: string, path: string[], label?: string): Promise<Source | undefined> {
    const arg = label ?? this.model.displayArg(path);
    const pointer = pointerOf(path);
    const fail = (message: string, rule: string) => {
      this.failed.push(pointer);
      this.add(0, arg, message, rule, pointer);
      return undefined;
    };
    if (raw === '-') {
      if (this.stdinUsed) return fail('cannot read stdin: another argument already reads it (only one per call)', 'stdin');
      this.stdinUsed = true;
      try {
        return { text: await this.options.io.readStdin(), label: 'stdin' };
      } catch (e) {
        return fail(`cannot read stdin: ${fileError(e)}`, 'stdin');
      }
    }
    if (raw.startsWith('@@')) return { text: raw.slice(1), label: null };
    if (raw.startsWith('@')) {
      const file = raw.slice(1);
      if (file === '') return fail('cannot read @: no file name (write @@ for a literal @)', 'file');
      try {
        return { text: await this.options.io.readFile(file), label: raw };
      } catch (e) {
        return fail(`cannot read ${raw}: ${fileError(e)}`, 'file');
      }
    }
    return { text: raw, label: null };
  }

  // --args ----------------------------------------------------------------------------------

  private async applyBase(raw: string): Promise<void> {
    const src = await this.expand(raw, [], '--args');
    if (!src) {
      this.baseFailed = true;
      return;
    }
    const r = parseJson(src.text);
    if (!r.ok) {
      this.baseFailed = true;
      this.add(0, '--args', describeJsonFailure(r, src.label), 'json', '');
      return;
    }
    if (!isPlainObject(r.value)) {
      this.baseFailed = true;
      this.add(0, '--args', 'must be a JSON object', 'type', '');
      return;
    }
    deepMerge(this.args, r.value);
  }

  // Command-line tokens ---------------------------------------------------------------------

  private async applyTokens(tokens: readonly string[]): Promise<void> {
    let dashDash = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!dashDash && token === '--') {
        dashDash = true;
        continue;
      }
      if (dashDash || !token.startsWith('--')) {
        await this.positional(token);
        continue;
      }
      const body = token.slice(2);
      const eq = body.indexOf('=');
      let name = eq < 0 ? body : body.slice(0, eq);
      const inline = eq < 0 ? undefined : body.slice(eq + 1);
      const prefixed = name.startsWith('p.');
      if (prefixed) name = name.slice(2);

      const res = this.resolve(name);
      if (res.kind !== 'ok') {
        if (res.kind === 'ambiguous') {
          const arg = `--${res.typed}`;
          this.add(2, arg, `ambiguous; use one of the original names: ${res.names.join(', ')}`, 'ambiguous', pointerOf([res.typed]));
        } else this.problems.push(res.problem);
        // Assume the unknown option takes a value, so that value is not mistaken for a positional.
        const next = tokens[i + 1];
        if (inline === undefined && next !== undefined && !next.startsWith('--')) i++;
        continue;
      }

      if (res.extraRoot) this.noteExtra(name, prefixed);
      const target = targetOf(this.model, res.pos);
      if (res.negate) {
        if (inline !== undefined) this.add(0, this.model.displayArg(res.path), 'takes no value', 'value', pointerOf(res.path));
        else this.setAt(res.path, false);
        continue;
      }
      let raw = inline;
      if (raw === undefined) {
        const next = tokens[i + 1];
        const hasValue = next !== undefined && !next.startsWith('--');
        if (isBooleanOnly(target)) {
          if (next === 'true' || next === 'false') {
            raw = next;
            i++;
          } else {
            this.setAt(res.path, true);
            continue;
          }
        } else if (hasValue) {
          raw = next;
          i++;
        } else if (allowsBoolean(target)) {
          this.setAt(res.path, true);
          continue;
        } else {
          this.failed.push(pointerOf(res.path));
          this.add(0, this.model.displayArg(res.path), 'requires a value', 'value', pointerOf(res.path));
          continue;
        }
      }
      await this.assign(res.path, target, raw);
    }
  }

  private async positional(token: string): Promise<void> {
    const shown = truncateToken(token);
    if (this.positionalParam === undefined) {
      this.add(0, shown, 'unexpected argument; pass values as --name value', 'positional', '', `unexpected argument "${shown}"; pass values as --name value`);
      return;
    }
    if (this.positionalSeen) {
      const m = 'unexpected argument; quote values that contain spaces';
      this.add(0, shown, m, 'positional', '', `unexpected argument "${shown}"; quote values that contain spaces`);
      return;
    }
    this.positionalSeen = true;
    const path = [this.positionalParam];
    await this.assign(path, targetOf(this.model, this.model.child(this.root, this.positionalParam)), token);
  }

  /**
   * `--name` is not a parameter of the tool and goes out as an extra field. A flag that other CLIs
   * share (`--verbose`, `--limit`…) is almost certainly a mistake: say so, once, and name the way to
   * keep it (`--p.<name>`). Only the flag's name is echoed, never its value (arguments.md, "JSON 输入").
   */
  private noteExtra(typed: string, prefixed: boolean): void {
    const key = typed.split('.')[0]!;
    if (!this.extraFields.includes(key)) this.extraFields.push(key);
    if (prefixed || !isCommonFlag(key) || !/^[A-Za-z0-9_-]+$/.test(key)) return;
    const warning = `--${key} is not a parameter of ${this.ctx.ref}; it was sent as an extra field (write --p.${key} to silence this)`;
    if (!this.extraWarnings.includes(warning)) this.extraWarnings.push(warning);
  }

  /** Resolve `filter.state` / `issue-number` / `no-draft` to schema property names. */
  private resolve(name: string): Resolution {
    const segs = name.split('.');
    let pos: Pos = this.root;
    const path: string[] = [];
    let extraRoot = false;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const last = i === segs.length - 1;
      const index = this.model.nameIndex(pos);
      let hit = seg === '' || seg === '__proto__' ? undefined : index.lookup(seg);
      let negate = false;
      if (!hit && last && /^no-./i.test(seg)) {
        const positive = index.lookup(seg.slice(3));
        if (positive && 'orig' in positive && allowsBoolean(targetOf(this.model, this.model.child(pos, positive.orig)))) {
          hit = positive;
          negate = true;
        }
      }
      if (hit && 'ambiguous' in hit) return { kind: 'ambiguous', typed: name, names: hit.ambiguous };
      if (hit) {
        path.push(hit.orig);
        pos = this.model.child(pos, hit.orig);
        if (negate) return { kind: 'ok', path, pos, negate, extraRoot: false };
        continue;
      }
      const extra = seg !== '' && seg !== '__proto__' && (!this.options.validate || this.model.allowsExtra(pos));
      if (!extra) return { kind: 'unknown', problem: unknownArgument(this.model, path, seg === '' ? name : seg) };
      path.push(seg);
      pos = this.model.child(pos, seg);
      if (i === 0) extraRoot = true;
    }
    return { kind: 'ok', path, pos, negate: false, extraRoot };
  }

  // Values ----------------------------------------------------------------------------------

  private async assign(path: string[], target: Target, raw: string): Promise<void> {
    const src = await this.expand(raw, path);
    if (!src) return;

    const first = src.text.trimStart()[0];
    if (isArrayTarget(target) && !(target.types.has('object') && first === '{')) {
      if (first === '[') {
        const r = parseJson(src.text);
        if (!r.ok) return this.jsonProblem(path, r, src.label);
        this.setAt(path, r.value);
        this.accumulating.add(JSON.stringify(path));
        return;
      }
      const conv = convertValue(src.text, targetOf(this.model, this.model.items(target.pos)));
      if (!conv.ok) return this.jsonProblem(path, conv.failure, src.label);
      this.append(path, conv.value);
      return;
    }
    const conv = convertValue(src.text, target);
    if (!conv.ok) return this.jsonProblem(path, conv.failure, src.label);
    this.setAt(path, conv.value);
  }

  private setAt(path: readonly string[], value: unknown): void {
    let cur = this.args;
    for (const k of path.slice(0, -1)) {
      let next = Object.hasOwn(cur, k) ? cur[k] : undefined;
      if (!isPlainObject(next)) {
        next = {};
        define(cur, k, next);
      }
      cur = next as Record<string, unknown>;
    }
    const last = path[path.length - 1]!;
    const existing = Object.hasOwn(cur, last) ? cur[last] : undefined;
    if (isPlainObject(existing) && isPlainObject(value)) deepMerge(existing, value);
    else define(cur, last, value);
    this.accumulating.delete(JSON.stringify(path));
  }

  private append(path: readonly string[], element: unknown): void {
    const key = JSON.stringify(path);
    let cur: unknown = this.args;
    for (const k of path) cur = isPlainObject(cur) && Object.hasOwn(cur, k) ? cur[k] : undefined;
    if (this.accumulating.has(key) && Array.isArray(cur)) {
      cur.push(element);
      return;
    }
    this.setAt(path, [element]);
    this.accumulating.add(key);
  }
}

function truncateToken(t: string): string {
  const chars = Array.from(t);
  return chars.length > 40 ? `${chars.slice(0, 39).join('')}…` : t;
}
