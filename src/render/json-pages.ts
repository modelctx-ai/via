// `-o json` over the output budget (output.md, "JSON 的分页"): the result is paged like any other,
// but every page is a JSON document of its own. A page is a run of lines of the pretty-printed
// result, opened with the lines of the containers it is inside and closed again at its end:
//
//   {                      {                       page 2 repeats the path, not the
//     "issues": [            "issues": [           siblings page 1 already showed
//       { ... },               { ... },
//       { ... }                { ... }
//     ]                      ],
//   }                        "totalCount": 23
//                          }
//
// Arrays and objects continue where the previous page stopped, and so does a string too long for
// one page: its text is split, and each page holds the next part under the same key. Appending
// the pages level by level (items to the array, keys to the object, text to the string) gives the
// whole result back.

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** How much of the budget one line may take: the rest is for the lines that open and close its containers. */
const LINE_SHARE = 0.75;
const MIN_LINE_BYTES = 64;

const indentOf = (line: string): number => line.length - line.trimStart().length;
/** `{`, `[`, `"key": {` or `"key": [`. A string value ends with `"` or `",`, never with a bracket. */
const opens = (line: string): boolean => line.endsWith('{') || line.endsWith('[');
/** `}`, `]`, `},` or `],`. An empty container (`[]`, `"k": {}`) starts with its opening bracket or its key. */
const closes = (line: string): boolean => /^\s*[}\]]/.test(line);
const stripComma = (line: string): string => (line.endsWith(',') ? line.slice(0, -1) : line);

