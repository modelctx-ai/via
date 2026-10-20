// A small POSIX-like word splitter for scripted commands. No shell is involved anywhere in the
// benchmark: the words become the argv of a spawned process, so nothing in a task file can run
// anything but `via` or `mcp2cli`.

/** Split `line` into words: whitespace separates, `'…'` is literal, `"…"` allows `\"` and `\\`, `\x` escapes outside quotes. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) current += line[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord || current !== '') words.push(current);
      current = '';
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unterminated ${quote} in: ${line}`);
  if (inWord || current !== '') words.push(current);
  return words;
}
