import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Tier2EntryRow, Tier2TableRow } from '../db/mutations'
import { buildEntryTree, flattenEntryTree } from '../domain/entryTree'
import { canWrite } from '../domain/workspaceRole'
import { ContextBar } from '../shell/slots'
import { useStatusStore } from '../store/status'
import { useTier2Store, type EntryLink } from '../store/tier2'
import { useWorkspaceRole } from '../store/workspace'
import { EditableGrid, type GridColumn } from './EditableGrid'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { InlineEdit, PhantomInput } from './ui/inline-editor'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './ui/popover'

// Stable empty fallback — a fresh [] in the selector loops the subscription.
const NO_ENTRIES: Tier2EntryRow[] = []

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

interface RowMeta {
  depth: number
  hasChildren: boolean
}

// SPEC §4.6 / SITEMAP §1 — the 2nd Tier Architecture tab: one nested-row table
// per intended dimension, stacked as paper panels. Selected entries promote
// into 3rd-Tier dimensions + parameters, each linked back (invariant 7). Reuses
// EditableGrid unchanged (ADR-0004) — the nesting, selection and source badge
// live in two static cell renderers only.
export function ArchitectureSurface({ projectId }: { projectId: string }) {
  // Issue 035 — a viewer sees every table's tree read-only: no add/delete
  // entry, no promote, no add-table, no table rename, no phantom row.
  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)
  const tables = useTier2Store((s) => s.tables)
  const load = useTier2Store((s) => s.load)
  const addTable = useTier2Store((s) => s.addTable)

  useEffect(() => {
    void load(projectId)
  }, [projectId, load])

  function jumpTo(tableId: string) {
    document.getElementById(`t2-table-${tableId}`)?.scrollIntoView({ block: 'start' })
  }

  return (
    <main className="architecture">
      <ContextBar>
        <div className="t2-contextbar">
          {/* Navigate-only (issue 084 finding 5): the quick-jump list stays,
              but creation no longer lives in this bar — it moved to the stable
              top add-row below. */}
          {tables.map((t) => (
            <Button
              key={t.id}
              variant="bare"
              className="t2-quickjump"
              aria-label={`Jump to ${t.name}`}
              onClick={() => jumpTo(t.id)}
            >
              {t.name}
            </Button>
          ))}
        </div>
      </ContextBar>

      <h2 className="tier2-header">2nd Tier · Architecture</h2>

      {/* D1 (issue 084) — the single create path: a stable, always-visible typed
          add-row fixed directly under the header. It never relocates as tables
          accumulate and is the only "add table" affordance (the old
          context-bar focus-only button is gone, finding 2). A viewer never sees
          this write-only affordance (issue 035). */}
      {readOnly ? null : (
        <div className="t2-add-table">
          <span className="t2-add-table__glyph" aria-hidden>
            +
          </span>
          <PhantomInput
            placeholder="Name a table"
            ariaLabel="Add architecture table"
            inputClassName="t2-add-table__input"
            onSubmit={(name) => void addTable(name)}
          />
        </div>
      )}

      {/* Empty-state guidance (issue 084 finding 1): one orienting line so a
          first-run project is never a bare input with nothing actionable. */}
      {tables.length === 0 && !readOnly ? (
        <p className="t2-empty">
          No tables yet. Name your first dimension above — e.g. “Stakeholders”, “Value”.
        </p>
      ) : null}

      {tables.map((table) => (
        <TablePanel key={table.id} projectId={projectId} table={table} readOnly={readOnly} />
      ))}
    </main>
  )
}

