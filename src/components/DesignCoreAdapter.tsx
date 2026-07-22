import { useEffect, useMemo, useState } from 'react'
import { useStore } from '@xyflow/react'
import type { CanvasEmphasis } from '../domain/canvasAdjacency'
import { quantizeHitScale } from '../domain/canvasResponsive'
import { firstUnbound } from '../domain/composeMode'
import { documentedStatus, isComplete } from '../domain/completeness'
import { describeContext, tupleReadout } from '../domain/contextDescription'
import { coverageStat } from '../domain/coverage'
import type { StaleRebindEvent } from '../db/mutations'
import { canWrite } from '../domain/workspaceRole'
import { useActiveCanvasStore } from '../store/activeCanvas'
import { useActiveLaneStore } from '../store/activeLane'
import { resolveCanvasStores } from '../store/canvasStores'
import { useCanvasCoverageStore } from '../store/canvasCoverage'
import { useCanvasSatellitesStore } from '../store/canvasSatellites'
import { useCanvasesStore } from '../store/canvases'
import { useParametersStore } from '../store/parameters'
import { healRichTextOnLoad } from '../store/richTextConvert'
import { useStatusStore } from '../store/status'
import { useWorkspaceRole } from '../store/workspace'
import type { DesignView } from '../shell/routes'
import { Breadcrumbs } from './Breadcrumbs'
import { Button } from './ui/button'
import { Canvas } from './Canvas'
import { CanvasStoresProvider } from './CanvasStoresContext'
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
  // Issue 100 Phase D — WHICH store instance this core resolves, SEPARATE from
  // `canvasId` (which is the active-canvas key for the `c`/`v`/`d` gate). The
  // PRIMARY (root) core passes nothing → `resolveCanvasStores(undefined)` → the
  // process-lifetime DEFAULT instance (byte-identical to Phase C, and the ONE
  // instance `presence`/`coreCommands`/`DesignSurface` also read). A drilled-in
  // LIVE CHILD core passes its `parentContextId` → its OWN independent instance
  // (one parent context ↔ one child canvas, so the key is stable + collision-free).
  storeCanvasId?: string | null | undefined
  // Issue 100 Phase D — a live CHILD core is collapsible in place: when provided,
  // the register header shows a `×` that tears the child core down. Undefined for
  // the primary core (which is never collapsed), so its header is unchanged.
  onCollapse?: (() => void) | undefined
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
function useDesignCanvasContext(
  projectId: string,
  contextPath: string[],
  canvasId: string | undefined,
  storeCanvasId: string | null | undefined,
) {
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
  const stores = resolveCanvasStores(storeCanvasId)
  const loadedFor = stores.useDimensions((s) => s.projectId)
  const loadedContextId = stores.useDimensions((s) => s.contextId)
  const loadedCanvasId = stores.useDimensions((s) => s.canvasId)
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
export function DesignRegisterBody({
  projectId,
  contextPath,
  view,
  canvasId,
  storeCanvasId,
  onCollapse,
}: DesignBodyProps) {
  const { contextId, atRoot, activeRootCanvasId, canvasSelector, canLoad, canvasReady } =
    useDesignCanvasContext(projectId, contextPath, canvasId, storeCanvasId)

  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)

  // Issue 100 Phase C — this core's stable active-canvas key (parallel to the
  // `activeLane === 'design'` gate). The root core's `canvasId` is undefined →
  // 'root'; a Phase-D child core passes its own canvas id. The `c`/`v`/`d` window
  // verbs gate on `activeCanvas === coreKey` so a keypress fires only in the
  // FOCUSED core. With one live core, coreKey is always the active canvas when
  // focused, so the gate is inert.
  const coreKey = canvasId ?? 'root'

  const stores = resolveCanvasStores(storeCanvasId)
  const dimensions = stores.useDimensions((s) => s.dimensions)
  const contexts = stores.useContexts((s) => s.contexts)
  const bindingsByContext = stores.useContexts((s) => s.bindingsByContext)
  const breadcrumbs = stores.useContexts((s) => s.breadcrumbs)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const composeContextId = stores.useCompose((s) => s.composeContextId)

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
        const stale = await stores.useContexts.getState().openChildCanvas(contextId)
        if (!cancelled) setStaleEvents(stale)
      } else if (!cancelled) {
        setStaleEvents([])
      }
      await stores.useDimensions.getState().load(projectId, canvasSelector)
      await stores.useContexts.getState().load(projectId, canvasSelector)
      void healRichTextOnLoad(projectId)
      void stores.useContexts.getState().loadBreadcrumbs(contextPath)
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
    // Issue 100 Phase D (011) — on the canvas, drilling OPENS the child canvas as
    // a LIVE {register+ring} core mounted beside this one (the parent stays live +
    // independent, on its own store instance), editable in place; collapse via the
    // child header's ×. This replaced the 089-P3 summary-satellite STUB and its
    // "Enter ▸" deep-navigate.
    useCanvasSatellitesStore.getState().openSatellite(id)
  }

  // `c` = New context (Design canvas view only), capture phase + text-field guard.
  useEffect(() => {
    if (view !== 'canvas') return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return
      if (useActiveLaneStore.getState().activeLane !== 'design') return
      if (useActiveCanvasStore.getState().activeCanvas !== coreKey) return
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
      void stores.useCompose.getState().enterCompose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [view, readOnly, stores, coreKey])

  // Esc exits compose (defers to an open Radix popover this press).
  useEffect(() => {
    if (!composeContextId) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return
      e.preventDefault()
      e.stopPropagation()
      stores.useCompose.getState().exitCompose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [composeContextId, stores])

  // `v` = open/collapse the coverage TWIN (P4, issue 012) — NOT a route swap. The
  // twin is an adjacent, edge-connected CoverageMatrix node below the core; `v`
  // toggles it via the canvas-only store (the twin renders in WorkspaceCanvas, a
  // separate React tree). routes.ts `?view=` grammar is preserved for deep-links.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'v' || e.metaKey || e.ctrlKey || e.altKey) return
      if (useActiveLaneStore.getState().activeLane !== 'design') return
      if (useActiveCanvasStore.getState().activeCanvas !== coreKey) return
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
  }, [coreKey])

  // `d` = focus the dimension rail's first phantom.
  useEffect(() => {
    if (view !== 'canvas') return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'd' || e.metaKey || e.ctrlKey || e.altKey) return
      if (useActiveLaneStore.getState().activeLane !== 'design') return
      if (useActiveCanvasStore.getState().activeCanvas !== coreKey) return
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
  }, [view, coreKey])

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
        {/* Issue 100 Phase D — a live CHILD core carries a `×` that collapses it
            (tears down its own store instance). The primary core passes no
            `onCollapse`, so this renders nothing and its header is unchanged. */}
        {onCollapse ? (
          <Button
            variant="bare"
            className="wc-child-collapse"
            onClick={onCollapse}
            aria-label="Collapse child canvas"
          >
            ×
          </Button>
        ) : null}
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
              void stores.useContexts
                .getState()
                .revertStale(event)
                .then(() => stores.useDimensions.getState().load(projectId, contextId))
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
          <CanvasStoresProvider value={stores}>
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
          </CanvasStoresProvider>
        </div>
      ) : null}
    </div>
  )
}

