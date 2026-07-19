import { create } from 'zustand'
import type { ContextRow } from '../db/mutations'
import { composeReducer, firstUnbound } from '../domain/composeMode'
import { tupleReadout } from '../domain/contextDescription'
import { useCommandLogStore } from './commandLog'
import { useContextsStore } from './contexts'
import { useDimensionsStore } from './dimensions'
import { useParametersStore } from './parameters'
import { useStatusStore } from './status'

// Issue 089 D3 graduation P2 — compose-mode state for the DECOMPOSED Design lane.
// On the `?d3rf` canvas the Design lane splits into two separate React Flow node
// bodies — a REGISTER body (authoring) stacked over a RING body (Canvas). They
// are distinct React trees, so the compose draft they share (the register's `c`
// key / phantom ENTERS compose; the ring's dots BIND/EXIT it) cannot live in a
// component's useState. This slice is the canvas-only extraction of
// DesignSurface's compose machine (DesignSurface.tsx:216-304): both bodies call
// these actions, so there is one source of truth and no duplication. The flag-off
// `DesignSurface` keeps its own in-component machine untouched (a mutually-
// exclusive render path — the store is never shared across the flag boundary).
//
// The store reads dimensions/parameters/contexts via getState() (it has no React
// context), replicating DesignSurface's orderedDimensionIds/paramNameById memos.
// readOnly is guarded by the CALLER (the `c` handler / the New-context button
// only fire for editors), mirroring how DesignSurface's own guard sat upstream.

function orderedDimensionIds(): string[] {
  return [...useDimensionsStore.getState().dimensions].sort((a, b) => a.sort - b.sort).map((d) => d.id)
}

function paramNameById(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const list of Object.values(useParametersStore.getState().byDimension)) {
    for (const p of list) map[p.id] = p.name
  }
  return map
}

interface CanvasComposeState {
  composeContextId: string | null
  // Entering compose creates a real, persisted draft (SPEC invariant 6) and
  // selects it. A coverage-gap caller passes the whole tuple as `initialBindings`
  // — create + the n binds are one undoable gesture (mirrors the register's
  // batched phantom create). No-op if a draft is already open.
  enterCompose: (initialBindings?: Record<string, string>) => Promise<void>
  // Leave compose keeping the draft (drafts are legal); offer to discard as one
  // undoable action via the status line.
  exitCompose: () => void
  bindParameter: (dimensionId: string, parameterId: string) => Promise<void>
  unbindParameter: (dimensionId: string) => Promise<void>
  // Drop compose state if the draft vanished (discarded / project switched /
  // undone) so the ring never points compose at a context that isn't there.
  clearIfMissing: (existing: ReadonlySet<string> | readonly string[]) => void
}

export const useCanvasComposeStore = create<CanvasComposeState>()((set, get) => ({
  composeContextId: null,

  async enterCompose(initialBindings) {
    if (get().composeContextId) return
    const ordered = orderedDimensionIds()
    const run = async (): Promise<ContextRow | null> => {
      const row = await useContextsStore.getState().create()
      if (!row) return null
      if (initialBindings) {
        for (const dimId of ordered) {
          const paramId = initialBindings[dimId]
          if (paramId) await useContextsStore.getState().bind(row.id, dimId, paramId)
        }
      }
      return row
    }
    const created = initialBindings
      ? await useCommandLogStore.getState().batch('compose from gap', run)
      : await run()
    if (!created) return
    useContextsStore.getState().select(created.id)
    set({ composeContextId: created.id })
    const firstUnboundName = useDimensionsStore
      .getState()
      .dimensions.find((d) => d.id === firstUnbound(ordered, initialBindings ?? {}))?.name
    useStatusStore
      .getState()
      .announce(
        firstUnboundName
          ? `Composing ${created.symbol} — bind ${firstUnboundName}`
          : `Composing ${created.symbol}`,
      )
  },

  exitCompose() {
    const id = get().composeContextId
    if (!id) return
    const symbol = useContextsStore.getState().contexts.find((c) => c.id === id)?.symbol ?? 'draft'
    set({ composeContextId: null })
    useStatusStore.getState().announce(`Draft ${symbol} kept`, {
      label: `Discard draft ${symbol}`,
      run: () => useContextsStore.getState().discard(id),
    })
  },

  async bindParameter(dimensionId, parameterId) {
    const id = get().composeContextId
    if (!id) return
    // The reducer only detects the incomplete→complete transition, so completion
    // is announced exactly once, on the bind that finishes the tuple. The active
    // pointer is derived from live bindings by the ring (activeDimensionId).
    const before = useContextsStore.getState().bindingsByContext[id] ?? {}
    const transition = composeReducer(
      orderedDimensionIds(),
      { bindings: before, activeDimensionId: null },
      { type: 'bind', dimensionId, parameterId },
    )
    await useContextsStore.getState().bind(id, dimensionId, parameterId)
    if (transition.completed) {
      const ctx = useContextsStore.getState().contexts.find((c) => c.id === id)
      const tuple = tupleReadout(
        useDimensionsStore.getState().dimensions,
        transition.state.bindings,
        paramNameById(),
      )
      useStatusStore
        .getState()
        .announce(`${ctx?.symbol ?? 'Context'} complete — ${tuple.join(', ')}`)
    }
  },

  async unbindParameter(dimensionId) {
    const id = get().composeContextId
    if (!id) return
    await useContextsStore.getState().unbind(id, dimensionId)
  },

  clearIfMissing(existing) {
    const id = get().composeContextId
    if (!id) return
    const present = existing instanceof Set ? existing.has(id) : (existing as readonly string[]).includes(id)
    if (!present) set({ composeContextId: null })
  },
}))

// Session-scoped test/reset seam, mirroring resetActiveLane / resetCanvasMode.
export function resetCanvasCompose(): void {
  useCanvasComposeStore.setState({ composeContextId: null })
}
