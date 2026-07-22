import { beforeEach, describe, expect, it } from 'vitest'
import { resetCanvasSatellites, satelliteNodeId, useCanvasSatellitesStore } from './canvasSatellites'

// 089-D3 P3 / 100 Phase D / 106 item 2 — the canvas-only slice tracking which child
// canvases are OPEN as edge-connected LIVE child cores beside the Design core. The
// register/ring bodies and the WorkspaceCanvas that renders the cores are SEPARATE
// React trees (P2's cross-tree lesson), so the open set lives in a store.
//
// 106 item 2 — the open set is now PARENT-AWARE: each entry records the store id of
// the core it was drilled FROM (`parentCoreId`, null = the primary). A grandchild
// hangs off ITS parent child-core's column, so collapse must CASCADE — collapsing a
// mid-level parent tears down every descendant so no orphaned edge/column dangles.

describe('canvasSatellites store (issue 011 / P3 / 106-②)', () => {
  beforeEach(() => resetCanvasSatellites())

  it('starts empty — no satellites, no focus', () => {
    const s = useCanvasSatellitesStore.getState()
    expect(s.open).toEqual([])
    expect(s.focus).toBeNull()
  })

  it('openSatellite adds a parent context and focuses it (pan target)', () => {
    useCanvasSatellitesStore.getState().openSatellite('ctx-a', null)
    const s = useCanvasSatellitesStore.getState()
    expect(s.open).toEqual([{ contextId: 'ctx-a', parentCoreId: null }])
    expect(s.focus).toBe(satelliteNodeId('ctx-a'))
  })

  it('openSatellite records parentCoreId — null for a primary drill, the parent core id for a nested one', () => {
    const store = useCanvasSatellitesStore.getState()
    // Direct child: drilled from the primary → parentCoreId null.
    store.openSatellite('child', null)
    // Grandchild: drilled from inside the `child` core → parentCoreId 'child'.
    store.openSatellite('grandchild', 'child')
    expect(useCanvasSatellitesStore.getState().open).toEqual([
      { contextId: 'child', parentCoreId: null },
      { contextId: 'grandchild', parentCoreId: 'child' },
    ])
  })

  it('is idempotent — re-opening an already-open context does not duplicate, but re-focuses', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a', null)
    store.openSatellite('ctx-b', null)
    store.openSatellite('ctx-a', null)
    const s = useCanvasSatellitesStore.getState()
    expect(s.open).toEqual([
      { contextId: 'ctx-a', parentCoreId: null },
      { contextId: 'ctx-b', parentCoreId: null },
    ])
    // Re-opening re-targets the pan to the existing satellite.
    expect(s.focus).toBe(satelliteNodeId('ctx-a'))
  })

  it('collapse removes exactly one leaf satellite, leaving siblings/other parents untouched', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a', null)
    store.openSatellite('ctx-b', null)
    store.collapse('ctx-a')
    expect(useCanvasSatellitesStore.getState().open).toEqual([
      { contextId: 'ctx-b', parentCoreId: null },
    ])
  })

  it('collapse CASCADES — collapsing a mid-level parent removes it AND every descendant', () => {
    const store = useCanvasSatellitesStore.getState()
    // primary → child → grandchild → great-grandchild (arbitrary depth), plus a
    // sibling under the primary that must survive.
    store.openSatellite('child', null)
    store.openSatellite('grandchild', 'child')
    store.openSatellite('ggc', 'grandchild')
    store.openSatellite('sibling', null)
    store.collapse('child')
    // The whole `child` subtree is gone; the unrelated `sibling` remains.
    expect(useCanvasSatellitesStore.getState().open).toEqual([
      { contextId: 'sibling', parentCoreId: null },
    ])
  })

  it('collapse returns the cascaded ids (target + descendants) so the caller can release each store', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('child', null)
    store.openSatellite('grandchild', 'child')
    store.openSatellite('ggc', 'grandchild')
    const released = store.collapse('child')
    expect(new Set(released)).toEqual(new Set(['child', 'grandchild', 'ggc']))
  })

  it('cascade-collapse clears focus when it pointed at ANY torn-down descendant', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('child', null)
    store.openSatellite('grandchild', 'child')
    // focus now points at the grandchild (last opened).
    expect(useCanvasSatellitesStore.getState().focus).toBe(satelliteNodeId('grandchild'))
    // Collapsing the PARENT cascades to the grandchild → its focus must clear.
    store.collapse('child')
    expect(useCanvasSatellitesStore.getState().focus).toBeNull()
  })

  it('collapsing the focused satellite clears the stale focus (no pan to a gone node)', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a', null)
    expect(useCanvasSatellitesStore.getState().focus).toBe(satelliteNodeId('ctx-a'))
    store.collapse('ctx-a')
    expect(useCanvasSatellitesStore.getState().focus).toBeNull()
  })

  it('consumeFocus clears the pan target after the viewport has panned', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a', null)
    store.consumeFocus()
    expect(useCanvasSatellitesStore.getState().focus).toBeNull()
    // open set is untouched — only the one-shot focus is consumed.
    expect(useCanvasSatellitesStore.getState().open).toEqual([
      { contextId: 'ctx-a', parentCoreId: null },
    ])
  })

  it('reset clears everything (per-canvas-nav reset — stable-id nodes never unmount)', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a', null)
    store.openSatellite('ctx-b', null)
    resetCanvasSatellites()
    const s = useCanvasSatellitesStore.getState()
    expect(s.open).toEqual([])
    expect(s.focus).toBeNull()
  })

  it('satelliteNodeId is a stable, namespaced id derived from the parent context', () => {
    expect(satelliteNodeId('ctx-a')).toBe('satellite:ctx-a')
    expect(satelliteNodeId('ctx-a')).toBe(satelliteNodeId('ctx-a'))
  })
})
