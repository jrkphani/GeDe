// Issue 042 — a small deterministic non-cryptographic string hash. The vector
// cache keys IndexedDB entries by an item's content hash so re-embedding only
// happens when the text actually changes (issue's test-first plan #3); this
// is a cache key, not a security boundary, so FNV-1a-style arithmetic is the
// right amount of machinery — no crypto dependency, pure, deterministic
// (ADR-0005 spirit: never recompute in a way that reorders nondeterministically).
export function hashContent(text: string): string {
  // FNV-1a over two 32-bit lanes (offset by a second prime) to keep the key
  // space large enough that an accidental collision across a palette's real
  // corpus (dozens-hundreds of short strings) is not a practical concern.
  let h1 = 0x811c9dc5
  let h2 = 0x1000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = (h1 ^ c) * 0x01000193
    h1 >>>= 0
    h2 = (h2 ^ c) * 0x811c9dc5
    h2 >>>= 0
  }
  return `${h1.toString(36)}${h2.toString(36)}`
}
