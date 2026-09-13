/**
 * Graph mutations (GRAPH-01..05, GRAPH-10, GRAPH-11). Every write is one
 * `transact` under the local origin — one gesture, one undo step, one sync
 * message — and every position or size snaps to whole lattice units before
 * it is stored. A pair's shared state (table, dimensions, slice) is written
 * to both halves in the same transaction; each half reads its own copy, so a
 * merge converges half by half and the halves cannot disagree.
 */
import * as Y from 'yjs';

import { sheetBounds, tableUnitBounds } from '../doc/geometry.js';
import { addRow, createSheet, createTable, deleteTable, setCellText } from '../doc/mutations.js';
import {
  EMPTY_SLICE,
  GRAPH_DEFAULT_HEIGHT_UNITS,
  GRAPH_DEFAULT_WIDTH_UNITS,
  GRAPH_MIN_HEIGHT_UNITS,
  GRAPH_MIN_WIDTH_UNITS,
  columnsArray,
  graphById,
  graphMap,
  graphRecord,
  graphsInPair,
  readString,
  tableById,
  tableMap,
  tablesOnSheet,
  type GedeDoc,
  type GraphKind,
  type GraphMap,
  type GraphRecord,
  type GraphSlice,
  type TableRecord,
} from '../doc/schema.js';
import { newId, type Id } from '../ids.js';
import { snapPoint, type LatticeUnits, type Pixels } from '../lattice.js';
import { isGraphDimensionCandidate } from '../ref/graph.js';

function transact<T>(gd: GedeDoc, fn: () => T): T {
  let out!: T;
  gd.doc.transact(() => {
    out = fn();
  }, gd.origin);
  return out;
}

function isPixels(at: LatticeUnits | Pixels): at is Pixels {
  return 'x' in at;
}

function snapUnits(at: LatticeUnits): LatticeUnits {
  if (!Number.isFinite(at.col) || !Number.isFinite(at.row)) {
    throw new RangeError(`lattice units must be finite, got ${String(at.col)},${String(at.row)}`);
  }
  return { col: Math.max(0, Math.round(at.col)), row: Math.max(0, Math.round(at.row)) };
}

/** The pre-shaped table's columns (PRD §19 "Dimension A · B · C · Notes"). */
export const SHAPED_TABLE_COLUMNS: readonly string[] = [
  'Dimension A',
  'Dimension B',
  'Dimension C',
  'Notes',
];
export const SHAPED_TABLE_ROWS = 6;
/** Dimensions a fresh binding starts with: the first eligible columns, up to this many. */
export const DEFAULT_DIMENSION_COUNT = 3;
/** Lattice gutter between the two halves and below the tables (GRAPH-01 "side by side below"). */
const PAIR_GUTTER_UNITS = 1;

/** The dimensions a binding starts with (REF-05 applied): the first eligible columns. */
export function defaultDimensions(record: TableRecord): Id[] {
  return record.columns
    .filter((c) => isGraphDimensionCandidate(c))
    .slice(0, DEFAULT_DIMENSION_COUNT)
    .map((c) => c.id);
}

export interface GraphPair {
  readonly pairId: Id;
  readonly ringId: Id;
  readonly coverageId: Id;
}

export interface CreateGraphPairOptions {
  sheetId: Id;
  /** The source table, or null for an unbound pair awaiting pointing (GRAPH-03). */
  tableId: Id | null;
  /** Lattice origin of the ring; the coverage sits one gutter to its right. Default: below the sheet's objects. */
  at?: LatticeUnits | undefined;
  widthUnits?: number | undefined;
  heightUnits?: number | undefined;
}

function newGraphMap(
  kind: GraphKind,
  shared: {
    sheetId: Id;
    pairId: Id;
    tableId: Id | null;
    dimensions: readonly Id[];
    slice: GraphSlice;
  },
  at: LatticeUnits,
  size: { widthUnits: number; heightUnits: number },
): { id: Id; map: GraphMap } {
  const id = newId();
  const map: GraphMap = new Y.Map<unknown>();
  map.set('id', id);
  map.set('sheetId', shared.sheetId);
  map.set('pairId', shared.pairId);
  map.set('kind', kind);
  map.set('tableId', shared.tableId ?? '');
  map.set('dimensions', [...shared.dimensions]);
  map.set('slice', sliceJson(shared.slice));
  map.set('gridCol', at.col);
  map.set('gridRow', at.row);
  map.set('widthUnits', size.widthUnits);
  map.set('heightUnits', size.heightUnits);
  return { id, map };
}

