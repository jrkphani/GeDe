import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type CellContext,
  type ColumnDef,
} from '@tanstack/react-table'
import { useEffect, useMemo, useRef, useState } from 'react'
import { plainTextToRichJson, richTextToPlainText, safeRichTextJson } from '../domain/richText'
import { Combobox, type ComboboxOption } from './ui/combobox'
import { RichTextEditor } from './ui/rich-text-editor'
import { Swatch } from './ui/swatch'

// ADR-0004: TanStack Table computes rows/columns; EditableGrid owns every
// <td> and implements the shared Numbers-style editing grammar once — text,
// mono (symbol chip) and combobox cells, dynamic columns, a phantom row.
// This component has zero knowledge of dimensions/contexts/tiers; callers
// supply getValue/onCommit closures (reused unchanged by tiers 1–2, 013–014).

// Re-exported so existing callers keep importing the option shape from here;
// the picker itself now lives in ui/combobox (shared with the composer, 010).
export type { ComboboxOption }

export interface TextCellKind<TRow> {
  kind: 'text'
  getValue: (row: TRow) => string
  onCommit: (row: TRow, value: string) => Promise<boolean> | void
  // Issue 084 — an optional read-mode adornment rendered inline immediately
  // after the value text (e.g. a "→ dimension" source badge). Never shown
  // while the cell is being edited. Additive: omit → identical to before, so
  // every other table (tier1/tier3) is unaffected.
  adornment?: (row: TRow) => React.ReactNode
}

export interface MonoCellKind<TRow> {
  kind: 'mono'
  getValue: (row: TRow) => string
  onCommit: (row: TRow, value: string) => Promise<boolean> | void
}

export interface ComboboxCellKind<TRow> {
  kind: 'combobox'
  getValue: (row: TRow) => string | null
  getOptions: (row: TRow) => ComboboxOption[]
  onCommit: (row: TRow, value: string | null) => Promise<boolean> | void
}

export interface StaticCellKind<TRow> {
  kind: 'static'
  render: (row: TRow) => React.ReactNode
}

export interface MultilineCellKind<TRow> {
  kind: 'multiline'
  getValue: (row: TRow) => string
  onCommit: (row: TRow, value: string) => Promise<boolean> | void
}

// Issue 089 D1 Phase 3 — a rich-text cell (Lexical). Same value contract as
// multiline (a stored string in, a stored string out) but the string is
// Lexical JSON once written, OR a legacy plain string on a not-yet-converted
// row (pre-P4 that's every row) — RichTextCell renders both, see seedRichValue.
export interface RichTextCellKind<TRow> {
  kind: 'richtext'
  getValue: (row: TRow) => string
  onCommit: (row: TRow, value: string) => Promise<boolean> | void
  // Ghost text shown when the cell is empty (089 D1 blocker 3). Per-column so a
  // Foundation/Architecture *description* cell no longer inherits the
  // justification column's "Add justification…" ghost.
  placeholder: string
}

export type GridCellKind<TRow> =
  | TextCellKind<TRow>
  | MonoCellKind<TRow>
  | ComboboxCellKind<TRow>
  | StaticCellKind<TRow>
  | MultilineCellKind<TRow>
  | RichTextCellKind<TRow>

export interface GridColumn<TRow> {
  id: string
  header: string
  cell: GridCellKind<TRow>
  headClassName?: string
  cellClassName?: string
}

export interface PhantomConfig {
  columnId: string
  placeholder: string
  onCreate: (value: string) => void
}

