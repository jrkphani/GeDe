import { useEffect, useMemo, useState } from 'react'
import { ContextBar } from '../shell/slots'
import { documentedStatus, isComplete } from '../domain/completeness'
import { describeContext, tupleReadout } from '../domain/contextDescription'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { useParametersStore } from '../store/parameters'
import { useStatusStore } from '../store/status'
import { Canvas } from './Canvas'
import { Composer } from './Composer'
import { ContextRegister } from './ContextRegister'
import { DimensionManager, DimensionManagerPanel } from './DimensionManager'
import type { DesignView } from '../shell/routes'

export function DesignSurface({ projectId, view }: { projectId: string; view: DesignView }) {
  const dimensions = useDimensionsStore((s) => s.dimensions)
  const loadedFor = useDimensionsStore((s) => s.projectId)
  const editingId = useDimensionsStore((s) => s.editingId)
  const contexts = useContextsStore((s) => s.contexts)
  const bindingsByContext = useContextsStore((s) => s.bindingsByContext)
  const selectedContextId = useContextsStore((s) => s.selectedContextId)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const [guided, setGuided] = useState<boolean | null>(null)

  useEffect(() => {
    void useDimensionsStore.getState().load(projectId)
    setGuided(null)
  }, [projectId])

  // The canvas is a read-only companion projection (SPEC invariant 6) — it
  // reads the same contexts/parameters state ContextRegister already loads,
  // via its own subscription rather than prop-threading through the register.
  useEffect(() => {
    void useContextsStore.getState().load(projectId)
  }, [projectId])

  useEffect(() => {
    for (const d of dimensions) void useParametersStore.getState().load(d.id)
  }, [dimensions])

  const dimensionIds = useMemo(() => dimensions.map((d) => d.id), [dimensions])
  const paramNameById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const list of Object.values(paramsByDimension)) {
      for (const p of list) map[p.id] = p.name
    }
    return map
  }, [paramsByDimension])

  // Issue 009 — selection changes announce via the same polite live region
  // as undo (status bar, aria-live="polite"), so this is the one place both
  // the store write and the narration happen together.
  function handleSelect(id: string | null) {
    useContextsStore.getState().select(id)
    if (id === null) {
      useStatusStore.getState().announce('Selection cleared')
      return
    }
    const ctx = contexts.find((c) => c.id === id)
    if (!ctx) return
    const bindings = bindingsByContext[id] ?? {}
    const bound = new Set(Object.keys(bindings))
    const status = documentedStatus(isComplete(dimensionIds, bound), ctx.justification)
    const tuple = tupleReadout(dimensions, bindings, paramNameById)
    useStatusStore.getState().announce(describeContext(ctx.symbol, tuple, status))
  }

  const selectedContext = selectedContextId ? (contexts.find((c) => c.id === selectedContextId) ?? null) : null
  const selectedBindings = selectedContextId ? (bindingsByContext[selectedContextId] ?? {}) : {}

  // Guided mode starts when the canvas is below the floor and ends only once
  // the crossing gesture completes — never unmount an open editor mid-gesture.
  useEffect(() => {
    if (loadedFor !== projectId) return
    if (guided === null) setGuided(dimensions.length < 2)
    else if (guided && dimensions.length >= 2 && editingId === null) setGuided(false)
  }, [loadedFor, projectId, guided, dimensions.length, editingId])

  if (loadedFor !== projectId || guided === null) return null

  // Guided start (issue 002): below the n = 2 floor the design surface IS the
  // dimension manager — no dead register/canvas to stare at.
  if (guided) {
    return (
      <main className="projects" data-view={view}>
        <section className="panel">
          <p className="placeholder">Add at least two dimensions to begin designing.</p>
          <DimensionManagerPanel />
        </section>
      </main>
    )
  }

  return (
    <>
      <ContextBar>
        <DimensionManager />
      </ContextBar>
      <main className="design-main" data-view={view}>
        {view === 'canvas' ? (
          <>
            <div className="design-surface-row">
              {/* Design brief (issue 008): the circle sits directly on the
                  graph-paper ground, no panel — unlike the register, which
                  stays opaque per STYLE_GUIDE's table convention. */}
              <Canvas
                dimensions={dimensions}
                parametersByDimension={paramsByDimension}
                contexts={contexts}
                bindingsByContext={bindingsByContext}
                selectedContextId={selectedContextId}
                onSelect={handleSelect}
              />
              <section className="panel context-register-shell">
                <ContextRegister projectId={projectId} />
              </section>
            </div>
            <Composer
              dimensions={dimensions}
              selected={selectedContext}
              bindings={selectedBindings}
              paramNameById={paramNameById}
              onJustificationCommit={(text) => {
                if (selectedContextId) void useContextsStore.getState().setJustification(selectedContextId, text)
              }}
            />
          </>
        ) : (
          <section className="panel">
            <p className="placeholder">Coverage matrix arrives with issue 012.</p>
          </section>
        )}
      </main>
    </>
  )
}
