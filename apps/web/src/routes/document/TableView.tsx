import clsx from 'clsx';
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  appearanceEqual,
  CAPTION_ROWS,
  cellFormatFor,
  cellFragment,
  cellKey,
  cellRich,
  columnLetter,
  cellAddress,
  distributeUnits,
  effectiveWrap,
  LATTICE,
  lineBoxPx,
  rowHeights as effectiveRowHeights,
  rowMeta,
  rowReadOnlyReason,
  spanIndex,
  TABLE_TITLE_ROWS,
  tableAddresses,
  tableOutline,
  tableRecord,
  EMPTY_DOC,
  plainText,
  richFromText,
  type Band,
  type ColumnRecord,
  type FormatLocale,
  type FormatOpts,
  type Id,
  type OutlineRow,
  type PresenceState,
  type ReadOnlyReason,
  type RowMeta,
  type SpanIndex,
  type TableMap,
  type TableOutline,
  type TableRecord,
} from '@gede/core';
import { Icon } from '@gede/ui';
import type * as Y from 'yjs';

import { announce } from '../../announce.js';
import { ARIA_KEYS, CHORDS, isApplePlatform, matchesChord } from '../../doc/shortcuts.js';
import type { ZoomTier } from '../../doc/viewport.js';
import {
  bandFor,
  nextCell,
  type AxisBand,
  type CellSelection,
  type Direction,
  type Editing,
  type TraversalTable,
} from '../../doc/selection.js';
import { CellContent, layoutCell, RichCellEditor, toFormatLocale } from './cell/index.js';
import { formatNumber } from '../../intl.js';
import { useLocale } from '../../locale.js';
import {
  FormulaCell,
  insertClickedAddress,
  isFormulaInput,
  projectSource,
} from './formula/index.js'; // wave2/formulas
import { useWorkbookIndexVersion } from '../../doc/workbook-index.js';
import { useCellVersions } from './grid/cell-versions.js';
import { readOnlyLabel, type GridCommands } from './grid/commands.js';
import { HIER_ARIA_KEYS, HIER_LABELS, hierarchyKey } from './grid/hier-keys.js';
import {
  DerivedCell,
  LineageHeader,
  MappingCell,
  refCellKind,
  ReferenceCell,
  useReferenceReconciler,
  type MappingCellHandle,
} from './ref/index.js'; // wave3/references
import { useGraphLitRows } from './graph/store.js'; // wave4/graphs: GRAPH-09 lit rows
import { frozenColumns as frozenColumnsOf } from './grid/pinned.js';
import { ColumnDivider, CornerHandle, RowDivider } from './grid/ResizeHandle.js';
import type { GridActions } from './grid/use-grid.js';
import {
  ariaSortOf,
  GroupBand,
  HeaderMenu,
  headerGlyphs,
  useTableProjection,
  type SortCommands,
} from './sort/index.js';
import {
  fitColumnsToContent,
  fitRowsToContent,
  looksEqual,
  paintLook,
  paintTable,
  styleOf,
  useColumnRules,
  useFitter,
  type CellLook,
  type Fitter,
} from './style/index.js'; // wave4/inspector-controls

export interface TableViewProps {
  table: TableMap;
  tier: ZoomTier;
  selected: boolean;
  selectedCell: CellSelection | null;
  /** ADR-049: the selected rows or columns of this table, if any (the shell filters by table). */
  axisBand?: AxisBand | null | undefined;
  /** ADR-049: how to measure for fit-to-content; defaults to this document's canvas measurer. */
  fitter?: Fitter | undefined;
  editing: Editing | null;
  /** RESP-02 / SHARE-03: no edit affordance renders when false. */
  editable: boolean;
  /**
   * Force the "view is sorted" treatment of the outline (HIER-08, ADR-026):
   * depth kept, not shown, no chevron, nest/promote refused. The table reads
   * its own viewer's sort and filter from the view store and applies this
   * itself; the prop is for a host that knows better (e.g. a preview).
   */
  viewSorted?: boolean | undefined;
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
  /**
   * SORT-01: sort, filter and group commands behind each header's ▼. Absent
   * renders no menu (the phone, RESP-02) — the viewer's view still applies.
   * Not tied to `editable`: the view is the viewer's own (ADR-025).
   */
  sort?: SortCommands | undefined;
}

const TITLE_PX = TABLE_TITLE_ROWS * LATTICE.row;
const EMPTY_ROWS: readonly Id[] = [];