export interface EditableGridProps<TRow> {
  rows: TRow[]
  columns: GridColumn<TRow>[]
  getRowId: (row: TRow) => string
  phantom?: PhantomConfig
  rowClassName?: (row: TRow) => string | undefined
  // Issue 021 — a11y: callers supply a short row identity (e.g. the context
  // symbol) so every cell/editor gets an accessible name of the shape
  // "{column header} for {row label}" (e.g. "Justification for α"). When
  // omitted the name is the bare column header.
  getRowLabel?: (row: TRow) => string | undefined
  // Issue 009 — fires on any click within the row, alongside whatever that
  // cell's own click does (e.g. entering edit mode); callers use this for
  // "select this row" gestures without EditableGrid knowing what selection is.
  onRowClick?: (row: TRow) => void
  // Issue 085 Phase B, Decision 3 — selection state must be non-color-only
  // (STYLE_GUIDE §10): `rowClassName`'s selected class already draws the left
  // rule; this feeds the matching `aria-selected` so it isn't a visual-only
  // signal. EditableGrid stays agnostic of what "selected" means — the caller
  // supplies the predicate, same shape as `rowClassName`.
  isRowSelected?: (row: TRow) => boolean
  // Issue 035 — viewer-role affordance: every cell renders its display state
  // only (no click-to-edit, no keyboard editing grammar) and the phantom row
  // never renders, regardless of whether `phantom` is passed. Defaults to
  // false so every existing caller is unchanged.
  readOnly?: boolean
  // Issue 038 (presence) — fires with the cell currently open for editing, or
  // null when none is. Covers text/mono/multiline cells only (the shared
  // `editing` state below); a combobox cell's open/closed state is owned
  // internally by ComboboxCell and isn't wired to this signal in this slice —
  // see ContextRegister's own comment for why that's a deliberate, flagged
  // scope cut rather than an oversight. Optional and additive: omitting it is
  // exactly the pre-038 behavior.
  onEditingChange?: (cell: EditingCell | null) => void
}

export const PHANTOM_ROW_ID = '__phantom__'

export interface EditingCell {
  rowId: string
  columnId: string
}

// Minimal shape the pure boundary helper needs — a subset of NavContext so
// `nextEditableCell` is unit-testable without a DOM/React (issue 022).
export interface GridNav {
  rowIds: string[]
  columnIds: string[]
  columnKindById: Record<string, GridCellKind<unknown>['kind']>
  phantomColumnId: string | null
  // Issue 035 — optional so existing `nextEditableCell` unit-test fixtures
  // (which predate this) keep compiling unchanged; treated as `false` when absent.
  readOnly?: boolean
}

interface NavContext extends GridNav {
  refs: React.RefObject<Map<string, HTMLElement>>
  editing: EditingCell | null
  setEditing: (cell: EditingCell | null) => void
  // Issue 022 — commit-then-move: focus (and, for text cells, open for editing)
  // the given target, or safely no-op onto `from` when the target is null so
  // focus is never stranded on <body>.
  advance: (target: EditingCell | null, fromRowId: string, fromColumnId: string) => void
  // Tab from the phantom row: create the row (via the phantom's onCreate) and,
  // once it materializes, open its next editable cell for editing — so Tab
  // continues across a brand-new record (Numbers/Excel grammar) instead of
  // dead-ending on the phantom's single column.
  createFromPhantom: (columnId: string, value: string) => void
}

// TanStack's `meta` is read at render time inside the (stable) cell renderer
// below — unlike baking column config into a per-render closure, a changing
// `meta` reference does NOT change the cell's component identity, so React
// never remounts it. (A per-render closure passed as `columnDef.cell` DOES
// change identity every render — flexRender treats it as a distinct
// component type and remounts the subtree, which silently kills anything
// with its own open/closed state, like a combobox popover mid-click.)
declare module '@tanstack/react-table' {
  interface TableMeta<TData> {
    columnsById: Record<string, GridColumn<TData>>
    nav: NavContext
    getRowId: (row: TData) => string
    getRowLabel?: ((row: TData) => string | undefined) | undefined
  }
}

function cellKey(rowId: string, columnId: string): string {
  return `${rowId}:${columnId}`
}

function focusCell(nav: NavContext, rowId: string, columnId: string): void {
  nav.refs.current.get(cellKey(rowId, columnId))?.focus()
}

// Is there an editable control at (rowId, columnId)? Static columns have none;
// the phantom row only renders its single configured column.
function isEditableCell(nav: GridNav, rowId: string, columnId: string): boolean {
  if (nav.readOnly) return false
  if (rowId === PHANTOM_ROW_ID) return columnId === nav.phantomColumnId
  const kind = nav.columnKindById[columnId]
  return kind !== undefined && kind !== 'static'
}

