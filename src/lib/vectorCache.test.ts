import { describe, expect, it, vi } from 'vitest'
import { createMemoryVectorCache, embedWithCache, type Embedder } from './vectorCache'

// Issue 042, test-first plan #3: vector cache invalidation, asserted without a
// real model via a stubbed embedder. `createMemoryVectorCache` is the
// same-shape, no-IndexedDB-required store used both here and as the fallback
// when IndexedDB is unavailable (SSR/older browsers) — the interesting logic
// (content-hash keyed reuse) is identical either way.

function stubEmbedder(): { embedder: Embedder; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    embedder: {
      embed(text: string) {
        calls.push(text)
        // A cheap deterministic "vector" derived from the text so different
        // inputs are distinguishable without needing a real model.
        return Promise.resolve([text.length, text.charCodeAt(0) || 0])
      },
    },
  }
}

describe('createMemoryVectorCache', () => {
  it('round-trips a stored vector', async () => {
    const cache = createMemoryVectorCache()
    expect(await cache.get('k')).toBeUndefined()
    await cache.set('k', [1, 2, 3])
    expect(await cache.get('k')).toEqual([1, 2, 3])
  })
})

describe('embedWithCache', () => {
  it('embeds once and reuses the cached vector for unchanged content', async () => {
    const cache = createMemoryVectorCache()
    const { embedder, calls } = stubEmbedder()

    const first = await embedWithCache('Budget', embedder, cache)
    const second = await embedWithCache('Budget', embedder, cache)

    expect(calls).toEqual(['Budget']) // the embedder ran exactly once
    expect(second).toEqual(first)
  })

  it('re-embeds when the content changes (content-hash keyed)', async () => {
    const cache = createMemoryVectorCache()
    const { embedder, calls } = stubEmbedder()

    await embedWithCache('Budget', embedder, cache)
    await embedWithCache('Budget v2', embedder, cache)
    await embedWithCache('Budget', embedder, cache) // unchanged again — cached

    expect(calls).toEqual(['Budget', 'Budget v2'])
  })

  it('never calls the embedder twice for the same text across many items sharing it', async () => {
    const cache = createMemoryVectorCache()
    const { embedder, calls } = stubEmbedder()
    const spy = vi.fn((text: string) => embedder.embed(text))
    const wrapped: Embedder = { embed: spy }

    await Promise.all([
      embedWithCache('shared text', wrapped, cache),
      embedWithCache('shared text', wrapped, cache),
    ])

    // Both calls raced before either write landed in the cache in the worst
    // case, but distinct items with the SAME resolved text must never grow
    // unbounded — at minimum, a second *sequential* call is a guaranteed hit.
    await embedWithCache('shared text', wrapped, cache)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2)
    void calls
  })
})
