import clsx from 'clsx';
import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  cellText,
  columnLetter,
  LATTICE,
  rowMeta,
  TABLE_HEADER_ROWS,
  TABLE_TITLE_ROWS,
  tableAddresses,
  tableRecord,
  type Id,
  type PresenceState,
  type TableMap,
} from '@gede/core';
import { Icon } from '@gede/ui';

import type { ZoomTier } from '../../doc/viewport.js';
import { useYVersion } from '../../doc/use-y.js';
import type { CellSelection } from './selection.js';

export interface TableViewProps {
  table: TableMap;
  tier: ZoomTier;
  selected: boolean;
  selectedCell: CellSelection | null;
  editingCell: CellSelection | null;
  /** RESP-02 / SHARE-03: no edit affordance renders when false. */
  editable: boolean;
  /** Other participants' selections on this table (SHARE-04). */
  presence: readonly PresenceState[];
  onSelectCell: (cell: CellSelection) => void;
  onSelectTable: (tableId: Id) => void;
  onEditCell: (cell: CellSelection | null) => void;
  onCommitCell: (cell: CellSelection, text: string) => void;
  onClearCell: (cell: CellSelection) => void;
  onAddRow: (tableId: Id) => void;
  onAddColumn: (tableId: Id) => void;
}

const TITLE_PX = TABLE_TITLE_ROWS * LATTICE.row;
const HEADER_PX = TABLE_HEADER_ROWS * LATTICE.row;

/**
 * One table on the lattice (DOM-first). Geometry is absolute: the title bar is
 * two lattice rows, the header one, every data row one (two when wrapped) and
 * every column `width` units wide. Nothing here reflows at a breakpoint
 * (RESP-01) — the viewport pans over it.
 */
