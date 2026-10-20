// Since the dependencies are bundled, the loader no longer sees them as packages; what a command
// loaded is read off the bundle chunks it imported. Each marker is a name that exists only in that
// library's code.
export const FEATURES: ReadonlyArray<readonly [name: string, marker: RegExp]> = [
  ['mcp-sdk', /InitializeRequestSchema/],
  ['zod', /ZodError/],
  ['ajv', /KeywordCxt/],
  ['yaml', /YAMLParseError/],
  ['smol-toml', /TomlError/],
  ['jsonc-parser', /printParseErrorCode/],
];

/** The libraries whose code is in `text`. */
export function featuresOf(text: string): string[] {
  return FEATURES.filter(([, marker]) => marker.test(text)).map(([name]) => name);
}
