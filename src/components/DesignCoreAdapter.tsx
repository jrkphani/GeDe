import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@xyflow/react'
import type { CanvasEmphasis } from '../domain/canvasAdjacency'
import { firstUnbound } from '../domain/composeMode'
import { documentedStatus, isComplete } from '../domain/completeness'
import { describeContext, tupleReadout } from '../domain/contextDescription'
import { coverageStat } from '../domain/coverage'
import type { StaleRebindEvent } from '../db/mutations'
import { canWrite } from '../domain/workspaceRole'
import { useActiveLaneStore } from '../store/activeLane'
import { useCanvasComposeStore } from '../store/canvasCompose'
import { useCanvasCoverageStore } from '../store/canvasCoverage'
import { useCanvasSatellitesStore } from '../store/canvasSatellites'
import { useCanvasesStore } from '../store/canvases'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { useParametersStore } from '../store/parameters'
import { healRichTextOnLoad } from '../store/richTextConvert'
import { useStatusStore } from '../store/status'
import { useWorkspaceRole } from '../store/workspace'
import type { DesignView } from '../shell/routes'
import { Breadcrumbs } from './Breadcrumbs'
import { Button } from './ui/button'
import { Canvas } from './Canvas'
import { CanvasSwitcher } from './CanvasSwitcher'
import { ChildCanvasBanners } from './ChildCanvasBanners'
import { ContextRegister } from './ContextRegister'
import { CoverageMatrix } from './CoverageMatrix'
import { DimensionManagerPanel } from './DimensionManager'

// Issue 089 D3 graduation P2 — the Design lane, DECOMPOSED into a {register + ring}
// core: a REGISTER body (rail + ContextRegister + the lane header) stacked OVER a
// RING body (Canvas / CoverageMatrix). Each is a SEPARATE React Flow node body, so
// they can't share React state — the compose draft they both touch lives in the
// `canvasCompose` store (the register's `c`/phantom ENTERS it, the ring's dots
// BIND/EXIT). Both derive the same canvas selector/readiness (the shared hook
// below), but only the register owns the load EFFECT; the ring subscribes to the
// stores the register fills. 085's rule still holds inside the core: no on-ring
// authoring — the ring stays a derived visual, the register the authoring surface.
// This is a canvas-only re-composition of the already-store-driven child
// components; the flag-off `DesignSurface` is a mutually-exclusive path, untouched.

export interface DesignBodyProps {
  projectId: string
  contextPath: string[]
  view: DesignView
  canvasId?: string | undefined
}

// Issue 093 — below this viewport zoom the register's per-dimension columns
// collapse into ONE tuple-summary column (an LOD glance for overview legibility);
// zoom back in past it to edit the full columns. Selecting the DERIVED boolean
// from React Flow's store (not the raw zoom) means the register only re-renders
// when the threshold is CROSSED, not on every pan/zoom frame.
const LOD_ZOOM = 0.6

// Pure derivation shared by both bodies: which canvas is open + whether its
// content has loaded. Mirrors DesignSurface.tsx:44-99,515-518 exactly. No side
// effects — the register body owns every load; the ring body only reads.
function useDesignCanvasContext(projectId: string, contextPath: string[], canvasId: string | undefined) {
  const contextId = contextPath.length > 0 ? (contextPath[contextPath.length - 1] as string) : null
  const atRoot = contextPath.length === 0
  const canvases = useCanvasesStore((s) => s.canvases)
  const activeRootCanvasId = useMemo(() => {
    if (!atRoot || canvases.length === 0) return null
    const fromRoute = canvasId && canvases.some((c) => c.id === canvasId) ? canvasId : null
    return fromRoute ?? canvases[0]?.id ?? null
  }, [atRoot, canvases, canvasId])
  const canvasSelector = atRoot ? activeRootCanvasId : contextId
  const canLoad = !atRoot || activeRootCanvasId !== null
  const loadedFor = useDimensionsStore((s) => s.projectId)
  const loadedContextId = useDimensionsStore((s) => s.contextId)
  const loadedCanvasId = useDimensionsStore((s) => s.canvasId)
  const canvasReady = atRoot
    ? loadedFor === projectId && loadedCanvasId === activeRootCanvasId
    : loadedFor === projectId && loadedContextId === contextId
  return {
    contextId,
    atRoot,
    activeRootCanvasId,
    canvasSelector,
    canLoad,
    canvasReady,
  }
}

