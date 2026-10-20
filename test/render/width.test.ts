import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { displayWidth } from '../../src/render';
import { terminalWidth } from '../../src/render/terminal-width';

// terminal-width.ts is string-width's algorithm with the expensive setup made lazy (cold start).
// It must stay a drop-in: same answers on a corpus of the kinds of text tool output holds, and on
// seeded random mixtures of the code points that make width hard.
const CORPUS = [
  '',
  'plain ascii text, 123',
  'tab\tand\nnewline\u0000control',
  '支持中文对齐',
  '日本語のテキスト ｶﾞｷﾞ ﾊﾟ ｰ',
  '한국어 ᄀ 가 각 ᄀ가 각',
  'café e\u0301 a\u0308\u0323 ñ',
  'emoji 😀 👍🏽 👨\u200D👩\u200D👧 🇯🇵 ✅ ❌ ⚠\uFE0F ❤\uFE0F ☺ 1\uFE0F\u20E3 #\uFE0F\u20E3 *\u20E3',
  'arrows → ← ↔ ↩ ↩\uFE0F box ┌─┐│ ░▒▓ ± × ½ ° ① ㊀ · … — “q” © ® ™ • ✓',
  '\u200B zero\u200Dwidth \uFEFF bom \u00AD soft',
  '\u001b[31mred\u001b[0m and \u001b]8;;http://x\u0007link\u001b]8;;\u0007',
  '\ud83d lone high surrogate, \ude00 lone low',
  'ＡＢＣ １２３ ｱｲｳ ｡｢｣',
  'ไทย ก\u0E47 ท\u0E35\u0E48 ह\u093Fन\u094Dद\u0940 العربية עברית',
];

const POOL = [
  'a', 'Z', '0', ' ', '-', '~', '\t', '\n', '\u0000', '\u007f', 'é', 'e\u0301', '\u0300', '\u200B', '\u200D', '\uFE0F', '\uFE0E',
  '中', '語', '。', 'ａ', '｡', 'ﾞ', 'ｶ', '한', 'ᄀ', 'ᅡ', 'ᆨ', 'ꥠ', 'ힰ', '😀', '👍', '🏽', '🇯', '🇵', '✅', '⚠', '❤', '☺', '\u20E3', '1', '#',
  '→', '─', '①', '·', '…', '—', '“', '©', '®', '\u00a0', '\u00ad', '×', 'ʼ', '↩', '↔', '•', '▒', 'ก', '\u0E31', '\u093E', '\u001b[1m', '\u009b31m', '\ud800',
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('terminalWidth', () => {
  it('agrees with string-width on a corpus', () => {
    for (const text of CORPUS) expect([text, terminalWidth(text)]).toEqual([text, stringWidth(text)]);
  });

  it('agrees with string-width on seeded random mixtures', () => {
    const random = rng(7);
    for (let i = 0; i < 3000; i += 1) {
      const length = 1 + Math.floor(random() * 12);
      let text = '';
      for (let j = 0; j < length; j += 1) text += POOL[Math.floor(random() * POOL.length)]!;
      expect([text, terminalWidth(text)]).toEqual([text, stringWidth(text)]);
    }
  });

  it('agrees with string-width on every code point the narrow fast path accepts, alone and in pairs', () => {
    const narrow: string[] = [];
    for (let cp = 0; cp <= 0x2fff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      if (/^[\u0020-\u007E\u00A0-\u00AC\u00AE-\u02FF\u2010-\u2027\u2190-\u2199\u2500-\u257F]$/.test(ch)) narrow.push(ch);
    }
    expect(narrow.length).toBeGreaterThan(600);
    for (const ch of narrow) expect([ch, stringWidth(ch)]).toEqual([ch, 1]);
    // Neighbours must not change a character's width (clusters): pair each with a mix of joiners.
    for (const ch of narrow) for (const next of ['a', '\u0301', '\u200d', '\ufe0f', '支', '😀']) {
      expect([ch + next, terminalWidth(ch + next)]).toEqual([ch + next, stringWidth(ch + next)]);
    }
  });

  it('counts CJK as two columns and ASCII as one', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('支持')).toBe(4);
    expect(displayWidth('a支b')).toBe(4);
  });
});
