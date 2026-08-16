import { beforeEach, describe, expect, it } from 'vitest'
import { resetCanvasCoverage, useCanvasCoverageStore } from './canvasCoverage'

// 089-D3 P4 — the canvas-only slice tracking whether the coverage TWIN node is
// open beside the Design core (issue 012). Unlike P3's satellites (an unbounded
// id-keyed set), the twin is a SINGLETON toggle per canvas, so this is a plain
// boolean. The `v` handler lives in DesignRegisterBody
// and the twin renders in WorkspaceCanvas — separate React trees — so the open
// state must be a store, not component state (the P2/P3 cross-tree lesson).

describe('canvasCoverage store (issue 012 / P4)', () => {
  beforeEach(() => resetCanvasCoverage())

  it('starts closed', () => {
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(false)
  })

  it('toggle opens the twin without carrying any camera state', () => {
    useCanvasCoverageStore.getState().toggle()
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(true)
    expect(s).toEqual(expect.objectContaining({ open: true }))
    expect(s).not.toHaveProperty('focus')
  })

  it('toggle again closes the twin', () => {
    const store = useCanvasCoverageStore.getState()
    store.toggle() // open
    store.toggle() // close
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(false)
  })

  it('collapse closes the twin regardless of prior state', () => {
    const store = useCanvasCoverageStore.getState()
    store.toggle() // open
    store.collapse()
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(false)
  })

  it('setOpen(true) opens (deep-link ?view=coverage seed); setOpen(false) closes', () => {
    useCanvasCoverageStore.getState().setOpen(true)
    expect(useCanvasCoverageStore.getState().open).toBe(true)
    useCanvasCoverageStore.getState().setOpen(false)
    expect(useCanvasCoverageStore.getState().open).toBe(false)
  })

  it('setOpen is idempotent', () => {
    const store = useCanvasCoverageStore.getState()
    store.setOpen(true)
    store.setOpen(true)
    expect(useCanvasCoverageStore.getState().open).toBe(true)
  })

  it('reset closes the twin (per-canvas-nav reset — stable-id node never unmounts)', () => {
    const store = useCanvasCoverageStore.getState()
    store.toggle()
    resetCanvasCoverage()
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(false)
  })
})