// Pure boundary resolver (issue 022): the next editable cell in `dir`, skipping
// static columns and honoring phantom-row availability. Tab/Shift+Tab wrap
// across rows (and into the phantom row); Enter/up walk the column. Returns
// null when there is no editable target (caller keeps focus put, never <body>).
export function nextEditableCell(
  nav: GridNav,
  rowId: string,
  columnId: string,
  dir: 'right' | 'left' | 'down' | 'up',
): EditingCell | null {
  const rIdx = nav.rowIds.indexOf(rowId)
  const cIdx = nav.columnIds.indexOf(columnId)
  if (rIdx === -1 || cIdx === -1) return null

  if (dir === 'down' || dir === 'up') {
    const step = dir === 'down' ? 1 : -1
    for (let r = rIdx + step; r >= 0 && r < nav.rowIds.length; r += step) {
      const rid = nav.rowIds[r] as string
      if (isEditableCell(nav, rid, columnId)) return { rowId: rid, columnId }
    }
    return null
  }

  const step = dir === 'right' ? 1 : -1
  // Remaining columns in the current row.
  for (let c = cIdx + step; c >= 0 && c < nav.columnIds.length; c += step) {
    const cid = nav.columnIds[c] as string
    if (isEditableCell(nav, rowId, cid)) return { rowId, columnId: cid }
  }
  // Wrap to the next/previous row, entering from its first/last editable cell.
  for (let r = rIdx + step; r >= 0 && r < nav.rowIds.length; r += step) {
    const rid = nav.rowIds[r] as string
    const start = dir === 'right' ? 0 : nav.columnIds.length - 1
    for (let c = start; c >= 0 && c < nav.columnIds.length; c += step) {
      const cid = nav.columnIds[c] as string
      if (isEditableCell(nav, rid, cid)) return { rowId: rid, columnId: cid }
    }
  }
  return null
}

// Arrow keys navigate the grid when a cell is focused but not editing — kept
// separate from Tab (handled while editing) and from Cmd-modified keys (never
// shadow the global keymap, SITEMAP §4).
function handleGridArrowKeys(e: React.KeyboardEvent, nav: NavContext, rowId: string, columnId: string): void {
  if (nav.editing || e.metaKey || e.ctrlKey || e.altKey) return
  const rowIdx = nav.rowIds.indexOf(rowId)
  const colIdx = nav.columnIds.indexOf(columnId)
  if (e.key === 'ArrowDown' && nav.rowIds[rowIdx + 1]) {
    e.preventDefault()
    focusCell(nav, nav.rowIds[rowIdx + 1] as string, columnId)
  } else if (e.key === 'ArrowUp' && rowIdx > 0) {
    e.preventDefault()
    focusCell(nav, nav.rowIds[rowIdx - 1] as string, columnId)
  } else if (e.key === 'ArrowRight' && nav.columnIds[colIdx + 1]) {
    e.preventDefault()
    focusCell(nav, rowId, nav.columnIds[colIdx + 1] as string)
  } else if (e.key === 'ArrowLeft' && colIdx > 0) {
    e.preventDefault()
    focusCell(nav, rowId, nav.columnIds[colIdx - 1] as string)
  }
}

function registerRef(nav: NavContext, rowId: string, columnId: string) {
  return (el: HTMLElement | null) => {
    const map = nav.refs.current
    if (el) map.set(cellKey(rowId, columnId), el)
    else map.delete(cellKey(rowId, columnId))
  }
}

