import clsx from 'clsx';
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  cellFormatFor,
  cellFragment,
  cellRich,
  columnLetter,
  distributeUnits,
  LATTICE,
  rowHeights as effectiveRowHeights,
  rowMeta,
  rowReadOnlyReason,
  TABLE_TITLE_ROWS,
  tableAddresses,
  tableOutline,
  tableRecord,
  tableWraps,
  WRAPPED_ROW_HEIGHT,
  EMPTY_DOC,
  plainText,
  richFromText,
  type ColumnRecord,
  type FormatLocale,
  type Id,
  type OutlineRow,
  type PresenceState,
  type ReadOnlyReason,
  type TableMap,
  type TableOutline,
  type TableRecord,
} from '@gede/core';
import { Icon } from '@gede/ui';
import type * as Y from 'yjs';

import { announce } from '../../announce.js';
import { ARIA_KEYS } from '../../doc/shortcuts.js';
import type { ZoomTier } from '../../doc/viewport.js';
import { useYVersion } from '../../doc/use-y.js';
import {
  nextCell,
  type CellSelection,
  type Direction,
  type Editing,
  type TraversalTable,
} from '../../doc/selection.js';
import { CellContent, layoutCell, RichCellEditor, toFormatLocale } from './cell/index.js';
import { useLocale } from '../../locale.js';
import {
  FormulaCell,
  insertClickedAddress,
  isFormulaInput,
  projectSource,
} from './formula/index.js'; // wave2/formulas
import { readOnlyLabel, type GridCommands } from './grid/commands.js';
import { HIER_ARIA_KEYS, hierarchyKey } from './grid/hier-keys.js';
import { frozenColumns as frozenColumnsOf } from './grid/pinned.js';
import { ColumnDivider, CornerHandle } from './grid/ResizeHandle.js';
import type { GridActions } from './grid/use-grid.js';

export interface TableViewProps {
  table: TableMap;
  tier: ZoomTier;
  selected: boolean;
  selectedCell: CellSelection | null;
  editing: Editing | null;
  /** RESP-02 / SHARE-03: no edit affordance renders when false. */
  editable: boolean;
  /** Other participants' selections on this table (SHARE-04). */
  presence: readonly PresenceState[];
  /**
   * GRID-10: canvas-pixel offset from the table's left edge at which the pinned
   * panel carrying the frozen columns sits, or null when none is due
   * (`grid/pinned.ts`).
   */
  pinnedLeft: number | null;
  /**
   * The document's undo manager (KEYS-03): the rich editor writes through it so
   * an edit session is one step, inside the editor and after commit alike.
   */
  undo?: Y.UndoManager | null | undefined;
  actions: GridActions;
  commands: GridCommands;
}

const TITLE_PX = TABLE_TITLE_ROWS * LATTICE.row;
const HEADER_PX = LATTICE.row;
const FOOTER_PX = LATTICE.row;

interface ColumnPreview {
  colId: Id;
  units: number;
}
interface TablePreview {
  widthUnits: number;
  wrapped: boolean;
}

/**
 * One table on the lattice (DOM-first). Geometry is absolute: the title bar is
 * two lattice rows, the header one (or none, GRID-11), every data row one (two
 * when wrapped, GRID-09), the footer strip one, and every visible column
 * `width` units wide; a hidden column is not drawn (GRID-02). Nothing here
 * reflows at a breakpoint (RESP-01) — the viewport pans over it.
 */
