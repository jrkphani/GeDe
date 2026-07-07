import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __setSemanticSearchFactoriesForTest,
  itemContentText,
  resetSemanticSearch,
  useSemanticSearchStore,
} from './semanticSearch'
import { createMemoryVectorCache } from '../lib/vectorCache'
import type { CommandItem } from '../domain/paletteRanking'
import type { Embedder } from '../lib/vectorCache'

// Issue 042 — the async orchestration layer between the pure ranking blend
// (paletteRanking.ts) and the real on-device model (semanticEmbedder.ts).
// Every test here injects a stub embedder + an in-memory cache
// (`__setSemanticSearchFactoriesForTest`) — never the real
// `@huggingface/transformers` — so this suite never imports the model or
// touches the network (test-first plan #3/#4).

afterEach(() => resetSemanticSearch())

const noop = () => {}
function item(partial: Partial<CommandItem> & Pick<CommandItem, 'id' | 'title'>): CommandItem {
  return { kind: 'context', run: noop, ...partial }
}

function stubEmbedder(vectorFor: (text: string) => readonly number[] = (t) => [t.length, 1]): {
  embedder: Embedder
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    embedder: {
      embed(text: string) {
        calls.push(text)
        return Promise.resolve(vectorFor(text))
      },
    },
  }
}

describe('itemContentText', () => {
  it('joins symbol, title, and keywords into one embeddable string', () => {
    const text = itemContentText(
      item({ id: 'a', title: 'Budget', symbol: 'β', keywords: ['money', 'spend'] }),
    )
    expect(text).toContain('Budget')
    expect(text).toContain('β')
    expect(text).toContain('money')
    expect(text).toContain('spend')
  })

  it('never throws for an item with no symbol/keywords', () => {
    expect(() => itemContentText(item({ id: 'a', title: 'Budget' }))).not.toThrow()
  })
})

describe('useSemanticSearchStore.ensureModel', () => {
  it('transitions idle -> loading -> ready and is idempotent', async () => {
    const { embedder } = stubEmbedder()
    // Async factory (a real model load is inherently async) so the
    // intermediate "loading" state is actually observable before the await.
    const factory = vi.fn(() => Promise.resolve(embedder))
    __setSemanticSearchFactoriesForTest({ embedder: factory, cache: createMemoryVectorCache })

    expect(useSemanticSearchStore.getState().status).toBe('idle')
    const first = useSemanticSearchStore.getState().ensureModel()
    expect(useSemanticSearchStore.getState().status).toBe('loading')
    await first
    expect(useSemanticSearchStore.getState().status).toBe('ready')

    // A second call while already ready must not re-create the embedder.
    await useSemanticSearchStore.getState().ensureModel()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('degrades to unavailable, never throwing, when the factory fails', async () => {
    __setSemanticSearchFactoriesForTest({
      embedder: () => {
        throw new Error('model failed to load')
      },
      cache: createMemoryVectorCache,
    })
    await expect(useSemanticSearchStore.getState().ensureModel()).resolves.toBeUndefined()
    expect(useSemanticSearchStore.getState().status).toBe('unavailable')
  })
})

describe('useSemanticSearchStore.scoreQuery', () => {
  it('is a no-op (never touches the network) while the model is idle/unloaded', async () => {
    // The default, untouched store state — ensureModel() was never called.
    // This is the "no fetch to any remote endpoint" guard (test-first plan
    // #4): the real default factories are still wired (nothing stubbed),
    // and scoreQuery must short-circuit before ever reaching them.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await useSemanticSearchStore
        .getState()
        .scoreQuery('hide the unconnected', [item({ id: 'a', title: 'Adjacency emphasis' })])
      expect(useSemanticSearchStore.getState().scores.size).toBe(0)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('populates scores from the embedder once the model is ready', async () => {
    // A trivial embedder: vector = [1] if the text contains "unconnected",
    // else [0] — cosineSimilarity(query, item) is then 1 for a semantic
    // match, 0 otherwise. No real model needed to prove the wiring.
    const { embedder } = stubEmbedder((t) => [t.toLowerCase().includes('unconnected') ? 1 : 0])
    __setSemanticSearchFactoriesForTest({ embedder: () => embedder, cache: createMemoryVectorCache })
    await useSemanticSearchStore.getState().ensureModel()

    const items = [
      item({ id: 'match', title: 'Fade unconnected contexts' }),
      item({ id: 'other', title: 'Rename project' }),
    ]
    await useSemanticSearchStore.getState().scoreQuery('hide the unconnected', items)

    const state = useSemanticSearchStore.getState()
    expect(state.query).toBe('hide the unconnected')
    expect(state.scores.get('match')).toBeCloseTo(1)
    expect(state.scores.get('other')).toBeCloseTo(0)
  })

  it('discards a stale in-flight result superseded by a newer query (generation guard)', async () => {
    let resolveSlow: (() => void) | undefined
    const embedder: Embedder = {
      async embed(text) {
        if (text === 'query:slow') {
          await new Promise<void>((resolve) => {
            resolveSlow = resolve
          })
        }
        return [text.length]
      },
    }
    __setSemanticSearchFactoriesForTest({ embedder: () => embedder, cache: createMemoryVectorCache })
    await useSemanticSearchStore.getState().ensureModel()

    const items = [item({ id: 'a', title: 'Alpha' })]
    const slow = useSemanticSearchStore.getState().scoreQuery('query:slow', items)
    const fast = useSemanticSearchStore.getState().scoreQuery('query:fast', items)
    await fast
    resolveSlow?.()
    await slow

    // The fast query's result must win even though the slow one resolved
    // after it — never let an out-of-order completion clobber a fresher one.
    expect(useSemanticSearchStore.getState().query).toBe('query:fast')
  })
})