/** Where the first JSON string token of `text` ends (index after its closing quote), or -1. */
function stringEnd(text: string): number {
  if (!text.startsWith('"')) return -1;
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

/** A line that holds one string value: what precedes the value, the value, and whether a comma follows. */
function stringLeaf(line: string): { head: string; value: string; comma: boolean } | undefined {
  const indent = indentOf(line);
  const rest = line.slice(indent);
  let at = 0;
  const first = stringEnd(rest);
  if (first < 0) return undefined;
  if (rest.startsWith(': ', first)) at = first + 2; // the first token was the key
  const end = stringEnd(rest.slice(at));
  if (end < 0) return undefined;
  const tail = rest.slice(at + end);
  if (tail !== '' && tail !== ',') return undefined;
  try {
    const value: unknown = JSON.parse(rest.slice(at, at + end));
    return typeof value === 'string' ? { head: line.slice(0, indent + at), value, comma: tail === ',' } : undefined;
  } catch {
    return undefined;
  }
}

export interface JsonBody {
  /** The pretty-printed document, a string too long for one page split over several lines. */
  lines: string[];
  /** Lines after which a page has to end: every part of a split string but its last. */
  breaks: number[];
}

/**
 * The lines to page over. A string value whose line would not fit on a page becomes several lines,
 * each the same key with the next part of the text; two of them never go on one page.
 */
export function jsonBody(lines: readonly string[], budget: number): JsonBody {
  const max = Math.max(MIN_LINE_BYTES, Math.floor(budget * LINE_SHARE));
  const out: string[] = [];
  const breaks: number[] = [];
  for (const line of lines) {
    if (byteLength(line) <= max) {
      out.push(line);
      continue;
    }
    const leaf = stringLeaf(line);
    const room = leaf ? max - byteLength(leaf.head) - 3 : 0; // two quotes and a comma
    // A key so long that nothing of the value fits next to it: the line stays whole and its page is over the budget.
    if (!leaf || room < 16) {
      out.push(line);
      continue;
    }
    let part = '';
    let size = 0;
    const flush = (last: boolean): void => {
      if (!last) breaks.push(out.length);
      out.push(`${leaf.head}${JSON.stringify(part)}${last && leaf.comma ? ',' : ''}`);
      part = '';
      size = 0;
    };
    for (const ch of leaf.value) {
      // Printable ASCII other than the quote and the backslash is written as it is: one byte.
      const code = ch.charCodeAt(0);
      const bytes = code >= 0x20 && code < 0x7f && code !== 0x22 && code !== 0x5c ? 1 : byteLength(JSON.stringify(ch)) - 2;
      if (size + bytes > room && part !== '') flush(false);
      part += ch;
      size += bytes;
    }
    flush(true);
  }
  return { lines: out, breaks };
}

export interface JsonPage {
  /** A complete JSON document: the opening lines of the path, the lines taken, the closing lines. */
  lines: string[];
  /** Index of the first line left over; `lines.length` of the body when finished. */
  next: number;
  /** Bytes of the lines taken from the body (the opening and closing lines around them excluded). */
  bodyBytes: number;
}

/** The lines that opened the containers still open before line `index`, outermost first. */
function pathAt(lines: readonly string[], index: number): string[] {
  const stack: string[] = [];
  for (let i = 0; i < index; i += 1) {
    const line = lines[i]!;
    if (opens(line)) stack.push(line);
    else if (closes(line)) stack.pop();
  }
  return stack;
}

const closerOf = (opener: string): string => `${' '.repeat(indentOf(opener))}${opener.endsWith('{') ? '}' : ']'}`;

/**
 * One page starting at line `start`, within `budget` bytes where that is possible (the first line
 * is always taken, so paging makes progress). The page ends between two items of the outermost
 * container it can: after whole issues rather than in the middle of one. Only an item that does not
 * fit on a page by itself is continued on the next.
 */
export function takeJsonPage(body: JsonBody, start: number, budget: number): JsonPage {
  const { lines } = body;
  const breaks = new Set(body.breaks);
  const path = pathAt(lines, start);
  const lineBytes = (line: string): number => byteLength(line) + 1;
  const prefixBytes = path.reduce((n, l) => n + lineBytes(l), 0);

  // 1. The longest run that fits, closing lines included.
  const stack = [...path];
  let closing = stack.reduce((n, l) => n + indentOf(l) + 2, 0);
  let used = prefixBytes;
  let end = start;
  let forced = false;
  const sizes: number[] = []; // bytes of the body taken up to and including line start + i
  while (end < lines.length) {
    const line = lines[end]!;
    const size = lineBytes(line);
    let after = closing;
    if (opens(line)) after += indentOf(line) + 2;
    else if (closes(line)) after -= indentOf(line) + 2;
    if (end > start && used + size + after > budget) break;
    if (opens(line)) stack.push(line);
    else if (closes(line)) stack.pop();
    closing = after;
    used += size;
    sizes.push((sizes[sizes.length - 1] ?? 0) + size);
    end += 1;
    if (breaks.has(end - 1)) {
      forced = true;
      break;
    }
  }

  // 2. Not the end, and free to choose: stop before the line that starts the shallowest item, as
  //    late as possible, without giving up more than half of what fits.
  let cut = end;
  if (end < lines.length && !forced) {
    const taken = sizes[sizes.length - 1]!;
    let best = Number.POSITIVE_INFINITY;
    for (let c = end; c > start; c -= 1) {
      if (sizes[c - start - 1]! * 2 < taken) break;
      if (opens(lines[c - 1]!)) continue; // an opening line with nothing after it
      let ahead = c;
      while (ahead < lines.length && closes(lines[ahead]!)) ahead += 1;
      const level = ahead < lines.length ? indentOf(lines[ahead]!) : -1;
      if (level < best) {
        best = level;
        cut = c;
      }
    }
  }
  // Closing lines that follow belong to this page: it writes the same brackets anyway.
  while (cut < lines.length && !forced && closes(lines[cut]!)) cut += 1;

  // 3. The document: path, lines, closers of what is still open.
  const open = [...path];
  const taken = lines.slice(start, cut);
  for (const line of taken) {
    if (opens(line)) open.push(line);
    else if (closes(line)) open.pop();
  }
  if (taken.length > 0) taken[taken.length - 1] = stripComma(taken[taken.length - 1]!);
  return {
    lines: [...path, ...taken, ...open.reverse().map(closerOf)],
    next: cut,
    bodyBytes: lines.slice(start, cut).reduce((n, l) => n + lineBytes(l), 0),
  };
}
