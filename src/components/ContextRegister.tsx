import { useEffect } from 'react'
import type { ContextRow } from '../db/mutations'
import { documentedStatus, isComplete } from '../domain/completeness'
import { tupleReadout } from '../domain/contextDescription'
import { findDuplicateContextIds } from '../domain/duplicates'
import { presenceCueLabel } from '../domain/presence'
import { useCommandLogStore } from '../store/commandLog'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { useParametersStore } from '../store/parameters'
import { usePresenceCues, usePresenceStore } from '../store/presence'
import { useStatusStore } from '../store/status'
import { EditableGrid, PHANTOM_ROW_ID, type GridColumn } from './EditableGrid'
import { Button } from './ui/button'

const DOCUMENTED_LABEL: Record<'draft' | 'complete' | 'documented', string> = {
  draft: 'Draft',
  complete: 'Complete — needs justification',
  documented: 'Documented',
}

// Issue 038 (presence) — an ephemeral, per-row identity cue beside the
// existing completeness status-dot: filled = someone else is editing this
// context right now (test-first plan #3's same-cell hint, at row grain — see
// the EditableGrid `onEditingChange` wiring below for why this doesn't
// narrow to the exact field in this slice); hollow ring = someone else has
// this context selected but isn't editing it (test-first plan #2's
// selectedContextId cue). Renders nothing when nobody else is here — no
// visual cost on the untested-for-demand common case (a solo session).
// Never persisted: reads straight off usePresenceCues (src/store/presence.ts),
// which never touches src/db — see that module's own header comment and
// presence.test.ts's "never persisted" assertion.
function PresenceCue({ contextId }: { contextId: string }) {
  const { selectors, editors } = usePresenceCues(contextId)
  const editing = editors.length > 0
  const entries = editing ? editors : selectors
  const first = entries[0]
  if (!first) return null
  const label = presenceCueLabel(entries, editing ? 'editing' : 'here')
  return (
    <span
      className="presence-dot"
      data-presence={editing ? 'editing' : 'selected'}
      style={editing ? { borderColor: first.color, background: first.color } : { borderColor: first.color }}
      title={label}
      aria-label={label}
    />
  )
}

// Pre-canvas (issues 008–010 add the circle), "selecting" a duplicate sibling
// means focusing its row in the register — the only surface today.
function focusRow(contextId: string): void {
  const escaped = typeof CSS !== 'undefined' ? CSS.escape(contextId) : contextId
  const row = document.querySelector<HTMLElement>(`[data-row-id="${escaped}"]`)
  const target = row?.querySelector<HTMLElement>('.grid-cell, button')
  target?.scrollIntoView({ block: 'nearest' })
  target?.focus()
}

const FIRST_CONTEXT_GHOST = 'Type to create your first context — it becomes α'
const FIRST_CHILD_GHOST = 'Type to create the first context on this canvas'

