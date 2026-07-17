import { create } from 'zustand'

// Issue 089 D2 Phase 3 — the active-lane registry. The unified workspace
// (WorkspaceSurface.tsx) co-mounts the Foundation, Architecture, and Design
// lanes on one page, so Design's ~5 capture-phase GLOBAL key handlers
// (`window.addEventListener('keydown', fn, true)` in DesignSurface.tsx) can no
// longer assume Design is the only surface: `c` / `v` / `d` would fire no
// matter which lane the user is working in. This slice records which lane is
// active — set on each lane's focusin / pointerdown (WorkspaceSurface) and on
// ⌘1/2/3 lane-jump (AppShell) — so those verbs can gate on `activeLane ===
// 'design'` and stay scoped to the lane the user is actually in.
//
// Deliberate trade (design brief risk 2): with NO lane active
// (`activeLane === null`, e.g. focus on <body>), `c` / `v` / `d` are no-ops
// until the user clicks / ⌘3s into a lane. Deterministic > cross-lane firing.
//
// Mirrors focusedEditor.ts / status.ts / commandRegistry.ts: a small,
// shell-owned Zustand slice features depend on, never the reverse. Handlers
// read it non-reactively via getState() so the capture listener never
// re-subscribes on lane changes.
export type Lane = 'foundation' | 'architecture' | 'design'

interface ActiveLaneState {
  activeLane: Lane | null
  setActiveLane: (lane: Lane | null) => void
}

export const useActiveLaneStore = create<ActiveLaneState>()((set) => ({
  activeLane: null,
  setActiveLane(lane) {
    set({ activeLane: lane })
  },
}))

// Session-scoped test/reset seam, mirroring resetFocusedEditor.
export function resetActiveLane(): void {
  useActiveLaneStore.setState({ activeLane: null })
}