export const TableView = memo(function TableView({
  table,
  tier,
  selected,
  selectedCell,
  editing,
  editable,
  presence,
  pinnedLeft,
  undo,
  actions,
  commands,
}: TableViewProps) {
  useYVersion(table);
  const [activeLocale] = useLocale();
  const locale = toFormatLocale(activeLocale);
  const record = tableRecord(table);
  const ref = useRef<HTMLElement>(null);
  const [columnPreview, setColumnPreview] = useState<ColumnPreview | null>(null);
  const [tablePreview, setTablePreview] = useState<TablePreview | null>(null);

  // Visible columns with the width each renders at (a drag previews before it commits).
  const visible = record.columns.filter((c) => !c.hidden);
  const storedWidths = visible.map((c) => c.width);
  const previewWidths =
    tablePreview === null ? storedWidths : distributeUnits(storedWidths, tablePreview.widthUnits);
  const widthUnitsOf = (colId: Id, i: number): number =>
    columnPreview?.colId === colId ? columnPreview.units : (previewWidths[i] ?? 1);
  const columnUnits = visible.map((c, i) => widthUnitsOf(c.id, i));
  const widthPx =
    Math.max(
      1,
      columnUnits.reduce((a, b) => a + b, 0),
    ) * LATTICE.col;
  const storedHeights = effectiveRowHeights(table, record);
  const rowHeights =
    tablePreview === null
      ? storedHeights
      : storedHeights.map((h) =>
          tablePreview.wrapped || tableWraps(record) ? WRAPPED_ROW_HEIGHT : Math.min(h, 1),
        );
  const bodyPx = rowHeights.reduce((a, b) => a + b, 0) * LATTICE.row;
  const allWrapped =
    storedHeights.length > 0 && storedHeights.every((h) => h === WRAPPED_ROW_HEIGHT);
  const addresses = tier === 'micro' ? tableAddresses(table) : null;
  const headerPx = record.headerRows === 1 ? HEADER_PX : 0;
  const footerPx = record.footerRows === 1 ? FOOTER_PX : 0;
  const style: CSSProperties = {
    left: `${String(record.gridCol * LATTICE.col)}px`,
    top: `${String(record.gridRow * LATTICE.row)}px`,
    width: `${String(widthPx)}px`,
  };
  const showAffordances = editable && selected && tier !== 'macro';

  let colOffset = 0;
  const columnStarts = visible.map((_c, i) => {
    const start = colOffset;
    colOffset += columnUnits[i] ?? 1;
    return start;
  });
  const frozenIds = new Set(frozenColumnsOf(record).map((c) => c.id));
  const freezeEdgeId =
    record.frozenColumns > 0
      ? (visible.filter((c) => frozenIds.has(c.id)).at(-1)?.id ?? null)
      : null;
  const traversal: TraversalTable = {
    rows: record.rows,
    columns: record.columns.map((c) => ({ id: c.id, hidden: c.hidden })),
  };
  // GRID-04: the read-only reason is a column fact (source) or a row fact (group band);
  // resolve each once per render rather than re-reading the Yjs column array per cell.
  const columnOrdinal = new Map<Id, number>(record.columns.map((c, i) => [c.id, i]));
  const columnReadOnly = new Map<Id, ReadOnlyReason | null>(
    record.columns.map((c) => [c.id, c.source === 'entered' ? null : c.source]),
  );
  // One rowMeta read per row: the row-level read-only reason (GRID-04: a category
  // band; HIER-07: a split child) and the row's own wrap (GRID-09).
  const rowFacts = (rowId: Id): { readOnly: ReadOnlyReason | null; wrapped: boolean } => {
    const meta = rowMeta(table, rowId);
    return { readOnly: rowReadOnlyReason(meta), wrapped: meta.height === WRAPPED_ROW_HEIGHT };
  };
  // HIER-04..08: the outline, once per render. Rows under a collapsed parent are
  // not drawn at all (HIER-06); while the table is grouped the outline column
  // shows no depth, though the data keeps it (HIER-08).
  const outline = tableOutline(table, record);
  const showOutline = !outline.grouped && outline.column !== null;
  // Ordinal among the rows that render, per row: `aria-rowindex` counts what is in the grid.
  let drawn = 0;
  const visibleOrdinals = outline.rows.map((r) => (r.hidden ? -1 : drawn++));
  const visibleRowCount = drawn;

  // M8: with nothing selected in this table, its first cell is the tab stop (roving tabindex).
  const tableHasSelection = selectedCell !== null && selectedCell.tableId === record.id;
  const presenceByCell = new Map<string, PresenceState>();
  for (const p of presence) {
    if (p.cell?.tableId === record.id) presenceByCell.set(`${p.cell.rowId}:${p.cell.colId}`, p);
  }

  /** Screen px per canvas px right now: the layer's zoom, read off the element itself. */
  const scale = useCallback(() => {
    const el = ref.current;
    if (el === null || el.offsetWidth === 0) return 1;
    const width = el.getBoundingClientRect().width;
    return width === 0 ? 1 : width / el.offsetWidth;
  }, []);

  const rowCount = record.rows.length;
  const columnCount = visible.length;

  return (
    <section
      ref={ref}
      className={clsx('gd-table', `gd-table--${tier}`, {
        'gd-table--selected': selected,
        'gd-table--resizing': columnPreview !== null || tablePreview !== null,
      })}
      style={style}
      aria-label={record.title}
      data-table-id={record.id}
      data-frozen-columns={record.frozenColumns}
    >
      <header
        className="gd-table__title"
        style={{ height: `${String(TITLE_PX)}px` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          actions.selectTable(record.id);
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
          style={{ height: `${String(headerPx + bodyPx + footerPx)}px` }}
          aria-hidden="true"
        />
      ) : (
        <>
          <div
            className="gd-table__grid"
            role="grid"
            aria-label={record.title}
            aria-rowcount={visibleRowCount + record.headerRows}
            aria-colcount={columnCount}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
          >
            {record.headerRows === 1 && (
              <div
                className="gd-table__row gd-table__row--header"
                role="row"
                style={{ height: `${String(HEADER_PX)}px` }}
              >
                {visible.map((col, ci) => {
                  const units = columnUnits[ci] ?? 1;
                  const letter = columnLetter(record.gridCol + (columnStarts[ci] ?? 0));
                  return (
                    <div
                      key={col.id}
                      role="columnheader"
                      className={clsx('gd-table__header', {
                        'gd-table__header--frozen': frozenIds.has(col.id),
                        'gd-table__header--freeze-edge': col.id === freezeEdgeId,
                      })}
                      style={{ width: `${String(units * LATTICE.col)}px` }}
                      title={col.label}
                      data-col-id={col.id}
                    >
                      <span className="gd-table__header-label">{col.label}</span>
                      <span className="gd-mono gd-table__letter" aria-label={`Column ${letter}`}>
                        {letter}
                      </span>
                      {editable && (
                        <ColumnDivider
                          label={col.label}
                          units={col.width}
                          tabStop={
                            selectedCell?.tableId === record.id && selectedCell.colId === col.id
                          }
                          scale={scale}
                          onPreview={(preview) => {
                            setColumnPreview(
                              preview === null ? null : { colId: col.id, units: preview },
                            );
                          }}
                          onCommit={(next) => {
                            commands.setColumnWidth(record.id, col.id, next);
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {record.rows.map((rowId, ri) => {
              // The outline has one entry per row; a missing one cannot happen, but a row
              // that is not drawn must not be drawn.
              const outlineRow = outline.rows[ri];
              if (outlineRow === undefined || outlineRow.hidden) return null; // HIER-06
              const heightPx = (rowHeights[ri] ?? 1) * LATTICE.row;
              const { readOnly: rowReadOnly, wrapped: rowWrapped } = rowFacts(rowId);
              const parentRow = showOutline && outlineRow.hasChildren;
              return (
                <div
                  key={rowId}
                  className="gd-table__row"
                  role="row"
                  aria-rowindex={(visibleOrdinals[ri] ?? 0) + 1 + record.headerRows}
                  aria-level={showOutline ? outlineRow.depth + 1 : undefined}
                  aria-expanded={parentRow ? !outlineRow.collapsed : undefined}
                  style={{ height: `${String(heightPx)}px` }}
                  data-depth={showOutline ? outlineRow.depth : undefined}
                >
                  {visible.map((col, ci) => {
                    const isSelected =
                      selectedCell !== null &&
                      selectedCell.tableId === record.id &&
                      selectedCell.rowId === rowId &&
                      selectedCell.colId === col.id;
                    const isEditing =
                      editing !== null &&
                      editing.cell.tableId === record.id &&
                      editing.cell.rowId === rowId &&
                      editing.cell.colId === col.id;
                    const other = presenceByCell.get(`${rowId}:${col.id}`);
                    const address = addresses?.[ri]?.[columnOrdinal.get(col.id) ?? -1] ?? undefined;
                    const cell = { tableId: record.id, rowId, colId: col.id };
                    // Column source wins over the row reason, as `cellReadOnlyReason` in core.
                    const readOnly: ReadOnlyReason | null =
                      columnReadOnly.get(col.id) ?? rowReadOnly;
                    return (
                      <Cell
                        key={col.id}
                        table={table}
                        cell={cell}
                        widthPx={(columnUnits[ci] ?? 1) * LATTICE.col}
                        tier={tier}
                        address={address}
                        selected={isSelected}
                        tabStop={
                          isSelected ||
                          (!tableHasSelection && visibleOrdinals[ri] === 0 && ci === 0)
                        }
                        editing={isEditing ? editing : null}
                        editable={editable}
                        readOnly={readOnly}
                        outline={showOutline && col.id === outline.column ? outlineRow : null}
                        column={col}
                        locale={locale}
                        undo={undo ?? null}
                        frozen={frozenIds.has(col.id)}
                        freezeEdge={col.id === freezeEdgeId}
                        // Per-column wrap clamps that column's cells only; a row wrapped on its
                        // own wraps all of its cells. Other cells in a two-unit row stay one line.
                        wrap={col.wrap || rowWrapped}
                        other={other}
                        traversal={traversal}
                        actions={actions}
                        commands={commands}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
          {record.footerRows === 1 && (
            <div
              className="gd-mono gd-table__footer"
              style={{ height: `${String(FOOTER_PX)}px` }}
              aria-label={`${record.title} footer`}
              data-testid="table-footer"
            >
              <span>
                {rowCount} {rowCount === 1 ? 'row' : 'rows'}
              </span>
              <span>
                {columnCount} {columnCount === 1 ? 'column' : 'columns'}
              </span>
            </div>
          )}
          {pinnedLeft !== null && record.frozenColumns > 0 && (
            <PinnedPanel
              table={table}
              record={record}
              outline={showOutline ? outline : null}
              left={pinnedLeft}
              rowHeights={rowHeights}
              selectedCell={selectedCell}
              locale={locale}
              onSelect={actions.selectCell}
            />
          )}
        </>
      )}

      {showAffordances && (
        <>
          {/* GRID-07: one lattice unit beneath the last row (and the footer, when shown). */}
          <button
            type="button"
            className="gd-table__add-row"
            style={{ height: `${String(LATTICE.row)}px` }}
            onClick={() => {
              commands.insertRowBelow(record.id);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            title="Add a row beneath the last row (⌥⌘↓)"
            aria-label={`Add row to ${record.title}`}
            aria-keyshortcuts={ARIA_KEYS.addRow}
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
              commands.insertColumnAfter(record.id);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            title="Add a column at the right edge (⌥⌘→)"
            aria-label={`Add column to ${record.title}`}
            aria-keyshortcuts={ARIA_KEYS.addColumn}
          >
            <Icon name="add-column" size={13} /> Add column
          </button>
          {/* GRID-08: the corner handle scales the whole table on the lattice. */}
          <CornerHandle
            title={record.title}
            widthUnits={storedWidths.reduce((a, b) => a + b, 0)}
            rows={rowCount}
            wrapped={allWrapped}
            tabStop={selected}
            scale={scale}
            onPreview={setTablePreview}
            onCommit={(change) => {
              commands.scaleTable(record.id, change);
            }}
          />
        </>
      )}
    </section>
  );
});

interface PinnedPanelProps {
  table: TableMap;
  record: TableRecord;
  /** The outline to mirror in the frozen outline column, or null while grouped (HIER-08). */
  outline: TableOutline | null;
  left: number;
  rowHeights: readonly number[];
  selectedCell: CellSelection | null;
  locale: FormatLocale;
  onSelect: (cell: CellSelection) => void;
}

/**
 * GRID-10: the frozen columns, carried along the viewport's left edge while the
 * table is scrolled under it. A mirror of cells already in the grid, so it is
 * hidden from assistive tech and holds no tab stops; pointing at a mirrored
 * cell selects the real one. The outline column mirrors its indent, prefix
 * and chevron state too (HIER-04, HIER-05), without the control.
 */
function PinnedPanel({
  table,
  record,
  outline,
  left,
  rowHeights,
  selectedCell,
  locale,
  onSelect,
}: PinnedPanelProps) {
  const columns = frozenColumnsOf(record);
  const width = columns.reduce((acc, c) => acc + c.width, 0) * LATTICE.col;
  return (
    <div
      className="gd-table__pinned"
      aria-hidden="true"
      data-testid="pinned-panel"
      style={{ left: `${String(left)}px`, width: `${String(width)}px` }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    >
      <div className="gd-table__pinned-title" style={{ height: `${String(TITLE_PX)}px` }}>
        <span className="gd-table__title-text">{record.title}</span>
      </div>
      {record.headerRows === 1 && (
        <div
          className="gd-table__row gd-table__row--header"
          style={{ height: `${String(HEADER_PX)}px` }}
        >
          {columns.map((col) => (
            <div
              key={col.id}
              className="gd-table__header gd-table__header--frozen"
              style={{ width: `${String(col.width * LATTICE.col)}px` }}
            >
              <span className="gd-table__header-label">{col.label}</span>
            </div>
          ))}
        </div>
      )}
      {record.rows.map((rowId, ri) => {
        if (rowHeights[ri] === 0) return null; // HIER-06: hidden under a collapsed parent
        const outlineRow = outline?.rows[ri];
        return (
          <div
            key={rowId}
            className="gd-table__row"
            style={{ height: `${String((rowHeights[ri] ?? 1) * LATTICE.row)}px` }}
          >
            {columns.map((col) => {
              const isSelected =
                selectedCell !== null &&
                selectedCell.tableId === record.id &&
                selectedCell.rowId === rowId &&
                selectedCell.colId === col.id;
              const onOutline = outline !== null && col.id === outline.column;
              return (
                <div
                  key={col.id}
                  className={clsx('gd-cell', 'gd-cell--frozen', {
                    'gd-cell--selected': isSelected,
                    'gd-cell--wrap':
                      col.wrap || rowMeta(table, rowId).height === WRAPPED_ROW_HEIGHT,
                    'gd-cell--outline': onOutline,
                  })}
                  style={{
                    width: `${String(col.width * LATTICE.col)}px`,
                    ...outlineStyle(onOutline ? outlineRow : undefined),
                  }}
                  onPointerDown={() => {
                    onSelect({ tableId: record.id, rowId, colId: col.id });
                  }}
                >
                  {onOutline && outlineRow !== undefined && (
                    <OutlineMarks row={outlineRow} control={null} />
                  )}
                  <CellContent
                    content={cellRich(table, rowId, col.id)}
                    format={cellFormatFor(table, col, rowId)}
                    locale={locale}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** HIER-04: the indent rides a custom property the stylesheet multiplies by `--outline-indent`. */
function outlineStyle(row: OutlineRow | undefined): CSSProperties | undefined {
  if (row === undefined || row.depth === 0) return undefined;
  return { '--gd-outline-depth': row.depth } as CSSProperties;
}

interface OutlineMarksProps {
  row: OutlineRow;
  /**
   * The chevron's handler and label, or null for a mirror or a read-only
   * viewer (RESP-02, SHARE-03): the state still shows, as a glyph the row's
   * `aria-expanded` speaks for, but nothing here toggles it.
   */
  control: { readonly label: string; readonly onToggle: () => void } | null;
}

/**
 * HIER-04 / HIER-05: what the outline column prefixes a cell with — a
 * disclosure chevron on a row with descendants (rotated when expanded) and
 * `↳` on a child row. Both are decorative to assistive tech: the row carries
 * `aria-level` and `aria-expanded`, and the chevron button its own label.
 */
function OutlineMarks({ row, control }: OutlineMarksProps) {
  const chevron = (
    <Icon
      name="chevron-right"
      size={13}
      className={clsx('gd-cell__chevron-glyph', {
        'gd-cell__chevron-glyph--expanded': !row.collapsed,
      })}
    />
  );
  return (
    <>
      {row.hasChildren &&
        (control === null ? (
          <span className="gd-cell__chevron" aria-hidden="true" data-testid="outline-chevron">
            {chevron}
          </span>
        ) : (
          <button
            type="button"
            className="gd-cell__chevron"
            aria-label={control.label}
            aria-expanded={!row.collapsed}
            title={control.label}
            tabIndex={-1}
            data-testid="outline-chevron"
            onPointerDown={(e) => {
              e.stopPropagation(); // the press must not also arm the cell under it
            }}
            onClick={(e) => {
              e.stopPropagation();
              control.onToggle();
            }}
          >
            {chevron}
          </button>
        ))}
      {row.depth > 0 && (
        <span className="gd-cell__branch" aria-hidden="true">
          ↳
        </span>
      )}
    </>
  );
}

interface CellProps {
  table: TableMap;
  cell: CellSelection;
  widthPx: number;
  tier: ZoomTier;
  address: string | undefined;
  selected: boolean;
  /** Reachable with Tab: the selected cell, or the table's first cell when none is. */
  tabStop: boolean;
  editing: Editing | null;
  editable: boolean;
  /** GRID-04: derived, linked, pulled, group and split-child cells are not editable. */
  readOnly: ReadOnlyReason | null;
  /**
   * HIER-04 / HIER-05: set on the outline column's cell only — the row's
   * depth, chevron and prefix render here. Null on every other cell, and on
   * every cell while the table is grouped (HIER-08).
   */
  outline: OutlineRow | null;
  /** The column record, resolved once per table render; carries the column's data format (FMT-01). */
  column: ColumnRecord;
  locale: FormatLocale;
  undo: Y.UndoManager | null;
  frozen: boolean;
  freezeEdge: boolean;
  wrap: boolean;
  other: PresenceState | undefined;
  traversal: TraversalTable;
  actions: GridActions;
  commands: GridCommands;
}

function arrowDirection(code: string): Direction | null {
  switch (code) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

function Cell({
  table,
  cell,
  widthPx,
  tier,
  address,
  selected,
  tabStop,
  editing,
  editable,
  readOnly,
  outline,
  column,
  locale,
  undo,
  frozen,
  freezeEdge,
  wrap,
  other,
  traversal,
  actions,
  commands,
}: CellProps) {
  // Micro only: below it cell text is not laid out at all (DOC-05).
  const rich = tier === 'micro' ? cellRich(table, cell.rowId, cell.colId) : EMPTY_DOC;
  const source = plainText(rich);
  // FX-07 / PRD §20: a formula cell's label, tooltip and editor text are the projected
  // expression (today's addresses), never the stored id tokens; at rest it shows its value.
  const formula = isFormulaInput(source);
  const shown = formula && table.doc !== null ? projectSource(table.doc, source) : null;
  const format = cellFormatFor(table, column, cell.rowId);
  const layout = layoutCell(shown === null ? rich : richFromText(shown), format, locale);
  const text = layout.text;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && editing === null) ref.current?.focus({ preventScroll: true });
  }, [selected, editing]);
  const canEdit = editable && readOnly === null;

  const refuse = () => {
    if (readOnly !== null) {
      announce(`${address ?? 'The cell'} is read-only: ${readOnlyLabel(readOnly)}`);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by the IME contract
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
      // I18N-01: an IME began composing on an armed cell — hand it the editor so the
      // conjunct forms there; nothing commits until the composition ends.
      if (canEdit) {
        e.stopPropagation();
        actions.dispatch({ type: 'edit', seed: { kind: 'overwrite', text: '' }, cell });
      }
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    // Escape clears the selection but leaves focus on this cell (GRID-03); a move
    // from here re-arms it first, so Tab and the arrows are never dead keys
    // (GRID-05, A11Y-01). `dispatch` updates the machine synchronously, so the
    // move that follows sees the new selection.
    const rearm = () => {
      if (!selected) actions.selectCell(cell);
    };
    // KEYS-06 / HIER-01 / HIER-06: ⌘] ⌘[ ⌥← ⌥→ act on this cell's row, by physical key.
    // A read-only viewer gets nothing from them (RESP-02): no default, no write.
    const hierarchy = hierarchyKey(e);
    if (hierarchy !== null) {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      rearm();
      switch (hierarchy) {
        case 'nest':
          commands.nestRow(cell.tableId, cell.rowId);
          return;
        case 'promote':
          commands.promoteRow(cell.tableId, cell.rowId);
          return;
        case 'collapse':
          commands.setCollapsed(cell.tableId, cell.rowId, true);
          return;
        case 'expand':
          commands.setCollapsed(cell.tableId, cell.rowId, false);
          return;
      }
    }
    const arrow = arrowDirection(e.code);
    if (arrow !== null) {
      if (mod || e.altKey) return; // ⌥⌘↓ / ⌥⌘→ add a row or column (the shell binds them)
      e.preventDefault();
      e.stopPropagation();
      rearm();
      actions.move(arrow);
      return;
    }
    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        if (mod) return;
        e.preventDefault();
        e.stopPropagation();
        if (!editable) return;
        if (readOnly !== null) {
          refuse();
          return;
        }
        actions.dispatch({ type: 'edit', seed: { kind: 'existing' }, cell });
        return;
      case 'Delete':
      case 'Backspace':
        if (mod) return;
        e.preventDefault();
        e.stopPropagation();
        if (editable) commands.clearCell(cell);
        return;
      case 'Tab': {
        if (mod || e.altKey) return; // ⌃⇥ switches sheets (the shell binds it)
        const direction: Direction = e.shiftKey ? 'left' : 'right';
        const result = nextCell(traversal, cell, direction);
        // Nowhere to go inside the grid: let focus leave it (A11Y-01).
        if (result.kind === 'stay' || (result.kind === 'append-row' && !editable)) return;
        e.preventDefault();
        e.stopPropagation();
        rearm();
        actions.move(direction);
        return;
      }
      case 'Escape':
        return; // the shell clears the selection (GRID-03)
      default:
        break;
    }
    // GRID-04: any printable character overwrites and opens the editor.
    if (mod || e.key.length !== 1 || !editable) return;
    e.preventDefault();
    e.stopPropagation();
    if (readOnly !== null) {
      refuse();
      return;
    }
    actions.dispatch({ type: 'edit', seed: { kind: 'overwrite', text: e.key }, cell });
  };

  const presenceStyle =
    other === undefined
      ? undefined
      : ({ '--gd-presence': `var(--presence-${String(other.colour)})` } as CSSProperties);
  const lockLabel = readOnly === null ? undefined : `Read-only: ${readOnlyLabel(readOnly)}`;
  const chevronControl =
    outline !== null && outline.hasChildren && editable
      ? {
          label: `${outline.collapsed ? 'Expand' : 'Collapse'} ${address ?? 'row'}`,
          onToggle: () => {
            commands.toggleCollapse(cell.tableId, cell.rowId);
          },
        }
      : null;

  return (
    <div
      ref={ref}
      role="gridcell"
      tabIndex={tabStop ? 0 : -1}
      aria-selected={selected || undefined}
      aria-readonly={readOnly === null ? undefined : true}
      aria-label={
        address === undefined
          ? undefined
          : `${address}${text === '' ? '' : `, ${text}`}${lockLabel === undefined ? '' : `, ${lockLabel}`}`
      }
      aria-keyshortcuts={
        outline === null || !editable
          ? undefined
          : `${HIER_ARIA_KEYS.nest} ${HIER_ARIA_KEYS.promote}${
              outline.hasChildren ? ` ${HIER_ARIA_KEYS.collapse} ${HIER_ARIA_KEYS.expand}` : ''
            }`
      }
      className={clsx('gd-cell', {
        'gd-cell--selected': selected,
        'gd-cell--editing': editing !== null,
        'gd-cell--presence': other !== undefined,
        'gd-cell--locked': readOnly !== null,
        'gd-cell--frozen': frozen,
        'gd-cell--freeze-edge': freezeEdge,
        'gd-cell--wrap': wrap,
        'gd-cell--outline': outline !== null,
      })}
      style={{
        width: `${String(widthPx)}px`,
        ...presenceStyle,
        ...outlineStyle(outline ?? undefined),
      }}
      title={
        tier === 'micro' && editing === null
          ? lockLabel === undefined
            ? text
            : `${text}${text === '' ? '' : ' — '}${lockLabel}`
          : undefined
      }
      onPointerDown={(e) => {
        e.stopPropagation();
        // FX-05: while a formula is being edited elsewhere, a press here inserts this
        // address into it; the default is cancelled so the editor keeps focus.
        if (address !== undefined && editing === null && insertClickedAddress(address)) {
          e.preventDefault();
          return;
        }
        actions.selectCell(cell);
      }}
      onFocus={(e) => {
        // Tabbing onto a cell arms it (A11Y-01), so Enter can open the editor. Focus
        // landing on the chevron inside it (HIER-05) is not a selection.
        if (!selected && e.target === e.currentTarget) actions.selectCell(cell);
      }}
      onDoubleClick={() => {
        if (!editable) return;
        if (readOnly !== null) {
          refuse();
          return;
        }
        actions.dispatch({ type: 'edit', seed: { kind: 'existing' }, cell });
      }}
      onKeyDown={onKeyDown}
      data-address={address}
      data-read-only={readOnly ?? undefined}
    >
      {outline !== null && <OutlineMarks row={outline} control={chevronControl} />}
      {editing !== null && canEdit ? (
        <RichCellEditor
          initial={shown ?? source}
          seed={editing.seed}
          address={address}
          fragment={cellFragment(table, cell.rowId, cell.colId)}
          undoManager={undo}
          locale={locale}
          table={table}
          cell={cell}
          onCommit={(value, then) => {
            actions.commit(cell, value, then);
          }}
          onCommitRich={(doc) => {
            // A cell with no fragment yet (empty, or a formula): the marks arrive here,
            // then `onCommit` follows with the same text and is a no-op write.
            commands.commitRichCell(cell, doc);
          }}
          onCancel={actions.cancel}
        />
      ) : formula && tier === 'micro' ? (
        <FormulaCell table={table} cell={cell} expression={wrap} />
      ) : (
        tier === 'micro' && (
          <CellContent content={rich} layout={layout} format={format} locale={locale} />
        )
      )}
      {readOnly !== null && (
        <span className="gd-cell__lock" aria-hidden="true">
          <Icon name="locked" size={13} />
        </span>
      )}
      {other !== undefined && (
        <span className="gd-cell__presence-tag" aria-label={`${other.name} is here`}>
          {other.name}
        </span>
      )}
    </div>
  );
}
