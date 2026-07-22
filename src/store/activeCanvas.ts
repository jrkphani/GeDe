import { create } from 'zustand'

// Issue 100 Phase C — the active-canvas registry. Parallel to activeLane.ts: where
// `activeLane` disambiguates Design's ~5 capture-phase GLOBAL key handlers across
// the CO-MOUNTED Foundation/Architecture/Design LANES, `activeCanvas` disambiguates
// them across CO-MOUNTED LIVE DESIGN CORES. Phase D promotes a drilled-in child
// canvas to its own live {register+ring} core stacked beside the root core; each
// core registers the SAME `c` / `v` / `d` `window.addEventListener('keydown', fn,
// true)` handlers (DesignCoreAdapter.tsx), so a keypress would otherwise fire in
// EVERY co-mounted core at once. This slice records which core is focused — set on
// each core body's focusin / pointerdown (WorkspaceCanvas) next to `setActiveLane`
// — so those verbs can gate on `activeCanvas === coreKey` and stay scoped to the
// core the user is actually in.
//
// A core's key is `canvasId ?? 'root'` (the primary root core's `canvasId` prop is
// the active root canvas id or undefined → 'root'; a Phase-D child core passes its
// own child canvas id). With exactly ONE live core (today), the sole core is always
// the active canvas when focused, so `activeCanvas === coreKey` is invariantly true
// and the added gate is inert — the verbs fire exactly as before.
//
// Deliberate trade (mirrors activeLane): with NO core active (`activeCanvas ===
// null`, e.g. focus on <body>), the verbs are no-ops until the user clicks into a
// core. Handlers read it non-reactively via getState() so the capture listener
// never re-subscribes on focus changes.
interface ActiveCanvasState {
  activeCanvas: string | null
  setActiveCanvas: (key: string | null) => void
}

export const useActiveCanvasStore = create<ActiveCanvasState>()((set) => ({
  activeCanvas: null,
  setActiveCanvas(key) {
    set({ activeCanvas: key })
  },
}))

// Session-scoped test/reset seam, mirroring resetActiveLane.
export function resetActiveCanvas(): void {
  useActiveCanvasStore.setState({ activeCanvas: null })
}
