// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { resetCanvasMode, useCanvasModeStore } from './canvasMode'

// Issue 089 D3 graduation P7 — the canvas GRADUATED to the default workspace.
// `canvasEnabled` is now driven by device CAPABILITY (desktop/tablet width +
// not a data-saver), with `?d3rf` retained only as a force-on override. The
// seed is read once at store-create and App reads the store thereafter, so an
// in-app navigate() never re-evaluates the gate mid-flow (the P0 persistence
// guarantee still holds).

function setUrl(search: string): void {
  window.history.replaceState(null, '', `/${search}`)
}

// jsdom has no matchMedia — install a stub that answers the two capability
// queries canvasCapable() asks (min-width + prefers-reduced-data).
function mockMatchMedia(opts: { wide: boolean; reducedData?: boolean }): void {
  ;(window as unknown as { matchMedia: (q: string) => { matches: boolean; media: string } }).matchMedia = (
    q: string,
  ) => ({
    matches: q.includes('min-width: 1024px')
      ? opts.wide
      : q.includes('prefers-reduced-data')
        ? (opts.reducedData ?? false)
        : false,
    media: q,
  })
}

function clearMatchMedia(): void {
  delete (window as Partial<Window>).matchMedia
}

afterEach(() => {
  resetCanvasMode()
  setUrl('')
  clearMatchMedia()
})

describe('canvasMode store (089 D3 graduation P7 — capability default)', () => {
  it('enables the canvas on a desktop/tablet-wide viewport (no ?d3rf needed)', () => {
    mockMatchMedia({ wide: true })
    useCanvasModeStore.getState().reseed()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(true)
  })

  it('falls back (canvas OFF → WorkspaceSurface) on a narrow (< 1024px) viewport', () => {
    mockMatchMedia({ wide: false })
    useCanvasModeStore.getState().reseed()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(false)
  })

  it('falls back (canvas OFF) under prefers-reduced-data even when wide', () => {
    mockMatchMedia({ wide: true, reducedData: true })
    useCanvasModeStore.getState().reseed()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(false)
  })

  it('?d3rf forces the canvas ON even on a narrow viewport (override / e2e pin)', () => {
    mockMatchMedia({ wide: false })
    setUrl('?d3rf=1')
    useCanvasModeStore.getState().reseed()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(true)
  })

  it('stays OFF with no matchMedia (jsdom/SSR) and no ?d3rf', () => {
    clearMatchMedia()
    setUrl('?other=1')
    useCanvasModeStore.getState().reseed()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(false)
  })

  it('PERSISTS across a navigate() that changes the URL (no re-seed) — the P0 guarantee', () => {
    mockMatchMedia({ wide: true })
    useCanvasModeStore.getState().reseed()
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(true)
    // A navigate() rebuilds the URL — but WITHOUT a re-seed the store keeps the
    // value, so the canvas does not exit mid-flow.
    setUrl('p/x/design')
    expect(useCanvasModeStore.getState().canvasEnabled).toBe(true)
  })

  it('setCanvasEnabled(true) turns it on; false turns it off (no longer DEV-gated)', () => {
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