export const TableView = memo(function TableView({
  table,
  tier,
  selected,
  selectedCell,
  editingCell,
  editable,
  presence,
  onSelectCell,
  onSelectTable,
  onEditCell,
  onCommitCell,
  onClearCell,
  onAddRow,
  onAddColumn,
}: TableViewProps) {
  useYVersion(table);
  const record = tableRecord(table);
  const widthPx = record.columns.reduce((acc, c) => acc + c.width, 0) * LATTICE.col;
  const rowHeights = record.rows.map((rowId) => rowMeta(table, rowId).height);
  const bodyPx = rowHeights.reduce((a, b) => a + b, 0) * LATTICE.row;
  const addresses = tier === 'micro' ? tableAddresses(table) : null;
  const style: CSSProperties = {
    left: `${String(record.gridCol * LATTICE.col)}px`,
    top: `${String(record.gridRow * LATTICE.row)}px`,
    width: `${String(widthPx)}px`,
  };
  const showAffordances = editable && selected;

  let colOffset = 0;
  const columnStarts = record.columns.map((c) => {
    const start = colOffset;
    colOffset += c.width;
    return start;
  });

  const presenceByCell = new Map<string, PresenceState>();
  for (const p of presence) {
    if (p.cell?.tableId === record.id) presenceByCell.set(`${p.cell.rowId}:${p.cell.colId}`, p);
  }

  return (
    <section
      className={clsx('gd-table', `gd-table--${tier}`, { 'gd-table--selected': selected })}
      style={style}
      aria-label={record.title}
      data-table-id={record.id}
    >
      <header
        className="gd-table__title"
        style={{ height: `${String(TITLE_PX)}px` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelectTable(record.id);
        }}
      >
        <span className="gd-table__title-text">{record.title}</span>
        <span className="gd-mono gd-table__degree" aria-hidden="true">
          {columnLetter(record.gridCol)}
          {record.gridRow + 1}
        </span>
      </header>

      {tier === 'macro' ? (
        <div
          className="gd-table__block"
          style={{ height: `${String(HEADER_PX + bodyPx)}px` }}
          aria-hidden="true"
        />
      ) : (
        <div
          className="gd-table__grid"
          role="grid"
          aria-label={record.title}
          aria-rowcount={record.rows.length + 1}
          aria-colcount={record.columns.length}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
        >
          <div
            className="gd-table__row gd-table__row--header"
            role="row"
            style={{ height: `${String(HEADER_PX)}px` }}
          >
            {record.columns.map((col, ci) => (
              <div
                key={col.id}
                role="columnheader"
                className="gd-table__header"
                style={{ width: `${String(col.width * LATTICE.col)}px` }}
                title={col.label}
              >
                <span className="gd-table__header-label">{col.label}</span>
                <span
                  className="gd-mono gd-table__letter"
                  aria-label={`Column ${columnLetter(record.gridCol + (columnStarts[ci] ?? 0))}`}
                >
                  {columnLetter(record.gridCol + (columnStarts[ci] ?? 0))}
                </span>
              </div>
            ))}
          </div>
          {record.rows.map((rowId, ri) => {
            const heightPx = (rowHeights[ri] ?? 1) * LATTICE.row;
            return (
              <div
                key={rowId}
                className="gd-table__row"
                role="row"
                style={{ height: `${String(heightPx)}px` }}
              >
                {record.columns.map((col, ci) => {
                  const isSelected =
                    selectedCell !== null &&
                    selectedCell.tableId === record.id &&
                    selectedCell.rowId === rowId &&
                    selectedCell.colId === col.id;
                  const isEditing =
                    editingCell !== null &&
                    editingCell.tableId === record.id &&
                    editingCell.rowId === rowId &&
                    editingCell.colId === col.id;
                  const other = presenceByCell.get(`${rowId}:${col.id}`);
                  const address = addresses?.[ri]?.[ci];
                  const cell = { tableId: record.id, rowId, colId: col.id };
                  return (
                    <Cell
                      key={col.id}
                      table={table}
                      cell={cell}
                      widthPx={col.width * LATTICE.col}
                      tier={tier}
                      address={address}
                      selected={isSelected}
                      editing={isEditing}
                      editable={editable}
                      other={other}
                      onSelect={onSelectCell}
                      onEdit={onEditCell}
                      onCommit={onCommitCell}
                      onClear={onClearCell}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {showAffordances && tier !== 'macro' && (
        <>
          {/* GRID-07: one lattice unit beneath the last row. */}
          <button
            type="button"
            className="gd-table__add-row"
            style={{ height: `${String(LATTICE.row)}px` }}
            onClick={() => {
              onAddRow(record.id);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            title="Add a row beneath the last row (⌥⌘↓)"
            aria-label={`Add row to ${record.title}`}
          >
            <Icon name="add-row" size={13} /> Add row
          </button>
          {/* GRID-07: one lattice unit at the right edge, level with the header. */}
          <button
            type="button"
            className="gd-table__add-column"
            style={{
              left: `${String(widthPx)}px`,
              top: `${String(TITLE_PX)}px`,
              width: `${String(LATTICE.col)}px`,
              height: `${String(LATTICE.row)}px`,
            }}
            onClick={() => {
              onAddColumn(record.id);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            title="Add a column at the right edge (⌥⌘→)"
            aria-label={`Add column to ${record.title}`}
          >
            <Icon name="add-column" size={13} /> Add column
          </button>
        </>
      )}
    </section>
  );
});

interface CellProps {
  table: TableMap;
  cell: CellSelection;
  widthPx: number;
  tier: ZoomTier;
  address: string | undefined;
  selected: boolean;
  editing: boolean;
  editable: boolean;
  other: PresenceState | undefined;
  onSelect: (cell: CellSelection) => void;
  onEdit: (cell: CellSelection | null) => void;
  onCommit: (cell: CellSelection, text: string) => void;
  onClear: (cell: CellSelection) => void;
}

function Cell({
  table,
  cell,
  widthPx,
  tier,
  address,
  selected,
  editing,
  editable,
  other,
  onSelect,
  onEdit,
  onCommit,
  onClear,
}: CellProps) {
  const text = tier === 'micro' ? cellText(table, cell.rowId, cell.colId) : '';
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && !editing) ref.current?.focus({ preventScroll: true });
  }, [selected, editing]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return; // I18N-01
    if (e.code === 'Enter' && editable) {
      e.preventDefault();
      onEdit(cell);
    } else if ((e.code === 'Delete' || e.code === 'Backspace') && editable) {
      e.preventDefault();
      onClear(cell);
    }
  };

  const presenceStyle =
    other === undefined
      ? undefined
      : ({ '--gd-presence': `var(--presence-${String(other.colour)})` } as CSSProperties);

  return (
    <div
      ref={ref}
      role="gridcell"
      tabIndex={selected ? 0 : -1}
      aria-selected={selected || undefined}
      aria-label={address === undefined ? undefined : `${address}${text === '' ? '' : `, ${text}`}`}
      className={clsx('gd-cell', {
        'gd-cell--selected': selected,
        'gd-cell--editing': editing,
        'gd-cell--presence': other !== undefined,
      })}
      style={{ width: `${String(widthPx)}px`, ...presenceStyle }}
      title={tier === 'micro' && !editing ? text : undefined}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect(cell);
      }}
      onDoubleClick={() => {
        if (editable) onEdit(cell);
      }}
      onKeyDown={onKeyDown}
      data-address={address}
    >
      {editing && editable ? (
        <CellEditor
          initial={text}
          address={address}
          onCommit={(value) => {
            onCommit(cell, value);
            onEdit(null);
          }}
          onCancel={() => {
            onEdit(null);
          }}
        />
      ) : (
        tier === 'micro' && <span className="gd-cell__text">{text}</span>
      )}
      {other !== undefined && (
        <span className="gd-cell__presence-tag" aria-label={`${other.name} is here`}>
          {other.name}
        </span>
      )}
    </div>
  );
}

interface CellEditorProps {
  initial: string;
  address: string | undefined;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Wave 1 editor: plain text. Enter commits, Escape cancels, blur commits; none
 * of them fire mid-composition (GRID-06, I18N-01). Rich text arrives in Wave 2.
 */
function CellEditor({ initial, address, onCommit, onCancel }: CellEditorProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="gd-cell__editor"
      aria-label={address === undefined ? 'Cell' : `Edit ${address}`}
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
      }}
      onKeyDown={(e) => {
        // I18N-01: `keyCode === 229` is the legacy IME signal some engines still send.
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by the IME contract
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (e.code === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          finish(true);
        } else if (e.code === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.code === 'Tab') {
          e.preventDefault();
          finish(true);
        }
      }}
      onBlur={() => {
        finish(true);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
      spellCheck={false}
    />
  );
}
