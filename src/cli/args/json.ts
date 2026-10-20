// JSON parsing with a precise error location (`invalid JSON at 1:18: unexpected "}"`).

export type JsonResult = { ok: true; value: unknown } | { ok: false; line: number; col: number; found: string };

export function parseJson(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return locateError(text);
  }
}

class Fail {
  constructor(readonly pos: number) {}
}

/** Find the first offending character with a strict RFC 8259 scanner. */
function locateError(text: string): JsonResult {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const expect = (c: string) => {
    if (text[i] !== c) throw new Fail(i);
    i++;
  };
  const digits = () => {
    const start = i;
    while (i < text.length && text[i]! >= '0' && text[i]! <= '9') i++;
    if (i === start) throw new Fail(i);
  };
  const str = () => {
    expect('"');
    for (;;) {
      const c = text[i];
      if (c === undefined || c < ' ') throw new Fail(i);
      if (c === '"') {
        i++;
        return;
      }
      if (c === '\\') {
        i++;
        const e = text[i];
        if (e === undefined || !'"\\/bfnrtu'.includes(e)) throw new Fail(i);
        i++;
        if (e === 'u') {
          for (let k = 0; k < 4; k++) {
            if (!/[0-9a-fA-F]/.test(text[i] ?? '')) throw new Fail(i);
            i++;
          }
        }
        continue;
      }
      i++;
    }
  };
  const num = () => {
    if (text[i] === '-') i++;
    if (text[i] === '0') i++;
    else digits();
    if (text[i] === '.') {
      i++;
      digits();
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      digits();
    }
  };
  const lit = (word: string) => {
    for (const c of word) expect(c);
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        str();
        ws();
        expect(':');
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        expect('}');
        return;
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        expect(']');
        return;
      }
    } else if (c === '"') str();
    else if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) num();
    else if (c === 't') lit('true');
    else if (c === 'f') lit('false');
    else if (c === 'n') lit('null');
    else throw new Fail(i);
  };
  let pos = 0;
  try {
    value();
    ws();
    if (i < text.length) throw new Fail(i);
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    pos = e.pos;
  }
  const before = text.slice(0, pos).split('\n');
  return {
    ok: false,
    line: before.length,
    col: before[before.length - 1]!.length + 1,
    found: pos >= text.length ? 'end of input' : JSON.stringify(text[pos]),
  };
}

export function describeJsonFailure(f: Extract<JsonResult, { ok: false }>, source: string | null): string {
  const where = source ? ` in ${source}` : '';
  const what = f.found === 'end of input' ? 'unexpected end of input' : `unexpected ${f.found}`;
  return `invalid JSON at ${f.line}:${f.col}${where}: ${what}${source ? '' : '; consider @file'}`;
}
