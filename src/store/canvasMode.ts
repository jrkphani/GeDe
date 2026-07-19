import { create } from 'zustand'

// Issue 089 D3 graduation P0 — the canvas-mode registry. The `?d3rf` React Flow
// canvas is opt-in per URL today; App.tsx's `d3CanvasEnabled()` re-reads
// `window.location.search` on every render, so any in-app `navigate()` that
// rebuilds the URL via `serializeRoute` (a tier-tab click, a recursion drill-in
// `DesignSurface.tsx:493`, the `v` coverage toggle `:567/:584`) DROPS the
// `?d3rf` param and the canvas silently exits mid-flow. The ⌘1/2/3 interceptor
// (d3CanvasNav.ts) preserves the flag only for lane jumps, not real navigates.
//
// Graduation's satellite phases (P3 recursion / P4 coverage) all navigate, so
// the flag must survive a navigate() BEFORE they land. This slice holds the
// opt-in ONCE (seeded from the initial URL at load) and App reads the store
// thereafter, so a later navigate that drops `?d3rf` no longer unmounts the
// canvas. When the canvas graduates to the DEFAULT (P7) this seed becomes a
// capability check instead of a URL read.
//
// `import.meta.env.DEV` is statically `false` in a production build, so
// `canvasEnabled` folds to a constant `false` there — the canvas stays dead
// code in prod (the `React.lazy(WorkspaceCanvas)` chunk is never fetched),
// exactly as the old `d3CanvasEnabled()` guaranteed. Both the seed and the
// setter re-apply the DEV gate so nothing can force the canvas on in prod.
//
// Mirrors activeLane.ts / focusedEditor.ts: a small, shell-owned Zustand slice
// App depends on, never the reverse.
function d3rfInUrl(): boolean {
  return new URLSearchParams(window.location.search).has('d3rf')
}

interface CanvasModeState {
  canvasEnabled: boolean
  // Re-read the URL and apply the DEV gate. Called once on load (the initial
  // state below already does this at store-create time); exposed for an
  // explicit re-seed and for tests.
  seedFromUrl: () => void
  setCanvasEnabled: (enabled: boolean) => void
}

export const useCanvasModeStore = create<CanvasModeState>()((set) => ({
  // Seeded at store-create time — App.tsx imports this module before any
  // component mounts, so `window.location.search` still carries the initial
  // `?d3rf` (before the /p/:id→lastTierRoute redirect or any tab click strips
  // it). No mount effect / one-frame flicker needed.
  canvasEnabled: import.meta.env.DEV && d3rfInUrl(),
  seedFromUrl() {
    set({ canvasEnabled: import.meta.env.DEV && d3rfInUrl() })
  },
  setCanvasEnabled(enabled) {
    set({ canvasEnabled: import.meta.env.DEV && enabled })
  },
}))

// Session-scoped test/reset seam, mirroring resetActiveLane / resetFocusedEditor.
export function resetCanvasMode(): void {
  useCanvasModeStore.setState({ canvasEnabled: false })
}