function sliceJson(slice: GraphSlice): {
  rowAxis: Id | null;
  colAxis: Id | null;
  pins: Record<Id, string>;
} {
  return { rowAxis: slice.rowAxis, colAxis: slice.colAxis, pins: { ...slice.pins } };
}

/** Where a new pair goes: one gutter row below everything on the sheet, from its left edge. */
export function defaultPairOrigin(gd: GedeDoc, sheetId: Id): LatticeUnits {
  const bounds = sheetBounds(gd, sheetId);
  if (bounds === null) return { col: 1, row: 1 };
  return { col: bounds.col, row: bounds.row + bounds.rows + PAIR_GUTTER_UNITS };
}

/**
 * GRAPH-01: one linked ring and coverage pair, side by side. Bound to
 * `tableId` with that table's default dimensions, or unbound.
 */
export function createGraphPair(gd: GedeDoc, options: CreateGraphPairOptions): GraphPair {
  const widthUnits = Math.max(
    GRAPH_MIN_WIDTH_UNITS,
    Math.round(options.widthUnits ?? GRAPH_DEFAULT_WIDTH_UNITS),
  );
  const heightUnits = Math.max(
    GRAPH_MIN_HEIGHT_UNITS,
    Math.round(options.heightUnits ?? GRAPH_DEFAULT_HEIGHT_UNITS),
  );
  return transact(gd, () => {
    const table = options.tableId === null ? null : tableById(gd, options.tableId);
    const at =
      options.at === undefined ? defaultPairOrigin(gd, options.sheetId) : snapUnits(options.at);
    const pairId = newId();
    const shared = {
      sheetId: options.sheetId,
      pairId,
      tableId: table?.id ?? null,
      dimensions: table === null ? [] : defaultDimensions(table),
      slice: EMPTY_SLICE,
    };
    const size = { widthUnits, heightUnits };
    const ring = newGraphMap('ring', shared, at, size);
    const coverage = newGraphMap(
      'coverage',
      shared,
      { col: at.col + widthUnits + PAIR_GUTTER_UNITS, row: at.row },
      size,
    );
    gd.graphs.set(ring.id, ring.map);
    gd.graphs.set(coverage.id, coverage.map);
    return { pairId, ringId: ring.id, coverageId: coverage.id };
  });
}

function pairMaps(gd: GedeDoc, pairId: Id): GraphMap[] {
  return graphsInPair(gd, pairId)
    .map((g) => graphMap(gd, g.id))
    .filter((m): m is GraphMap => m !== null);
}

/**
 * GRAPH-03 / GRAPH-05 Re-point: bind (or re-bind) both halves to a table.
 * Dimensions start again from the table's defaults and the slice is cleared,
 * since the old column ids mean nothing in the new table. Returns false when
 * the pair or the table is not in the document.
 */
export function bindGraphPair(gd: GedeDoc, pairId: Id, tableId: Id): boolean {
  return transact(gd, () => {
    const table = tableById(gd, tableId);
    const maps = pairMaps(gd, pairId);
    if (table === null || maps.length === 0) return false;
    const dimensions = defaultDimensions(table);
    for (const map of maps) {
      map.set('tableId', tableId);
      map.set('dimensions', dimensions);
      map.set('slice', sliceJson(EMPTY_SLICE));
    }
    return true;
  });
}

/** GRAPH-05: the dimension checklist. Ineligible or unknown columns are dropped (REF-05). */
export function setGraphDimensions(gd: GedeDoc, pairId: Id, dimensions: readonly Id[]): Id[] {
  return transact(gd, () => {
    const maps = pairMaps(gd, pairId);
    const first = maps[0];
    if (first === undefined) return [];
    const tableId = readString(first, 'tableId');
    const table = tableId === '' ? null : tableById(gd, tableId);
    const eligible = new Set(
      (table?.columns ?? []).filter((c) => isGraphDimensionCandidate(c)).map((c) => c.id),
    );
    const next: Id[] = [];
    for (const id of dimensions) if (eligible.has(id) && !next.includes(id)) next.push(id);
    for (const map of maps) map.set('dimensions', next);
    return next;
  });
}

/** Toggle one column in the checklist, keeping table order for the dimension list. */
export function toggleGraphDimension(gd: GedeDoc, pairId: Id, colId: Id, on: boolean): Id[] {
  const first = graphsInPair(gd, pairId)[0];
  if (first === undefined) return [];
  const table = first.tableId === null ? null : tableById(gd, first.tableId);
  const current = new Set(first.dimensions);
  if (on) current.add(colId);
  else current.delete(colId);
  const ordered = (table?.columns ?? []).map((c) => c.id).filter((id) => current.has(id));
  return setGraphDimensions(gd, pairId, ordered);
}