// SPEC §4.3 — Symbol · one column per dimension (dynamic, sort order) ·
// Justification · Children. On a child canvas the register is scoped to that
// canvas's contexts; the Children column drills into a context's own child
// canvas (issue 011).
export function ContextRegister({
  projectId,
  contextId = null,
  onDrillIn,
  readOnly = false,
  collapsed = false,
}: {
  projectId: string
  contextId?: string | null
  onDrillIn?: (contextId: string) => void
  // Issue 035 — a viewer sees the same register, minus every write affordance
  // (phantom row, in-place edit of any cell); forwarded straight to EditableGrid.
  readOnly?: boolean
  // Issue 093 — LOD glance: when true (the D3 register is zoomed out), the
  // per-dimension columns collapse into ONE read-only tuple-summary column so
  // the register stays legible in overview. Zoom back in (collapsed=false) to
  // edit the full columns. Default off for the D2 / normal-route register.
  collapsed?: boolean
}) {
  const dimensions = useDimensionsStore((s) => s.dimensions)
  const contexts = useContextsStore((s) => s.contexts)
  const bindingsByContext = useContextsStore((s) => s.bindingsByContext)
  const childCountByContext = useContextsStore((s) => s.childCountByContext)
  const loadContexts = useContextsStore((s) => s.load)
  const createContext = useContextsStore((s) => s.create)
  const setSymbol = useContextsStore((s) => s.setSymbol)
  const setJustification = useContextsStore((s) => s.setJustification)
  const bind = useContextsStore((s) => s.bind)
  const unbind = useContextsStore((s) => s.unbind)
  const selectedContextId = useContextsStore((s) => s.selectedContextId)
  const select = useContextsStore((s) => s.select)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const loadParams = useParametersStore((s) => s.load)
  const announce = useStatusStore((s) => s.announce)

  useEffect(() => {
    void loadContexts(projectId, contextId)
  }, [projectId, contextId, loadContexts])

  useEffect(() => {
    for (const d of dimensions) void loadParams(d.id)
  }, [dimensions, loadParams])

  // Issue 009 sync rule, re-pointed by issue 085 Phase B (Decision 3 — the
  // Composer strip is retired, selection now scrolls+highlights the register
  // row directly instead of surfacing a second element): selecting in either
  // projection scrolls the other to reveal. Canvas-driven selection must not
  // steal keyboard focus from the canvas, so this only scrolls (no .focus());
  // register-driven selection already has focus here, so the call is a
  // harmless no-op. `grid-row--selected` (rowClassName below) draws the left
  // rule; `isRowSelected` below pairs it with a non-color-only aria signal.
  useEffect(() => {
    if (!selectedContextId) return
    const escaped = typeof CSS !== 'undefined' ? CSS.escape(selectedContextId) : selectedContextId
    const row = document.querySelector<HTMLElement>(`[data-row-id="${escaped}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedContextId])

  const dimensionIds = dimensions.map((d) => d.id)
  const duplicatesByContext = findDuplicateContextIds(dimensionIds, bindingsByContext)
  const symbolById = Object.fromEntries(contexts.map((c) => [c.id, c.symbol]))

  // Issue 093 — the collapsed tuple-summary column reads each context's whole
  // bound tuple as one string ("Comfort · Users · —"), reusing the same
  // `tupleReadout` / `' · '` idiom as the coverage matrix and the ring's a11y.
  const paramNameById: Record<string, string> = {}
  for (const list of Object.values(paramsByDimension)) {
    for (const p of list) paramNameById[p.id] = p.name
  }
  const tupleSummaryColumn: GridColumn<ContextRow> = {
    id: '__tuple_summary__',
    header: 'Tuple',
    headClassName: 'grid-col--tuple-summary',
    cellClassName: 'grid-col--tuple-summary',
    cell: {
      kind: 'static',
      render: (ctx) => {
        const readout = tupleReadout(dimensions, bindingsByContext[ctx.id] ?? {}, paramNameById).join(
          ' · ',
        )
        return (
          <span className="register-tuple-summary font-mono" title={readout}>
            {readout}
          </span>
        )
      },
    },
  }

  const columns: GridColumn<ContextRow>[] = [
    {
      id: 'symbol',
      header: 'Symbol',
      headClassName: 'grid-col--symbol',
      cellClassName: 'grid-col--symbol',
      cell: {
        kind: 'mono',
        getValue: (ctx) => ctx.symbol,
        onCommit: async (ctx, value) => {
          const result = await setSymbol(ctx.id, value)
          if (!result.ok && result.reason) announce(result.reason)
          return result.ok
        },
      },
    },
    {
      id: 'documented',
      header: 'Documented',
      headClassName: 'grid-col--status',
      cellClassName: 'grid-col--status',
      cell: {
        kind: 'static',
        render: (ctx) => {
          const bound = new Set(Object.keys(bindingsByContext[ctx.id] ?? {}))
          const status = documentedStatus(isComplete(dimensionIds, bound), ctx.justification)
          const label = DOCUMENTED_LABEL[status]
          return (
            <>
              <span className="status-dot" data-status={status} title={label} aria-label={label} />
              <PresenceCue contextId={ctx.id} />
            </>
          )
        },
      },
    },
    // Issue 093 — collapsed (zoomed out) → one tuple-summary column; else the
    // full per-dimension combobox columns.
    ...(collapsed
      ? [tupleSummaryColumn]
      : dimensions.map(
          (dim): GridColumn<ContextRow> => ({
            id: dim.id,
            header: dim.name,
            cell: {
              kind: 'combobox',
              getValue: (ctx) => bindingsByContext[ctx.id]?.[dim.id] ?? null,
              getOptions: () =>
                (paramsByDimension[dim.id] ?? []).map((p) => ({
                  value: p.id,
                  label: p.name,
                  color: dim.color,
                })),
              onCommit: async (ctx, value) => {
                if (value) await bind(ctx.id, dim.id, value)
                else await unbind(ctx.id, dim.id)
                return true
              },
            },
          }),
        )),
    {
      id: 'justification',
      header: 'Justification',
      cell: {
        // Issue 089 D1 Phase 3 — the proof column: justification is now a rich
        // cell (Lexical). Same value contract (a stored string in/out), but the
        // string is Lexical JSON once edited here; legacy plain strings (and the
        // phantom-row's plain-input create below) still render. The global
        // FormatStrip (089 D1 P1) binds to this cell's editor when focused.
        kind: 'richtext',
        placeholder: 'Add justification…',
        // Issue 104 Facet 1 — the justification prose keeps the roomy ~72px
        // editor floor (085 Decision 4); the Architecture/Foundation description
        // cells opt OUT (compact, auto-grow) so short descriptions don't balloon.
        roomy: true,
        getValue: (ctx) => ctx.justification ?? '',
        onCommit: async (ctx, value) => {
          await setJustification(ctx.id, value)
          return true
        },
      },
    },
    {
      id: 'children',
      header: 'Children',
      cell: {
        kind: 'static',
        render: (ctx) => {
          const count = childCountByContext[ctx.id] ?? 0
          const label = count > 0 ? `${count} ▸` : 'Open ▸'
          return (
            <Button
              variant="bare"
              className="children-drill"
              aria-label={`Open ${ctx.symbol}’s canvas${count > 0 ? ` (${count} contexts)` : ''}`}
              title="Open child canvas"
              onClick={() => onDrillIn?.(ctx.id)}
            >
              {label}
            </Button>
          )
        },
      },
    },
    {
      id: 'duplicate',
      header: 'Duplicate',
      headClassName: 'grid-col--duplicate',
      cellClassName: 'grid-col--duplicate',
      cell: {
        kind: 'static',
        render: (ctx) => {
          const siblingIds = duplicatesByContext[ctx.id]
          if (!siblingIds || siblingIds.length === 0) return null
          const symbols = siblingIds.map((id) => symbolById[id] ?? '?')
          const label = `Same tuple as ${symbols.join(', ')}`
          return (
            <Button
              variant="bare"
              className="duplicate-badge"
              title={label}
              onClick={() => {
                focusRow(siblingIds[0] as string)
              }}
            >
              = {symbols.join(', ')}
            </Button>
          )
        },
      },
    },
  ]

  return (
    <EditableGrid
      rows={contexts}
      columns={columns}
      getRowId={(ctx) => ctx.id}
      readOnly={readOnly}
      // Issue 038 — feeds the presence store's "same-cell editing" hint. Only
      // text/mono/multiline cells (Symbol, Justification) report through
      // EditableGrid's shared `editing` state; a dimension-binding combobox
      // cell manages its own open/closed state internally and isn't wired to
      // this signal in this slice (see EditableGrid's own prop doc comment
      // and this issue's final report for the flagged scope cut). The
      // phantom row has no real context id yet, so it never publishes.
      onEditingChange={(cell) =>
        usePresenceStore
          .getState()
          .setFocusedCell(cell && cell.rowId !== PHANTOM_ROW_ID ? { contextId: cell.rowId, field: cell.columnId } : null)
      }
      rowClassName={(ctx) => {
        const bound = new Set(Object.keys(bindingsByContext[ctx.id] ?? {}))
        const classes = [
          isComplete(dimensionIds, bound) ? null : 'grid-row--draft',
          ctx.id === selectedContextId ? 'grid-row--selected' : null,
        ].filter((c): c is string => c !== null)
        return classes.length > 0 ? classes.join(' ') : undefined
      }}
      // Issue 085 Phase B, Decision 3 — the left rule (`grid-row--selected`
      // above) is joined by this non-color-only aria signal.
      isRowSelected={(ctx) => ctx.id === selectedContextId}
      onRowClick={(ctx) => select(ctx.id)}
      phantom={{
        columnId: 'justification',
        placeholder:
          contexts.length === 0 ? (contextId === null ? FIRST_CONTEXT_GHOST : FIRST_CHILD_GHOST) : 'New context',
        onCreate: (text) => {
          // One user gesture (typing + Enter in the phantom row) spans two
          // store calls — batched into a single undo step (issue 006).
          void useCommandLogStore.getState().batch('create context', async () => {
            const ctx = await createContext()
            if (ctx) await setJustification(ctx.id, text)
          })
        },
      }}
    />
  )
}
