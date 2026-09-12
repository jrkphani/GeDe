/**
 * Arrange (INSP-07): stacking order, canvas layout, pin to viewport and the
 * DAG edges between tables. Stacking and pinning are keys on the table map;
 * a layout is a one-shot placement that writes `gridCol` / `gridRow` — the
 * positions stay data (non-negotiable 3) and every address follows its
 * table's origin (RESP-01). Edge visibility is a key on the sheet map; the
 * edges themselves are read from the id-bound formula tokens (PRD §7
 * "Connecting Edges", §20) and never stored.
 */
import {
  cellsMap,
  columnRecord,
  columnsArray,
  isFormula,
  readBoolean,
  readString,
  tableMap,
  tableUnitBounds,
  tablesOnSheet,
  type GedeDoc,
  type SheetMap,
} from '../doc/index.js';
import { tokenize } from '../formula/tokenizer.js';
import type { BoundReference } from '../formula/bound.js';
import type { Id } from '../ids.js';
import { requireTable, transact } from './write.js';

// ---------------------------------------------------------------------------
// Stacking order
// ---------------------------------------------------------------------------

/** Tables in paint order: lowest `z` first, ties by id (creation order). */
export function stackingOrder<T extends { readonly id: Id; readonly z: number }>(
  tables: readonly T[],
): T[] {
  return [...tables].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const STACKING_MOVES = ['back', 'backward', 'forward', 'front'] as const;
export type StackingMove = (typeof STACKING_MOVES)[number];
export const STACKING_LABELS: Readonly<Record<StackingMove, string>> = {
  back: 'Back',
  backward: 'Backward',
  forward: 'Forward',
  front: 'Front',
};

/** Where the table sits in its sheet's paint order: 0 = at the back. */
export function stackingPosition(
  gd: GedeDoc,
  tableId: Id,
): { index: number; count: number } | null {
  const record = tableMap(gd, tableId);
  if (record === null) return null;
  const order = stackingOrder(tablesOnSheet(gd, readString(record, 'sheetId')));
  const index = order.findIndex((t) => t.id === tableId);
  return index < 0 ? null : { index, count: order.length };
}

/**
 * Move a table in the stacking order. Writes `z` for the sheet's tables as a
 * dense 0…n−1 sequence in the new order, one transaction. Returns the new
 * index, or null when the move changes nothing (already at the front, the
 * only table).
 */
export function restack(gd: GedeDoc, tableId: Id, move: StackingMove): number | null {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const order = stackingOrder(tablesOnSheet(gd, readString(table, 'sheetId')));
    const from = order.findIndex((t) => t.id === tableId);
    if (from < 0) return null;
    const last = order.length - 1;
    const to =
      move === 'back' ? 0 : move === 'front' ? last : move === 'backward' ? from - 1 : from + 1;
    if (to === from || to < 0 || to > last) return null;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return null;
    next.splice(to, 0, moved);
    next.forEach((t, z) => {
      const map = tableMap(gd, t.id);
      if (map !== null && map.get('z') !== z) map.set('z', z);
    });
    return to;
  });
}

// ---------------------------------------------------------------------------
// Pin to viewport (PRD §10)
// ---------------------------------------------------------------------------

export function setTablePinned(gd: GedeDoc, tableId: Id, pinned: boolean): void {
  transact(gd, () => {
    const table = requireTable(gd, tableId);
    if (pinned) table.set('pinned', true);
    else table.delete('pinned');
  });
}

// ---------------------------------------------------------------------------
// Canvas layout (prototype "align on canvas": Side by side / Pipeline lanes / Stacked)
// ---------------------------------------------------------------------------

export const CANVAS_LAYOUTS = ['side-by-side', 'lanes', 'stacked'] as const;
export type CanvasLayout = (typeof CANVAS_LAYOUTS)[number];
export const CANVAS_LAYOUT_LABELS: Readonly<Record<CanvasLayout, string>> = {
  'side-by-side': 'Side by side',
  lanes: 'Pipeline lanes',
  stacked: 'Stacked',
};

/** Gaps between placed tables, in lattice units (the prototype's 160 px and 88 px). */
export const LAYOUT_GAP = { cols: 1, rows: 4, stagger: 6 } as const;

/**
 * Place every table on the sheet by the layout, in stacking order, from the
 * first table's origin: lanes lay them left to right on one row; stacked
 * lays them top to bottom in one column; side by side lays them left to
 * right with every second table dropped by `stagger` rows, as the prototype
 * does. Returns the tables moved (their new origins).
 */