/** GRAPH-08: the coverage axes and pins, shared by the pair. */
export function setGraphSlice(gd: GedeDoc, pairId: Id, slice: GraphSlice): void {
  transact(gd, () => {
    for (const map of pairMaps(gd, pairId)) map.set('slice', sliceJson(slice));
  });
}

/** GRAPH-11: move one half; pixels snap to the lattice, units clamp at A1. */
export function setGraphPosition(gd: GedeDoc, graphId: Id, at: LatticeUnits | Pixels): void {
  const origin = isPixels(at) ? snapPoint(at) : snapUnits(at);
  transact(gd, () => {
    const map = graphMap(gd, graphId);
    if (map === null) return;
    map.set('gridCol', origin.col);
    map.set('gridRow', origin.row);
  });
}

/** GRAPH-11: resize one half to whole units, never below the minimum box. Returns what was stored. */
export function setGraphSize(
  gd: GedeDoc,
  graphId: Id,
  size: { widthUnits: number; heightUnits: number },
): { widthUnits: number; heightUnits: number } {
  const widthUnits = Math.max(GRAPH_MIN_WIDTH_UNITS, Math.round(size.widthUnits));
  const heightUnits = Math.max(GRAPH_MIN_HEIGHT_UNITS, Math.round(size.heightUnits));
  transact(gd, () => {
    const map = graphMap(gd, graphId);
    if (map === null) return;
    map.set('widthUnits', widthUnits);
    map.set('heightUnits', heightUnits);
  });
  return { widthUnits, heightUnits };
}

/** GRAPH-05 Remove: both halves go together. Returns the ids removed. */
export function removeGraphPair(gd: GedeDoc, pairId: Id): Id[] {
  return transact(gd, () => {
    const ids = graphsInPair(gd, pairId).map((g) => g.id);
    for (const id of ids) gd.graphs.delete(id);
    return ids;
  });
}

/**
 * ADR-047: remove one graph object — one half of a pair — and leave the other
 * bound to the table. A lone half is a valid pair: it carries the shared state
 * itself, so every pair mutation keeps working on it. One transaction, one
 * undo step. Returns false when the graph is not in the document.
 */
export function removeGraph(gd: GedeDoc, graphId: Id): boolean {
  return transact(gd, () => {
    if (graphMap(gd, graphId) === null) return false;
    gd.graphs.delete(graphId);
    return true;
  });
}

/** `removeGraph` addressed by pair and kind. Returns the id removed, or null when there is no such half. */
export function removeGraphObject(gd: GedeDoc, pairId: Id, kind: GraphKind): Id | null {
  return transact(gd, () => {
    const half = graphsInPair(gd, pairId).find((g) => g.kind === kind);
    if (half === undefined || !removeGraph(gd, half.id)) return null;
    return half.id;
  });
}

/**
 * ADR-047: collapse one half to its header strip, or expand it. Position and
 * the stored size are untouched, so the expand restores the box exactly.
 * Returns false when the graph is gone or already reads that way.
 */
export function setGraphCollapsed(gd: GedeDoc, graphId: Id, collapsed: boolean): boolean {
  return transact(gd, () => {
    const map = graphMap(gd, graphId);
    if (map === null || graphRecord(map).collapsed === collapsed) return false;
    if (collapsed) map.set('collapsed', true);
    else map.delete('collapsed');
    return true;
  });
}

