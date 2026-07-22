import type { StoreApi, UseBoundStore } from 'zustand'
import { createCanvasComposeStore, type CanvasComposeState } from './canvasCompose'
import { createContextsStore, type ContextsState } from './contexts'
import { createDimensionsStore, type DimensionsState } from './dimensions'

// Issue 100 Phase A — CLIENT store-lifetime refactor. The three Design-tier
// stores (contexts / dimensions / canvasCompose) used to be module-level
// singletons; they are now factory-produced so a later phase can hold one
// independent instance per open canvas. THIS phase only ever instantiates the
// single default instance, so runtime behaviour is byte-identical to the
// pre-refactor singletons. parameters.ts stays a global singleton (it is
// dimension-keyed, hence collision-free across canvases) and is untouched.
//
// ⚠️ CIRCULAR-INIT INVARIANT (do not break — nothing lints it). This module and
// the three store modules form an import cycle: canvasStores → {contexts,
// dimensions, canvasCompose} (value imports of the factories) → canvasStores
// (the `export { useXStore } from './canvasStores'` re-export lines). It is safe
// ONLY because:
//   (1) `createContextsStore`/`createDimensionsStore`/`createCanvasComposeStore`
//       are HOISTED `function` declarations — so `getCanvasStores(null)` below
//       can call them during module init regardless of cycle entry order. Do NOT
//       convert them to `const` arrow exports (would TDZ / read undefined).
//   (2) The dependent modules import `CanvasStores` as a TYPE-ONLY import
//       (`import type { CanvasStores }`), which is erased at compile time. Do NOT
//       add a VALUE import from this module into contexts/dimensions/canvasCompose
//       (would reintroduce a runtime cycle that reads a not-yet-initialised
//       binding). There is no `import/no-cycle` lint rule; the 1665-test suite +
//       prod build are the only guardrails.

export interface CanvasStores {
  canvasId: string | null
  useContexts: UseBoundStore<StoreApi<ContextsState>>
  useDimensions: UseBoundStore<StoreApi<DimensionsState>>
  useCompose: UseBoundStore<StoreApi<CanvasComposeState>>
  resetContexts: () => void
  resetDimensions: () => void
  resetCompose: () => void
  teardown: () => void
}

function createCanvasStores(canvasId: string | null): CanvasStores {
  // `stores` is populated by the property assignments below; the lazy
  // `getStores` accessor closes over it and is only ever CALLED from inside
  // store actions (long after this function returns), so every cross-store read
  // resolves against the fully-populated object. This forward reference — the
  // empty-object seed filled in immediately after the factories are built — is
  // what lets dimensions/compose read their siblings with no initialisation-
  // order hazard.
  const stores = {} as CanvasStores
  const getStores = (): CanvasStores => stores

  // contexts is a leaf (no sibling reads), so its factory takes no accessor.
  const contexts = createContextsStore()
  const dimensions = createDimensionsStore(getStores)
  const compose = createCanvasComposeStore(getStores)

  stores.canvasId = canvasId
  stores.useContexts = contexts.useStore
  stores.useDimensions = dimensions.useStore
  stores.useCompose = compose.useStore
  stores.resetContexts = contexts.reset
  stores.resetDimensions = dimensions.reset
  stores.resetCompose = compose.reset
  // compose has no sync subscription, so only the two DB-backed stores have a
  // per-instance listener to release.
  stores.teardown = () => {
    contexts.teardown()
    dimensions.teardown()
  }
  return stores
}

const DEFAULT_KEY = '__default__'
const registry = new Map<string, CanvasStores>()

// Memoised per-canvas accessor. `null` ⇒ the project's default root canvas —
// the ONLY key ever requested in Phase A.
export function getCanvasStores(canvasId: string | null): CanvasStores {
  const key = canvasId ?? DEFAULT_KEY
  const existing = registry.get(key)
  if (existing) return existing
  const created = createCanvasStores(canvasId)
  registry.set(key, created)
  return created
}

// Issue 106 item 3 — every currently-live store instance, in insertion order
// (default first). A pure synchronous Map read: presence's palette/cue paths
// enumerate the LIVE cores from this, never a DB query. Released instances are
// already `registry.delete`d (releaseCanvasStores) so they self-exclude — no
// stale entry can leak out. Callers distinguish the default from a child purely
// by `.canvasId` (null ⇒ default, parentContextId ⇒ child).
export function listCanvasStores(): CanvasStores[] {
  return [...registry.values()]
}

// Tear down and drop a non-default canvas's stores. The default instance is
// process-lifetime and is never released.
export function releaseCanvasStores(canvasId: string | null): void {
  const key = canvasId ?? DEFAULT_KEY
  if (key === DEFAULT_KEY) return
  const existing = registry.get(key)
  if (!existing) return
  existing.teardown()
  registry.delete(key)
}

// Issue 100 — resolves which canvas's stores a live core should use. The optional
// `canvasId` is the Phase-D seam: a child core passes its own canvas id to get an
// independent store instance. In Phase C EVERY caller passes NO argument →
// `getCanvasStores(null)` → the single default instance (root === default), so
// behavior is byte-identical to the pre-Phase-B singleton.
export function resolveCanvasStores(canvasId?: string | null): CanvasStores {
  return getCanvasStores(canvasId ?? null)
}

// The default instance — created once, at module load. Its hooks and reset
// seams are re-exported by contexts.ts / dimensions.ts / canvasCompose.ts so
// every pre-refactor import path keeps resolving to exactly these singletons.
const defaultStores = getCanvasStores(null)

export const useContextsStore = defaultStores.useContexts
export const useDimensionsStore = defaultStores.useDimensions
export const useCanvasComposeStore = defaultStores.useCompose

export function resetContextsStore(): void {
  defaultStores.resetContexts()
}

export function resetDimensionsStore(): void {
  defaultStores.resetDimensions()
}

export function resetCanvasCompose(): void {
  defaultStores.resetCompose()
}