export function layoutSheet(
  gd: GedeDoc,
  sheetId: Id,
  layout: CanvasLayout,
): { id: Id; col: number; row: number }[] {
  return transact(gd, () => {
    const order = stackingOrder(tablesOnSheet(gd, sheetId));
    const first = order[0];
    if (first === undefined) return [];
    const originCol = Math.min(...order.map((t) => t.gridCol));
    const originRow = Math.min(...order.map((t) => t.gridRow));
    let col = originCol;
    let row = originRow;
    const moved: { id: Id; col: number; row: number }[] = [];
    order.forEach((t, i) => {
      const map = tableMap(gd, t.id);
      if (map === null) return;
      const bounds = tableUnitBounds(map, t);
      let at: { col: number; row: number };
      if (layout === 'stacked') {
        at = { col: originCol, row };
        row += bounds.rows + LAYOUT_GAP.rows;
      } else if (layout === 'lanes') {
        at = { col, row: originRow };
        col += bounds.cols + LAYOUT_GAP.cols;
      } else {
        at = { col, row: originRow + (i % 2) * LAYOUT_GAP.stagger };
        col += bounds.cols + LAYOUT_GAP.cols;
      }
      if (map.get('gridCol') !== at.col) map.set('gridCol', at.col);
      if (map.get('gridRow') !== at.row) map.set('gridRow', at.row);
      moved.push({ id: t.id, ...at });
    });
    return moved;
  });
}

// ---------------------------------------------------------------------------
// DAG edges
// ---------------------------------------------------------------------------

function sheetMapOf(gd: GedeDoc, sheetId: Id): SheetMap | null {
  return gd.sheets.toArray().find((s) => readString(s, 'id') === sheetId) ?? null;
}

/** Whether the sheet draws its DAG edges (off until switched on, PRD §7 "can be toggled on"). */
export function sheetEdgesShown(gd: GedeDoc, sheetId: Id): boolean {
  const sheet = sheetMapOf(gd, sheetId);
  return sheet === null ? false : readBoolean(sheet, 'edgesShown', false);
}

export function setSheetEdgesShown(gd: GedeDoc, sheetId: Id, shown: boolean): boolean {
  return transact(gd, () => {
    const sheet = sheetMapOf(gd, sheetId);
    if (sheet === null) return false;
    if (shown) sheet.set('edgesShown', true);
    else sheet.delete('edgesShown');
    return true;
  });
}

export interface DagEdge {
  /** The table read from. */
  readonly from: Id;
  /** The table whose formulas read it. */
  readonly to: Id;
  /** Formula cells in `to` that read `from`. */
  readonly count: number;
  /** True when the two tables are on different sheets: reported, not drawn (PRD §11). */
  readonly crossSheet: boolean;
}

function referencedTables(ref: BoundReference): Id[] {
  switch (ref.kind) {
    case 'cell':
    case 'range':
      return [ref.tableId];
    case 'column':
      return ref.columns.map((c) => c.tableId);
  }
}

/**
 * The table-to-table dependency edges that touch a sheet: one edge per
 * (from, to) pair, counted, from every reader anywhere in the workbook —
 * the id-bound tokens of its formula cells (typed formulas, reference cells,
 * pulled cells), its mapping columns (REF-03 `link`) and its pull columns
 * (REF-02 `pull`, whether or not the filter matches a row today). Self-
 * references are not edges. An edge is returned when either end is on the
 * sheet; one whose other end is elsewhere carries `crossSheet` — reported
 * numerically in both directions, never drawn (PRD §11).
 */
export function dagEdges(gd: GedeDoc, sheetId: Id): DagEdge[] {
  const counts = new Map<string, DagEdge>();
  const sheetOf = new Map<Id, Id>();
  gd.tables.forEach((map, id) => {
    sheetOf.set(id, readString(map, 'sheetId'));
  });
  const add = (from: Id, to: Id, n: number) => {
    if (from === to || !sheetOf.has(from)) return;
    const fromSheet = sheetOf.get(from);
    const toSheet = sheetOf.get(to);
    if (fromSheet !== sheetId && toSheet !== sheetId) return;
    const key = `${from}>${to}`;
    const edge = counts.get(key);
    counts.set(key, {
      from,
      to,
      count: (edge?.count ?? 0) + n,
      crossSheet: fromSheet !== toSheet,
    });
  };
  gd.tables.forEach((map, to) => {
    for (const column of columnsArray(map).toArray()) {
      const record = columnRecord(column);
      if (record.link !== null) add(record.link.tableId, to, 1);
      if (record.pull !== null) add(record.pull.tableId, to, 1);
    }
    cellsMap(map).forEach((value) => {
      if (!isFormula(value)) return;
      const tokens = tokenize(value);
      if (!tokens.ok) return;
      const seen = new Set<Id>();
      for (const token of tokens.tokens) {
        if (token.kind !== 'bound' || typeof token.value !== 'object') continue;
        for (const from of referencedTables(token.value)) {
          if (seen.has(from)) continue;
          seen.add(from);
          add(from, to, 1);
        }
      }
    });
  });
  return Array.from(counts.values());
}

/** The edges touching one table, for the inspector's count line. */
export function edgesOf(
  edges: readonly DagEdge[],
  tableId: Id,
): { in: number; out: number; crossSheet: number } {
  let inbound = 0;
  let out = 0;
  let crossSheet = 0;
  for (const e of edges) {
    if (e.to === tableId) inbound += 1;
    if (e.from === tableId) out += 1;
    if ((e.to === tableId || e.from === tableId) && e.crossSheet) crossSheet += 1;
  }
  return { in: inbound, out, crossSheet };
}
