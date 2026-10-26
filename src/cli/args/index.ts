// Schema-driven tool arguments (arguments.md): mapping, JSON input, @file/stdin, anyOf/oneOf
// completion, local validation, help and usage text.
//
// Only types and light modules are imported statically. ajv and ajv-formats are loaded with
// dynamic import() the first time a schema is validated (implementation.md, "启动速度").
export type { ArgIssue, ParsedToolArgs, ParseToolArgsOptions, ToolArgsContext, ToolArgsIO } from './types';
export type { CompileResult, Compiled, SchemaCompiler } from './validate';
export { ToolArgsError } from './types';
export { parseToolArgs } from './parse';
export { formatToolHelp, formatUsage, type HelpOptions, type UsageOptions } from './help';
export { validateOutput } from './output';
/** Lines between the `error:` line and the `next:` line of a ToolArgsError: the per-argument block (more than one problem) and `usage:`. */
export { argsErrorLines } from './report';