function TextOrMonoCell<TRow>({
  row,
  rowId,
  columnId,
  cellDef,
  nav,
  mono,
  name,
}: {
  row: TRow
  rowId: string
  columnId: string
  cellDef: TextCellKind<TRow> | MonoCellKind<TRow>
  nav: NavContext
  mono: boolean
  name: string
}) {
  const value = cellDef.getValue(row)
  // Only text cells carry an adornment; a mono cell never does. Rendered in the
  // read-mode branches below, never while editing (issue 084).
  const adornment = cellDef.kind === 'text' ? cellDef.adornment : undefined
  const editing = !nav.readOnly && nav.editing?.rowId === rowId && nav.editing.columnId === columnId
  const [draft, setDraft] = useState(value)
  const cancelling = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  async function commitAndAdvance(next: string, target: EditingCell | null) {
    if (next !== value) {
      const ok = await cellDef.onCommit(row, next)
      if (ok === false) setDraft(value) // rejected: revert to the last-known-good value
    }
    nav.advance(target, rowId, columnId)
  }

  // Issue 035 — a read-only cell never becomes a click/keyboard target at all
  // (no tabIndex, no handlers), so it can never enter `editing` in the first
  // place; this is a static display, not merely a disabled input.
  if (nav.readOnly) {
    return (
      <div className={`grid-cell${mono ? ' grid-cell--mono' : ''}`} aria-label={value ? undefined : `${name}, empty`}>
        {value || (
          <span className="grid-cell__placeholder" aria-hidden="true">
            —
          </span>
        )}
        {adornment?.(row)}
      </div>
    )
  }

  if (editing) {
    return (
      <input
        ref={registerRef(nav, rowId, columnId)}
        className={`inplace-input grid-cell__input${mono ? ' grid-cell__input--mono' : ''}`}
        aria-label={name}
        autoFocus
        onFocus={(e) => e.target.select()}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void commitAndAdvance(draft.trim(), nextEditableCell(nav, rowId, columnId, 'down'))
          } else if (e.key === 'Tab') {
            e.preventDefault()
            void commitAndAdvance(draft.trim(), nextEditableCell(nav, rowId, columnId, e.shiftKey ? 'left' : 'right'))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelling.current = true
            setDraft(value)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        onBlur={() => {
          if (cancelling.current) {
            cancelling.current = false
            nav.setEditing(null)
            return
          }
          void commitAndAdvance(draft.trim(), null)
        }}
      />
    )
  }

  return (
    <div
      ref={registerRef(nav, rowId, columnId)}
      className={`grid-cell${mono ? ' grid-cell--mono' : ''}`}
      // A non-empty cell's name is its own text (the column is announced via the
      // scoped <th>); an empty cell has only the aria-hidden em-dash, so it
      // needs an explicit name that states the column and its empty state (021).
      aria-label={value ? undefined : `${name}, empty`}
      tabIndex={0}
      onClick={() => nav.setEditing({ rowId, columnId })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          nav.setEditing({ rowId, columnId })
        }
        handleGridArrowKeys(e, nav, rowId, columnId)
      }}
    >
      {value || <span className="grid-cell__placeholder" aria-hidden="true">—</span>}
      {adornment?.(row)}
    </div>
  )
}

// The one sanctioned row-height exception (STYLE_GUIDE §6, issue 005): the
// justification cell grows to fit while editing instead of clipping.
function MultilineCell<TRow>({
  row,
  rowId,
  columnId,
  cellDef,
  nav,
  name,
}: {
  row: TRow
  rowId: string
  columnId: string
  cellDef: MultilineCellKind<TRow>
  nav: NavContext
  name: string
}) {
  const value = cellDef.getValue(row)
  const editing = !nav.readOnly && nav.editing?.rowId === rowId && nav.editing.columnId === columnId
  const [draft, setDraft] = useState(value)
  const cancelling = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  useEffect(() => {
    const el = textareaRef.current
    if (editing && el) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [editing, draft])

  async function commitAndAdvance(next: string, target: EditingCell | null) {
    if (next !== value) {
      const ok = await cellDef.onCommit(row, next)
      if (ok === false) setDraft(value)
    }
    nav.advance(target, rowId, columnId)
  }

  // Issue 035 — same read-only short-circuit as TextOrMonoCell.
  if (nav.readOnly) {
    return (
      <div
        className="grid-cell grid-cell--multiline"
        aria-label={value ? undefined : `${name}, empty`}
        title={value || undefined}
      >
        {value ? (
          <span className="grid-cell__clamp">{value}</span>
        ) : (
          <span className="grid-cell__placeholder" aria-hidden="true">
            —
          </span>
        )}
      </div>
    )
  }

  if (editing) {
    return (
      <textarea
        ref={(el) => {
          textareaRef.current = el
          registerRef(nav, rowId, columnId)(el)
        }}
        className="inplace-input grid-cell__input grid-cell__input--multiline"
        aria-label={name}
        rows={1}
        autoFocus
        onFocus={(e) => e.target.select()}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            // Shift+Enter inserts a newline (native); plain Enter commits + advances.
            e.preventDefault()
            void commitAndAdvance(draft.trim(), nextEditableCell(nav, rowId, columnId, 'down'))
          } else if (e.key === 'Tab') {
            e.preventDefault()
            void commitAndAdvance(draft.trim(), nextEditableCell(nav, rowId, columnId, e.shiftKey ? 'left' : 'right'))
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelling.current = true
            setDraft(value)
            ;(e.target as HTMLTextAreaElement).blur()
          }
        }}
        onBlur={() => {
          if (cancelling.current) {
            cancelling.current = false
            nav.setEditing(null)
            return
          }
          void commitAndAdvance(draft.trim(), null)
        }}
      />
    )
  }

  return (
    <div
      ref={registerRef(nav, rowId, columnId)}
      className="grid-cell grid-cell--multiline"
      aria-label={value ? undefined : `${name}, empty`}
      tabIndex={0}
      title={value || undefined}
      onClick={() => nav.setEditing({ rowId, columnId })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          nav.setEditing({ rowId, columnId })
        }
        handleGridArrowKeys(e, nav, rowId, columnId)
      }}
    >
      {value ? (
        <span className="grid-cell__clamp">{value}</span>
      ) : (
        <span className="grid-cell__placeholder" aria-hidden="true">—</span>
      )}
    </div>
  )
}

