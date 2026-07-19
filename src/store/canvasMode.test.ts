// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { resetCanvasMode, useCanvasModeStore } from './canvasMode'

// Issue 089 D3 graduation P0 — the canvas-mode slice persists the `?d3rf`
// opt-in across an in-app navigate(). Today `d3CanvasEnabled()` re-reads
// `window.location.search` every render (App.tsx), so any navigate() that
// rebuilds the URL via serializeRoute (a tab click, a drill-in, the `v`
// toggle) DROPS `?d3rf` and the canvas exits mid-flow. Seeding the flag into
// this store ONCE — and reading the store thereafter — lets the canvas survive
// those navigations (a hard prerequisite for the satellite phases, which all
// navigate). In DEV/test `import.meta.env.DEV` is true, so the value tracks the
// URL; in a prod build DEV is statically false so the flag can never turn on.

function setUrl(search: string): void {
  window.history.replaceState(null, '', `/${search}`)
}

afterEach(() => {
  resetCanvasMode()
  setUrl('')
})

describe('canvasMode store (089 D3 graduation P0)', () => {
  it('seedFromUrl enables the canvas when ?d3rf is present', () => {
    setUrl('?d3rf=1')
    useCanvasModeStore.getState().seedFromUrl()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(true)
  })

  it('seedFromUrl leaves the canvas off when ?d3rf is absent', () => {
    setUrl('?other=1')
    useCanvasModeStore.getState().seedFromUrl()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(false)
  })

  it('PERSISTS across a URL that later drops ?d3rf (the P0 guarantee)', () => {
    setUrl('?d3rf=1')
    useCanvasModeStore.getState().seedFromUrl()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(true)
    // A navigate() rebuilds the URL and drops ?d3rf — but WITHOUT a re-seed the
    // store keeps the flag, so the canvas does not exit.
    setUrl('p/x/design')
    // The URL really did drop the flag…
    expect(new URLSearchParams(window.location.search).has('d3rf')).toBe(false)
    // …but the store persists it.
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(true)
  })

  it('setCanvasEnabled(true) turns it on; false turns it off (DEV-gated setter)', () => {
    useCanvasModeStore.getState().setCanvasEnabled(true)
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(true)
    useCanvasModeStore.getState().setCanvasEnabled(false)
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(false)
  })

  it('resetCanvasMode clears it (test/session seam)', () => {
    useCanvasModeStore.getState().setCanvasEnabled(true)
    resetCanvasMode()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(false)
  })
})
