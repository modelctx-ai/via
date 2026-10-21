// A fast non-cryptographic string hash, for cache keys and "did the inputs change" checks.
//
// SHA-256 (src/sha256.ts) is for content that must not collide on purpose: config files compared
// against a trust record. A cache key over a server definition or the inputs of a catalog build
// only has to tell different inputs apart, and in a process that has never run either function the
// plain hash is several times cheaper per call (a few dozen calls per command).

/** 128 bits as 32 hex digits: four multiply-xor lanes over the UTF-16 code units, finalised cyrb-style. */
export function stringHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  let h3 = 0x9e3779b9;
  let h4 = 0x7f4a7c15;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
    h3 = Math.imul(h3 ^ c, 2246822519);
    h4 = Math.imul(h4 ^ c, 3266489917);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  h3 = Math.imul(h3 ^ (h3 >>> 16), 2246822507) ^ Math.imul(h4 ^ (h4 >>> 13), 3266489909);
  h4 = Math.imul(h4 ^ (h4 >>> 16), 2246822507) ^ Math.imul(h3 ^ (h3 >>> 13), 3266489909);
  return [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}
