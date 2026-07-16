import { useEffect, useMemo, useRef, useState } from 'react'
import { ContextBar } from '../shell/slots'
import type { CanvasEmphasis } from '../domain/canvasAdjacency'
import { composeReducer, firstUnbound } from '../domain/composeMode'
import { documentedStatus, isComplete } from '../domain/completeness'
import { describeContext, tupleReadout } from '../domain/contextDescription'
import { coverageStat } from '../domain/coverage'
import type { ContextRow } from '../db/mutations'
import { navigate } from '../shell/router'
import { canWrite } from '../domain/workspaceRole'
import { useCommandLogStore } from '../store/commandLog'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { useParametersStore } from '../store/parameters'
import { useStatusStore } from '../store/status'
import { useTier2Store } from '../store/tier2'
import { useWorkspaceRole } from '../store/workspace'
import type { StaleRebindEvent } from '../db/mutations'
import { Button } from './ui/button'
import { Breadcrumbs } from './Breadcrumbs'
import { Canvas } from './Canvas'
import { ChildCanvasBanners } from './ChildCanvasBanners'
import { ContextRegister } from './ContextRegister'
import { CoverageMatrix } from './CoverageMatrix'
import { DimensionManagerPanel } from './DimensionManager'
import type { DesignView } from '../shell/routes'

