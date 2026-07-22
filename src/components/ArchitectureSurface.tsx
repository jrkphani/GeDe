import { ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Tier2EntryRow, Tier2TableRow } from '../db/mutations'
import { buildEntryTree, flattenEntryTree } from '../domain/entryTree'
import { canWrite } from '../domain/workspaceRole'
import { useStatusStore } from '../store/status'
import { useTier2Store, type EntryLink } from '../store/tier2'
import { useWorkspaceRole } from '../store/workspace'
import { EditableGrid, type GridColumn } from './EditableGrid'
import {
  CHAIN_PHANTOM_ID,
  chainOrder,
  entryNameCell,
  firstEditableCell,
  lastEditablePosition,
  tableInId,
  tableOutId,
} from './gridBoundaryFocus'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { KeyHint } from './ui/key-hint'
import { EditableChainProvider, InlineEdit, PhantomInput, useEditableChain } from './ui/inline-editor'
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
    <>
      {/* 089 D2 P4 — the quick-jump used to portal into the ONE shared shell
          `.context-bar` slot; with three lanes co-mounted that jumbled it with
          Design's context groups. It now renders as this Architecture lane's OWN
          in-lane sticky header (.workspace__lane-header), leaving the shell slot
          to host only the focus-revealed D1 FormatStrip. */}
      <div className="workspace__lane-header">
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
      </div>

      <main className="architecture">
        <h2 className="tier2-header">2nd Tier · Architecture</h2>

        {/* Empty-state guidance (issue 084 finding 1): one orienting line so a
            first-run project is never a bare input with nothing actionable. The
            add-row it points to now trails the (empty) stack, below. */}
        {tables.length === 0 && !readOnly ? (
          <p className="t2-empty">
            No tables yet. Name your first dimension below — e.g. “Stakeholders”, “Value”.
          </p>
        ) : null}

        {/* Issue 084 Direction 3 P1/P2 — one outer chain threads the stacked
            tables plus the trailing add-table phantom. `order` is recomputed each
            render from live tables (mirrors DimensionManager). P2 registers each
            table's cross-table boundaries (`ChainedTablePanel`) and wires the
            grid's frozen `onExitBoundary` seam so Tab flows table→table→add-table
            and the add-table phantom continues into a freshly-created table. */}
        <EditableChainProvider order={chainOrder(tables)}>
          {tables.map((table) => (
            <ChainedTablePanel key={table.id} projectId={projectId} table={table} readOnly={readOnly} />
          ))}

          {/* Direction 3 fork 2 — the single create path is the chain's TERMINAL
              node: one typed add-table phantom as the LAST row of the surface (the
              top standalone add-row is gone; still one add grammar, finding 2).
              Enter creates + self-refocuses; Tab-with-content creates AND continues
              focus into the new table (P2). A viewer never sees this write-only
              affordance (issue 035). */}
          {readOnly ? null : <AddTablePhantom addTable={addTable} />}
        </EditableChainProvider>
      </main>
    </>
  )
}