// ── The RING body: the Canvas (or, in coverage view, the CoverageMatrix).
export function DesignRingBody({ projectId, contextPath, canvasId, storeCanvasId }: DesignBodyProps) {
  const { contextId, canvasSelector, canvasReady } = useDesignCanvasContext(
    projectId,
    contextPath,
    canvasId,
    storeCanvasId,
  )

  // 099-2c — the ring renders inside the canvas's `transform: scale()`, so the
  // dots' 44px hit target has to be sized in SCREEN space. QUANTIZED (bucketed)
  // rather than raw, on the same discipline as `registerCollapsed`'s boolean
  // selector: the ring re-renders only when a bucket is crossed, never per frame.
  const hitScale = useStore((s) => quantizeHitScale(s.transform[2]))

  const stores = resolveCanvasStores(storeCanvasId)
  const dimensions = stores.useDimensions((s) => s.dimensions)
  const contexts = stores.useContexts((s) => s.contexts)
  const bindingsByContext = stores.useContexts((s) => s.bindingsByContext)
  const childCountByContext = stores.useContexts((s) => s.childCountByContext)
  const selectedContextId = stores.useContexts((s) => s.selectedContextId)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const composeContextId = stores.useCompose((s) => s.composeContextId)

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
    stores.useCompose.getState().clearIfMissing(contexts.map((c) => c.id))
  }, [contexts, stores])

  // Drop a stale hover/focus mark when the open canvas changes (mirrors
  // DesignSurface.tsx:126-131). The register owns the load effect, but hoveredMark
  // is ring-local; and because the ring node keeps a STABLE React Flow id it never
  // unmounts across a drill-in, so without this the mark would emphasize/mute
  // against ids from the canvas we just left — dimming the whole new child canvas.
  useEffect(() => {
    setHoveredMark(null)
  }, [canvasSelector])

  function handleDrillIn(id: string) {
    // Issue 100 Phase D (011) — on the canvas, drilling OPENS the child canvas as
    // a LIVE {register+ring} core mounted beside this one (the parent stays live +
    // independent, on its own store instance), editable in place; collapse via the
    // child header's ×. This replaced the 089-P3 summary-satellite STUB and its
    // "Enter ▸" deep-navigate.
    useCanvasSatellitesStore.getState().openSatellite(id)
  }

  function handleSelect(id: string | null) {
    if (id === null && composeContextId) {
      stores.useCompose.getState().exitCompose()
      return
    }
    stores.useContexts.getState().select(id)
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
        onBindParameter={(d, p) => void stores.useCompose.getState().bindParameter(d, p)}
        onUnbindParameter={(d) => void stores.useCompose.getState().unbindParameter(d)}
        onExitCompose={() => stores.useCompose.getState().exitCompose()}
        hoveredMark={hoveredMark}
        onHoverChange={setHoveredMark}
        scale={hitScale}
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
  storeCanvasId,
}: {
  projectId: string
  onGapComposed: () => void
  // Issue 100 Phase D — same store-instance seam as the register/ring bodies.
  // The primary twin passes nothing → default instance (unchanged); a child twin
  // (none emitted this phase) would pass its parent context id.
  storeCanvasId?: string | null | undefined
}) {
  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)
  const stores = resolveCanvasStores(storeCanvasId)
  const dimensions = stores.useDimensions((s) => s.dimensions)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const contexts = stores.useContexts((s) => s.contexts)
  const bindingsByContext = stores.useContexts((s) => s.bindingsByContext)
  const selectedContextId = stores.useContexts((s) => s.selectedContextId)

  function handleComposeTuple(bindings: Record<string, string>) {
    // Read-only guard (issue 035): a viewer may LOOK at coverage but a gap-cell
    // click must never create a context. CoverageMatrix has no role awareness.
    if (readOnly) return
    void stores.useCompose.getState().enterCompose(bindings)
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
      onSelectContext={(id) => stores.useContexts.getState().select(id)}
      onComposeTuple={handleComposeTuple}
    />
  )
}
