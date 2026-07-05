import { useEffect, useState } from 'react'
import { ContextBar } from '../shell/slots'
import { useDimensionsStore } from '../store/dimensions'
import { DimensionManager, DimensionManagerPanel } from './DimensionManager'
import type { DesignView } from '../shell/routes'

export function DesignSurface({ projectId, view }: { projectId: string; view: DesignView }) {
  const dimensions = useDimensionsStore((s) => s.dimensions)
  const loadedFor = useDimensionsStore((s) => s.projectId)
  const editingId = useDimensionsStore((s) => s.editingId)
  const [guided, setGuided] = useState<boolean | null>(null)

  useEffect(() => {
    void useDimensionsStore.getState().load(projectId)
    setGuided(null)
  }, [projectId])

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
      <main className="projects" data-view={view}>
        <section className="panel">
          <p className="placeholder">
            3rd Tier · Design ({view}) — register and canvas arrive with issues 004 and 008.
          </p>
        </section>
      </main>
    </>
  )
}