// 084-D3 P2 — the cross-table chain adapter. Rendered per table INSIDE the outer
// EditableChainProvider so it can speak the chain; `TablePanel` itself stays
// chain-agnostic (WorkspaceCanvas reuses it under NO provider, driving the same
// `onExitBoundary` seam onto its own canvas traversal). This wrapper does two
// things: (1) registers this table's two boundary edges into the chain —
//   • `:in`  → its first editable cell (a forward advance from the PREVIOUS
//     table's `:out`, or the add-table continuation, lands here);
//   • `:out` → its add-entry phantom (a backward advance from the NEXT table's
//     `:in` lands here);
// and (2) wires the grid's FROZEN `onExitBoundary(dir)` to a cross-table advance.
// The DOM edges resolve lazily through the shared `gridBoundaryFocus` helpers,
// scoped to this table's `#t2-table-<id>` section (looked up by getElementById —
// never a DOM-reach focus query, finding 7), so a re-rendered/reordered grid is
// always current. Skipped entirely when read-only (no phantom, no editable
// cells → nothing to thread; issue 035).
function ChainedTablePanel({
  projectId,
  table,
  readOnly,
}: {
  projectId: string
  table: Tier2TableRow
  readOnly: boolean
}) {
  const chain = useEditableChain()

  useEffect(() => {
    if (!chain || readOnly) return
    const sectionEl = () => document.getElementById(`t2-table-${table.id}`)
    const focusFirst = () => {
      const s = sectionEl()
      if (s) firstEditableCell(s)?.focus()
    }
    const focusLast = () => {
      const s = sectionEl()
      if (s) lastEditablePosition(s)?.focus()
    }
    const unregisterIn = chain.register(tableInId(table.id), {
      focus: focusFirst,
      startEditing: focusFirst,
    })
    const unregisterOut = chain.register(tableOutId(table.id), { focus: focusLast })
    return () => {
      unregisterIn()
      unregisterOut()
    }
  }, [chain, table.id, readOnly])

  // Frozen seam (089-D3): forward off this table's add-entry phantom advances
  // right off its `:out` (→ next table's `:in`, or `t2phantom` for the last);
  // backward off its first cell advances left off its `:in` (→ previous table's
  // `:out`, or a no-op at the very first table). The chain's own advance is a
  // no-op past either end, so focus is never stranded.
  const onExitBoundary = useCallback(
    (dir: 'forward' | 'backward') => {
      if (!chain) return
      if (dir === 'forward') chain.advance(tableOutId(table.id), 'right')
      else chain.advance(tableInId(table.id), 'left')
    },
    [chain, table.id],
  )

  return (
    <TablePanel
      projectId={projectId}
      table={table}
      readOnly={readOnly}
      onExitBoundary={onExitBoundary}
      // Issue 084 D3 P5 — the normal Architecture surface teaches its grammar
      // with the quiet shortcut hints; the ?d3rf WorkspaceCanvas opts out.
      showKeyHints
    />
  )
}

// 084-D3 P2 — the chain's TERMINAL create node, inside the provider so it can
// continue focus into a freshly-created table. Enter still creates + self-
// refocuses (via `onSubmit`); Tab-with-content creates AND lands focus in the new
// (empty) table's first editable position — its own add-entry phantom — via
// `focusWhenReady`'s pending mechanism: the new table's `ChainedTablePanel`
// registers its `:in` on mount, and `register()` activates the pending target the
// moment it appears (mirrors DimensionManager's dim→param-phantom continuation
// across an async create — the create promise resolves after the store reload, so
// the target row may not exist yet when Tab fires).
function AddTablePhantom({
  addTable,
}: {
  addTable: (name: string) => Promise<Tier2TableRow | null>
}) {
  const chain = useEditableChain()
  return (
    <div className="t2-add-table">
      <span className="t2-add-table__glyph" aria-hidden>
        +
      </span>
      <PhantomInput
        placeholder="Name a table"
        ariaLabel="Add architecture table"
        inputClassName="t2-add-table__input"
        chainId={CHAIN_PHANTOM_ID}
        onSubmit={(name) => void addTable(name)}
        onTabSubmit={(name) =>
          void addTable(name).then((row) => {
            if (row && chain) chain.focusWhenReady(tableInId(row.id))
          })
        }
      />
      {/* Issue 084 D3 P5 — a quiet `⏎` hint that this write-only add-row commits
          on Enter. Decorative (aria-hidden), revealed on focus-within (base.css),
          absent at rest — mirrors the row-action reveal pattern. */}
      <KeyHint keys={['⏎']} />
    </div>
  )
}

