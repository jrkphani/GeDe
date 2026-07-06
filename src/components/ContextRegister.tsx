import { useEffect } from 'react'
import type { ContextRow } from '../db/mutations'
import { documentedStatus, isComplete } from '../domain/completeness'
import { findDuplicateContextIds } from '../domain/duplicates'
import { useCommandLogStore } from '../store/commandLog'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { useParametersStore } from '../store/parameters'
import { useStatusStore } from '../store/status'
import { EditableGrid, type GridColumn } from './EditableGrid'
import { Button } from './ui/button'

const DOCUMENTED_LABEL: Record<'draft' | 'complete' | 'documented', string> = {
  draft: 'Draft',
  complete: 'Complete — needs justification',
  documented: 'Documented',
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
}: {
  projectId: string
  contextId?: string | null
  onDrillIn?: (contextId: string) => void
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

  // Issue 009 sync rule — selecting in either projection scrolls the other
  // to reveal. Canvas-driven selection must not steal keyboard focus from
  // the canvas, so this only scrolls (no .focus()); register-driven
  // selection already has focus here, so the call is a harmless no-op.
  useEffect(() => {
    if (!selectedContextId) return
    const escaped = typeof CSS !== 'undefined' ? CSS.escape(selectedContextId) : selectedContextId
    const row = document.querySelector<HTMLElement>(`[data-row-id="${escaped}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedContextId])

  const dimensionIds = dimensions.map((d) => d.id)
  const duplicatesByContext = findDuplicateContextIds(dimensionIds, bindingsByContext)
  const symbolById = Object.fromEntries(contexts.map((c) => [c.id, c.symbol]))

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
          return <span className="status-dot" data-status={status} title={label} aria-label={label} />
        },
      },
    },
    ...dimensions.map(
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
    ),
    {
      id: 'justification',
      header: 'Justification',
      cell: {
        kind: 'multiline',
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
      rowClassName={(ctx) => {
        const bound = new Set(Object.keys(bindingsByContext[ctx.id] ?? {}))
        const classes = [
          isComplete(dimensionIds, bound) ? null : 'grid-row--draft',
          ctx.id === selectedContextId ? 'grid-row--selected' : null,
        ].filter((c): c is string => c !== null)
        return classes.length > 0 ? classes.join(' ') : undefined
      }}
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