function TablePanel({
  projectId,
  table,
  readOnly,
}: {
  projectId: string
  table: Tier2TableRow
  readOnly: boolean
}) {
  const entries = useTier2Store((s) => s.entriesByTable[table.id] ?? NO_ENTRIES)
  const linkByEntryId = useTier2Store((s) => s.linkByEntryId)
  const renameTable = useTier2Store((s) => s.renameTable)
  const addEntry = useTier2Store((s) => s.addEntry)
  const renameEntry = useTier2Store((s) => s.renameEntry)
  const setEntryDescription = useTier2Store((s) => s.setEntryDescription)
  const removeEntry = useTier2Store((s) => s.removeEntry)

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  // The row whose delete surfaced a linked-parameter resolution (never silent).
  const [resolving, setResolving] = useState<{ entry: Tier2EntryRow; links: EntryLink[] } | null>(
    null,
  )
  // The entry whose "Add child" opened a typed phantom (never a literal row).
  const [addingChildTo, setAddingChildTo] = useState<string | null>(null)

  const flat = useMemo(
    () => flattenEntryTree(buildEntryTree(entries), collapsed),
    [entries, collapsed],
  )
  const rows = flat.map((f) => f.entry)
  const metaById = useMemo(() => {
    const map = new Map<string, RowMeta>()
    for (const f of flat) map.set(f.entry.id, { depth: f.depth, hasChildren: f.hasChildren })
    return map
  }, [flat])
  const flatIds = flat.map((f) => f.entry.id)

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function onSelectClick(id: string, e: React.MouseEvent) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (e.shiftKey && anchorRef.current) {
        const from = flatIds.indexOf(anchorRef.current)
        const to = flatIds.indexOf(id)
        if (from !== -1 && to !== -1) {
          for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(flatIds[i] as string)
        }
      } else if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
    anchorRef.current = id
  }

  // Returns whether the delete completed cleanly or surfaced the linked-parameter
  // resolution (invariant 7 — never a silent cascade). The selection-bar Remove
  // drives this per selected entry and uses the outcome to know when to stop
  // (a promoted entry pauses the batch until the user resolves it) and when to
  // clear the selection.
  async function handleDelete(entry: Tier2EntryRow): Promise<'deleted' | 'needs-resolution'> {
    const result = await removeEntry(table.id, entry.id)
    if (result.kind === 'needs-resolution') {
      setResolving({ entry, links: result.links })
      return 'needs-resolution'
    }
    useStatusStore.getState().announce(`Deleted ${entry.name}`)
    return 'deleted'
  }

  // Remove every selected entry (issue 084) — the verb moved out of a per-row
  // data-column button into the selection bar. Promoted entries still route
  // through the resolution popover one at a time: on the first that needs
  // resolution we stop, keeping it (and the still-unprocessed rest) selected so
  // the user can resolve and re-run; already-removed entries drop out. A clean
  // sweep clears the whole selection.
  async function removeSelected() {
    const ids = [...selected]
    for (let i = 0; i < ids.length; i++) {
      const entry = entries.find((e) => e.id === ids[i])
      if (!entry) continue
      const outcome = await handleDelete(entry)
      if (outcome === 'needs-resolution') {
        setSelected(new Set(ids.slice(i)))
        return
      }
    }
    setSelected(new Set())
  }

  const columns: GridColumn<Tier2EntryRow>[] = [
    {
      id: 'tree',
      header: '',
      headClassName: 't2-col--tree',
      cellClassName: 't2-col--tree',
      cell: {
        kind: 'static',
        render: (entry) => {
          const meta = metaById.get(entry.id) ?? { depth: 0, hasChildren: false }
          const isSelected = selected.has(entry.id)
          return (
            <div
              className="t2-tree"
              data-depth={meta.depth}
              style={{ paddingLeft: `calc(var(--space-5) * ${meta.depth})` }}
            >
              {meta.hasChildren ? (
                <Button
                  variant="bare"
                  className="t2-chevron"
                  aria-label={`${collapsed.has(entry.id) ? 'Expand' : 'Collapse'} ${entry.name}`}
                  onClick={() => toggleCollapse(entry.id)}
                >
                  {collapsed.has(entry.id) ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </Button>
              ) : (
                <span className="t2-chevron-spacer" />
              )}
              {/* Issue 035 — selection only ever feeds the promote action, so
                  a viewer (who can't promote) never sees the affordance. */}
              {readOnly ? null : (
                <Button
                  variant="bare"
                  className="t2-select"
                  aria-label={`Select ${entry.name}`}
                  aria-pressed={isSelected}
                  onClick={(e) => onSelectClick(entry.id, e)}
                >
                  <span className="t2-checkbox" data-checked={isSelected || undefined} />
                </Button>
              )}
            </div>
          )
        },
      },
    },
    {
      id: 'name',
      header: 'Name',
      cell: {
        kind: 'text',
        getValue: (entry) => entry.name,
        onCommit: async (entry, value) => {
          if (value.length > 0 && value !== entry.name) {
            const count = await renameEntry(table.id, entry.id, value)
            if (count > 0) {
              useStatusStore
                .getState()
                .announce(`Renamed ${value} — ${plural(count, 'parameter')} updated`)
            }
          }
          return value.length > 0
        },
        // Source badge rides inline on the Name cell (issue 084) — both sides of
        // the tier link stay visible (invariant 7) without a data column of its
        // own. Read-mode only; the grid hides it while the name is being edited.
        // `aria-hidden`: the badge is a decorative derived cue, so it must NOT
        // join the cell's accessible name (else the cell reads "Users → Stake"
        // and `getByRole('cell', {name})` exact lookups break — e2e + AT noise).
        adornment: (entry) => {
          const link = linkByEntryId[entry.id]
          return link ? (
            <span
              className="t2-source-badge font-mono"
              title={`Promoted to ${link.dimensionName}`}
              aria-hidden="true"
            >
              → {link.dimensionName}
            </span>
          ) : null
        },
      },
    },
    {
      id: 'description',
      header: 'Description',
      cell: {
        kind: 'multiline',
        getValue: (entry) => entry.description ?? '',
        onCommit: async (entry, value) => {
          await setEntryDescription(table.id, entry.id, value)
          return true
        },
      },
    },
    {
      // Trailing row-command gutter (issue 084): row verbs are never a data
      // column. The typed "Add child" affordance lives here, quiet at rest and
      // revealed on row hover/focus (see .t2-col--actions). Remove moved to the
      // selection bar. A viewer (issue 035) sees no affordance at all.
      id: 'actions',
      header: '',
      headClassName: 't2-col--actions',
      cellClassName: 't2-col--actions',
      cell: {
        kind: 'static',
        render: (entry) =>
          readOnly ? null : (
            // Typed add-child (issue 084 finding 4): un-collapses the parent then
            // opens a phantom — type → Enter — instead of inserting a literal
            // 'New entry' row the user then has to find and rename. Same
            // type-first grammar as every other add on this surface.
            <Popover
              open={addingChildTo === entry.id}
              onOpenChange={(open) => setAddingChildTo(open ? entry.id : null)}
            >
              <PopoverTrigger asChild>
                <Button
                  className="t2-add-child-trigger"
                  aria-label={`Add child to ${entry.name}`}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev)
                      next.delete(entry.id)
                      return next
                    })
                  }
                >
                  <span aria-hidden>＋ </span>Add child
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={4} className="t2-add-child">
                <PhantomInput
                  placeholder={`Name a child of ${entry.name}`}
                  ariaLabel={`Name a child of ${entry.name}`}
                  onSubmit={(name) => void addEntry(table.id, entry.id, name)}
                />
              </PopoverContent>
            </Popover>
          ),
      },
    },
  ]

  return (
    <section className="panel t2-table" id={`t2-table-${table.id}`} data-selecting={selected.size > 0 || undefined}>
      <InlineEdit
        value={table.name}
        onCommit={(next) => void renameTable(table.id, next)}
        display={table.name}
        displayClassName="t2-table__name"
        ariaLabel={`Table name ${table.name}`}
        selectOnFocus
        readOnly={readOnly}
      />
      {/* Delete-with-link resolution rehomed out of the cramped .t2-meta icon
          strip (issue 084): it anchors at the panel level now, opened by any
          row's quiet-text Remove. */}
      {resolving && (
        <Popover
          open
          onOpenChange={(open) => {
            if (!open) setResolving(null)
          }}
        >
          <PopoverAnchor className="t2-resolution-anchor" />
          <ResolutionPopover
            tableId={table.id}
            entry={resolving.entry}
            links={resolving.links}
            onClose={() => setResolving(null)}
          />
        </Popover>
      )}
      <EditableGrid
        rows={rows}
        columns={columns}
        getRowId={(entry) => entry.id}
        readOnly={readOnly}
        phantom={{
          columnId: 'name',
          placeholder: 'Name an entry',
          onCreate: (name) => void addEntry(table.id, null, name),
        }}
      />
      {selected.size > 0 && (
        <div className="t2-selection-bar">
          <span className="t2-selection-bar__count">{selected.size} selected</span>
          <PromotePopover
            projectId={projectId}
            tableName={table.name}
            entryIds={[...selected]}
            onDone={() => setSelected(new Set())}
          />
          {/* Remove moved off the row into the selection bar (issue 084). It
              deletes every selected entry, routing any promoted one through the
              resolution flow above — never a silent cascade. */}
          <Button
            variant="command"
            className="t2-selection-bar__remove"
            onClick={() => void removeSelected()}
          >
            Remove
          </Button>
        </div>
      )}
    </section>
  )
}