// A richtext cell stores EITHER Lexical JSON (a converted cell) or a legacy
// plain string (not yet converted — pre-P4 that's every cell). The read-mode
// display always projects to plain text (richTextToPlainText, correct on both
// shapes). The live editor needs a value Lexical can hydrate: valid JSON passes
// through; a legacy plain string is wrapped as a single paragraph so it shows
// (only re-persisted if the user actually edits and commits — the editor is
// unmounted while the cell is merely viewed); an empty cell seeds null (an
// empty editor) so a focus+blur with no edit can't spuriously commit an
// empty-paragraph doc over a null.
function seedRichValue(stored: string): string | null {
  if (stored === '') return null
  if (stored.trimStart().startsWith('{')) {
    const safe = safeRichTextJson(stored)
    if (safe !== null) return safe
  }
  return plainTextToRichJson(stored)
}

// Issue 089 D1 Phase 3 — the rich-text justification cell. Modeled on
// MultilineCell (click-to-swap: a clamped read-mode display becomes a live
// editor on click/Enter), but the editor is RichTextEditor — an always-live
// Lexical contentEditable. The Numbers-grammar conflict (Enter=paragraph,
// Tab=indent) is resolved by keeping Tab/arrow traversal on the read-mode
// display and moving commit to Cmd/Ctrl+Enter inside the editor (the seam in
// rich-text-editor.tsx). The global FormatStrip (089 D1 P1) binds to this
// editor when it is focused, via the focused-editor registry.
function RichTextCell<TRow>({
  row,
  rowId,
  columnId,
  cellDef,
  nav,
  name,
}: {
  row: TRow
  rowId: string
  columnId: string
  cellDef: RichTextCellKind<TRow>
  nav: NavContext
  name: string
}) {
  const stored = cellDef.getValue(row)
  const editing = !nav.readOnly && nav.editing?.rowId === rowId && nav.editing.columnId === columnId
  const displayRef = useRef<HTMLDivElement | null>(null)
  const refocusDisplay = useRef(false)
  // The plain projection is both the read-mode text and the em-dash/empty test;
  // it never throws on a legacy string or malformed JSON (richText.ts).
  const plain = richTextToPlainText(stored)

  // After Esc collapses the editor back to read mode, land focus on the display
  // element (never stranded on <body>) so the Tab/arrow grammar resumes.
  useEffect(() => {
    if (!editing && refocusDisplay.current) {
      refocusDisplay.current = false
      displayRef.current?.focus()
    }
  }, [editing])

  // Issue 035 — same read-only short-circuit as MultilineCell: a static,
  // clamped display, no click-to-edit and no live editor.
  if (nav.readOnly) {
    return (
      <div
        className="grid-cell grid-cell--multiline"
        aria-label={plain ? undefined : `${name}, empty`}
        title={plain || undefined}
      >
        {plain ? (
          <span className="grid-cell__clamp">{plain}</span>
        ) : (
          <span className="grid-cell__placeholder" aria-hidden="true">
            —
          </span>
        )}
      </div>
    )
  }

  if (editing) {
    return (
      <div className="grid-cell grid-cell--richtext" ref={registerRef(nav, rowId, columnId)}>
        <RichTextEditor
          value={seedRichValue(stored)}
          namespace={`gede-justification-${rowId}`}
          ariaLabel={name}
          placeholder={cellDef.placeholder}
          autoFocus
          onCommit={(next) => {
            void cellDef.onCommit(row, next ?? '')
          }}
          onCommitAndAdvance={() =>
            nav.advance(nextEditableCell(nav, rowId, columnId, 'down'), rowId, columnId)
          }
          onEscape={() => {
            refocusDisplay.current = true
            nav.setEditing(null)
          }}
        />
      </div>
    )
  }

  return (
    <div
      ref={(el) => {
        displayRef.current = el
        registerRef(nav, rowId, columnId)(el)
      }}
      className="grid-cell grid-cell--multiline"
      aria-label={plain ? undefined : `${name}, empty`}
      tabIndex={0}
      title={plain || undefined}
      onClick={() => nav.setEditing({ rowId, columnId })}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          nav.setEditing({ rowId, columnId })
        }
        handleGridArrowKeys(e, nav, rowId, columnId)
      }}
    >
      {plain ? (
        <span className="grid-cell__clamp">{plain}</span>
      ) : (
        <span className="grid-cell__placeholder" aria-hidden="true">—</span>
      )}
    </div>
  )
}

