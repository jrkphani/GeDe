import { afterEach, describe, expect, it } from 'vitest'
import { getCanvasStores, listCanvasStores, releaseCanvasStores } from './canvasStores'

// Issue 106 item 3 — the palette enumerates CURRENTLY-LIVE store instances via
// listCanvasStores() (a pure synchronous registry read, never a DB read). The
// default instance is process-lifetime; child instances come and go with
// getCanvasStores(parentContextId) / releaseCanvasStores(parentContextId), so
// the registry must self-exclude released children.
afterEach(() => {
  releaseCanvasStores('parent-A')
})

describe('listCanvasStores — live per-canvas store registry (issue 106 item 3)', () => {
  it('includes the default instance (created at module load)', () => {
    expect(listCanvasStores().some((s) => s.canvasId === null)).toBe(true)
  })

  it('includes a child instance after getCanvasStores(parentContextId), keyed by canvasId', () => {
    getCanvasStores('parent-A')
    const child = listCanvasStores().find((s) => s.canvasId === 'parent-A')
    expect(child).toBeDefined()
    // The child is distinguishable from the default purely by its canvasId key.
    expect(child?.canvasId).toBe('parent-A')
    expect(listCanvasStores().some((s) => s.canvasId === null)).toBe(true)
  })

  it('excludes a child instance after releaseCanvasStores', () => {
    getCanvasStores('parent-A')
    expect(listCanvasStores().some((s) => s.canvasId === 'parent-A')).toBe(true)
    releaseCanvasStores('parent-A')
    expect(listCanvasStores().some((s) => s.canvasId === 'parent-A')).toBe(false)
    // The default instance is never released.
    expect(listCanvasStores().some((s) => s.canvasId === null)).toBe(true)
  })
})
