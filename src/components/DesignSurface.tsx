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
import { useCanvasesStore } from '../store/canvases'
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
import { CanvasSwitcher } from './CanvasSwitcher'
import type { DesignView } from '../shell/routes'

export function DesignSurface({
  projectId,
  contextPath,
  view,
  canvasId,
}: {
  projectId: string
  contextPath: string[]
  view: DesignView
  // Issue 090 Phase 4c — the root-canvas selector from `?canvas=` (depth 0
  // only). Undefined ⇒ the project's default (first) root canvas.
  canvasId?: string | undefined
}) {
  // The canvas currently open: null = root canvas; the last path segment = the
  // context whose child canvas we're inside (issue 011).
  const contextId = contextPath.length > 0 ? (contextPath[contextPath.length - 1] as string) : null
  const atRoot = contextPath.length === 0
  // Issue 090 Phase 4c — the live root canvases of this project, so the switcher
  // and the active-canvas resolution share one source of truth.
  const canvases = useCanvasesStore((s) => s.canvases)
  const storeSelectedCanvasId = useCanvasesStore((s) => s.selectedCanvasId)
  useEffect(() => {
    void useCanvasesStore.getState().load(projectId)
  }, [projectId])
  // At depth 0 the active root canvas is `?canvas=` validated against the live
  // list (a stale/deleted id falls back to the first root canvas); at depth>0
  // the canvas is pinned by the context chain, so this is null and the load
  // selector is the URL context id instead (resolved to that context's child
  // canvas by the store's resolveCanvasScope).
  const activeRootCanvasId = useMemo(() => {
    if (!atRoot || canvases.length === 0) return null
    const fromRoute = canvasId && canvases.some((c) => c.id === canvasId) ? canvasId : null
    return fromRoute ?? canvases[0]?.id ?? null
  }, [atRoot, canvases, canvasId])
  // Keep the store's selection aligned with the URL so archive's reselect and
  // create's "append after" reason from the canvas the user is actually on.
  useEffect(() => {
    if (activeRootCanvasId) useCanvasesStore.getState().select(activeRootCanvasId)
  }, [activeRootCanvasId])
  // The concrete selector threaded into the two content stores' load(): a real
  // root canvas id at depth 0, the URL context id at depth>0.
  const canvasSelector = atRoot ? activeRootCanvasId : contextId
  // At depth 0 the selector isn't settled until the canvases list has loaded
  // (a project always has ≥1 root canvas). Loading the content stores with the
  // transient `null` selector first and the resolved id second would race —
  // whichever SELECT resolves last wins, and a late null-load would strand the
  // render gate. So hold the load until the selector is settled.
  const canLoad = !atRoot || activeRootCanvasId !== null
  // Preserved across the view-toggle navigates below (which always target
  // contextPath:[]) so Canvas/Coverage + `v` never drop back to canvas 1 — at
  // depth>0 fall back to the store's last root selection.
  const preservedCanvasId = activeRootCanvasId ?? storeSelectedCanvasId
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
  // Issue 090 Phase 4c — the RESOLVED canvas id the store last loaded. At depth
  // 0 the same root canvas is addressable by two selectors (null ⇒ default, or
  // its real id), both of which resolve here to the same concrete id — so the
  // render gate keys on this resolved id, not the raw selector, and never
  // false-blocks when a caller reloads with `null`.
  const loadedCanvasId = useDimensionsStore((s) => s.canvasId)
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
      await useDimensionsStore.getState().load(projectId, canvasSelector)
      await useContextsStore.getState().load(projectId, canvasSelector)
      void useContextsStore.getState().loadBreadcrumbs(contextPath)
    }
    // Only load once the canvas selector is settled (see canLoad above) — this
    // avoids the transient null-load → resolved-load race at depth 0.
    if (canLoad) void openCanvas()
    return () => {
      cancelled = true
    }
    // canvasSelector is the meaningful key (a real root canvas id at depth 0,
    // the URL context id at depth>0); contextId still drives the child-canvas
    // seed above, and contextPath is only read for breadcrumb symbols.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, contextId, canvasSelector, canLoad])

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
    navigate({
      kind: 'design',
      projectId,
      contextPath: [],
      view: 'canvas',
      canvasId: preservedCanvasId ?? undefined,
    })
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
        canvasId: preservedCanvasId ?? undefined,
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [view, projectId, preservedCanvasId])

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

  // Issue 085 Phase C — bridges the rail -> register keyboard seam (design
  // brief: "dimensions -> parameters -> contexts is one uninterrupted tab
  // order"). PhantomInput's own 082 Phase 1 grammar already lets Tab escape
  // NATIVELY out of an EMPTY phantom rather than trapping the user on it
  // (inline-editor.tsx PhantomInput, "let native Tab move focus out"); before
  // this issue that native escape landed wherever the DOM put it next — the
  // canvas, since it used to sit between the rail and the register (085's own
  // #1 complaint). Now the canvas moves outside the editing zone entirely, so
  // native order alone would land on the FIRST EXISTING register row rather
  // than the "new context" phantom row the design brief calls out by name
  // (existing rows render before the phantom row in EditableGrid's DOM). This
  // explicitly redirects that one escape onto the register's phantom row
  // instead of trusting native order — the minimal bridge across the seam.
  // Root and child canvases have different "last phantom" (the dimension-add
  // phantom vs. the last dimension's own parameter-add phantom, since a child
  // canvas has no dimension-add affordance at all — DimensionManagerPanel
  // above); querying the rail's phantoms in DOM order and comparing against
  // the focused one covers both without hardcoding which.
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

  // Render-gate (issue 090 Phase 4c) — blocks the frame between a canvas switch
  // and its load resolving. At depth 0 it compares the RESOLVED canvas id (so a
  // reload via the null-default selector still matches the active root canvas);
  // at depth>0 the raw context selector is the key (its resolved child canvas id
  // isn't known here until the store resolves it).
  const canvasReady = atRoot
    ? loadedFor === projectId && loadedCanvasId === activeRootCanvasId
    : loadedFor === projectId && loadedContextId === contextId
  if (!canvasReady) return null

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
          {/* Issue 090 Phase 4c — the root-canvas switcher, depth 0 only. At
              depth>0 the breadcrumb owns navigation and the canvas is pinned by
              the context chain, so the switcher would be meaningless there. */}
          {atRoot ? (
            <CanvasSwitcher projectId={projectId} view={view} currentCanvasId={activeRootCanvasId} />
          ) : null}
        </div>
        <div className="context-bar__controls">
          <div className="design-view-toggle" role="group" aria-label="Design view">
            <Button
              variant="bare"
              className="view-toggle__btn"
              data-active={view === 'canvas' || undefined}
              aria-pressed={view === 'canvas'}
              onClick={() =>
                navigate({
                  kind: 'design',
                  projectId,
                  contextPath: [],
                  view: 'canvas',
                  canvasId: preservedCanvasId ?? undefined,
                })
              }
            >
              Canvas
            </Button>
            <Button
              variant="bare"
              className="view-toggle__btn"
              data-active={view === 'coverage' || undefined}
              aria-pressed={view === 'coverage'}
              onClick={() =>
                navigate({
                  kind: 'design',
                  projectId,
                  contextPath: [],
                  view: 'coverage',
                  canvasId: preservedCanvasId ?? undefined,
                })
              }
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
            <div
              className="canvas-zoom"
              // Issue 090 Phase 4c — key on the active canvas so switching root
              // canvases re-triggers the drill/zoom choreography, not just
              // drilling into a child.
              key={canvasSelector ?? 'root'}
              data-depth={contextPath.length}
            >
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
                {/* Issue 085 Phase C — one editing zone: the rail and the
                    register are grouped into a single bordered surface with
                    one continuous tab order (dimensions -> parameters ->
                    contexts). The canvas (below) moves OUT from between them
                    to a side visual panel — it is never rendered inside this
                    container, at any dimension count. */}
                <div className="editing-zone" role="group" aria-label="Dimensions, parameters, and contexts">
                  {/* Issue 082 Phase 1 — the persistent, always-anchored rail:
                      a stable panel that never unmounts across the n=2 floor
                      or any dimension count, replacing the old popover-
                      behind-a-trigger + guided-start-panel bifurcation.
                      <640px the editing zone itself stacks rail -> register
                      (base.css); the whole zone then stacks above the canvas. */}
                  {/* Issue 085 Phase C — `.panel`'s own border/background move
                      to the wrapping `.editing-zone` (single bordered
                      surface, Decision 1); the rail and register no longer
                      carry their own separate `.panel` chrome. */}
                  <section className="dim-rail" aria-label="Dimensions and parameters">
                    <DimensionManagerPanel childCanvas={contextId !== null} />
                  </section>
                  <section className="context-register-shell">
                    <ContextRegister
                      projectId={projectId}
                      contextId={contextId}
                      onDrillIn={handleDrillIn}
                      readOnly={readOnly}
                    />
                  </section>
                </div>
                {/* Design brief (issue 008, reworked 085 Phase C): the circle
                    sits directly on the graph-paper ground, no panel — a
                    side visual-only panel now, out of the editing tab path
                    entirely (Decision 2). It is deliberately the LAST child
                    of the row (not between the rail and the register) so
                    native/roving focus in the canvas never sits mid-flow
                    between the two editing surfaces. */}
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