function ResolutionPopover({
  tableId,
  entry,
  links,
  onClose,
}: {
  tableId: string
  entry: Tier2EntryRow
  links: EntryLink[]
  onClose: () => void
}) {
  const resolveKeep = useTier2Store((s) => s.resolveKeep)
  const resolveDeleteParams = useTier2Store((s) => s.resolveDeleteParams)
  const totalBound = links.reduce((sum, l) => sum + l.boundContextCount, 0)

  return (
    <PopoverContent align="end" sideOffset={4} className="t2-resolution">
      <p className="t2-resolution__copy">
        Delete <strong>{entry.name}</strong>? It is linked to {plural(links.length, 'parameter')}.
      </p>
      <div className="t2-resolution__actions">
        <Button
          variant="command"
          onClick={() => {
            void resolveKeep(tableId, entry.id).then(() => {
              useStatusStore.getState().announce(`Deleted ${entry.name} — parameter kept as unlinked copy`)
              onClose()
            })
          }}
        >
          Keep parameter as unlinked copy
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            void resolveDeleteParams(tableId, entry.id).then(() => {
              useStatusStore
                .getState()
                .announce(`Deleted ${entry.name} and its parameter — unbound ${plural(totalBound, 'context')}`)
              onClose()
            })
          }}
        >
          {totalBound > 0 ? `Delete parameter — unbinds ${plural(totalBound, 'context')}` : 'Delete parameter'}
        </Button>
      </div>
    </PopoverContent>
  )
}