function sameIds(a: readonly Id[], b: readonly Id[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
const HEADER_PX = LATTICE.row;
const FOOTER_PX = LATTICE.row;

/** A drag's live preview: the sizes every dragged member would take, by id (ADR-049). */
type SizePreview = ReadonlyMap<Id, number>;
interface TablePreview {
  widthUnits: number;
  heightUnits: number;
}

/**
 * Numbers N2 (ADR-049): the sizes a band takes when one member is dragged —
 * each scales by the dragged one's new/old ratio, snapped to whole units,
 * never below one; the dragged member lands exactly where the pointer is.
 */
export function proportionalSizes(
  sizes: ReadonlyMap<Id, number>,
  draggedId: Id,
  draggedUnits: number,
): Map<Id, number> {
  const from = sizes.get(draggedId) ?? 1;
  const ratio = draggedUnits / Math.max(1, from);
  const out = new Map<Id, number>();
  for (const [id, units] of sizes) {
    out.set(id, id === draggedId ? draggedUnits : Math.max(1, Math.round(units * ratio)));
  }
  return out;
}

/**
 * One table on the lattice (DOM-first). Geometry is absolute: the title bar is
 * two lattice rows, the header one (or none, GRID-11), every data row its
 * stored whole number of units (GRID-09, ADR-049), the footer strip one, and
 * every visible column `width` units wide; a hidden column is not drawn
 * (GRID-02). Nothing here reflows at a breakpoint (RESP-01) — the viewport
 * pans over it.
 */
export const TableView = memo(function TableView({
  table,
  tier,
  selected,
  selectedCell,
  axisBand = null,
  fitter: givenFitter,
  editing,
  editable,
  viewSorted = false,
  presence,
  pinnedLeft,
  undo,
  actions,
  commands,
  sort,
}: TableViewProps) {
  // Per-cell counters (not just the table's): a keystroke re-renders its own cell only.
  const versions = useCellVersions(table);
  const version = versions.table;
  const [activeLocale] = useLocale();
  const locale = toFormatLocale(activeLocale);
  // One record per document change: its `rows` and `columns` keep identity between
  // renders that change nothing, so what derives from them can be memoised.
  const record = useMemo(() => tableRecord(table), [table, version]);
  // SORT-01..05: the rows to render, in view order; held still while a cell here is edited.
  const projection = useTableProjection(
    table,
    record,
    activeLocale,
    editing !== null && editing.cell.tableId === record.id,
  );
  const bandLabelId = useId();
  const ref = useRef<HTMLElement>(null);
  const [columnPreview, setColumnPreview] = useState<SizePreview | null>(null);
  const [rowPreview, setRowPreview] = useState<SizePreview | null>(null);
  const [tablePreview, setTablePreview] = useState<TablePreview | null>(null);
  const ownFitter = useFitter(table.doc);
  const fitter = givenFitter ?? ownFitter;
  const columnBand = axisBand !== null && axisBand.axis === 'column' ? axisBand : null;
  const rowBand = axisBand !== null && axisBand.axis === 'row' ? axisBand : null;

  // Visible columns with the width each renders at (a drag previews before it commits).
  const visible = record.columns.filter((c) => !c.hidden);
  const storedWidths = visible.map((c) => c.width);
  const previewWidths =
    tablePreview === null ? storedWidths : distributeUnits(storedWidths, tablePreview.widthUnits);
  const widthUnitsOf = (colId: Id, i: number): number =>
    columnPreview?.get(colId) ?? previewWidths[i] ?? 1;
  const columnUnits = visible.map((c, i) => widthUnitsOf(c.id, i));
  const widthPx =
    Math.max(
      1,
      columnUnits.reduce((a, b) => a + b, 0),
    ) * LATTICE.col;
  // Heights in document row order (GRID-09, ADR-049): the stored whole units, or a drag's
  // preview — one row's, a band's, or the corner's proportional share of every row's.
  const storedHeights = effectiveRowHeights(table, record);
  const rowHeights = useMemo(() => {
    if (rowPreview === null && tablePreview === null) return storedHeights;
    if (tablePreview !== null) {
      const shown = storedHeights.filter((h) => h > 0);
      const shared = distributeUnits(shown, tablePreview.heightUnits);
      let k = 0;
      return storedHeights.map((h) => (h === 0 ? 0 : (shared[k++] ?? h)));
    }
    return storedHeights.map((h, i) => {
      if (h === 0) return 0;
      const id = record.rows[i];
      return (id === undefined ? undefined : rowPreview?.get(id)) ?? h;
    });
  }, [storedHeights, rowPreview, tablePreview, record.rows]);
  const bodyUnits = storedHeights.reduce((a, b) => a + b, 0);
  const addresses = tier === 'micro' ? tableAddresses(table) : null;
  const headerPx = record.headerRows === 1 ? HEADER_PX : 0;
  const footerPx = record.footerRows === 1 ? FOOTER_PX : 0;
  // INSP-04: the caption strip is one lattice row at the foot; INSP-05/MENU-04: the
  // matched rules (from the rules Worker) and the merged spans, resolved once per render.
  const captionPx = record.look.captionShown ? CAPTION_ROWS * LATTICE.row : 0;
  const rules = useColumnRules(table, record, version);
  const spans = useMemo(() => spanIndex(table, record), [table, record]);
  const paint = paintTable(record);
  const style: CSSProperties = {
    left: `${String(record.gridCol * LATTICE.col)}px`,
    top: `${String(record.gridRow * LATTICE.row)}px`,
    width: `${String(widthPx)}px`,
    ...paint.style,
  };
  const showAffordances = editable && selected && tier !== 'macro';
  // ADR-049: the fit routes (double-click, Enter on a divider); absent where nothing measures.
  const fitOptions = fitter.fit;
  const fitColumnIds = (ids: readonly Id[]) => {
    const o = fitOptions();
    if (o === null) return;
    commands.fitColumns(record.id, fitColumnsToContent(table, record, { ...o, only: ids }));
  };
  const fitRowIds = (ids: readonly Id[]) => {
    const o = fitOptions();
    if (o === null) return;
    commands.fitRows(record.id, fitRowsToContent(table, record, { ...o, only: ids }));
  };
  // A drag on a member of the selected band resizes every member, proportionally (N2).
  const columnSizes = new Map(visible.map((c) => [c.id, c.width]));
  const rowSizes = new Map(record.rows.map((id, i) => [id, storedHeights[i] ?? 1]));
  const previewColumns = (colId: Id, units: number | null) => {
    if (units === null) {
      setColumnPreview(null);
      return;
    }
    const ids = bandFor(columnBand, colId);
    const sizes = new Map(ids.map((id) => [id, columnSizes.get(id) ?? 1]));
    setColumnPreview(proportionalSizes(sizes, colId, units));
  };
  const commitColumns = (colId: Id, units: number) => {
    const ids = bandFor(columnBand, colId);
    if (ids.length === 1) {
      commands.setColumnWidth(record.id, colId, units);
      return;
    }
    const sizes = new Map(ids.map((id) => [id, columnSizes.get(id) ?? 1]));
    const next = proportionalSizes(sizes, colId, units);
    commands.setColumnWidths(
      record.id,
      ids.map((id) => ({ colId: id, units: next.get(id) ?? 1 })),
    );
  };
  const previewRows = (rowId: Id, units: number | null) => {
    if (units === null) {
      setRowPreview(null);
      return;
    }
    const ids = bandFor(rowBand, rowId);
    const sizes = new Map(ids.map((id) => [id, rowSizes.get(id) ?? 1]));
    setRowPreview(proportionalSizes(sizes, rowId, units));
  };
  const commitRows = (rowId: Id, units: number) => {
    const ids = bandFor(rowBand, rowId);
    const sizes = new Map(ids.map((id) => [id, rowSizes.get(id) ?? 1]));
    const next = proportionalSizes(sizes, rowId, units);
    commands.setRowHeights(
      record.id,
      ids.map((id) => ({ rowId: id, units: next.get(id) ?? 1 })),
    );
  };
  /** "Row 5", by the lattice number the ruler shows (DOC-06). */
  const rowNameOf = (rowId: Id): string => {
    const first = visible[0];
    const address = first === undefined ? null : cellAddress(table, rowId, first.id);
    const number = address?.replace(/^[A-Z]+/, '');
    return number === undefined || number === '' ? 'Row' : `Row ${number}`;
  };

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
  // Sections of the body: one per band when grouped (its rows hidden while collapsed),
  // else the whole view in one. Row ordinals index `rowHeights` and `addresses`,
  // which stay in document order — a sorted row keeps its address (non-negotiable 3).
  // Memoised on the projection, so a render that changes nothing about the rows hands
  // every cell the same `traversal` and the grid registers its view rows once.
  const rowOrdinal = useMemo(
    () => new Map<Id, number>(record.rows.map((id, i) => [id, i])),
    [record.rows],
  );
  // HIER-04..06: the outline, once per document change. A row under a collapsed
  // parent has left the lattice (no height, no address) and is not drawn, whatever
  // the viewer's sort, filter or grouping: the sections below leave it out.
  const outline = useMemo(() => tableOutline(table, record), [table, record]);
  const { sections, visibleRows, bandCount } = useMemo(() => {
    const list: { band: Band | null; rows: readonly Id[]; firstIndex: number }[] = [];
    const shown: Id[] = [];
    const hiddenRow = (id: Id) => outline.rows[rowOrdinal.get(id) ?? -1]?.hidden === true;
    // ARIA row indices count what renders, bands included, in view order.
    let index = 1 + record.headerRows;
    const add = (band: Band | null, all: readonly Id[]) => {
      const collapsed = band !== null && projection.collapsed.has(band.key);
      const rows = all.some(hiddenRow) ? all.filter((id) => !hiddenRow(id)) : all;
      list.push({ band, rows: collapsed ? EMPTY_ROWS : rows, firstIndex: index });
      index += (band === null ? 0 : 1) + (collapsed ? 0 : rows.length);
      if (!collapsed) shown.push(...rows);
    };
    if (projection.bands === null) add(null, projection.rowIds);
    else {
      for (const band of projection.bands) add(band, band.rowIds);
      add(null, projection.loose);
    }
    return { sections: list, visibleRows: shown, bandCount: projection.bands?.length ?? 0 };
  }, [projection, record.headerRows, outline, rowOrdinal]);
  // Keep the array's identity while its content is unchanged (a re-projection that lands the
  // same order): what depends on it — `traversal`, the grid's view rows — then stays put too.
  const stableRowsRef = useRef<readonly Id[]>(visibleRows);
  const stableVisibleRows = sameIds(stableRowsRef.current, visibleRows)
    ? stableRowsRef.current
    : visibleRows;
  stableRowsRef.current = stableVisibleRows;
  const renderedBodyPx =
    (visibleRows.reduce((acc, id) => acc + (rowHeights[rowOrdinal.get(id) ?? 0] ?? 1), 0) +
      bandCount) *
    LATTICE.row;
  // Traversal follows what is on screen (SORT-01..05): arrows and Tab move through the
  // visible order, and past its last row a new row is appended as ever (GRID-05).
  useEffect(() => {
    actions.setViewRows(record.id, stableVisibleRows);
  }, [actions, record.id, stableVisibleRows]);
  useEffect(
    () => () => {
      actions.setViewRows(record.id, null);
    },
    [actions, record.id],
  );
  // The cells read the traversal through a stable getter: `record` (and so `columns`) is
  // rebuilt on every document change, and a fresh object per render would invalidate every
  // memoised cell on each keystroke. The getter's identity never changes.
  const traversalRef = useRef<TraversalTable>({ rows: [], columns: [] });
  traversalRef.current = useMemo(
    () => ({
      rows: stableVisibleRows,
      columns: record.columns.map((c) => ({ id: c.id, hidden: c.hidden })),
      covered: spans.covered,
    }),
    [stableVisibleRows, record.columns, spans],
  );
  const traversal = useMemo(() => () => traversalRef.current, []);
  // GRID-04: the read-only reason is a column fact (source) or a row fact (group band);
  // resolve each once per render rather than re-reading the Yjs column array per cell.
  const columnOrdinal = new Map<Id, number>(record.columns.map((c, i) => [c.id, i]));
  const columnReadOnly = new Map<Id, ReadOnlyReason | null>(
    record.columns.map((c) => [c.id, c.source === 'entered' ? null : c.source]),
  );
  // One rowMeta read per row: the row-level read-only reason (GRID-04: a category band;
  // REF-02: a pulled row; HIER-07: a split child) and the meta itself for the cell bodies
  // that need provenance.
  const rowFacts = (rowId: Id): { readOnly: ReadOnlyReason | null; meta: RowMeta } => {
    const meta = rowMeta(table, rowId);
    return { readOnly: rowReadOnlyReason(meta), meta };
  };
  // REF-02 / HIER-07: pulls and Split children stay materialised while this replica can write.
  useReferenceReconciler(table.doc, editable);
  // GRAPH-09: the rows a hovered graph node, dot or cell lights (a dot lights every row bound
  // to its parameter, #141); subscribed here so a hover re-renders this table and nothing above it.
  const litRows = useGraphLitRows(table.doc, record.id);
  // HIER-04..08: while the viewer groups the table the bands own the outline column,
  // and while the viewer sorts or filters it a child could draw above its parent:
  // in both the outline shows no depth, though the data keeps it (HIER-08, ADR-026).
  const grouped = projection.view.groupBy !== null;
  const sorted = viewSorted || projection.view.sortBy !== null || projection.view.filter !== null;
  const showOutline = !grouped && !sorted && outline.column !== null;
  const outlineLocked = grouped
    ? 'Hierarchy is unavailable while the table is grouped'
    : sorted
      ? 'Hierarchy is unavailable while the view is sorted or filtered'
      : null;
  // A table with any nesting is a treegrid to assistive tech: that is the role whose
  // rows carry `aria-level` and `aria-expanded` (a plain grid's may not). A flat table
  // stays a grid, so nothing changes for it.
  const hierarchical = showOutline && outline.rows.some((r) => r.depth > 0 || r.hasChildren);

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
  // INSP-05 / INSP-06 / MENU-04: the look of one cell — appearance, matched rule, span —
  // with a span's anchor box measured over the widths and heights rendering now.
  const visibleIndex = new Map<Id, number>(visible.map((c, i) => [c.id, i]));
  const lookOf = (col: ColumnRecord, rowId: Id): CellLook =>
    styleOf(table, col, rowId, rules.get(cellKey(rowId, col.id)) ?? null, spans, (span) => ({
      widthUnits: span.colIds.reduce((acc, id) => {
        const i = visibleIndex.get(id);
        return i === undefined ? acc : acc + (columnUnits[i] ?? 1);
      }, 0),
      heightUnits: span.rowIds.reduce(
        (acc, id) => acc + (rowHeights[rowOrdinal.get(id) ?? 0] ?? 1),
        0,
      ),
    }));

  return (
    <section
      ref={ref}
      className={clsx('gd-table', `gd-table--${tier}`, {
        'gd-table--selected': selected,
        'gd-table--resizing':
          columnPreview !== null || rowPreview !== null || tablePreview !== null,
        'gd-table--pinned': record.pinned,
        'gd-table--gutter': showAffordances,
      })}
      style={style}
      aria-label={record.title}
      data-table-id={record.id}
      data-frozen-columns={record.frozenColumns}
      {...paint.data}
    >
      <header
        className="gd-table__title"
        style={{ height: `${String(TITLE_PX)}px` }}
        onPointerDown={(e) => {
          e.stopPropagation();
          actions.selectTable(record.id);
        }}
      >
        {/* INSP-04: a hidden title leaves its two-row bar (no address moves); the section's name stays. */}
        {record.look.titleShown && <span className="gd-table__title-text">{record.title}</span>}
        <span className="gd-mono gd-table__degree" aria-hidden="true">
          {columnLetter(record.gridCol)}
          {record.gridRow + 1}
        </span>
        {tier !== 'macro' && <LineageHeader record={record} />}
      </header>

      {tier === 'macro' ? (
        <div
          className="gd-table__block"
          style={{ height: `${String(headerPx + renderedBodyPx + footerPx + captionPx)}px` }}
          aria-hidden="true"
        />
      ) : (
        <>
          <div
            className="gd-table__grid"
            role={hierarchical ? 'treegrid' : 'grid'}
            aria-label={record.title}
            aria-rowcount={visibleRows.length + bandCount + record.headerRows}
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
                  // SORT-01: the active column is tinted and carries ↑ ↓ ⇅ and/or ⌕, plus aria-sort.
                  const glyphs = headerGlyphs(projection.view, col.id);
                  const glyph = glyphs[0] ?? null;
                  const grouped = projection.view.groupBy === col.id;
                  const columnTabStop =
                    selectedCell?.tableId === record.id && selectedCell.colId === col.id;
                  const inBand = columnBand?.ids.includes(col.id) === true;
                  return (
                    <div
                      key={col.id}
                      role="columnheader"
                      // MENU-05: focusable by script only, so a column menu opened on the header
                      // can return focus to it; the grid keeps one tab stop (A11Y-01).
                      tabIndex={-1}
                      aria-sort={ariaSortOf(projection.view, col.id)}
                      aria-selected={inBand ? true : undefined}
                      className={clsx('gd-table__header', {
                        'gd-table__header--frozen': frozenIds.has(col.id),
                        'gd-table__header--freeze-edge': col.id === freezeEdgeId,
                        'gd-table__header--view': glyph !== null || grouped,
                        'gd-table__header--banded': inBand,
                      })}
                      style={{ width: `${String(units * LATTICE.col)}px` }}
                      // ADR-049 (Numbers): a press on the header selects the column; Shift
                      // extends. The ▼, its menu (a portal whose events still bubble here in
                      // React's tree) and the divider keep their own presses.
                      onPointerDown={(e) => {
                        if (e.button !== 0 || !editable) return;
                        const target = e.target instanceof Element ? e.target : null;
                        if (target === null || !e.currentTarget.contains(target)) return;
                        if (target.closest('button, [role="separator"]') !== null) return;
                        e.stopPropagation();
                        actions.selectBand(record.id, 'column', col.id, e.shiftKey);
                      }}
                      title={
                        glyph === null && !grouped
                          ? col.label
                          : `${col.label} — ${[...glyphs.map((g) => g.label), grouped ? 'grouped' : null].filter(Boolean).join(', ')}`
                      }
                      data-col-id={col.id}
                      data-view={glyph === null && !grouped ? undefined : 'active'}
                    >
                      <span className="gd-table__header-label">{col.label}</span>
                      {glyphs.map((g) => (
                        <span key={g.icon} className="gd-table__header-glyph" data-glyph={g.icon}>
                          <Icon name={g.icon} size={13} label={g.label} />
                        </span>
                      ))}
                      {grouped && glyph === null && (
                        <span className="gd-table__header-glyph" data-glyph="group">
                          <Icon name="group" size={13} label="grouped" />
                        </span>
                      )}
                      <span className="gd-mono gd-table__letter" aria-label={`Column ${letter}`}>
                        {letter}
                      </span>
                      {sort !== undefined && (
                        <HeaderMenu
                          tableId={record.id}
                          column={col}
                          view={projection.view}
                          commands={sort}
                          tabStop={columnTabStop}
                          // ADR-051: the table's default outline column, for an editor only.
                          outline={
                            editable
                              ? {
                                  checked: outline.column === col.id,
                                  onCheckedChange: (on) => {
                                    commands.setOutlineColumn(record.id, on ? col.id : null);
                                  },
                                }
                              : undefined
                          }
                        />
                      )}
                      {editable && (
                        <ColumnDivider
                          label={col.label}
                          units={col.width}
                          tabStop={columnTabStop}
                          scale={scale}
                          onPreview={(preview) => {
                            previewColumns(col.id, preview);
                          }}
                          onCommit={(next) => {
                            commitColumns(col.id, next);
                          }}
                          onFit={
                            fitter.reason === undefined
                              ? () => {
                                  fitColumnIds(bandFor(columnBand, col.id));
                                }
                              : undefined
                          }
                          fitReason={fitter.reason}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {sections.map((section, si) => {
              const { band, rows, firstIndex } = section;
              const bandCollapsed = band !== null && projection.collapsed.has(band.key);
              const bandLabel = `${bandLabelId}-${String(si)}`;
              const groupIndex = visible.findIndex((c) => c.id === projection.view.groupBy);
              const Wrapper = band === null ? Fragment : 'div';
              const wrapperProps =
                band === null
                  ? {}
                  : { role: 'rowgroup', 'aria-labelledby': bandLabel, 'data-band': band.key };
              return (
                <Wrapper key={band === null ? `section-${String(si)}` : band.key} {...wrapperProps}>
                  {band !== null && (
                    <GroupBand
                      value={band.value}
                      count={band.rowIds.length}
                      collapsed={bandCollapsed}
                      columnLeft={(columnStarts[groupIndex] ?? 0) * LATTICE.col}
                      columnWidth={(columnUnits[groupIndex] ?? 1) * LATTICE.col}
                      columns={columnCount}
                      rowIndex={firstIndex}
                      labelId={bandLabel}
                      countText={`${formatNumber(activeLocale, band.rowIds.length)} ${band.rowIds.length === 1 ? 'row' : 'rows'}`}
                      onToggle={() => {
                        projection.toggleBand(band.key);
                      }}
                    />
                  )}
                  {rows.map((rowId, vi) => {
                    const ri = rowOrdinal.get(rowId) ?? 0;
                    // One outline entry per row; rows under a collapsed parent never reach
                    // here (the sections leave them out, HIER-06).
                    const outlineRow = outline.rows[ri];
                    const rowUnits = rowHeights[ri] ?? 1;
                    const heightPx = rowUnits * LATTICE.row;
                    const { readOnly: rowReadOnly, meta: rowMetaOf } = rowFacts(rowId);
                    const parentRow = hierarchical && outlineRow?.hasChildren === true;
                    const rowSelected =
                      selectedCell?.tableId === record.id && selectedCell.rowId === rowId;
                    const rowInBand = rowBand?.ids.includes(rowId) === true;
                    const rowName = rowNameOf(rowId);
                    return (
                      <div
                        key={rowId}
                        className={clsx('gd-table__row', {
                          'gd-table__row--lit': litRows.has(rowId),
                          'gd-table__row--banded': rowInBand,
                        })}
                        role="row"
                        data-lit={litRows.has(rowId) || undefined}
                        data-row-id={rowId}
                        data-units={rowUnits}
                        aria-rowindex={firstIndex + (band === null ? 0 : 1) + vi}
                        aria-level={
                          hierarchical && outlineRow !== undefined
                            ? outlineRow.depth + 1
                            : undefined
                        }
                        aria-expanded={parentRow ? !outlineRow.collapsed : undefined}
                        aria-selected={rowInBand ? true : undefined}
                        // #167 criterion 18: a row taller than one unit says so.
                        aria-description={
                          rowUnits > 1 ? `${String(rowUnits)} units tall` : undefined
                        }
                        style={{ height: `${String(heightPx)}px` }}
                        data-depth={
                          showOutline && outlineRow !== undefined ? outlineRow.depth : undefined
                        }
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
                          const address =
                            addresses?.[ri]?.[columnOrdinal.get(col.id) ?? -1] ?? undefined;
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
                                (!tableHasSelection && rowId === visibleRows[0] && ci === 0)
                              }
                              editing={isEditing ? editing : null}
                              editable={editable}
                              readOnly={readOnly}
                              // ADR-051: the row's own outline column, not the table's.
                              outline={
                                showOutline && outlineRow?.column === col.id ? outlineRow : null
                              }
                              outlineLocked={outlineLocked}
                              column={col}
                              rowMeta={rowMetaOf}
                              locale={locale}
                              undo={undo ?? null}
                              frozen={frozenIds.has(col.id)}
                              freezeEdge={col.id === freezeEdgeId}
                              // ADR-049: wrap is cell > row > column > table; the row's height is
                              // separate data, so a tall row shows its unwrapped cells on one line.
                              wrap={effectiveWrap(table, col, rowId, record.look.wrap)}
                              rowUnits={rowUnits}
                              other={other}
                              version={versions.of(cellKey(rowId, col.id))}
                              look={lookOf(col, rowId)}
                              traversal={traversal}
                              actions={actions}
                              commands={commands}
                            />
                          );
                        })}
                        {/* ADR-049: the row's handle and divider live in the gutter GeDe draws
                            left of the table while it is selected (Numbers' row header) — a
                            `rowheader` named "Row 5", the row's last child so it is never in
                            the Tab path the grid owns; ⌥↓ / ⌥↑ from a cell focus the edge below
                            or above (A11Y-01); the handle selects the row (Shift extends). */}
                        {showAffordances && (
                          <div role="rowheader" className="gd-table__row-head" aria-label={rowName}>
                            <button
                              type="button"
                              className="gd-table__row-handle"
                              tabIndex={-1}
                              aria-label={`Select ${rowName.toLowerCase()}`}
                              aria-pressed={rowInBand}
                              title={`${rowName}: click to select, Shift-click to extend`}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                if (e.button !== 0) return;
                                actions.selectBand(record.id, 'row', rowId, e.shiftKey);
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                              }}
                            >
                              <span aria-hidden="true">{rowName.replace(/^Row ?/, '')}</span>
                            </button>
                            <RowDivider
                              name={rowName}
                              units={storedHeights[ri] ?? 1}
                              tabStop={rowSelected}
                              scale={scale}
                              onPreview={(preview) => {
                                previewRows(rowId, preview);
                              }}
                              onCommit={(next) => {
                                commitRows(rowId, next);
                              }}
                              onFit={
                                fitter.reason === undefined
                                  ? () => {
                                      fitRowIds(bandFor(rowBand, rowId));
                                    }
                                  : undefined
                              }
                              fitReason={fitter.reason}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Wrapper>
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
                {projection.hidden > 0 ? (
                  <>
                    <span className="gd-table__footer-hidden">
                      {formatNumber(activeLocale, rowCount - projection.hidden)}
                    </span>
                    {' of '}
                    {formatNumber(activeLocale, rowCount)} rows
                  </>
                ) : (
                  <>
                    {formatNumber(activeLocale, rowCount)} {rowCount === 1 ? 'row' : 'rows'}
                  </>
                )}
              </span>
              <span>
                {columnCount} {columnCount === 1 ? 'column' : 'columns'}
              </span>
            </div>
          )}
          {record.look.captionShown && (
            <div
              className="gd-table__caption"
              style={{ height: `${String(captionPx)}px` }}
              data-testid="table-caption"
            >
              {record.look.caption === '' ? (
                <span className="gd-table__caption-empty">No caption yet</span>
              ) : (
                record.look.caption
              )}
            </div>
          )}
          {pinnedLeft !== null && record.frozenColumns > 0 && (
            <PinnedPanel
              table={table}
              record={record}
              spans={spans}
              lookOf={lookOf}
              outline={showOutline ? outline : null}
              rowOrdinal={rowOrdinal}
              left={pinnedLeft}
              rowHeights={rowHeights}
              sections={sections.map((s) => ({
                band: s.band !== null,
                rows: s.band !== null && projection.collapsed.has(s.band.key) ? [] : s.rows,
              }))}
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
            heightUnits={bodyUnits}
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
  /** MENU-04: cells a span covers mirror as empty placeholders here too. */
  spans: SpanIndex;
  /** INSP-05/06: the same resolved look the grid paints, so a frozen cell mirrors its fill, border, type and span. */
  lookOf: (col: ColumnRecord, rowId: Id) => CellLook;
  /** The outline to mirror in the frozen outline column, or null while grouped or sorted (HIER-08). */
  outline: TableOutline | null;
  /** Document ordinal per row id: `rowHeights` and the outline are in document order. */
  rowOrdinal: ReadonlyMap<Id, number>;
  left: number;
  /** Heights in document row order; index by the row's ordinal in `record.rows`. */
  rowHeights: readonly number[];
  /** The grid's sections in view order: a band (one spacer row) and its visible rows. */
  sections: readonly { band: boolean; rows: readonly Id[] }[];
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
  spans,
  lookOf,
  outline,
  rowOrdinal,
  left,
  rowHeights,
  sections,
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
      {sections.map((section, si) => (
        <Fragment key={si}>
          {section.band && (
            <div className="gd-table__row gd-band" style={{ height: `${String(LATTICE.row)}px` }} />
          )}
          {section.rows.map((rowId) => {
            const ri = rowOrdinal.get(rowId) ?? 0;
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
                  const onOutline = outline !== null && outlineRow?.column === col.id;
                  const coveredBy = spans.covered.get(cellKey(rowId, col.id));
                  if (coveredBy !== undefined) {
                    const inAnchorRow = coveredBy.startsWith(`${rowId}:`);
                    return (
                      <div
                        key={col.id}
                        className="gd-cell gd-cell--frozen gd-cell--covered"
                        style={{ width: `${String(inAnchorRow ? 0 : col.width * LATTICE.col)}px` }}
                      />
                    );
                  }
                  // The mirror carries only the frozen columns: a span's box is clipped to them.
                  const grid = lookOf(col, rowId);
                  const look: CellLook =
                    grid.span === null
                      ? grid
                      : {
                          ...grid,
                          spanUnits: {
                            widthUnits: grid.span.colIds.reduce(
                              (acc, id) => acc + (columns.find((c) => c.id === id)?.width ?? 0),
                              0,
                            ),
                            heightUnits: grid.spanUnits?.heightUnits ?? 1,
                          },
                        };
                  const format = cellFormatFor(table, col, rowId);
                  const paint = paintLook(look, format);
                  return (
                    <div
                      key={col.id}
                      className={clsx('gd-cell', 'gd-cell--frozen', paint.className, {
                        'gd-cell--selected': isSelected,
                        'gd-cell--wrap': effectiveWrap(table, col, rowId, record.look.wrap),
                        'gd-cell--tall': (rowHeights[ri] ?? 1) > 1,
                        'gd-cell--outline': onOutline,
                      })}
                      style={{
                        width: `${String(col.width * LATTICE.col)}px`,
                        ...outlineStyle(onOutline ? outlineRow : undefined),
                        ...paint.style,
                      }}
                      {...paint.data}
                      onPointerDown={() => {
                        onSelect({ tableId: record.id, rowId, colId: col.id });
                      }}
                    >
                      {onOutline && <OutlineMarks row={outlineRow} control={null} />}
                      <CellContent
                        content={cellRich(table, rowId, col.id)}
                        format={format}
                        locale={locale}
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </Fragment>
      ))}
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
              // The press must neither arm the cell under it nor take focus from the
              // selected cell: the grid's one tab stop stays where it is (A11Y-01).
              e.stopPropagation();
              e.preventDefault();
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
  /**
   * Why the outline is inactive on this table, or null when it is live: the
   * chords then announce the reason instead of writing (HIER-08; sorted or
   * filtered view). Same value on every cell of the table.
   */
  outlineLocked: string | null;
  /** The column record, resolved once per table render; carries the column's data format (FMT-01). */
  column: ColumnRecord;
  /** The row's meta, resolved once per row render (REF-02 provenance, HIER-07 children). */
  rowMeta: RowMeta;
  locale: FormatLocale;
  undo: Y.UndoManager | null;
  frozen: boolean;
  freezeEdge: boolean;
  /** ADR-049: whether this cell wraps (cell > row > column > table). */
  wrap: boolean;
  /** The row's height in lattice units, for the whole-line clip (#167 criterion 11). */
  rowUnits: number;
  other: PresenceState | undefined;
  /**
   * The cell's own change counter (`grid/cell-versions.ts`): the one prop
   * that changes when this cell's text or format override changes, so the
   * memoised cell re-reads the document exactly then.
   */
  version: number;
  /** INSP-05 / INSP-06 / MENU-04: the cell's resolved look, compared by value (`looksEqual`). */
  look: CellLook;
  traversal: () => TraversalTable;
  actions: GridActions;
  commands: GridCommands;
}

/**
 * Field-by-field equality for a record the parent rebuilds every render. The
 * key set is typed against the record, so a field added to `OutlineRow`,
 * `ColumnRecord` or `FormatOpts` without a line here fails to compile rather
 * than silently never re-rendering the memoised cell.
 */
function fieldsEqual<T extends object>(keys: Readonly<Record<keyof T, true>>, a: T, b: T): boolean {
  for (const key of Object.keys(keys) as (keyof T)[]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

const OUTLINE_ROW_KEYS = {
  id: true,
  depth: true,
  collapsed: true,
  hidden: true,
  hasChildren: true,
  parent: true,
  splitChild: true,
  canNest: true,
  canPromote: true,
  column: true,
} as const satisfies Record<keyof OutlineRow, true>;

const FORMAT_OPTS_KEYS = {
  decimals: true,
  grouping: true,
  currency: true,
  datePattern: true,
  textCase: true,
} as const satisfies Record<keyof FormatOpts, true>;

const COLUMN_KEYS = {
  id: true,
  label: true,
  width: true,
  hidden: true,
  wrap: true,
  source: true,
  format: true,
  formatOpts: true,
  derive: true,
  link: true,
  pull: true,
  appearance: true,
  rules: true,
} as const satisfies Record<keyof ColumnRecord, true>;

/** REF-02..04 specs are plain JSON rebuilt per render; compare by content. */
function specsEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

const ROW_META_KEYS = {
  depth: true,
  collapsed: true,
  height: true,
  fit: true,
  wrap: true,
  group: true,
  splitChild: true,
  pulledFrom: true,
  splitOf: true,
  outlineColumn: true,
} as const satisfies Record<keyof RowMeta, true>;

function rowMetaEqual(a: RowMeta, b: RowMeta): boolean {
  const { pulledFrom: _pa, splitOf: _sa, ...restA } = a;
  const { pulledFrom: _pb, splitOf: _sb, ...restB } = b;
  const { pulledFrom: _k1, splitOf: _k2, ...restKeys } = ROW_META_KEYS;
  return (
    fieldsEqual(restKeys, restA, restB) &&
    specsEqual(a.pulledFrom, b.pulledFrom) &&
    specsEqual(a.splitOf, b.splitOf)
  );
}

/** The outline row is rebuilt per render too (HIER-04); compare what the cell draws. */
function outlineRowsEqual(a: OutlineRow | null, b: OutlineRow | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return fieldsEqual(OUTLINE_ROW_KEYS, a, b);
}

function columnsEqual(a: ColumnRecord, b: ColumnRecord): boolean {
  const {
    formatOpts: _a,
    derive: _da,
    link: _la,
    pull: _pa,
    appearance: _aa,
    rules: _ra,
    ...restA
  } = a;
  const {
    formatOpts: _b,
    derive: _db,
    link: _lb,
    pull: _pb,
    appearance: _ab,
    rules: _rb,
    ...restB
  } = b;
  const {
    formatOpts: _keys,
    derive: _kd,
    link: _kl,
    pull: _kp,
    appearance: _ka,
    rules: _kr,
    ...restKeys
  } = COLUMN_KEYS;
  return (
    fieldsEqual(restKeys, restA, restB) &&
    fieldsEqual(FORMAT_OPTS_KEYS, a.formatOpts, b.formatOpts) &&
    specsEqual(a.derive, b.derive) &&
    specsEqual(a.link, b.link) &&
    specsEqual(a.pull, b.pull) &&
    appearanceEqual(a.appearance, b.appearance) &&
    specsEqual(a.rules, b.rules)
  );
}

/**
 * Every prop the comparison below covers. Typed against `CellProps` so that a
 * prop added to the cell without a line here fails to compile, rather than
 * silently never re-rendering the memoised cell.
 */
const COMPARED_CELL_PROPS = {
  table: true,
  cell: true,
  widthPx: true,
  tier: true,
  address: true,
  selected: true,
  tabStop: true,
  editing: true,
  editable: true,
  readOnly: true,
  outline: true,
  outlineLocked: true,
  column: true,
  rowMeta: true,
  locale: true,
  undo: true,
  frozen: true,
  freezeEdge: true,
  wrap: true,
  rowUnits: true,
  other: true,
  version: true,
  look: true,
  traversal: true,
  actions: true,
  commands: true,
} as const satisfies Record<keyof CellProps, true>;

/**
 * Props equality for the memoised cell. `cell`, `column` and `outline` are
 * rebuilt by the parent every render, so they compare by value; everything
 * else is stable by construction or is a primitive.
 */
function cellPropsEqual(a: CellProps, b: CellProps): boolean {
  if (Object.keys(a).some((key) => !(key in COMPARED_CELL_PROPS))) return false;
  if (
    a.table !== b.table ||
    a.cell.tableId !== b.cell.tableId ||
    a.cell.rowId !== b.cell.rowId ||
    a.cell.colId !== b.cell.colId ||
    a.widthPx !== b.widthPx ||
    a.tier !== b.tier ||
    a.address !== b.address ||
    a.selected !== b.selected ||
    a.tabStop !== b.tabStop ||
    a.editing !== b.editing ||
    a.editable !== b.editable ||
    a.readOnly !== b.readOnly ||
    a.outlineLocked !== b.outlineLocked ||
    !outlineRowsEqual(a.outline, b.outline) ||
    a.locale !== b.locale ||
    a.undo !== b.undo ||
    a.frozen !== b.frozen ||
    a.freezeEdge !== b.freezeEdge ||
    a.wrap !== b.wrap ||
    a.rowUnits !== b.rowUnits ||
    a.other !== b.other ||
    a.version !== b.version ||
    a.traversal !== b.traversal ||
    a.actions !== b.actions ||
    a.commands !== b.commands ||
    !looksEqual(a.look, b.look)
  ) {
    return false;
  }
  return columnsEqual(a.column, b.column) && rowMetaEqual(a.rowMeta, b.rowMeta);
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

const Cell = memo(function Cell({
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
  outlineLocked,
  column,
  rowMeta: row,
  locale,
  undo,
  frozen,
  freezeEdge,
  wrap,
  rowUnits,
  other,
  look,
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
  // A formula cell re-projects when the workbook index changes (a label it names was
  // renamed, a row moved); text cells never subscribe, so the memoised cell stays put.
  useWorkbookIndexVersion(formula ? table.doc : null);
  const shown = formula && table.doc !== null ? projectSource(table.doc, source) : null;
  const format = cellFormatFor(table, column, cell.rowId);
  const layout = layoutCell(shown === null ? rich : richFromText(shown), format, locale);
  const text = layout.text;
  // INSP-05 / INSP-06: the paint for this look — classes, custom properties, data attributes.
  const paint = paintLook(look, format);
  // #167 criterion 11 / ADR-049: text clips at the last whole line that fits the row — the
  // lines the row's content box holds at this cell's line box, as `--gd-lines` for the
  // stylesheet's max-height; a span's box is its rows' sum.
  const cellUnits = look.spanUnits?.heightUnits ?? rowUnits;
  const linePx = lineBoxPx(look.appearance.size ?? 'cell', layout.lang !== null);
  const clipStyle = {
    '--gd-lines': String(
      Math.max(1, Math.floor((cellUnits * LATTICE.row - 1 - (wrap ? 2 : 0) + 0.5) / linePx)),
    ),
    '--gd-line-px': `${String(linePx)}px`,
  } as CSSProperties;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && editing === null) ref.current?.focus({ preventScroll: true });
  }, [selected, editing]);
  const canEdit = editable && readOnly === null;
  // REF-01..04: a reference, pulled, derived or mapping cell has its own body; a mapping
  // cell's picker is its edit affordance (Enter opens it) and is absent without edit rights.
  const refKind = tier === 'micro' ? refCellKind(column, row, source) : null;
  const picker = useRef<MappingCellHandle>(null);
  const mappingEditable =
    refKind === 'mapping' && editable && !row.group && row.pulledFrom === null && !row.splitChild;

  // ADR-049: where the last Shift-arrow left the band's far edge, so the next one extends
  // from there (the armed cell stays at the anchor).
  const bandEdgeRef = useRef<{ axis: 'row' | 'column'; id: Id } | null>(null);

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
      if (outlineLocked !== null) {
        announce(outlineLocked); // HIER-08: depth is kept, not shown, not edited
        return;
      }
      switch (hierarchy) {
        // ADR-051: the outline is drawn in the column of the selected cell.
        case 'nest':
          commands.nestRow(cell.tableId, cell.rowId, cell.colId);
          return;
        case 'promote':
          commands.promoteRow(cell.tableId, cell.rowId, cell.colId);
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
      // ADR-049 / A11Y-01: ⌥↓ focuses this row's divider (its bottom edge), ⌥↑ the row above's
      // (its top edge); the divider then takes the arrows itself. ⌥← / ⌥→ stay the hierarchy's.
      if (!mod && e.altKey && (arrow === 'down' || arrow === 'up') && editable) {
        const row = ref.current?.closest<HTMLElement>('[role="row"]') ?? null;
        const target = arrow === 'down' ? row : (row?.previousElementSibling ?? null);
        const edge = target?.querySelector<HTMLElement>('.gd-table__row-divider') ?? null;
        if (edge === null) return;
        e.preventDefault();
        e.stopPropagation();
        rearm();
        edge.focus();
        return;
      }
      if (mod || e.altKey) return; // ⌥⌘↓ / ⌥⌘→ add a row or column (the shell binds them)
      e.preventDefault();
      e.stopPropagation();
      rearm();
      // ADR-049 (Numbers): ⇧↑ / ⇧↓ select rows from this one, ⇧← / ⇧→ columns; a second
      // press extends the band by one. An editable table only: a band exists to be resized.
      if (e.shiftKey) {
        if (!editable) return;
        const t = traversal();
        const axis = arrow === 'up' || arrow === 'down' ? 'row' : 'column';
        const order = axis === 'row' ? t.rows : t.columns.filter((c) => !c.hidden).map((c) => c.id);
        const bandEdge = bandEdgeRef.current;
        const from =
          bandEdge?.axis === axis ? bandEdge.id : axis === 'row' ? cell.rowId : cell.colId;
        const at = order.indexOf(from);
        const next =
          order[
            Math.min(
              order.length - 1,
              Math.max(0, at + (arrow === 'down' || arrow === 'right' ? 1 : -1)),
            )
          ];
        if (next === undefined) return;
        bandEdgeRef.current = { axis, id: next };
        actions.selectBand(cell.tableId, axis, next, true);
        return;
      }
      bandEdgeRef.current = null;
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
        if (mappingEditable) {
          picker.current?.open();
          return;
        }
        if (readOnly !== null) {
          refuse();
          return;
        }
        actions.dispatch({ type: 'edit', seed: { kind: 'existing' }, cell });
        return;
      case 'Delete':
      case 'Backspace':
        if (mod) return;
        // ADR-047 (#163): only the armed cell clears. With the table selected (⌘A, or a press
        // on its title) this cell still holds DOM focus but is not armed; the keystroke is the
        // shell's, which deletes the table.
        if (!selected) return;
        e.preventDefault();
        e.stopPropagation();
        if (editable) commands.clearCell(cell);
        return;
      case 'Tab': {
        if (mod || e.altKey) return; // ⌃⇥ switches sheets (the shell binds it)
        const direction: Direction = e.shiftKey ? 'left' : 'right';
        const result = nextCell(traversal(), cell, direction);
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
    // KEYS-01 (ADR-042, #136): `?` (Shift+/ by physical key) opens the shortcut sheet from an
    // armed cell as from anywhere else; the shell's binding takes it. Type-to-edit yields to
    // that one chord — Enter then `?` types the character.
    if (matchesChord(e, CHORDS.shortcutSheet, isApplePlatform())) return;
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
  // MENU-04: a cell under another cell's span keeps its width in the row and nothing else —
  // no content, no tab stop, hidden from assistive tech, like a hidden column's cells.
  if (look.covered) {
    return (
      <div
        className="gd-cell gd-cell--covered"
        style={{ width: `${String(look.coveredInAnchorRow ? 0 : widthPx)}px` }}
        aria-hidden="true"
        data-address={address}
        data-row-id={cell.rowId}
        data-col-id={cell.colId}
        data-covered="true"
      />
    );
  }
  const lockLabel = readOnly === null ? undefined : `Read-only: ${readOnlyLabel(readOnly)}`;
  // KEYS-08 (#136): the chevron names its chord, so ⌥← / ⌥→ have a route beside the command.
  const chevronControl =
    outline !== null && outline.hasChildren && editable
      ? {
          label: `${outline.collapsed ? 'Expand' : 'Collapse'} ${address ?? 'row'} (${outline.collapsed ? HIER_LABELS.expand : HIER_LABELS.collapse})`,
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
      aria-colspan={look.span === null || look.span.cols === 1 ? undefined : look.span.cols}
      aria-rowspan={look.span === null || look.span.rows === 1 ? undefined : look.span.rows}
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
      className={clsx('gd-cell', paint.className, {
        'gd-cell--selected': selected,
        'gd-cell--editing': editing !== null,
        'gd-cell--presence': other !== undefined,
        'gd-cell--locked': readOnly !== null,
        'gd-cell--frozen': frozen,
        'gd-cell--freeze-edge': freezeEdge,
        'gd-cell--wrap': wrap,
        'gd-cell--tall': cellUnits > 1,
        'gd-cell--outline': outline !== null,
      })}
      style={{
        width: `${String(widthPx)}px`,
        ...presenceStyle,
        ...outlineStyle(outline ?? undefined),
        ...paint.style,
        ...clipStyle,
      }}
      {...paint.data}
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
      data-row-id={cell.rowId}
      data-col-id={cell.colId}
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
      ) : refKind === 'reference' || refKind === 'pulled' ? (
        // FX-07 / REF-01 (ADR-043): the path shows in every row — beside the value in a
        // compact row (document.css), beneath it in a wrapped one.
        <ReferenceCell table={table} cell={cell} kind={refKind} expression />
      ) : refKind === 'derived' && column.derive !== null ? (
        // A derived cell's pipeline is the lineage header's (ADR-032); its expression takes
        // its own line only in a row of two or more units (ADR-043, ADR-049).
        <DerivedCell table={table} cell={cell} spec={column.derive} expression={cellUnits > 1} />
      ) : refKind === 'mapping' && column.link !== null ? (
        <MappingCell
          ref={picker}
          table={table}
          cell={cell}
          link={column.link}
          address={address}
          editable={mappingEditable}
          active={selected}
          onPick={(value, locale) => commands.pickMappingValue(cell, value, locale)}
        />
      ) : formula && tier === 'micro' ? (
        <FormulaCell table={table} cell={cell} expression format={format} />
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
      {/* INSP-05 / A11Y-04: a matched rule carries a glyph with the rule's words, never a tint alone. */}
      {paint.ruleLabel !== null && (
        <span className="gd-cell__rule" title={paint.ruleLabel}>
          <Icon name="rule" size={13} label={paint.ruleLabel} />
        </span>
      )}
      {other !== undefined && (
        <span className="gd-cell__presence-tag" aria-label={`${other.name} is here`}>
          {other.name}
        </span>
      )}
    </div>
  );
}, cellPropsEqual);
