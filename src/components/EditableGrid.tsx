import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type CellContext,
  type ColumnDef,
} from '@tanstack/react-table'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Swatch } from './ui/swatch'

// ADR-0004: TanStack Table computes rows/columns; EditableGrid owns every
// <td> and implements the shared Numbers-style editing grammar once — text,
// mono (symbol chip) and combobox cells, dynamic columns, a phantom row.
// This component has zero knowledge of dimensions/contexts/tiers; callers
// supply getValue/onCommit closures (reused unchanged by tiers 1–2, 013–014).

export interface ComboboxOption {
  value: string
  label: string
  color?: string
}

export interface TextCellKind<TRow> {
  kind: 'text'
  getValue: (row: TRow) => string
  onCommit: (row: TRow, value: string) => Promise<boolean> | void
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

export type GridCellKind<TRow> =
  | TextCellKind<TRow>
  | MonoCellKind<TRow>
  | ComboboxCellKind<TRow>
  | StaticCellKind<TRow>

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
}

const PHANTOM_ROW_ID = '__phantom__'

interface EditingCell {
  rowId: string
  columnId: string
}

interface NavContext {
  rowIds: string[]
  columnIds: string[]
  refs: React.RefObject<Map<string, HTMLElement>>
  editing: EditingCell | null
  setEditing: (cell: EditingCell | null) => void
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
  }
}

function cellKey(rowId: string, columnId: string): string {
  return `${rowId}:${columnId}`
}

function focusCell(nav: NavContext, rowId: string, columnId: string): void {
  nav.refs.current?.get(cellKey(rowId, columnId))?.focus()
}

function moveFocusDown(nav: NavContext, rowId: string, columnId: string): void {
  const idx = nav.rowIds.indexOf(rowId)
  const nextRowId = nav.rowIds[idx + 1]
  if (nextRowId) focusCell(nav, nextRowId, columnId)
}

// Arrow keys navigate the grid when a cell is focused but not editing — kept
// separate from Tab (native DOM order already traverses cells) and from
// Cmd-modified keys (never shadow the global keymap, SITEMAP §4).
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
    if (!map) return
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
}: {
  row: TRow
  rowId: string
  columnId: string
  cellDef: TextCellKind<TRow> | MonoCellKind<TRow>
  nav: NavContext
  mono: boolean
}) {
  const value = cellDef.getValue(row)
  const editing = nav.editing?.rowId === rowId && nav.editing.columnId === columnId
  const [draft, setDraft] = useState(value)
  const cancelling = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  async function commit(next: string, andMoveDown: boolean) {
    if (next !== value) {
      const ok = await cellDef.onCommit(row, next)
      if (ok === false) setDraft(value) // rejected: revert to the last-known-good value
    }
    nav.setEditing(null)
    if (andMoveDown) moveFocusDown(nav, rowId, columnId)
  }

  if (editing) {
    return (
      <input
        ref={registerRef(nav, rowId, columnId) as React.Ref<HTMLInputElement>}
        className={`inplace-input grid-cell__input${mono ? ' grid-cell__input--mono' : ''}`}
        autoFocus
        onFocus={(e) => e.target.select()}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit(draft.trim(), true)
          }
          if (e.key === 'Escape') {
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
          void commit(draft.trim(), false)
        }}
      />
    )
  }

  return (
    <div
      ref={registerRef(nav, rowId, columnId)}
      className={`grid-cell${mono ? ' grid-cell--mono' : ''}`}
      role="gridcell"
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
      {value || <span className="grid-cell__placeholder">—</span>}
    </div>
  )
}

function ComboboxCell<TRow>({
  row,
  rowId,
  columnId,
  cellDef,
  nav,
}: {
  row: TRow
  rowId: string
  columnId: string
  cellDef: ComboboxCellKind<TRow>
  nav: NavContext
}) {
  const [open, setOpen] = useState(false)
  const value = cellDef.getValue(row)
  const options = cellDef.getOptions(row)
  const selected = options.find((o) => o.value === value)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        nav.setEditing(next ? { rowId, columnId } : null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={registerRef(nav, rowId, columnId) as React.Ref<HTMLButtonElement>}
          type="button"
          className="grid-cell grid-cell--combobox"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              setOpen(true)
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
            <span className="grid-cell__placeholder">—</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="combobox-popover" align="start" sideOffset={2}>
        <Command loop>
          <CommandInput autoFocus placeholder="Type to filter…" />
          <CommandList>
            <CommandEmpty>No match</CommandEmpty>
            {value !== null && (
              <CommandItem
                value="__unbind__"
                onSelect={() => {
                  void cellDef.onCommit(row, null)
                  setOpen(false)
                  moveFocusDown(nav, rowId, columnId)
                }}
              >
                <span className="grid-cell__placeholder">— clear —</span>
              </CommandItem>
            )}
            {options.map((opt) => (
              <CommandItem
                key={opt.value}
                value={opt.label}
                onSelect={() => {
                  void cellDef.onCommit(row, opt.value)
                  setOpen(false)
                  moveFocusDown(nav, rowId, columnId)
                }}
              >
                <Swatch color={opt.color} />
                {opt.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
      placeholder={config.placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && draft.trim()) {
          config.onCreate(draft.trim())
          setDraft('')
          ref.current?.focus()
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
  }
  const col = meta.columnsById[info.column.id] as GridColumn<TRow>
  const row = info.row.original
  const rowId = meta.getRowId(row)

  if (col.cell.kind === 'static') return col.cell.render(row)
  if (col.cell.kind === 'combobox') {
    return <ComboboxCell row={row} rowId={rowId} columnId={col.id} cellDef={col.cell} nav={meta.nav} />
  }
  return (
    <TextOrMonoCell
      row={row}
      rowId={rowId}
      columnId={col.id}
      cellDef={col.cell}
      nav={meta.nav}
      mono={col.cell.kind === 'mono'}
    />
  )
}

export function EditableGrid<TRow>({
  rows,
  columns,
  getRowId,
  phantom,
  rowClassName,
}: EditableGridProps<TRow>) {
  const [editing, setEditing] = useState<EditingCell | null>(null)
  const refs = useRef<Map<string, HTMLElement>>(new Map())
  const rowIds = rows.map(getRowId)
  const allRowIds = phantom ? [...rowIds, PHANTOM_ROW_ID] : rowIds
  const columnIds = columns.map((c) => c.id)
  const nav: NavContext = { rowIds: allRowIds, columnIds, refs, editing, setEditing }
  const columnSignature = columns.map((c) => `${c.id}:${c.header}:${c.headClassName ?? ''}`).join('|')

  // The ColumnDef skeleton only depends on shape (id/header), never on the
  // per-render getValue/onCommit closures — those are looked up through
  // `meta` at render time by the stable `renderGridCell`.
  const tanstackColumns = useMemo<ColumnDef<TRow>[]>(
    () => columns.map((col) => ({ id: col.id, header: col.header, cell: renderGridCell<TRow> })),
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
    },
  })

  return (
    <div className="register-scroll">
      <table className="editable-grid">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header, i) => (
                <th key={header.id} className={columns[i]?.headClassName}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className={rowClassName?.(row.original)}>
              {row.getVisibleCells().map((cell, i) => (
                <td key={cell.id} className={columns[i]?.cellClassName}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
          {phantom && (
            <tr className="grid-row--phantom">
              {columns.map((col) =>
                col.id === phantom.columnId ? (
                  <td key={col.id}>
                    <PhantomCell columnId={col.id} config={phantom} nav={nav} />
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