function PromotePopover({
  projectId,
  tableName,
  entryIds,
  onDone,
}: {
  projectId: string
  tableName: string
  entryIds: string[]
  onDone: () => void
}) {
  const promote = useTier2Store((s) => s.promote)
  const linkByEntryId = useTier2Store((s) => s.linkByEntryId)
  const rootDimensions = useTier2Store((s) => s.rootDimensions)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [name, setName] = useState(tableName)
  const [dimId, setDimId] = useState<string | null>(rootDimensions[0]?.id ?? null)

  const unlinkedCount = entryIds.filter((id) => !linkByEntryId[id]).length
  const targetName = mode === 'new' ? name.trim() : (rootDimensions.find((d) => d.id === dimId)?.name ?? '')
  const canConfirm =
    unlinkedCount > 0 && (mode === 'new' ? name.trim().length > 0 : dimId !== null)

  async function confirm() {
    await promote({
      projectId,
      entryIds,
      target: mode === 'new' ? { kind: 'new', name: name.trim() } : { kind: 'existing', dimensionId: dimId as string },
    })
    useStatusStore.getState().announce(`${plural(unlinkedCount, 'parameter')} on ${targetName}`)
    setOpen(false)
    onDone()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="command" className="t2-promote-trigger">
          Use as dimension…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="t2-promote">
        <div className="t2-promote__modes">
          <Button
            variant="bare"
            className="t2-promote__mode"
            aria-pressed={mode === 'new'}
            onClick={() => setMode('new')}
          >
            New dimension
          </Button>
          <Button
            variant="bare"
            className="t2-promote__mode"
            aria-pressed={mode === 'existing'}
            disabled={rootDimensions.length === 0}
            onClick={() => setMode('existing')}
          >
            Extend existing
          </Button>
        </div>

        {mode === 'new' ? (
          <Input
            className="inplace-input t2-promote__name"
            aria-label="New dimension name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          <div className="t2-promote__dims">
            {rootDimensions.map((d) => (
              <Button
                key={d.id}
                variant="bare"
                className="t2-promote__dim"
                aria-pressed={dimId === d.id}
                onClick={() => setDimId(d.id)}
              >
                {d.name}
              </Button>
            ))}
          </div>
        )}

        <p className="t2-promote__preview">
          {unlinkedCount > 0
            ? `Creates ${plural(unlinkedCount, 'parameter')} on ${targetName || '…'}`
            : 'All selected entries are already linked'}
        </p>
        <Button
          variant="command"
          className="t2-promote__confirm"
          disabled={!canConfirm}
          onClick={() => void confirm()}
        >
          Promote
        </Button>
      </PopoverContent>
    </Popover>
  )
}