function ComboboxCell<TRow>({
  row,
  rowId,
  columnId,
  cellDef,
  nav,
  name,
}: {
  row: TRow
  rowId: string
  columnId: string
  cellDef: ComboboxCellKind<TRow>
  nav: NavContext
  name: string
}) {
  const [open, setOpen] = useState(false)
  const value = cellDef.getValue(row)
  const options = cellDef.getOptions(row)
  const selected = options.find((o) => o.value === value)

  // Issue 035 — same read-only short-circuit as the other cell kinds: no
  // trigger button at all, just the current selection's display.
  if (nav.readOnly) {
    return (
      <div className="grid-cell grid-cell--combobox" aria-label={`${name}: ${selected ? selected.label : 'unset'}`}>
        {selected ? (
          <>
            <Swatch color={selected.color} />
            {selected.label}
          </>
        ) : (
          <span className="grid-cell__placeholder" aria-hidden="true">
            —
          </span>
        )}
      </div>
    )
  }

  return (
    <Combobox
      value={value}
      options={options}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        nav.setEditing(next ? { rowId, columnId } : null)
      }}
      onChange={(next) => {
        void cellDef.onCommit(row, next)
        // Selecting a value advances down the column into edit mode (issue 022).
        nav.advance(nextEditableCell(nav, rowId, columnId, 'down'), rowId, columnId)
      }}
      trigger={
        <button
          ref={registerRef(nav, rowId, columnId)}
          type="button"
          className="grid-cell grid-cell--combobox"
          aria-label={`${name}: ${selected ? selected.label : 'unset'}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              setOpen(true)
            } else if (e.key === 'Tab') {
              // Tab commits nothing here (selection commits on pick) and moves
              // to the next editable cell, landing on it in edit mode.
              e.preventDefault()
              nav.advance(nextEditableCell(nav, rowId, columnId, e.shiftKey ? 'left' : 'right'), rowId, columnId)
            }
            handleGridArrowKeys(e, nav, rowId, columnId)
          }}
        >
          {selected ? (
            <>
              <Swatch color={selected.color} />
              {selected.label}
            </>
          ) : (
            <span className="grid-cell__placeholder" aria-hidden="true">—</span>
          )}
        </button>
      }
    />
  )
}

function PhantomCell({
  columnId,
  config,
  nav,
}: {
  columnId: string
  config: PhantomConfig
  nav: NavContext
}) {
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLInputElement>(null)

  return (
    <input
      ref={(el) => {
        ref.current = el
        registerRef(nav, PHANTOM_ROW_ID, columnId)(el)
      }}
      className="inplace-input grid-cell__input"
      aria-label={config.placeholder}
      placeholder={config.placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && draft.trim()) {
          config.onCreate(draft.trim())
          setDraft('')
          ref.current?.focus()
        } else if (e.key === 'Tab') {
          if (e.shiftKey) {
            // Go back up to the previous row's last editable cell.
            e.preventDefault()
            nav.advance(nextEditableCell(nav, PHANTOM_ROW_ID, columnId, 'left'), PHANTOM_ROW_ID, columnId)
          } else if (draft.trim()) {
            // Forward Tab with content: create the row and continue into its
            // next editable cell (Numbers/Excel grammar across a new record).
            e.preventDefault()
            nav.createFromPhantom(columnId, draft.trim())
            setDraft('')
          }
          // Empty phantom + forward Tab: let native Tab move focus out of the
          // grid rather than trapping the user on an empty phantom cell.
        }
        if (e.key === 'Escape') setDraft('')
        handleGridArrowKeys(e, nav, PHANTOM_ROW_ID, columnId)
      }}
    />
  )
}

// A single stable function reference used as `columnDef.cell` for every
// column — see the TableMeta note above for why this must never be
// recreated per render.
function renderGridCell<TRow>(info: CellContext<TRow, unknown>) {
  const meta = info.table.options.meta as {
    columnsById: Record<string, GridColumn<TRow>>
    nav: NavContext
    getRowId: (row: TRow) => string
    getRowLabel?: (row: TRow) => string | undefined
  }
  const col = meta.columnsById[info.column.id] as GridColumn<TRow>
  const row = info.row.original
  const rowId = meta.getRowId(row)

  if (col.cell.kind === 'static') return col.cell.render(row)

  // Accessible name: "{column header} for {row label}" (issue 021).
  const rowLabel = meta.getRowLabel?.(row)
  const name = rowLabel ? `${col.header} for ${rowLabel}` : col.header

  if (col.cell.kind === 'combobox') {
    return <ComboboxCell row={row} rowId={rowId} columnId={col.id} cellDef={col.cell} nav={meta.nav} name={name} />
  }
  if (col.cell.kind === 'multiline') {
    return <MultilineCell row={row} rowId={rowId} columnId={col.id} cellDef={col.cell} nav={meta.nav} name={name} />
  }
  if (col.cell.kind === 'richtext') {
    return <RichTextCell row={row} rowId={rowId} columnId={col.id} cellDef={col.cell} nav={meta.nav} name={name} />
  }
  return (
    <TextOrMonoCell
      row={row}
      rowId={rowId}
      columnId={col.id}
      cellDef={col.cell}
      nav={meta.nav}
      mono={col.cell.kind === 'mono'}
      name={name}
    />
  )
}

export function EditableGrid<TRow>({
  rows,
  columns,
  getRowId,
  phantom,
  rowClassName,
  getRowLabel,
  onRowClick,
  isRowSelected,
  readOnly = false,
  onEditingChange,
}: EditableGridProps<TRow>) {
  // Issue 035 — a read-only grid never shows the phantom row, regardless of
  // what the caller passed; callers don't need their own conditional.
  const activePhantom = readOnly ? undefined : phantom
  const [editing, setEditing] = useState<EditingCell | null>(null)

  // Issue 038 — the presence seam: report every open/close of the shared
  // `editing` state to whoever asked. A plain effect (not folded into
  // `setEditing` calls directly) so every path that changes `editing` — the
  // grammar's several call sites below — stays a single source of truth.
  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])

  const refs = useRef<Map<string, HTMLElement>>(new Map())
  // A queued focus target (issue 022): set by `advance` when the destination is
  // an always-mounted control (combobox trigger, phantom input) or a stay-put
  // no-op — text/mono/multiline editors self-focus via autoFocus on mount.
  const pendingFocus = useRef<EditingCell | null>(null)
  // Tab-across-a-new-row (issue 022 refinement): the phantom column Tab was
  // pressed from; the effect below opens the freshly-created row's next
  // editable cell once that row appears in `rows`.
  const pendingPhantomEdit = useRef<string | null>(null)
  const prevRowIdsRef = useRef<string[]>([])
  const rowIds = rows.map(getRowId)
  const allRowIds = activePhantom ? [...rowIds, PHANTOM_ROW_ID] : rowIds
  const columnIds = columns.map((c) => c.id)
  const columnKindById = Object.fromEntries(columns.map((c) => [c.id, c.cell.kind]))

  const nav: NavContext = {
    rowIds: allRowIds,
    columnIds,
    columnKindById,
    phantomColumnId: activePhantom?.columnId ?? null,
    readOnly,
    refs,
    editing,
    setEditing,
    advance: (target, fromRowId, fromColumnId) => {
      if (target && target.rowId !== PHANTOM_ROW_ID && columnKindById[target.columnId] !== 'combobox') {
        // Text/mono/multiline editor: mount it in edit mode; autoFocus lands us.
        setEditing(target)
        return
      }
      // Combobox trigger, phantom input, or a stay-put no-op (null): focus an
      // already-rendered element after the editor unmounts, never <body>.
      pendingFocus.current = target ?? { rowId: fromRowId, columnId: fromColumnId }
      setEditing(null)
    },
    createFromPhantom: (columnId, value) => {
      pendingPhantomEdit.current = columnId
      activePhantom?.onCreate(value)
    },
  }
  const columnSignature = columns.map((c) => `${c.id}:${c.header}:${c.headClassName ?? ''}`).join('|')

  // After any render, honor a queued focus target (see `pendingFocus`). Runs
  // every render; a null target is a cheap no-op.
  useEffect(() => {
    const target = pendingFocus.current
    if (target) {
      pendingFocus.current = null
      focusCell(nav, target.rowId, target.columnId)
    }
  })

  // Once a Tab-created phantom row appears in `rows`, open its next editable
  // cell for editing (the Description after the Name, etc.); if the phantom's
  // column is the row's last editable one, fall back to the phantom for the
  // next entry. Diffed against the previous render's ids so we edit the row
  // that was just added, not a pre-existing one.
  useEffect(() => {
    const column = pendingPhantomEdit.current
    if (column) {
      const previous = new Set(prevRowIdsRef.current)
      const createdId = rowIds.find((id) => !previous.has(id))
      if (createdId) {
        pendingPhantomEdit.current = null
        const target = nextEditableCell(nav, createdId, column, 'right')
        if (target) setEditing(target)
        else focusCell(nav, PHANTOM_ROW_ID, column)
      }
    }
    prevRowIdsRef.current = rowIds
  })

  // The ColumnDef skeleton only depends on shape (id/header), never on the
  // per-render getValue/onCommit closures — those are looked up through
  // `meta` at render time by the stable `renderGridCell`.
  const tanstackColumns = useMemo<ColumnDef<TRow>[]>(
    () => columns.map((col) => ({ id: col.id, header: col.header, cell: renderGridCell<TRow> })),
    // Keyed on the shape signature, not the `columns` array identity (new every
    // render) — rebuilding the ColumnDefs would remount cells. Intentional
    // (see the flexRender note above); reviewed (issue 020).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columnSignature],
  )

  const table = useReactTable({
    data: rows,
    columns: tanstackColumns,
    getCoreRowModel: getCoreRowModel(),
    meta: {
      columnsById: Object.fromEntries(columns.map((c) => [c.id, c])),
      nav,
      getRowId,
      getRowLabel,
    },
  })

  return (
    <div className="register-scroll">
      <table className="editable-grid">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header, i) => (
                <th key={header.id} scope="col" className={columns[i]?.headClassName}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row, rowIndex) => {
            // Issue 024 — zebra parity on data rows only (the phantom row is an
            // affordance, not data, so it must not stripe); selection/hover win
            // over the zebra tint via CSS specificity.
            const classes = [rowClassName?.(row.original), rowIndex % 2 === 1 ? 'grid-row--zebra' : undefined]
              .filter((c): c is string => Boolean(c))
              .join(' ')
            return (
              <tr
                key={row.id}
                className={classes || undefined}
                data-row-id={getRowId(row.original)}
                aria-selected={isRowSelected?.(row.original) ?? undefined}
                onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              >
                {row.getVisibleCells().map((cell, i) => (
                  <td key={cell.id} className={columns[i]?.cellClassName}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            )
          })}
          {activePhantom && (
            <tr className="grid-row--phantom">
              {columns.map((col) =>
                col.id === activePhantom.columnId ? (
                  <td key={col.id}>
                    <PhantomCell columnId={col.id} config={activePhantom} nav={nav} />
                  </td>
                ) : (
                  <td key={col.id} />
                ),
              )}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
