import { create } from 'zustand'

// Issue 089 D3 graduation — the canvas-mode registry. GRADUATED at P7: the
// React Flow pan/zoom canvas is now the DEFAULT workspace for the project /
// tier / design routes, gated by device CAPABILITY (desktop/tablet width + not
// a data-saver), NOT the old dev-only `?d3rf` URL flag. `WorkspaceSurface` (the
// D2 stacked-lane page) is retained as the < 1024px / reduced-data fallback
// (App.tsx reads `canvasEnabled` and renders one or the other).
//
// `?d3rf` is retained ONLY as a force-ON override — a narrow-screen escape
// hatch, and the pin the `d3-canvas.spec.ts` e2e suite uses to mount the canvas
// regardless of the test viewport.
//
// The seed is read ONCE at store-create (App.tsx imports this module before any
// component mounts) and App reads the store thereafter, so any in-app
// navigate() that rebuilds the URL via `serializeRoute` (a tier-tab click, a
// recursion drill-in, the `v` coverage toggle) never re-evaluates the gate
// mid-flow — the P0 persistence guarantee still holds. Mirrors activeLane.ts /
// focusedEditor.ts: a small, shell-owned Zustand slice App depends on, never
// the reverse.
//
// DELIBERATELY NOT re-seeded on viewport resize: crossing the 1024px boundary
// mid-session (undocking a laptop, restoring a window) keeps the surface chosen
// at load until a full reload. WorkspaceCanvas and WorkspaceSurface are
// structurally different React trees; hot-swapping one for the other mid-edit
// would unmount live editing state and the React Flow instance — a jarring,
// data-risky surprise far worse than staying on a slightly-too-wide/narrow
// surface until the next reload. `reseed()` is exposed if a future explicit
// "switch layout" affordance ever wants it.

// Canvas is the default when the viewport is desktop/tablet-wide (>= 1024px,
// matching the base.css narrow-reflow boundary) AND the user is not in a
// data-saver (prefers-reduced-data) mode — the infinite pan/zoom canvas is
// desktop/tablet-first by necessity (089). `matchMedia` is guaranteed by the
// DOM lib types but absent under jsdom (unit tests) and SSR — read it through
// Partial<Window> so the presence check is a real runtime guard; with no
// matchMedia the canvas stays OFF and WorkspaceSurface renders. An unsupported
// `prefers-reduced-data` feature reports `matches: false`, i.e. "not saving
// data" → canvas stays enabled, the correct default.
function canvasCapable(): boolean {
  const matchMedia = (window as Partial<Window>).matchMedia
  if (!matchMedia) return false
  const wideEnough = matchMedia('(min-width: 1024px)').matches
  const reducedData = matchMedia('(prefers-reduced-data: reduce)').matches
  return wideEnough && !reducedData
}

// `?d3rf` — the retained force-ON override (see module note).
function d3rfInUrl(): boolean {
  return new URLSearchParams(window.location.search).has('d3rf')
}

function resolveCanvasEnabled(): boolean {
  return canvasCapable() || d3rfInUrl()
}

interface CanvasModeState {
  canvasEnabled: boolean
  // Re-evaluate capability (+ the `?d3rf` override) and update. Called once at
  // store-create time (the initial state below already does this); exposed for
  // an explicit re-seed and for tests.
  reseed: () => void
  setCanvasEnabled: (enabled: boolean) => void
}

export const useCanvasModeStore = create<CanvasModeState>()((set) => ({
  // Seeded at store-create time — App.tsx imports this module before any
  // component mounts, so capability (viewport width) is already resolvable and
  // `?d3rf`, if present, still carries in `window.location.search`. No mount
  // effect / one-frame flicker needed.
  canvasEnabled: resolveCanvasEnabled(),
  reseed() {
    set({ canvasEnabled: resolveCanvasEnabled() })
  },
  setCanvasEnabled(enabled) {
    set({ canvasEnabled: enabled })
  },
}))

// Session-scoped test/reset seam, mirroring resetActiveLane / resetFocusedEditor.
export function resetCanvasMode(): void {
  useCanvasModeStore.setState({ canvasEnabled: false })
}
