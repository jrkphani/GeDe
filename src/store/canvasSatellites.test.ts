import { beforeEach, describe, expect, it } from 'vitest'
import { resetCanvasSatellites, satelliteNodeId, useCanvasSatellitesStore } from './canvasSatellites'

// 089-D3 P3 — the canvas-only slice tracking which child canvases are OPEN as
// edge-connected satellites beside the Design core. The register/ring bodies and
// the WorkspaceCanvas that renders the satellites are SEPARATE React trees (P2's
// cross-tree lesson), so the open set lives in a store, not component state.
//
// STUB scope (owner, 2026-07-19): a satellite is a SUMMARY node, not a second
// live {register+ring} core (the contexts store is a hard singleton). Promoting a
// stub to a live child core is the tracked follow-up in issue 089.

describe('canvasSatellites store (issue 011 / P3)', () => {
  beforeEach(() => resetCanvasSatellites())

  it('starts empty — no satellites, no focus', () => {
    const s = useCanvasSatellitesStore.getState()
    expect(s.open).toEqual([])
    expect(s.focus).toBeNull()
  })

  it('openSatellite adds a parent context and focuses it (pan target)', () => {
    useCanvasSatellitesStore.getState().openSatellite('ctx-a')
    const s = useCanvasSatellitesStore.getState()
    expect(s.open).toEqual(['ctx-a'])
    expect(s.focus).toBe(satelliteNodeId('ctx-a'))
  })

  it('is idempotent — re-opening an already-open context does not duplicate, but re-focuses', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a')
    store.openSatellite('ctx-b')
    store.openSatellite('ctx-a')
    const s = useCanvasSatellitesStore.getState()
    expect(s.open).toEqual(['ctx-a', 'ctx-b'])
    // Re-opening re-targets the pan to the existing satellite.
    expect(s.focus).toBe(satelliteNodeId('ctx-a'))
  })

  it('collapse removes exactly one satellite, leaving the rest untouched', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a')
    store.openSatellite('ctx-b')
    store.collapse('ctx-a')
    expect(useCanvasSatellitesStore.getState().open).toEqual(['ctx-b'])
  })

  it('collapsing the focused satellite clears the stale focus (no pan to a gone node)', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a')
    expect(useCanvasSatellitesStore.getState().focus).toBe(satelliteNodeId('ctx-a'))
    store.collapse('ctx-a')
    expect(useCanvasSatellitesStore.getState().focus).toBeNull()
  })

  it('consumeFocus clears the pan target after the viewport has panned', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a')
    store.consumeFocus()
    expect(useCanvasSatellitesStore.getState().focus).toBeNull()
    // open set is untouched — only the one-shot focus is consumed.
    expect(useCanvasSatellitesStore.getState().open).toEqual(['ctx-a'])
  })

  it('reset clears everything (per-canvas-nav reset — stable-id nodes never unmount)', () => {
    const store = useCanvasSatellitesStore.getState()
    store.openSatellite('ctx-a')
    store.openSatellite('ctx-b')
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
