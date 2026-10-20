// Terminal display width of a string: the algorithm of `string-width` 8 (MIT, Sindre Sorhus),
// restructured so that nothing expensive happens before it is needed. Importing the package
// compiles a `\p{RGI_Emoji}` regex and creates an `Intl.Segmenter` at load time, about 30 ms on a
// cold start for what is, in nearly every table, plain ASCII. Here both are built on the first
// string that is not printable ASCII. The parity test (test/render/width.test.ts) runs the
// package, kept as a dev dependency, against this on a corpus and on seeded random strings.
//
// Rules: graphemes are measured as the terminal draws them. Non-printing clusters are 0, RGI
// emoji (and keycap / ZWJ emoji sequences) are 2, Hangul jamo clusters are combined, anything
// else is the East Asian Width of the first visible code point plus trailing spacing marks and
// halfwidth / fullwidth forms.
import { eastAsianWidth } from 'get-east-asian-width';

// Text made only of these is one column per UTF-16 unit: printable ASCII, Latin-1 and Latin
// Extended letters and punctuation (not the soft hyphen), general punctuation (dashes, quotes,
// bullet, ellipsis), the basic arrows and box drawing. None of them is combining, wide, emoji or
// ignorable, and none joins a neighbour into a cluster. Tool output is full of `·`, `…` and `→`,
// so ASCII alone would still pay for the Unicode setup in most views. The test checks every one.
const NARROW = /^[\u0020-\u007E\u00A0-\u00AC\u00AE-\u02FF\u2010-\u2027\u2190-\u2199\u2500-\u257F]*$/;

// ansi-regex 6: OSC sequences, then CSI and friends.
const ANSI = new RegExp(
  '(?:(?:\\u001B\\]|\\u009D)[^\\u0007\\u001B\\u009C\\u009D]*(?:\\u0007|\\u001B\\u005C|\\u009C))' +
    '|[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]',
  'g',
);

const KEYCAP = /^[\d#*]\u20E3$/;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/gu;

// Built on first use; the `v` flag is not a TypeScript target feature, hence the constructor.
interface Slow {
  segmenter: Intl.Segmenter;
  visible: RegExp;
  spacingMark: RegExp;
  rgiEmoji: RegExp;
}
let slow: Slow | undefined;
function load(): Slow {
  slow ??= {
    segmenter: new Intl.Segmenter(),
    // A visible (printing) character; a single negated class, no quantifier (no backtracking blow-up).
    visible: new RegExp('[^\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Nonspacing_Mark}\\p{Enclosing_Mark}\\p{Surrogate}]', 'v'),
    spacingMark: new RegExp('\\p{Spacing_Mark}', 'v'),
    rgiEmoji: new RegExp('^\\p{RGI_Emoji}$', 'v'),
  };
  return slow;
}

function isDoubleWidthNonRgiEmojiSequence(segment: string): boolean {
  // Real emoji clusters are shorter than 30 UTF-16 units; guard against pathological input.
  if (segment.length > 50) return false;
  if (KEYCAP.test(segment)) return true;
  if (segment.includes('\u200D')) {
    const pictographics = segment.match(EXTENDED_PICTOGRAPHIC);
    return pictographics !== null && pictographics.length >= 2;
  }
  return false;
}

const isHangulLeadingJamo = (cp: number): boolean => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c);
const isHangulVowelJamo = (cp: number): boolean => (cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6);
const isHangulTrailingJamo = (cp: number): boolean => (cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb);
const isHangulJamo = (cp: number): boolean => isHangulLeadingJamo(cp) || isHangulVowelJamo(cp) || isHangulTrailingJamo(cp);

/** Width of a cluster made of Hangul jamo; undefined when it is not one. */
function hangulClusterWidth(visibleSegment: string, { visible }: Slow): number | undefined {
  const codePoints: number[] = [];
  for (const character of visibleSegment) {
    if (visible.test(character)) codePoints.push(character.codePointAt(0)!);
  }
  if (codePoints.length === 0) return undefined;

  let width = 0;
  for (let index = 0; index < codePoints.length; index += 1) {
    const codePoint = codePoints[index]!;
    if (!isHangulJamo(codePoint)) {
      if (width === 0) return undefined;
      // Mixed cluster (L + precomposed syllable): East Asian Width for the rest.
      for (let rest = index; rest < codePoints.length; rest += 1) width += eastAsianWidth(codePoints[rest]!);
      return width;
    }
    // Modern Hangul L+V(+T) is one syllable block; unmatched jamo stay additive.
    if (isHangulLeadingJamo(codePoint) && isHangulVowelJamo(codePoints[index + 1]!)) {
      width += 2;
      index += isHangulTrailingJamo(codePoints[index + 2]!) ? 2 : 1;
      continue;
    }
    width += eastAsianWidth(codePoint);
  }
  return width;
}

function trailingWidth(visibleSegment: string, { spacingMark }: Slow): number {
  let extra = 0;
  let first = true;
  for (const character of visibleSegment) {
    if (first) {
      first = false;
      continue;
    }
    if (spacingMark.test(character) || (character >= '\uFF00' && character <= '\uFFEF')) extra += eastAsianWidth(character.codePointAt(0)!);
  }
  return extra;
}

export function terminalWidth(input: string): number {
  if (input.length === 0) return 0;
  if (NARROW.test(input)) return input.length;

  const text = input.includes('\u001B') || input.includes('\u009B') ? input.replace(ANSI, '') : input;
  if (text.length === 0) return 0;
  if (NARROW.test(text)) return text.length;

  const state = load();
  let width = 0;
  for (const { segment } of state.segmenter.segment(text)) {
    const index = segment.search(state.visible);
    if (index === -1) continue; // zero-width / non-printing cluster
    const visibleSegment = segment.slice(index);

    if (state.rgiEmoji.test(segment) || isDoubleWidthNonRgiEmojiSequence(segment)) {
      width += 2;
      continue;
    }
    const hangul = hangulClusterWidth(visibleSegment, state);
    if (hangul !== undefined) {
      width += hangul;
      continue;
    }
    width += eastAsianWidth(visibleSegment.codePointAt(0)!);
    width += trailingWidth(visibleSegment, state);
  }
  return width;
}