// 089-D3 P3.2 — exported so the decomposed D3 canvas (WorkspaceCanvas, behind
// the dev-only `?d3rf` flag) can mount ONE real table per React Flow node while
// the normal (flag-off) ArchitectureSurface keeps rendering N of these stacked
// as paper panels. Identical rendering either way — the only additive seam is
// the optional `onExitBoundary`, forwarded to EditableGrid for D3's cross-node
// Tab (undefined here → byte-identical behavior for the normal surface).
export function TablePanel({
  projectId,
  table,
  readOnly,
  onExitBoundary,
  showKeyHints = false,
}: {
  projectId: string
  table: Tier2TableRow
  readOnly: boolean
  onExitBoundary?: (dir: 'forward' | 'backward') => void
  // Issue 084 D3 P5 — opt into the quiet keyboard-shortcut hints on the grid's
  // editing cells + add-entry phantom. The normal ArchitectureSurface passes
  // true (via ChainedTablePanel); the ?d3rf WorkspaceCanvas leaves it OFF, so
  // that decomposed canvas stays byte-identical.
  showKeyHints?: boolean
}) {
  const entries = useTier2Store((s) => s.entriesByTable[table.id] ?? NO_ENTRIES)
  const linkByEntryId = useTier2Store((s) => s.linkByEntryId)
  const renameTable = useTier2Store((s) => s.renameTable)
  const addEntry = useTier2Store((s) => s.addEntry)
  const renameEntry = useTier2Store((s) => s.renameEntry)
  const setEntryDescription = useTier2Store((s) => s.setEntryDescription)
  const removeEntry = useTier2Store((s) => s.removeEntry)
  const moveEntry = useTier2Store((s) => s.moveEntry)

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  // The row whose delete surfaced a linked-parameter resolution (never silent).
  const [resolving, setResolving] = useState<{ entry: Tier2EntryRow; links: EntryLink[] } | null>(
    null,
  )
  // The entry whose "Add child" opened a typed phantom (never a literal row).
  const [addingChildTo, setAddingChildTo] = useState<string | null>(null)

  // Issue 105 P1 — the entry AFTER which a keyboard "new sibling" series is
  // open. Pressing Enter in a committed name cell arms this: an inline phantom
  // (the SAME type-to-create PhantomInput as add-child, at the row's OWN depth)
  // appears under that row and creates siblings under its parent on type+Enter.
  // Nothing is persisted until a non-empty name is committed (no orphan empty
  // rows — issue 105 review HIGH 1), and PhantomInput's issue-069 submit guard
  // blocks a double-Enter double-create (HIGH 2). Mutually exclusive with
  // `addingChildTo` (arming one clears the other). The bottom add-entry phantom
  // is deliberately NOT coupled to this — it always creates top-level (HIGH 3).
  const [addingSiblingAfter, setAddingSiblingAfter] = useState<string | null>(null)

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

  // Issue 105 P2/P3 — keyboard tree verbs on the free modifier chords the grid
  // leaves inert (handleGridArrowKeys early-returns on Cmd/Ctrl/Alt): ⌘] demote
  // / ⌘[ promote / ⌥⇧↑↓ move-among-siblings. Architecture-SCOPED: this handler
  // lives on THIS surface's <section> (a bubbling keydown), never in the shared
  // EditableGrid — Design's register/rail and Foundation never see it. Acts only
  // on a resting-focused data cell (a real entry row); editing inputs/richtext
  // and the phantoms are excluded so typing ] or an arrow is never hijacked.
  function siblingsOfIn(parentId: string | null): Tier2EntryRow[] {
    return entries.filter((e) => e.parentId === parentId).sort((a, b) => a.sort - b.sort)
  }

  function runMove(id: string, newParentId: string | null, toIndex: number, message: string) {
    void moveEntry(table.id, id, newParentId, toIndex).then(() => {
      useStatusStore.getState().announce(message)
      const section = document.getElementById(`t2-table-${table.id}`)
      if (!section) return
      // The moved row re-renders at a new depth/position — re-plant focus on the
      // moved entry by id next frame (its old DOM node is gone), like the P1
      // gridBoundaryFocus deferral.
      requestAnimationFrame(() => entryNameCell(section, id)?.focus())
    })
  }

  function handleTreeKey(e: React.KeyboardEvent<HTMLElement>) {
    if (readOnly) return
    const demote = e.metaKey && !e.altKey && (e.key === ']' || e.code === 'BracketRight')
    const promote = e.metaKey && !e.altKey && (e.key === '[' || e.code === 'BracketLeft')
    const moveUp = e.altKey && e.shiftKey && !e.metaKey && e.key === 'ArrowUp'
    const moveDown = e.altKey && e.shiftKey && !e.metaKey && e.key === 'ArrowDown'
    if (!demote && !promote && !moveUp && !moveDown) return

    // Resting-focused only: ignore while a name/description editor (input,
    // textarea, contenteditable richtext) or a phantom holds focus.
    const target = e.target as HTMLElement
    if (
      target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA'
    ) {
      return
    }
    const rowEl = target.closest<HTMLElement>('tr[data-row-id]')
    const id = rowEl?.dataset.rowId
    if (!id) return
    const entry = entries.find((x) => x.id === id)
    if (!entry) return
    // A recognized chord on a real entry — own it (never let the browser act).
    e.preventDefault()
    // Ignore OS key-repeat (held chord): moveEntry is a multi-step async DB
    // mutation, so overlapping repeats could interleave against the un-transacted
    // moveTier2Entry and leave a sibling group with non-contiguous sort. One move
    // per physical press (review MEDIUM).
    if (e.repeat) return

    if (demote) {
      // Last child of the immediately-preceding VISIBLE sibling (same parent).
      const group = siblingsOfIn(entry.parentId)
      const idx = group.findIndex((x) => x.id === id)
      if (idx <= 0) return // first child → no preceding sibling → no-op
      const preceding = group[idx - 1] as Tier2EntryRow
      const toIndex = siblingsOfIn(preceding.id).length // append as last child
      runMove(id, preceding.id, toIndex, `Indented ${entry.name} under ${preceding.name}`)
      return
    }
    if (promote) {
      if (entry.parentId === null) return // top level → nothing to outdent to
      const parent = entries.find((x) => x.id === entry.parentId)
      if (!parent) return
      const grandParentId = parent.parentId
      const parentIdx = siblingsOfIn(grandParentId).findIndex((x) => x.id === parent.id)
      runMove(id, grandParentId, parentIdx + 1, `Outdented ${entry.name}`)
      return
    }
    // Move among siblings (⌥⇧↑ / ⌥⇧↓).
    const group = siblingsOfIn(entry.parentId)
    const idx = group.findIndex((x) => x.id === id)
    if (moveUp) {
      if (idx <= 0) return // already first → no-op
      runMove(id, entry.parentId, idx - 1, `Moved ${entry.name} up`)
    } else {
      if (idx === -1 || idx >= group.length - 1) return // already last → no-op
      runMove(id, entry.parentId, idx + 1, `Moved ${entry.name} down`)
    }
  }

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

  // Issue 084 D3 P3 / issue 105 P1 — the ONE inline typed-create phantom, in two
  // modes (mutually exclusive). ADD-CHILD (mouse, 084/104): a child under the
  // armed parent, one level deeper. ADD-SIBLING (keyboard, 105 P1): a sibling of
  // the edited row, at its OWN depth, under its parent. Both reuse the SAME
  // PhantomInput type-to-create primitive, so both inherit its two safety
  // properties for free: nothing is persisted until a non-empty name is
  // committed (no orphan empty rows — HIGH 1) and its issue-069 submit guard
  // blocks a double-Enter double-create (HIGH 2).
  interface InlinePhantom {
    afterRowId: string
    parentId: string | null
    depth: number
    placeholder: string
    dismiss: () => void
  }

  function activeInlinePhantom(): InlinePhantom | null {
    if (addingChildTo) {
      const parent = entries.find((e) => e.id === addingChildTo)
      if (!parent) return null
      return {
        afterRowId: addingChildTo,
        parentId: addingChildTo,
        depth: (metaById.get(addingChildTo)?.depth ?? 0) + 1,
        placeholder: `Name a child of ${parent.name}`,
        dismiss: () => setAddingChildTo(null),
      }
    }
    if (addingSiblingAfter) {
      const meta = metaById.get(addingSiblingAfter)
      if (!meta) return null
      const parentId = entries.find((e) => e.id === addingSiblingAfter)?.parentId ?? null
      const parent = parentId ? entries.find((e) => e.id === parentId) : null
      return {
        afterRowId: addingSiblingAfter,
        parentId,
        depth: meta.depth,
        placeholder: parent ? `Name a sibling under ${parent.name}` : 'Name a sibling',
        dismiss: () => setAddingSiblingAfter(null),
      }
    }
    return null
  }

  // The grid owns the <tr>/<td>; this fills the tree cell with a depth-indented
  // spacer (token-driven via the same `--depth` model as data rows — no raw px)
  // and the Name cell with a typed create input. Every other column is blank.
  function renderInlinePhantomCell(columnId: string, ph: InlinePhantom): React.ReactNode {
    if (columnId === 'tree') {
      return (
        <div className="t2-tree" data-depth={ph.depth} style={{ '--depth': ph.depth } as CSSProperties}>
          <span className="t2-chevron-spacer" />
        </div>
      )
    }
    if (columnId === 'name') {
      // Reuse the shared PhantomInput primitive (the layer-boundary rule's
      // sanctioned create control) in its EPHEMERAL mode: autofocus on arm,
      // Enter creates the named entry and CONTINUES (clears + self-refocuses for
      // the next one), Esc/blur dismiss. Named-on-create → no placeholder row, no
      // rename step. `stopPropagation` keeps the grid's own key grammar from also
      // seeing these keystrokes.
      return (
        <PhantomInput
          placeholder={ph.placeholder}
          ariaLabel={ph.placeholder}
          inputClassName="grid-cell__input t2-add-child__input"
          autoFocus
          stopPropagation
          onSubmit={(name) => void addEntry(table.id, ph.parentId, name)}
          onCancel={ph.dismiss}
          // Issue 104 Facet 3(a) — do NOT dismiss on blur: clicking another cell
          // must open THAT cell's editor (the grid's onDismiss handles teardown in
          // the same click), and a blur-dismiss would re-render the row away before
          // the click lands. Esc/onTab/edit-another-cell still dismiss.
          dismissOnBlur={false}
          // Issue 104 Facet 3(b) — grid-aware Tab: PhantomInput has already committed
          // the current name on a forward Tab; here we exit add mode and land focus on
          // the next grid position, using the SAME section-scoped helpers the
          // cross-table chain uses (finding 7 — never a global DOM-reach). Deferred a
          // frame so the phantom row (which shares the `.grid-row--phantom` class the
          // forward helper targets) has unmounted, leaving the table's own add-entry
          // phantom as the forward landing spot; Shift+Tab lands on the first editable
          // cell.
          onTab={(dir) => {
            const section = document.getElementById(`t2-table-${table.id}`)
            ph.dismiss()
            if (!section) return
            // Timing invariant (issue 104 edge review): the focus handoff MUST run
            // after React has committed the dismiss above (which unmounts this
            // `.grid-row--phantom` row). Tab is a discrete event, so React 18 flushes
            // that state update synchronously before paint — the next animation frame
            // is therefore guaranteed to observe the unmounted DOM, so
            // `lastEditablePosition` lands on the table's own add-entry phantom (not
            // this row) and `firstEditableCell` on the first real cell.
            requestAnimationFrame(() => {
              const target =
                dir === 'forward' ? lastEditablePosition(section) : firstEditableCell(section)
              target?.focus()
            })
          }}
        />
      )
    }
    return null
  }

  const inlinePhantom = activeInlinePhantom()

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
              // Finding 6 (STYLE_GUIDE §11): feed the depth to a --depth custom
              // property; base.css multiplies it by the --space-5 token. No raw
              // pixel literal and no inline calc lives in the component.
              style={{ '--depth': meta.depth } as CSSProperties}
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
                  a viewer (who can't promote) never sees the affordance.
                  084-D3 P4 (decision 4): the per-row control is a `role="option"`
                  in the panel's labeled `role="listbox"` (below), so an AT user
                  hears "selected"/"not selected" for the promote multi-select —
                  stronger semantics than the old `aria-pressed` toggle. Owned by
                  the listbox via `aria-owns` (the option lives in a grid cell, so
                  it can't be a DOM child of the listbox). */}
              {readOnly ? null : (
                <Button
                  variant="bare"
                  className="t2-select"
                  id={`t2-opt-${entry.id}`}
                  role="option"
                  aria-label={`Select ${entry.name}`}
                  aria-selected={isSelected}
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
      // Owner req ("indent child records"): the name cell is a targetable column
      // so its per-depth left inset (base.css .t2-col--name, keyed on the row's
      // --depth) makes a child's name step visibly right of its parent's — the
      // leading tree column alone only indents the chevron.
      cellClassName: 't2-col--name',
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
        // Issue 089 D1 Phase 5 — the entry description is now a rich cell
        // (Lexical), mirroring the justification column (P3). Same stored-string
        // value contract in/out; legacy plain strings still render and
        // wrap-on-edit. The global FormatStrip binds when this cell is focused.
        kind: 'richtext',
        placeholder: 'Add description…',
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
            <>
              {/* Typed add-child (issue 084 finding 4 / D3 P3): un-collapses the
                  parent then reveals an INLINE typed phantom child ROW directly
                  under it (at depth+1, via the grid's `inlineRow` seam below) —
                  type → Enter — instead of a floating popover or a literal
                  placeholder row the user must hunt down and rename. Same
                  type-first grammar as every other add on this surface, at a
                  lower interaction cost. */}
              <Button
                className="t2-add-child-trigger"
                aria-label={`Add child to ${entry.name}`}
                // Issue 105 P0 — a row COMMAND, never a form tab-stop. Native Tab
                // (now intercepted inside the description editor, above) must never
                // land here and arm an accidental sub-child; it stays a click/hover
                // affordance. The row-hover reveal + click are unchanged.
                tabIndex={-1}
                onClick={() => {
                  setCollapsed((prev) => {
                    const next = new Set(prev)
                    next.delete(entry.id)
                    return next
                  })
                  // Issue 105 (review fix) — arming add-child clears any armed
                  // sibling phantom, so mutual exclusivity is BIDIRECTIONAL (the
                  // Enter-sibling path already clears addingChildTo). Otherwise a
                  // stale sibling phantom would silently reappear once this
                  // add-child session is dismissed.
                  setAddingSiblingAfter(null)
                  setAddingChildTo(entry.id)
                }}
              >
                <span aria-hidden>＋ </span>Add child
              </Button>
              {/* Issue 105 P4 — quiet key-hint chips teaching the keyboard tree
                  grammar this surface added: ⏎ = new sibling (P1), ⌘] = make
                  child (P2 demote), ⌘[ = promote (P2). Reuses the 084-D3 P5
                  KeyHint pattern: decorative (aria-hidden — the real AT semantics
                  ride on the role="tree" overlay's aria-level/aria-expanded),
                  hidden at rest and revealed only on row hover/focus (base.css).
                  Gated by `showKeyHints` so the ?d3rf canvas (opts out) stays quiet. */}
              {showKeyHints ? (
                <span className="t2-row-hints">
                  <KeyHint keys={['⏎']} />
                  <KeyHint keys={['⌘', ']']} />
                  <KeyHint keys={['⌘', '[']} />
                </span>
              ) : null}
            </>
          ),
      },
    },
  ]

  return (
    <section
      className="panel t2-table t2-table--indent"
      id={`t2-table-${table.id}`}
      data-selecting={selected.size > 0 || undefined}
      // Issue 105 P2/P3 — Architecture-scoped keyboard tree verbs (⌘]/⌘[/⌥⇧↑↓).
      // A bubbling keydown on THIS surface's section only; the shared EditableGrid
      // (Design/Foundation) never carries it. handleTreeKey acts on a resting
      // data cell and no-ops otherwise, so grid nav/editing is unaffected.
      onKeyDown={handleTreeKey}
    >
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
        // Issue 084 D3 P5 — quiet keyboard-shortcut hints on the editing cells
        // (Tab →/Esc, ⌘⏎/Esc) + the add-entry phantom's focus-revealed ⏎. Off
        // for the ?d3rf canvas (WorkspaceCanvas never passes it).
        showKeyHints={showKeyHints}
        // Owner req ("indent child records"): carry each entry's tree depth to
        // the <tr> as the --depth custom property so the NAME cell (a column
        // separate from the leading tree/chevron cell) steps right per level —
        // reusing the SAME depth model .t2-tree already uses, no parallel system.
        // Depth 0 → 0 inset → flat/top-level rows and every non-tree grid
        // unchanged. No raw px (base.css multiplies by the --space-5 token).
        rowStyle={(entry) =>
          ({ '--depth': metaById.get(entry.id)?.depth ?? 0 }) as CSSProperties
        }
        phantom={{
          columnId: 'name',
          placeholder: 'Name an entry',
          // Issue 105 review HIGH 3 — the bottom add-entry phantom ALWAYS creates
          // top-level (parentId null). It is intentionally decoupled from the
          // keyboard Enter-series depth: a sibling series creates under
          // `parentIdOf(editedRow)` via the inline sibling phantom (below), never
          // through this shared persistent affordance.
          onCreate: (name) => void addEntry(table.id, null, name),
        }}
        // Issue 105 P1 — Architecture-scoped opt-in: Enter on a committed name
        // ARMS an inline "new sibling" phantom under that row, at its OWN depth
        // (parent = the edited row's parent). Only this surface passes the seam,
        // so the shared grid's default Enter=commit+down (Design register/rail,
        // Foundation) is untouched. The phantom (PhantomInput) creates on
        // type+Enter and continues — no orphan empty rows (HIGH 1), guarded
        // against double-Enter (HIGH 2). Mutually exclusive with add-child.
        onEnterCreateSibling={(rowId) => {
          setAddingChildTo(null)
          setAddingSiblingAfter(rowId)
        }}
        // Issue 105 review HIGH 4 — OPT-IN (Architecture only): the richtext
        // description cell's Tab commits + advances to the next editable cell
        // instead of falling through to native Tab (which armed a stray
        // sub-child). Design (ContextRegister) and Foundation richtext cells do
        // NOT set this, so their Tab stays native/byte-identical.
        richTextTabAdvances
        // Conditional spread (not `onExitBoundary={onExitBoundary}`) so the prop
        // is ABSENT — not `undefined` — for the normal surface, honoring
        // exactOptionalPropertyTypes and keeping EditableGrid byte-identical.
        {...(onExitBoundary ? { onExitBoundary } : {})}
        // Issue 084 D3 P3 / issue 105 P1 — the inline typed create phantom (add-
        // child OR add-sibling), a transient row rendered directly under its
        // anchor at the right depth, reusing the grid's tier-agnostic `inlineRow`
        // seam. Absent (nothing armed) → byte-identical to the normal grid;
        // spread conditionally so the prop is ABSENT, not `undefined`.
        {...(inlinePhantom
          ? {
              inlineRow: {
                afterRowId: inlinePhantom.afterRowId,
                className: 'grid-row--phantom t2-add-child-row',
                // Issue 104 Facet 3(a) — continuous, non-blocking: if the user
                // starts editing another cell while this phantom is up, the grid
                // dismisses it (whichever the user did LAST wins) instead of 102
                // blocking the edit. Arming while a cell is mid-edit is the reverse
                // case and stays suppressed by the grid (102 preserved).
                onDismiss: inlinePhantom.dismiss,
                // Match the phantom's depth on the row so its NAME input inherits
                // the same per-level indent as a real row. Same --depth model as
                // data rows (rowStyle above); no raw px.
                style: { '--depth': inlinePhantom.depth } as CSSProperties,
                cell: (columnId: string) => renderInlinePhantomCell(columnId, inlinePhantom),
              },
            }
          : {})}
      />
      {/* Issue 105 P4 — the tree a11y semantics the Architecture surface lacked.
          EditableGrid renders the entries as a native <table> (its <td> cells
          back the exact-name getByRole('cell') grammar the whole suite relies on),
          and putting aria-level/aria-expanded on a <tr> in a plain table is an
          axe `aria-conditional-attr` violation (those attrs need a treegrid row —
          and promoting to role="treegrid" would remap every <td>→gridcell). So we
          MIRROR the promote listbox pattern (below): a parallel, SR-only
          `role="tree"` of `role="treeitem"`s that carries the hierarchy to
          assistive tech — `aria-level` (= depth + 1) and, on parents,
          `aria-expanded` (true unless collapsed) — without touching the table's
          cell semantics. Only the VISIBLE (non-collapsed) rows appear, matching
          the flattened render, so a collapsed parent's descendants drop out and
          its `aria-expanded` reads false. Purely additive; present whenever there
          are entries (viewers benefit too). */}
      {flatIds.length > 0 && (
        <div role="tree" aria-label={`${table.name} entry tree`} className="visually-hidden">
          {flat.map((f) => (
            // Named via aria-label (NOT text content) — same as the promote
            // options ("Select X") — so the entry name isn't duplicated as a
            // second text node (which would break every getByText(name) lookup).
            <div
              key={f.entry.id}
              role="treeitem"
              aria-label={f.entry.name}
              aria-level={f.depth + 1}
              // aria-expanded only on rows that HAVE children (a leaf omits it);
              // true while expanded, false when this parent is collapsed.
              aria-expanded={f.hasChildren ? !collapsed.has(f.entry.id) : undefined}
            />
          ))}
        </div>
      )}
      {/* 084-D3 P4 (decision 4): the labeled listbox that OWNS the per-row
          `role="option"` select controls. The options live in grid cells (they
          can't be DOM children of the listbox — EditableGrid owns the table), so
          the listbox claims them via `aria-owns`. Visually-hidden anchor: the
          checkboxes render in the grid; this only carries the multi-select
          semantics + accessible name. Present whenever there is something to
          select (a viewer sees no options → no listbox). */}
      {!readOnly && flatIds.length > 0 && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={`Select ${table.name} entries to promote`}
          aria-owns={flatIds.map((id) => `t2-opt-${id}`).join(' ')}
          className="visually-hidden"
        />
      )}
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
              resolution flow above — never a silent cascade. 084-D3 P4
              (decision 8): the verb weight aligns to the Design route's QUIET
              `rowAction` (matching ParameterList's per-row Remove) — no
              `variant` prop → the primitive's default `rowAction`. The delete +
              resolution behavior is unchanged; only the chrome quiets. */}
          <Button
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