export function DesignSurface({
  projectId,
  contextPath,
  view,
}: {
  projectId: string
  contextPath: string[]
  view: DesignView
}) {
  // The canvas currently open: null = root canvas; the last path segment = the
  // context whose child canvas we're inside (issue 011).
  const contextId = contextPath.length > 0 ? (contextPath[contextPath.length - 1] as string) : null
  // Issue 035 — a viewer's read surface renders unchanged, minus every write
  // affordance: EditableGrid's phantom row/in-place edit (including the
  // register's own justification cell, issue 085 Phase B), and "New context"
  // (compose is never entered at all, so Canvas's own compose-mode dot
  // interactivity is moot — it's only reachable via `composeContextId`, which
  // stays null for a read-only caller below).
  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)
  const dimensions = useDimensionsStore((s) => s.dimensions)
  const loadedFor = useDimensionsStore((s) => s.projectId)
  const loadedContextId = useDimensionsStore((s) => s.contextId)
  const contexts = useContextsStore((s) => s.contexts)
  const bindingsByContext = useContextsStore((s) => s.bindingsByContext)
  const childCountByContext = useContextsStore((s) => s.childCountByContext)
  const breadcrumbs = useContextsStore((s) => s.breadcrumbs)
  const selectedContextId = useContextsStore((s) => s.selectedContextId)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  // Issue 011 — stale parent-rebind banners for the current child canvas.
  const [staleEvents, setStaleEvents] = useState<StaleRebindEvent[]>([])
  // Issue 010 — compose mode. `composeContextId` is the live draft. The active
  // (next-to-bind) dimension is DERIVED from the store's live bindings each
  // render (see below), not held in state — so rapid dot clicks, whose async
  // store writes settle out of order, can never leave the pointer stale.
  const [composeContextId, setComposeContextId] = useState<string | null>(null)
  // Issue 028(a) — focus + adjacency (STYLE_GUIDE §7/§8, amended). The
  // transient hover/keyboard-focus mark; Canvas resolves it against
  // selectedContextId itself ("hover ?? selection") so this stays exactly as
  // transient as selection is persistent — reset on canvas navigation below
  // so a stale mark from a different canvas can never linger.
  const [hoveredMark, setHoveredMark] = useState<CanvasEmphasis | null>(null)

  // One canvas-load effect, keyed on (project, canvas). Drilling in changes
  // `contextId`; before loading a child canvas we seed/reconcile it (idempotent
  // — SPEC recursion rule) and capture any stale parent-rebind events for the
  // banner. Root canvas (contextId null) skips seeding. The load()s must set
  // their scope synchronously before awaiting (the paid-for CI race, HANDOFF)
  // — both stores already do. Breadcrumb symbols resolve from the URL path.
  useEffect(() => {
    let cancelled = false
    // Issue 028(a) — a hover/focus mark from the canvas we're leaving can
    // never refer to anything on the one we're entering; drop it so nothing
    // stays muted/emphasized against stale ids.
    setHoveredMark(null)
    async function openCanvas() {
      if (contextId !== null) {
        const stale = await useContextsStore.getState().openChildCanvas(contextId)
        if (!cancelled) setStaleEvents(stale)
      } else if (!cancelled) {
        setStaleEvents([])
      }
      await useDimensionsStore.getState().load(projectId, contextId)
      await useContextsStore.getState().load(projectId, contextId)
      void useContextsStore.getState().loadBreadcrumbs(contextPath)
    }
    void openCanvas()
    return () => {
      cancelled = true
    }
    // contextPath identity changes each navigation; contextId is the meaningful
    // key, and contextPath is only read inside for breadcrumb symbols.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, contextId])

  // Tier-2 linkage projection (issue 014): loaded so a promoted parameter's
  // link glyph in ParameterList can name its source entry. Read-only here.
  useEffect(() => {
    void useTier2Store.getState().load(projectId)
  }, [projectId])

  useEffect(() => {
    for (const d of dimensions) void useParametersStore.getState().load(d.id)
  }, [dimensions])

  const dimensionIds = useMemo(() => dimensions.map((d) => d.id), [dimensions])
  // Sort order matters for guided binding's "next unbound dimension" pointer
  // (composeReducer); the register and canvas already render in sort order.
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

  // Issue 009 — selection changes announce via the same polite live region
  // as undo (status bar, aria-live="polite"), so this is the one place both
  // the store write and the narration happen together.
  function handleSelect(id: string | null) {
    // Clearing selection while composing is the click-away exit path — treat it
    // like Escape: leave compose mode keeping the draft, offer discard.
    if (id === null && composeContextId) {
      exitCompose()
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

  // --- Compose mode (issue 010) -------------------------------------------
  // Entering compose creates a real, persisted draft (same mutation layer as
  // the register — SPEC invariant 6, acceptance criterion 1) and selects it.
  async function enterCompose(initialBindings?: Record<string, string>) {
    // Issue 035 — a read-only caller never opens a compose draft: no button,
    // no `c` shortcut, and this guard even if something else calls it (the
    // coverage matrix's gap-click, `handleComposeTuple` below).
    if (composeContextId || readOnly) return
    // From a coverage-matrix gap the draft arrives pre-filled with the whole
    // tuple (issue 012); create + the n binds are one undoable gesture, mirroring
    // the register's batched phantom-row create.
    const run = async (): Promise<ContextRow | null> => {
      const row = await useContextsStore.getState().create()
      if (!row) return null
      if (initialBindings) {
        for (const dimId of orderedDimensionIds) {
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
    setComposeContextId(created.id)
    const firstUnboundName = dimensions.find(
      (d) => d.id === firstUnbound(orderedDimensionIds, initialBindings ?? {}),
    )?.name
    useStatusStore
      .getState()
      .announce(
        firstUnboundName
          ? `Composing ${created.symbol} — bind ${firstUnboundName}`
          : `Composing ${created.symbol}`,
      )
  }

  // A coverage-matrix hollow cell jumps to the canvas in compose mode, pre-filled
  // with that tuple (SPEC §4.5 "gap → composer"). View switch + compose entry
  // happen together; enterCompose is a no-op if a draft is already open.
  function handleComposeTuple(bindings: Record<string, string>) {
    navigate({ kind: 'design', projectId, contextPath: [], view: 'canvas' })
    void enterCompose(bindings)
  }

  function exitCompose() {
    const id = composeContextId
    if (!id) return
    const symbol = contexts.find((c) => c.id === id)?.symbol ?? 'draft'
    setComposeContextId(null)
    // The draft is kept (drafts are legal); the status line offers to discard
    // it as one undoable action (mirrors the archive-with-Undo pattern).
    useStatusStore.getState().announce(`Draft ${symbol} kept`, {
      label: `Discard draft ${symbol}`,
      run: () => useContextsStore.getState().discard(id),
    })
  }

  async function handleBindParameter(dimensionId: string, parameterId: string) {
    const id = composeContextId
    if (!id) return
    // The reducer is used only to detect the incomplete -> complete transition,
    // so completion is announced exactly once, on the bind that finishes the
    // tuple. The displayed active pointer is derived from live bindings below.
    const before = useContextsStore.getState().bindingsByContext[id] ?? {}
    const transition = composeReducer(
      orderedDimensionIds,
      { bindings: before, activeDimensionId: null },
      { type: 'bind', dimensionId, parameterId },
    )
    await useContextsStore.getState().bind(id, dimensionId, parameterId)
    if (transition.completed) {
      const ctx = useContextsStore.getState().contexts.find((c) => c.id === id)
      const tuple = tupleReadout(dimensions, transition.state.bindings, paramNameById)
      useStatusStore.getState().announce(`${ctx?.symbol ?? 'Context'} complete — ${tuple.join(', ')}`)
    }
  }

  async function handleUnbindParameter(dimensionId: string) {
    const id = composeContextId
    if (!id) return
    await useContextsStore.getState().unbind(id, dimensionId)
  }

  // `c` = New context (SITEMAP §4), Design canvas view only. Registered on the
  // capture phase (EditableGrid inputs stopPropagation their keydowns) and
  // ignored while a text field has focus so typing a literal "c" never fires.
  const enterComposeRef = useRef(enterCompose)
  enterComposeRef.current = enterCompose
  useEffect(() => {
    if (view !== 'canvas') return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      void enterComposeRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [view])

  // Esc exits compose from anywhere (SITEMAP §4 order: a picker popover closes
  // first, THEN compose exits). Rather than racing Radix's listener by
  // registration order (the paid-for 009 gotcha), this checks the DOM
  // synchronously: if a picker popover is open, defer to Radix this press;
  // otherwise exit compose and stop the event so the node's own handler doesn't
  // double-fire. Active only while a draft is being composed.
  const exitComposeRef = useRef(exitCompose)
  exitComposeRef.current = exitCompose
  useEffect(() => {
    if (!composeContextId) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return
      e.preventDefault()
      e.stopPropagation()
      exitComposeRef.current()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [composeContextId])

  // `v` = toggle canvas / coverage view (SITEMAP §4). Capture phase + text-field
  // guard, same grammar as the `c` compose shortcut above.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'v' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      navigate({
        kind: 'design',
        projectId,
        contextPath: [],
        view: view === 'canvas' ? 'coverage' : 'canvas',
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [view, projectId])

  // `d` = focus the dimension rail's first phantom (issue 082 Phase 1 test-
  // first plan item 4) — same capture-phase + text-field-guard grammar as
  // `c`/`v` above, so bulk keyboard entry can start without the mouse. Design
  // brief: "the rail's first phantom" — that's the dimension-add phantom when
  // one exists (root canvas); a child canvas has no add-dimension affordance
  // (dimensions are derived from the parent's bindings), so it falls back to
  // the first parameter phantom instead, rather than doing nothing.
  useEffect(() => {
    if (view !== 'canvas') return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'd' || e.metaKey || e.ctrlKey || e.altKey) return
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

  // Live coverage stat + draft count for the context bar (SITEMAP §2). Both
  // derive from store state each render, so any mutation moves them same-frame.
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

  const composing = composeContextId !== null && composeContextId === selectedContextId
  // Derived, race-free: the next dimension to bind is simply the first unbound
  // one in sort order given the draft's current (store-authoritative) bindings.
  // Still consumed by Canvas (its own compose-mode dot interactivity/highlight,
  // issue 010) even after the Composer strip's removal (issue 085 Phase B) —
  // the register hosts the guided binding now, Canvas keeps its own pointer.
  const activeDimensionId = composeContextId
    ? firstUnbound(orderedDimensionIds, bindingsByContext[composeContextId] ?? {})
    : null

  // Drill into a context's child canvas (SPEC §4.2, issue 011): push a deeper
  // route. Browser back/forward mirror it since every push is a history entry.
  function handleDrillIn(id: string) {
    navigate({ kind: 'design', projectId, contextPath: [...contextPath, id], view: 'canvas' })
  }

  // First-open seeding (design brief): a freshly-seeded child dimension has no
  // sub-parameters yet. While any does, the dimension manager opens on its own
  // so the phantom rows are ready — no blocking wizard.
  const needsSeeding =
    contextId !== null && dimensions.length > 0 && dimensions.some((d) => (paramsByDimension[d.id]?.length ?? 0) === 0)

  // Drop compose state if the draft vanished (discarded, project switched, or
  // undone) so the canvas never points compose at a context that isn't there.
  useEffect(() => {
    if (composeContextId && !contexts.some((c) => c.id === composeContextId)) {
      setComposeContextId(null)
    }
  }, [composeContextId, contexts])

  if (loadedFor !== projectId || loadedContextId !== contextId) return null

  const dimensionNames = dimensions.map((d) => d.name)
  // Issue 082 Phase 1, Decision 3 (soft-hint floor) — the guided/populated
  // bifurcation is gone: one tree renders at every dimension count. Below the
  // n=2 floor the circle simply renders partial/empty (Canvas already
  // handles 0/1-dimension geometry) and this quiet inline line replaces the
  // old hard placeholder wall. Never shown once the seed-hint (child canvas
  // missing sub-parameters) already owns the surface's one empty-state voice.
  const belowFloor = !needsSeeding && dimensions.length < 2

  return (
    <>
      <ContextBar>
        {/* Design brief (issue 027): the bar reads as three distinct groups —
            location (breadcrumb, the primary depth nav) · controls (dimension
            manager, canvas/coverage toggle) · stats (documented, drafts) —
            separated by group-level spacing so it parses in one glance
            instead of one flat row at equal weight (SITEMAP §2). */}
        <div className="context-bar__location">
          {/* SITEMAP §2: breadcrumbs. Issue 082 Phase 1 — the dimension
              manager is no longer a popover trigger here; it's an
              always-open rail on the canvas surface itself (below), so
              there's nothing to open from the context bar anymore.
              Root-canvas dimension names trail the crumbs as muted context. */}
          <Breadcrumbs projectId={projectId} crumbs={breadcrumbs} dimensionNames={dimensionNames} />
        </div>
        <div className="context-bar__controls">
          <div className="design-view-toggle" role="group" aria-label="Design view">
            <Button
              variant="bare"
              className="view-toggle__btn"
              data-active={view === 'canvas' || undefined}
              aria-pressed={view === 'canvas'}
              onClick={() => navigate({ kind: 'design', projectId, contextPath: [], view: 'canvas' })}
            >
              Canvas
            </Button>
            <Button
              variant="bare"
              className="view-toggle__btn"
              data-active={view === 'coverage' || undefined}
              aria-pressed={view === 'coverage'}
              onClick={() => navigate({ kind: 'design', projectId, contextPath: [], view: 'coverage' })}
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
      </ContextBar>
      <main className="design-main" data-view={view}>
        {view === 'canvas' ? (
          <>
            {/* One choreographed zoom (STYLE_GUIDE §8 drill-down exception):
                keyed on the canvas so the child fades/scales in on the same
                graph paper; reduced-motion snaps straight to the rested state. */}
            <div className="canvas-zoom" key={contextId ?? 'root'} data-depth={contextPath.length}>
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
              {/* Issue 082 Phase 1, Decision 3 — a quiet inline hint, not a
                  gate: the rail and circle are both live below the n=2 floor
                  too (Canvas already renders 0/1-dimension geometry); this
                  replaces the old hard placeholder wall that used to swap
                  the whole surface out for the dimension manager alone. */}
              {belowFloor ? (
                <p className="canvas-floor-hint" role="status">
                  Add a second dimension to start binding contexts.
                </p>
              ) : null}
              {/* Issue 035 — a viewer never sees the write-only "New context"
                  affordance at all (not merely disabled); the read surface
                  otherwise looks identical. */}
              {readOnly ? null : (
                <div className="canvas-toolbar">
                  {/* "New context" or the `c` key enters compose mode (SPEC §4.2,
                      §4.4). No palette verb here — the command palette (017) owns
                      its own registry. */}
                  <Button onClick={() => void enterCompose()} disabled={composing}>
                    New context
                  </Button>
                </div>
              )}
              <div
                className="design-surface-row"
                // Issue 027 — the child-no-params state already shows ONE
                // calm prompt above ("This canvas needs parameters…"); the
                // canvas's own always-on empty-state text (SPEC §4.2) would
                // otherwise repeat "nothing here yet" a second time. Canvas
                // still mounts (its arcs/geometry are real chrome) — only its
                // redundant empty-state text is suppressed here, in CSS,
                // since Canvas.tsx itself is out of scope for this issue.
                data-suppress-canvas-empty={needsSeeding || undefined}
              >
                {/* Issue 082 Phase 1 — the persistent, always-anchored rail
                    (rail · canvas · register, design brief): a stable panel
                    that never unmounts across the n=2 floor or any dimension
                    count, replacing the old popover-behind-a-trigger + guided-
                    start-panel bifurcation. <640px it joins the column stack
                    below the other two (base.css). */}
                <section className="panel dim-rail" aria-label="Dimensions and parameters">
                  <DimensionManagerPanel childCanvas={contextId !== null} />
                </section>
                {/* Design brief (issue 008): the circle sits directly on the
                    graph-paper ground, no panel — unlike the register, which
                    stays opaque per STYLE_GUIDE's table convention. */}
                <Canvas
                  dimensions={dimensions}
                  parametersByDimension={paramsByDimension}
                  contexts={contexts}
                  bindingsByContext={bindingsByContext}
                  childCountByContext={childCountByContext}
                  selectedContextId={selectedContextId}
                  onSelect={handleSelect}
                  onDrillIn={handleDrillIn}
                  // Issue 027 — dropped: the breadcrumb already states the
                  // parent tuple being refined ("Refining …" trails the
                  // crumbs, Breadcrumbs.tsx), so the canvas-center lineage
                  // line was a second copy of the same sentence.
                  composeContextId={composeContextId}
                  activeDimensionId={activeDimensionId}
                  onBindParameter={(d, p) => void handleBindParameter(d, p)}
                  onUnbindParameter={(d) => void handleUnbindParameter(d)}
                  onExitCompose={exitCompose}
                  hoveredMark={hoveredMark}
                  onHoverChange={setHoveredMark}
                />
                <section className="panel context-register-shell">
                  <ContextRegister
                    projectId={projectId}
                    contextId={contextId}
                    onDrillIn={handleDrillIn}
                    readOnly={readOnly}
                  />
                </section>
              </div>
            </div>
          </>
        ) : (
          <CoverageMatrix
            dimensions={dimensions}
            parametersByDimension={paramsByDimension}
            contexts={contexts}
            bindingsByContext={bindingsByContext}
            selectedContextId={selectedContextId}
            onSelectContext={(id) => handleSelect(id)}
            onComposeTuple={handleComposeTuple}
          />
        )}
      </main>
    </>
  )
}
