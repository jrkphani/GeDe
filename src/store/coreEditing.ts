import { create } from 'zustand'

// Issue 106 item 1 (HIGH review fix) — the shared per-core editing signal that
// couples a drilled-in child core's REGISTER and RING on the editing axis.
//
// The problem it solves: the register owns the edit gate (its focus-within ref keeps
// an actively-edited core live), but the ring is a SEPARATE React Flow node body with
// its own `useCoreLod` call — it cannot see the register's ref. Before this store the
// ring's edit gate was permanently false, so editing a register then panning the core
// off-screen left a LIVE register beside a STUB ring for the same core (a visible
// violation of the locked "register + ring demote in lockstep" contract).
//
// The register WRITES this signal imperatively from its focus handlers via
// `getState().setCoreEditing(...)` — write-only, NOT a hook selector — so the register
// never subscribes to it and never re-renders on its own focus (a focus-triggered
// re-render cancels click-to-edit — the documented 089-P5 / useLaneLod regression; the
// register keeps its LOCAL focus ref for its OWN gate). The ring READS it with a
// BOOLEAN `useStore` selector (`s.editing[coreId] === true`) so it re-renders only when
// the register's editing flips (the ring is read-only per 085, so re-rendering on the
// register's edit start/stop is harmless). Keyed by the core's `storeCanvasId`.
//
// Mirrors activeLane.ts / focusedEditor.ts: a small, shell-owned Zustand slice that
// features depend on, never the reverse — so it adds no import cycle.
interface CoreEditingState {
  // Present-and-true iff that core is currently being edited. A cleared core is
  // DELETED from the map (not stored `false`) so `editing` stays a compact set and
  // an unchanged clear is a stable-reference no-op (no needless ring re-render).
  editing: Record<string, boolean>
  setCoreEditing: (coreId: string, editing: boolean) => void
  resetCoreEditing: () => void
}

export const useCoreEditingStore = create<CoreEditingState>()((set) => ({
  editing: {},
  setCoreEditing(coreId, editing) {
    set((s) => {
      const wasEditing = s.editing[coreId] === true
      if (wasEditing === editing) return s // no-op → stable ref, no subscriber churn
      if (editing) return { editing: { ...s.editing, [coreId]: true } }
      const next = { ...s.editing }
      Reflect.deleteProperty(next, coreId)
      return { editing: next }
    })
  },
  resetCoreEditing() {
    set({ editing: {} })
  },
}))

// Session-scoped test/reset seam, mirroring resetActiveLane / resetActiveCanvas.
export function resetCoreEditing(): void {
  useCoreEditingStore.setState({ editing: {} })
}
