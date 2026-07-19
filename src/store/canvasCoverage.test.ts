import { beforeEach, describe, expect, it } from 'vitest'
import { resetCanvasCoverage, useCanvasCoverageStore } from './canvasCoverage'

// 089-D3 P4 — the canvas-only slice tracking whether the coverage TWIN node is
// open beside the Design core (issue 012). Unlike P3's satellites (an unbounded
// id-keyed set), the twin is a SINGLETON toggle per canvas, so this is a plain
// boolean + a one-shot pan `focus`. The `v` handler lives in DesignRegisterBody
// and the twin renders in WorkspaceCanvas — separate React trees — so the open
// state must be a store, not component state (the P2/P3 cross-tree lesson).

describe('canvasCoverage store (issue 012 / P4)', () => {
  beforeEach(() => resetCanvasCoverage())

  it('starts closed — no twin, no focus', () => {
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(false)
    expect(s.focus).toBe(false)
  })

  it('toggle opens the twin and requests a pan to it', () => {
    useCanvasCoverageStore.getState().toggle()
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(true)
    expect(s.focus).toBe(true)
  })

  it('toggle again closes the twin and clears any pending pan', () => {
    const store = useCanvasCoverageStore.getState()
    store.toggle() // open
    store.toggle() // close
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(false)
    expect(s.focus).toBe(false)
  })

  it('collapse closes the twin regardless of prior state', () => {
    const store = useCanvasCoverageStore.getState()
    store.toggle() // open
    store.collapse()
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(false)
    expect(s.focus).toBe(false)
  })

  it('setOpen(true) opens + focuses (deep-link ?view=coverage seed); setOpen(false) closes', () => {
    useCanvasCoverageStore.getState().setOpen(true)
    expect(useCanvasCoverageStore.getState().open).toBe(true)
    expect(useCanvasCoverageStore.getState().focus).toBe(true)
    useCanvasCoverageStore.getState().setOpen(false)
    expect(useCanvasCoverageStore.getState().open).toBe(false)
    expect(useCanvasCoverageStore.getState().focus).toBe(false)
  })

  it('setOpen is idempotent — re-seeding the same open state does not re-request a pan', () => {
    const store = useCanvasCoverageStore.getState()
    store.setOpen(true)
    store.consumeFocus() // viewport panned
    store.setOpen(true) // same state (e.g. a re-render) — must NOT re-pan
    expect(useCanvasCoverageStore.getState().open).toBe(true)
    expect(useCanvasCoverageStore.getState().focus).toBe(false)
  })

  it('consumeFocus clears the one-shot pan target, leaving open untouched', () => {
    const store = useCanvasCoverageStore.getState()
    store.toggle() // open + focus
    store.consumeFocus()
    expect(useCanvasCoverageStore.getState().focus).toBe(false)
    expect(useCanvasCoverageStore.getState().open).toBe(true)
  })

  it('reset closes the twin (per-canvas-nav reset — stable-id node never unmounts)', () => {
    const store = useCanvasCoverageStore.getState()
    store.toggle()
    resetCanvasCoverage()
    const s = useCanvasCoverageStore.getState()
    expect(s.open).toBe(false)
    expect(s.focus).toBe(false)
  })
})
