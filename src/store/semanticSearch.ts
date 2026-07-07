import { create } from 'zustand'
import type { CommandItem } from '../domain/paletteRanking'
import { semanticScoresFromVectors } from '../domain/paletteRanking'
import { createTransformersEmbedder } from '../lib/semanticEmbedder'
import { createVectorCache, embedWithCache } from '../lib/vectorCache'
import type { Embedder, VectorCacheStore } from '../lib/vectorCache'

// Issue 042 — the palette's semantic-search seam. Composes the pure blend
// (`paletteRanking.ts`) with the real embedder + vector cache, but stays a
// thin orchestration layer: model load and per-query embedding are both
// fire-and-forget from the caller's point of view (the palette's lexical
// results never wait on this), and every failure mode degrades to "no
// scores" rather than throwing into the UI.
//
// The shell (AppShell) calls `ensureModel()` once, on the palette's first
// open (SITEMAP §3 lazy-load contract) — never `CommandPalette.tsx` itself,
// so the palette component stays feature-agnostic (017's framing: it reads
// only registries/stores, never triggers a feature's side effects itself)
// and — just as importantly — so `CommandPalette.test.tsx` (which renders
// the palette directly, without the shell) never touches the model or the
// network. `CommandPalette.tsx` only calls `scoreQuery` (debounced) and
// reads `scores`/`query` back.

export type SemanticStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

interface SemanticSearchState {
  status: SemanticStatus
  // The query these `scores` were computed for — a consumer must compare
  // this against its own live query before trusting `scores` (a slower
  // in-flight embed for an older keystroke is guarded by `generation` below,
  // but a consumer re-reading state after its own query changed again needs
  // this too).
  query: string
  scores: ReadonlyMap<string, number>
  generation: number
  ensureModel: () => Promise<void>
  scoreQuery: (query: string, items: readonly CommandItem[]) => Promise<void>
}

// The text embedded per item — issue 042's corpus is the same CommandItem
// list the lexical ranking already scores (symbol/title/keywords), so no
// separate corpus concept is needed.
export function itemContentText(item: CommandItem): string {
  return [item.symbol, item.title, ...(item.keywords ?? [])].filter(Boolean).join(' | ')
}

// Swappable for tests (never the real model/IndexedDB — see semanticSearch.
// test.ts) and, in principle, for a future smaller/larger model choice.
let embedderFactory: () => Embedder | Promise<Embedder> = createTransformersEmbedder
let cacheFactory: () => VectorCacheStore | Promise<VectorCacheStore> = createVectorCache
let embedder: Embedder | null = null
let cache: VectorCacheStore | null = null

export function __setSemanticSearchFactoriesForTest(factories: {
  embedder?: () => Embedder | Promise<Embedder>
  cache?: () => VectorCacheStore | Promise<VectorCacheStore>
}): void {
  if (factories.embedder) embedderFactory = factories.embedder
  if (factories.cache) cacheFactory = factories.cache
}

export const useSemanticSearchStore = create<SemanticSearchState>()((set, get) => ({
  status: 'idle',
  query: '',
  scores: new Map(),
  generation: 0,

  async ensureModel() {
    if (get().status !== 'idle') return
    set({ status: 'loading' })
    try {
      embedder = await embedderFactory()
      cache = await cacheFactory()
      set({ status: 'ready' })
    } catch {
      embedder = null
      cache = null
      set({ status: 'unavailable' })
    }
  },

  async scoreQuery(query, items) {
    if (get().status !== 'ready' || embedder === null || cache === null) return
    const activeEmbedder = embedder
    const activeCache = cache
    const myGeneration = get().generation + 1
    set({ generation: myGeneration })
    try {
      const queryVector = await embedWithCache(query, activeEmbedder, activeCache)
      const itemVectors = new Map<string, readonly number[]>()
      for (const item of items) {
        itemVectors.set(item.id, await embedWithCache(itemContentText(item), activeEmbedder, activeCache))
      }
      // A newer scoreQuery call started (and possibly already finished)
      // while this one was in flight — its result is stale, drop it rather
      // than clobber the fresher one (HANDOFF's generation-counter pattern).
      if (get().generation !== myGeneration) return
      set({ query, scores: semanticScoresFromVectors(queryVector, itemVectors) })
    } catch {
      set({ status: 'unavailable' })
    }
  },
}))

export function resetSemanticSearch(): void {
  embedderFactory = createTransformersEmbedder
  cacheFactory = createVectorCache
  embedder = null
  cache = null
  useSemanticSearchStore.setState({ status: 'idle', query: '', scores: new Map(), generation: 0 })
}
