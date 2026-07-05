import { useEffect, useState } from 'react'
import { ContextBar } from '../shell/slots'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { useParametersStore } from '../store/parameters'
import { Canvas } from './Canvas'
import { ContextRegister } from './ContextRegister'
import { DimensionManager, DimensionManagerPanel } from './DimensionManager'
import type { DesignView } from '../shell/routes'

export function DesignSurface({ projectId, view }: { projectId: string; view: DesignView }) {
  const dimensions = useDimensionsStore((s) => s.dimensions)
  const loadedFor = useDimensionsStore((s) => s.projectId)
  const editingId = useDimensionsStore((s) => s.editingId)
  const contexts = useContextsStore((s) => s.contexts)
  const bindingsByContext = useContextsStore((s) => s.bindingsByContext)
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
          <div className="design-surface-row">
            {/* Design brief (issue 008): the circle sits directly on the
                graph-paper ground, no panel — unlike the register, which
                stays opaque per STYLE_GUIDE's table convention. */}
            <Canvas
              dimensions={dimensions}
              parametersByDimension={paramsByDimension}
              contexts={contexts}
              bindingsByContext={bindingsByContext}
            />
            <section className="panel context-register-shell">
              <ContextRegister projectId={projectId} />
            </section>
          </div>
        ) : (
          <section className="panel">
            <p className="placeholder">Coverage matrix arrives with issue 012.</p>
          </section>
        )}
      </main>
    </>
  )
}