/** Every graph object bound to `tableId`, on any sheet. */
export function graphsBoundTo(gd: GedeDoc, tableId: Id): GraphRecord[] {
  const out: GraphRecord[] = [];
  gd.graphs.forEach((map) => {
    const record = graphRecord(map);
    if (record.tableId === tableId) out.push(record);
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * ADR-047: delete a table and every graph object bound to it in one
 * transaction — one undo step restores the table, its cells and meta, and the
 * pairs. Returns the graph ids removed with it, or null when the table is gone.
 */
export function deleteTableWithGraphs(gd: GedeDoc, tableId: Id): Id[] | null {
  return transact(gd, () => {
    if (tableMap(gd, tableId) === null) return null;
    const ids = graphsBoundTo(gd, tableId).map((g) => g.id);
    for (const id of ids) gd.graphs.delete(id);
    deleteTable(gd, tableId);
    return ids;
  });
}

/** The pair a graph belongs to, or null. */
export function pairOf(gd: GedeDoc, graphId: Id): Id | null {
  return graphById(gd, graphId)?.pairId ?? null;
}

// ---------------------------------------------------------------------------
// Tables the graphs create (GRAPH-04, GRAPH-10)
// ---------------------------------------------------------------------------

export interface ShapedTableOptions {
  sheetId: Id;
  at: LatticeUnits;
  title?: string | undefined;
}

/**
 * A pre-shaped table: Dimension A · B · C · Notes with six empty rows, titled
 * `Contexts N` unless told otherwise; called inside a transaction.
 */
function shapeTable(gd: GedeDoc, options: ShapedTableOptions): Id {
  const id = createTable(gd, {
    sheetId: options.sheetId,
    at: options.at,
    columns: SHAPED_TABLE_COLUMNS.length,
    rows: SHAPED_TABLE_ROWS,
    title: options.title ?? `Contexts ${String(tablesOnSheet(gd, options.sheetId).length + 1)}`,
  });
  const table = tableMap(gd, id);
  if (table !== null) {
    columnsArray(table)
      .toArray()
      .forEach((column, i) => {
        const label = SHAPED_TABLE_COLUMNS[i];
        if (label !== undefined) column.set('label', label);
      });
  }
  return id;
}

/** GRAPH-04 "Add shaped table" on its own: the table, nothing bound. */
export function createShapedTable(gd: GedeDoc, options: ShapedTableOptions): Id {
  return transact(gd, () => shapeTable(gd, options));
}

/**
 * GRAPH-04: a shaped table and a pair bound to it in one step (one undo).
 * The table goes at `at`; the pair below it.
 */
export function createShapedTableWithGraph(
  gd: GedeDoc,
  options: ShapedTableOptions,
): { tableId: Id } & GraphPair {
  return transact(gd, () => {
    const tableId = shapeTable(gd, options);
    const map = tableMap(gd, tableId);
    const record = map === null ? null : tableById(gd, tableId);
    const below =
      map === null || record === null
        ? undefined
        : (() => {
            const b = tableUnitBounds(map, record);
            return { col: b.col, row: b.row + b.rows + PAIR_GUTTER_UNITS };
          })();
    const pair = createGraphPair(gd, { sheetId: options.sheetId, tableId, at: below });
    return { tableId, ...pair };
  });
}

/**
 * GRAPH-04 Re-point variant: a shaped table bound to an existing pair, one step.
 * Returns the table id, or null when the pair is gone.
 */
export function bindShapedTable(gd: GedeDoc, pairId: Id, options: ShapedTableOptions): Id | null {
  return transact(gd, () => {
    if (graphsInPair(gd, pairId).length === 0) return null;
    const tableId = shapeTable(gd, options);
    bindGraphPair(gd, pairId, tableId);
    return tableId;
  });
}

/**
 * GRAPH-10: append a row pre-filled with a tuple (dimension column id →
 * value), one transaction. Returns the row id, or null when the table is gone.
 */
export function appendRowWithValues(
  gd: GedeDoc,
  tableId: Id,
  values: Readonly<Record<Id, string>>,
): Id | null {
  return transact(gd, () => {
    if (tableMap(gd, tableId) === null) return null;
    // Nested transacts join the outer transaction: the row and its cells are one step.
    const rowId = addRow(gd, tableId);
    for (const [colId, value] of Object.entries(values)) {
      if (value !== '') setCellText(gd, tableId, rowId, colId, value);
    }
    return rowId;
  });
}

export interface ChildSheetOptions {
  /** The context's symbol; the sheet is named after it (GRAPH-10). */
  symbol: string;
  /** The context's tuple, recorded as the sheet's `parentContext` (PRD §11). */
  tupleKey: string;
}

/**
 * GRAPH-10 double-click: a new sheet named after the symbol, holding a shaped
 * child table for that context's children. One transaction. Returns the ids.
 */
export function createChildSheet(
  gd: GedeDoc,
  options: ChildSheetOptions,
): { sheetId: Id; tableId: Id } {
  return transact(gd, () => {
    const sheetId = createSheet(gd, {
      label: options.symbol,
      parentContext: `${options.symbol}${options.tupleKey === '' ? '' : ` — ${options.tupleKey}`}`,
    });
    const tableId = shapeTable(gd, {
      sheetId,
      at: { col: 1, row: 1 },
      title: `Children of ${options.symbol}`,
    });
    return { sheetId, tableId };
  });
}
