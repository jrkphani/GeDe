import { hashContent } from '../domain/contentHash'

// Issue 042 — the client-side vector cache. Kept infra-only (not `src/domain`)
// because it does real I/O (IndexedDB); the content-hash math and the
// cosine-similarity blend stay pure in `src/domain/paletteRanking.ts` and
// `src/domain/contentHash.ts`. Injectable by design (`VectorCacheStore`,
// `Embedder`) so `embedWithCache`'s cache-invalidation contract is fully
// testable with a stubbed embedder and an in-memory store — no real model,
// no real IndexedDB, no network (test-first plan #3).

export interface VectorCacheStore {
  get(key: string): Promise<readonly number[] | undefined>
  set(key: string, vector: readonly number[]): Promise<void>
}

export interface Embedder {
  embed(text: string): Promise<readonly number[]>
}

/** A plain `Map`-backed store — the IndexedDB fallback (SSR/no-IndexedDB) and
 * the whole cache surface tests need, since the interesting behavior is the
 * content-hash keying in `embedWithCache`, not the storage medium itself. */
export function createMemoryVectorCache(): VectorCacheStore {
  const store = new Map<string, readonly number[]>()
  return {
    get(key) {
      return Promise.resolve(store.get(key))
    },
    set(key, vector) {
      store.set(key, vector)
      return Promise.resolve()
    },
  }
}

const DB_NAME = 'gede-embeddings'
const STORE_NAME = 'vectors'

/** The real, persistent, offline-capable cache (issue 042: "cache vectors in
 * IndexedDB keyed by a content hash"). Browser-only; guarded so importing
 * this module never throws in a non-browser context (tests run in `node`/
 * jsdom without IndexedDB — see `createMemoryVectorCache` for the fallback
 * they actually use). Not unit-tested directly (a real IndexedDB round-trip
 * needs a browser or a fake-indexeddb dependency this repo doesn't carry);
 * `embedWithCache`'s cache semantics are proven against the interface, which
 * this satisfies structurally. */
export function createIndexedDbVectorCache(): VectorCacheStore {
  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    })
  }

  return {
    async get(key) {
      const db = await openDb()
      return new Promise<readonly number[] | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const req = tx.objectStore(STORE_NAME).get(key)
        req.onsuccess = () => resolve(req.result as readonly number[] | undefined)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'))
      })
    },
    async set(key, vector) {
      const db = await openDb()
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).put(vector, key)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
      })
    },
  }
}

/** `typeof indexedDB === 'undefined'` in any non-browser context (tests,
 * SSR) or a browser with IndexedDB disabled (private mode in some engines) —
 * degrade to the in-memory cache rather than throw. Semantic search still
 * works for the session; it just re-embeds every reload (no persistence),
 * which is strictly additive over issue 017's pure-lexical baseline, never a
 * regression. */
export function createVectorCache(): VectorCacheStore {
  return typeof indexedDB === 'undefined' ? createMemoryVectorCache() : createIndexedDbVectorCache()
}

// In-flight embed promises, deduped by cache key, so two calls for the same
// content racing before either write lands don't both hit the embedder.
const inFlight = new Map<string, Promise<readonly number[]>>()

/** The cache-or-embed orchestration (issue 042 test-first plan #3): re-embeds
 * only when an item's text actually changed (content-hash keyed); unchanged
 * text is a guaranteed cache hit on the next call. */
export async function embedWithCache(
  text: string,
  embedder: Embedder,
  cache: VectorCacheStore,
): Promise<readonly number[]> {
  const key = hashContent(text)
  const cached = await cache.get(key)
  if (cached) return cached

  const existing = inFlight.get(key)
  if (existing) return existing

  const pending = (async () => {
    try {
      const vector = await embedder.embed(text)
      await cache.set(key, vector)
      return vector
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, pending)
  return pending
}
