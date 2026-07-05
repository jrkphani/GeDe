import { useEffect, useMemo, useRef, useState } from 'react'
import { ContextBar } from '../shell/slots'
import { composeReducer, firstUnbound } from '../domain/composeMode'
import { documentedStatus, isComplete } from '../domain/completeness'
import { describeContext, tupleReadout } from '../domain/contextDescription'
import { findDuplicateContextIds } from '../domain/duplicates'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { useParametersStore } from '../store/parameters'
import { useStatusStore } from '../store/status'
import { Button } from './ui/button'
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
  // Issue 010 — compose mode. `composeContextId` is the live draft. The active
  // (next-to-bind) dimension is DERIVED from the store's live bindings each
  // render (see below), not held in state — so rapid dot clicks, whose async
  // store writes settle out of order, can never leave the pointer stale.
  const [composeContextId, setComposeContextId] = useState<string | null>(null)

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
  async function enterCompose() {
    if (composeContextId) return
    const created = await useContextsStore.getState().create()
    if (!created) return
    useContextsStore.getState().select(created.id)
    setComposeContextId(created.id)
    const firstName = dimensions.find((d) => d.id === orderedDimensionIds[0])?.name
    useStatusStore
      .getState()
      .announce(firstName ? `Composing ${created.symbol} — bind ${firstName}` : `Composing ${created.symbol}`)
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

  const selectedContext = selectedContextId ? (contexts.find((c) => c.id === selectedContextId) ?? null) : null
  const selectedBindings = selectedContextId ? (bindingsByContext[selectedContextId] ?? {}) : {}
  const composing = composeContextId !== null && composeContextId === selectedContextId
  // Derived, race-free: the next dimension to bind is simply the first unbound
  // one in sort order given the draft's current (store-authoritative) bindings.
  const activeDimensionId = composeContextId
    ? firstUnbound(orderedDimensionIds, bindingsByContext[composeContextId] ?? {})
    : null
  const duplicateSiblingSymbols = useMemo(() => {
    if (!selectedContextId) return []
    const dupes = findDuplicateContextIds(dimensionIds, bindingsByContext)[selectedContextId] ?? []
    const symbolById = new Map(contexts.map((c) => [c.id, c.symbol]))
    return dupes.map((sid) => symbolById.get(sid) ?? '?')
  }, [selectedContextId, dimensionIds, bindingsByContext, contexts])

  // Guided mode starts when the canvas is below the floor and ends only once
  // the crossing gesture completes — never unmount an open editor mid-gesture.
  useEffect(() => {
    if (loadedFor !== projectId) return
    if (guided === null) setGuided(dimensions.length < 2)
    else if (guided && dimensions.length >= 2 && editingId === null) setGuided(false)
  }, [loadedFor, projectId, guided, dimensions.length, editingId])

  // Drop compose state if the draft vanished (discarded, project switched, or
  // undone) so the canvas never points compose at a context that isn't there.
  useEffect(() => {
    if (composeContextId && !contexts.some((c) => c.id === composeContextId)) {
      setComposeContextId(null)
    }
  }, [composeContextId, contexts])

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
            <div className="canvas-toolbar">
              {/* "New context" or the `c` key enters compose mode (SPEC §4.2,
                  §4.4). No palette verb here — the command palette (017) owns
                  its own registry. */}
              <Button onClick={() => void enterCompose()} disabled={composing}>
                New context
              </Button>
            </div>
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
                composeContextId={composeContextId}
                activeDimensionId={activeDimensionId}
                onBindParameter={(d, p) => void handleBindParameter(d, p)}
                onUnbindParameter={(d) => void handleUnbindParameter(d)}
                onExitCompose={exitCompose}
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
              composing={composing}
              activeDimensionId={activeDimensionId}
              parametersByDimension={paramsByDimension}
              onBindParameter={(d, p) => void handleBindParameter(d, p)}
              onUnbindParameter={(d) => void handleUnbindParameter(d)}
              duplicateSiblingSymbols={duplicateSiblingSymbols}
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
