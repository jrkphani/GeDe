import { describe, expect, it } from 'vitest'
import { hashContent } from './contentHash'

// Issue 042 — the vector cache is keyed by a content hash (ADR-0005 spirit:
// deterministic, never recomputed nondeterministically). This is plain
// arithmetic, not crypto: it only needs to be a stable, collision-unlikely
// cache key for small palette-corpus strings, never a security boundary.

describe('hashContent', () => {
  it('is deterministic for the same input', () => {
    expect(hashContent('Budget')).toBe(hashContent('Budget'))
  })

  it('differs for different input', () => {
    expect(hashContent('Budget')).not.toBe(hashContent('budget'))
    expect(hashContent('Budget')).not.toBe(hashContent('Budget '))
  })

  it('is stable across repeated calls in the same process (no hidden state)', () => {
    const first = hashContent('Fade unconnected contexts')
    for (let i = 0; i < 5; i++) {
      expect(hashContent('Fade unconnected contexts')).toBe(first)
    }
  })

  it('handles the empty string without throwing', () => {
    expect(() => hashContent('')).not.toThrow()
    expect(hashContent('')).toBe(hashContent(''))
  })
})