// ── The REGISTER body: header + rail + context register (the authoring surface).
export function DesignRegisterBody({ projectId, contextPath, view, canvasId }: DesignBodyProps) {
  const { contextId, atRoot, activeRootCanvasId, canvasSelector, canLoad, canvasReady } =
    useDesignCanvasContext(projectId, contextPath, canvasId)

  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)

  const dimensions = useDimensionsStore((s) => s.dimensions)
  const contexts = useContextsStore((s) => s.contexts)
  const bindingsByContext = useContextsStore((s) => s.bindingsByContext)
  const breadcrumbs = useContextsStore((s) => s.breadcrumbs)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const composeContextId = useCanvasComposeStore((s) => s.composeContextId)

  // Issue 093 + 089-P5 — collapse the per-dimension columns to a tuple-summary
  // when zoomed out (boolean selector → re-renders only on threshold crossing),
  // EXCEPT during guided compose, when the register hosts the binding comboboxes
  // and must show the full columns (P5). The many-dimension case is handled by the
  // P5 width-cap (max-width 1600px + inner-scroll, base.css) — a stable, edit-safe
  // legibility bound — NOT by an >8-column collapse + DOM-focus-expand, which the
  // adversarial review showed drops focus into the register's own PORTALLED
  // combobox (a `.contains()` check can't see portal content) and blocks the very
  // binding flow it needs. So the cap SUPERSEDES 093's deferred >8-col collapse.
  const registerCollapsed = useStore((s) => s.transform[2] < LOD_ZOOM) && !composeContextId

  // P4 (issue 012) — whether the coverage twin is open (drives the header toggle's
  // active state; the `v` key + toggle buttons open/collapse it).
  const coverageOpen = useCanvasCoverageStore((s) => s.open)

  const [staleEvents, setStaleEvents] = useState<StaleRebindEvent[]>([])

  // Root canvases of this project (switcher + active-canvas resolution).
  useEffect(() => {
    void useCanvasesStore.getState().load(projectId)
  }, [projectId])

  // Keep the store's selection aligned with the URL's active root canvas.
  useEffect(() => {
    if (activeRootCanvasId) useCanvasesStore.getState().select(activeRootCanvasId)
  }, [activeRootCanvasId])

  // The one canvas-load effect (DesignSurface.tsx:126-162) — owned by the register
  // body; the ring body subscribes to the stores it fills. Drilling in changes
  // contextId; before loading a child canvas we seed/reconcile it and capture any
  // stale parent-rebind events for the banner. Tier2's linkage load is NOT here
  // (the Architecture lane owns it now).
  useEffect(() => {
    let cancelled = false
    async function openCanvas() {
      if (contextId !== null) {
        const stale = await useContextsStore.getState().openChildCanvas(contextId)
        if (!cancelled) setStaleEvents(stale)
      } else if (!cancelled) {
        setStaleEvents([])
      }
      await useDimensionsStore.getState().load(projectId, canvasSelector)
      await useContextsStore.getState().load(projectId, canvasSelector)
      void healRichTextOnLoad(projectId)
      void useContextsStore.getState().loadBreadcrumbs(contextPath)
    }
    if (canLoad) void openCanvas()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, contextId, canvasSelector, canLoad])

  useEffect(() => {
    for (const d of dimensions) void useParametersStore.getState().load(d.id)
  }, [dimensions])

  const dimensionIds = useMemo(() => dimensions.map((d) => d.id), [dimensions])
  const orderedDimensionIds = useMemo(
    () => [...dimensions].sort((a, b) => a.sort - b.sort).map((d) => d.id),
    [dimensions],
  )

  // Live coverage stat + draft count for the lane header (SITEMAP §2).
  const coverage = useMemo(() => {
    const paramIds: Record<string, string[]> = {}
    for (const id of orderedDimensionIds) paramIds[id] = (paramsByDimension[id] ?? []).map((p) => p.id)
    const ctxInput = contexts.map((c) => ({
      id: c.id,
      symbol: c.symbol,
      bindings: bindingsByContext[c.id] ?? {},
      justification: c.justification,
    }))
    return coverageStat(orderedDimensionIds, paramIds, ctxInput)
  }, [orderedDimensionIds, paramsByDimension, contexts, bindingsByContext])
  const draftCount = useMemo(
    () =>
      contexts.filter(
        (c) => !isComplete(dimensionIds, new Set(Object.keys(bindingsByContext[c.id] ?? {}))),
      ).length,
    [contexts, dimensionIds, bindingsByContext],
  )

  function handleDrillIn(id: string) {
    // P3 (issue 011) — on the canvas, drilling OPENS the child canvas as an
    // edge-connected SUMMARY satellite beside the core (the parent stays visible),
    // instead of navigating away. Deep entry into the child still happens via the
    // satellite's "Enter ▸" (the same navigate). Promoting the summary satellite to
    // a live child {register+ring} core is the tracked 089 follow-up.
    useCanvasSatellitesStore.getState().openSatellite(id)
  }

  // `c` = New context (Design canvas view only), capture phase + text-field guard.
  useEffect(() => {
    if (view !== 'canvas') return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return
      if (useActiveLaneStore.getState().activeLane !== 'design') return
      const el = document.activeElement
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      if (readOnly) return
      void useCanvasComposeStore.getState().enterCompose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [view, readOnly])

  // Esc exits compose (defers to an open Radix popover this press).
  useEffect(() => {
    if (!composeContextId) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return
      e.preventDefault()
      e.stopPropagation()
      useCanvasComposeStore.getState().exitCompose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [composeContextId])

  // `v` = open/collapse the coverage TWIN (P4, issue 012) — NOT a route swap. The
  // twin is an adjacent, edge-connected CoverageMatrix node below the core; `v`
  // toggles it via the canvas-only store (the twin renders in WorkspaceCanvas, a
  // separate React tree). routes.ts `?view=` grammar is preserved for deep-links.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'v' || e.metaKey || e.ctrlKey || e.altKey) return
      if (useActiveLaneStore.getState().activeLane !== 'design') return
      const el = document.activeElement
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      useCanvasCoverageStore.getState().toggle()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // `d` = focus the dimension rail's first phantom.
  useEffect(() => {
    if (view !== 'canvas') return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'd' || e.metaKey || e.ctrlKey || e.altKey) return
      if (useActiveLaneStore.getState().activeLane !== 'design') return
      const el = document.activeElement
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return
      }
      const rail = document.querySelector('.dim-rail')
      if (!rail) return
      const dimPhantom = rail.querySelector<HTMLInputElement>('.dim-manager__add-phantom input')
      const target = dimPhantom ?? rail.querySelector<HTMLInputElement>('.param-row--phantom input')
      if (!target) return
      e.preventDefault()
      target.focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [view])

  // Rail → register Tab bridge (issue 085 Phase C): Tab out of the rail's LAST
  // empty phantom lands on the register's phantom row, not the first existing row.
  useEffect(() => {
    if (view !== 'canvas') return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (!(el instanceof HTMLInputElement) || el.value !== '') return
      const rail = document.querySelector('.dim-rail')
      if (!rail) return
      const phantoms = rail.querySelectorAll<HTMLInputElement>(
        '.dim-manager__add-phantom input, .param-row--phantom input',
      )
      const last = phantoms[phantoms.length - 1]
      if (!last || last !== el) return
      const registerPhantom = document.querySelector<HTMLInputElement>(
        '.context-register-shell .grid-row--phantom input',
      )
      if (!registerPhantom) return
      e.preventDefault()
      registerPhantom.focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [view])

  if (!canvasReady) return null

  const dimensionNames = dimensions.map((d) => d.name)
  const needsSeeding =
    contextId !== null &&
    dimensions.length > 0 &&
    dimensions.some((d) => (paramsByDimension[d.id]?.length ?? 0) === 0)
  const belowFloor = !needsSeeding && dimensions.length < 2

  return (
    <div className="design-core-register">
      <div className="workspace__lane-header design-lane-header">
        <div className="context-bar__location">
          <Breadcrumbs projectId={projectId} crumbs={breadcrumbs} dimensionNames={dimensionNames} />
          {atRoot ? (
            <CanvasSwitcher projectId={projectId} view={view} currentCanvasId={activeRootCanvasId} />
          ) : null}
        </div>
        <div className="context-bar__controls">
          <div className="design-view-toggle" role="group" aria-label="Design view">
            <Button
              variant="bare"
              className="view-toggle__btn"
              data-active={!coverageOpen || undefined}
              aria-pressed={!coverageOpen}
              onClick={() => useCanvasCoverageStore.getState().collapse()}
            >
              Canvas
            </Button>
            <Button
              variant="bare"
              className="view-toggle__btn"
              data-active={coverageOpen || undefined}
              aria-pressed={coverageOpen}
              onClick={() => useCanvasCoverageStore.getState().setOpen(true)}
            >
              Coverage
            </Button>
          </div>
        </div>
        <div className="context-bar__stats">
          <span
            className="coverage-stat font-mono"
            aria-label={`${coverage.documented} of ${coverage.total} tuples documented`}
          >
            {coverage.documented} / {coverage.total} documented
          </span>
          <span className="draft-count">
            {draftCount} draft{draftCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>
      {view === 'canvas' ? (
        <div className="canvas-zoom" key={canvasSelector ?? 'root'} data-depth={contextPath.length}>
          <ChildCanvasBanners
            events={staleEvents}
            onUndo={(event) => {
              void useContextsStore
                .getState()
                .revertStale(event)
                .then(() => useDimensionsStore.getState().load(projectId, contextId))
              setStaleEvents((prev) => prev.filter((e) => e !== event))
            }}
          />
          {needsSeeding ? (
            <p className="canvas-seed-hint" role="status">
              This canvas needs parameters. Its dimensions come from the parent’s bindings — add
              sub-parameters in the dimension manager.
            </p>
          ) : null}
          {belowFloor ? (
            <p className="canvas-floor-hint" role="status">
              Add a second dimension to start binding contexts.
            </p>
          ) : null}
          {/* Issue 093 — the top "New context" button is REMOVED; the register's
              phantom row is now the sole create affordance (the `c` key still
              enters guided compose mode). */}
          <div className="editing-zone" role="group" aria-label="Dimensions, parameters, and contexts">
            <section className="dim-rail" aria-label="Dimensions and parameters">
              <DimensionManagerPanel childCanvas={contextId !== null} />
            </section>
            <section className="context-register-shell">
              <ContextRegister
                projectId={projectId}
                contextId={contextId}
                onDrillIn={handleDrillIn}
                readOnly={readOnly}
                collapsed={registerCollapsed}
              />
            </section>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ── The RING body: the Canvas (or, in coverage view, the CoverageMatrix).
export function DesignRingBody({ projectId, contextPath, canvasId }: DesignBodyProps) {
  const { contextId, canvasSelector, canvasReady } = useDesignCanvasContext(
    projectId,
    contextPath,
    canvasId,
  )

  const dimensions = useDimensionsStore((s) => s.dimensions)
  const contexts = useContextsStore((s) => s.contexts)
  const bindingsByContext = useContextsStore((s) => s.bindingsByContext)
  const childCountByContext = useContextsStore((s) => s.childCountByContext)
  const selectedContextId = useContextsStore((s) => s.selectedContextId)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const composeContextId = useCanvasComposeStore((s) => s.composeContextId)

  const [hoveredMark, setHoveredMark] = useState<CanvasEmphasis | null>(null)

  const dimensionIds = useMemo(() => dimensions.map((d) => d.id), [dimensions])
  const orderedDimensionIds = useMemo(
    () => [...dimensions].sort((a, b) => a.sort - b.sort).map((d) => d.id),
    [dimensions],
  )
  const paramNameById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const list of Object.values(paramsByDimension)) {
      for (const p of list) map[p.id] = p.name
    }
    return map
  }, [paramsByDimension])

  // Derived, race-free next-to-bind pointer (the ring keeps its own compose dot
  // highlight even though the register hosts guided binding).
  const activeDimensionId = composeContextId
    ? firstUnbound(orderedDimensionIds, bindingsByContext[composeContextId] ?? {})
    : null

  // Single owner of the vanished-draft cleanup (mirrors DesignSurface.tsx:504-508).
  useEffect(() => {
    useCanvasComposeStore.getState().clearIfMissing(contexts.map((c) => c.id))
  }, [contexts])

  // Drop a stale hover/focus mark when the open canvas changes (mirrors
  // DesignSurface.tsx:126-131). The register owns the load effect, but hoveredMark
  // is ring-local; and because the ring node keeps a STABLE React Flow id it never
  // unmounts across a drill-in, so without this the mark would emphasize/mute
  // against ids from the canvas we just left — dimming the whole new child canvas.
  useEffect(() => {
    setHoveredMark(null)
  }, [canvasSelector])

  function handleDrillIn(id: string) {
    // P3 (issue 011) — on the canvas, drilling OPENS the child canvas as an
    // edge-connected SUMMARY satellite beside the core (the parent stays visible),
    // instead of navigating away. Deep entry into the child still happens via the
    // satellite's "Enter ▸" (the same navigate). Promoting the summary satellite to
    // a live child {register+ring} core is the tracked 089 follow-up.
    useCanvasSatellitesStore.getState().openSatellite(id)
  }

  function handleSelect(id: string | null) {
    if (id === null && composeContextId) {
      useCanvasComposeStore.getState().exitCompose()
      return
    }
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

  if (!canvasReady) return null

  const needsSeeding =
    contextId !== null &&
    dimensions.length > 0 &&
    dimensions.some((d) => (paramsByDimension[d.id]?.length ?? 0) === 0)

  // P4 (issue 012) — the ring ALWAYS renders the Canvas now. Coverage is no longer
  // a route swap that REPLACED the ring; it is an adjacent, edge-connected TWIN
  // node (DesignCoverageTwinBody, below) opened by `v`, so the ring + coverage
  // coexist rather than one hiding the other. `view` is forced to 'canvas' for the
  // core bodies (WorkspaceCanvas), and the `?view=coverage` deep-link now seeds
  // the twin open instead — routes.ts grammar preserved for deep-link parity.
  return (
    <div className="design-core-ring" data-suppress-canvas-empty={needsSeeding || undefined}>
      <Canvas
        dimensions={dimensions}
        parametersByDimension={paramsByDimension}
        contexts={contexts}
        bindingsByContext={bindingsByContext}
        childCountByContext={childCountByContext}
        selectedContextId={selectedContextId}
        onSelect={handleSelect}
        onDrillIn={handleDrillIn}
        composeContextId={composeContextId}
        activeDimensionId={activeDimensionId}
        onBindParameter={(d, p) => void useCanvasComposeStore.getState().bindParameter(d, p)}
        onUnbindParameter={(d) => void useCanvasComposeStore.getState().unbindParameter(d)}
        onExitCompose={() => useCanvasComposeStore.getState().exitCompose()}
        hoveredMark={hoveredMark}
        onHoverChange={setHoveredMark}
      />
    </div>
  )
}

// ── P4 (issue 012) — the COVERAGE TWIN body: the analytical twin of the ring,
// rendered as its own edge-connected node BELOW the Design core (WorkspaceCanvas
// stacks it at design-lane sort 2). Fully LIVE (not a P3-style stub): CoverageMatrix
// is read-only + fully derived and reads the SAME current-canvas stores the ring
// reads, so no second canvas scope / multi-canvas refactor is needed. A gap-cell
// click composes pre-filled (read-only-guarded, issue 035) then pans back along the
// edge to the ring (onGapComposed) so the new draft dot is in view.
export function DesignCoverageTwinBody({
  projectId,
  onGapComposed,
}: {
  projectId: string
  onGapComposed: () => void
}) {
  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)
  const dimensions = useDimensionsStore((s) => s.dimensions)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const contexts = useContextsStore((s) => s.contexts)
  const bindingsByContext = useContextsStore((s) => s.bindingsByContext)
  const selectedContextId = useContextsStore((s) => s.selectedContextId)

  function handleComposeTuple(bindings: Record<string, string>) {
    // Read-only guard (issue 035): a viewer may LOOK at coverage but a gap-cell
    // click must never create a context. CoverageMatrix has no role awareness.
    if (readOnly) return
    void useCanvasComposeStore.getState().enterCompose(bindings)
    // Pan back along the edge to the ring so the freshly-composed draft is in view
    // (the old route swap put you on the canvas; the twin keeps both visible).
    onGapComposed()
  }

  return (
    <CoverageMatrix
      dimensions={dimensions}
      parametersByDimension={paramsByDimension}
      contexts={contexts}
      bindingsByContext={bindingsByContext}
      selectedContextId={selectedContextId}
      onSelectContext={(id) => useContextsStore.getState().select(id)}
      onComposeTuple={handleComposeTuple}
    />
  )
}
