/**
 * Merged cells (MENU-04) as visual spans — ADR in PR: the lattice model has
 * one address per position (GRID-01, non-negotiable 3), so a merge cannot
 * remove positions. A span is stored on its anchor (top-left) cell as a count
 * of rows and columns; the covered cells keep their ids, addresses and data
 * — the span hides them the way a hidden column hides its cells (GRID-02) —
 * and unmerging shows them again unchanged. Addresses are never touched:
 * `cellAddress` answers the same before, during and after a merge.
 *
 * Storage: `spans` Y.Map on the table, `rowId:colId` → `{ rows, cols }`.
 * Resolution is against today's row and column order and clipped to the
 * table, so a deleted covered row simply shrinks the span.
 */
import { cellKey, splitCellKey, type CellKey, type Id } from '../ids.js';
import {
  readMap,
  tableRecord,
  type GedeDoc,
  type TableMap,
  type TableRecord,
} from '../doc/schema.js';
import { nestedMap, requireTable, transact } from './write.js';

export interface SpanExtent {
  readonly rows: number;
  readonly cols: number;
}

export interface CellSpan extends SpanExtent {
  readonly anchor: CellKey;
  readonly rowId: Id;
  readonly colId: Id;
  /** Row ids the span covers, anchor first, in table order. */
  readonly rowIds: readonly Id[];
  /** Column ids the span covers, anchor first, in table order (hidden columns included). */
  readonly colIds: readonly Id[];
}

export interface SpanIndex {
  /** Spans by anchor key. */
  readonly byAnchor: ReadonlyMap<CellKey, CellSpan>;
  /** For every covered (non-anchor) cell, the key of the span's anchor. */
  readonly covered: ReadonlyMap<CellKey, CellKey>;
}

const EMPTY_INDEX: SpanIndex = { byAnchor: new Map(), covered: new Map() };

function readExtent(value: unknown): SpanExtent | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const rows = typeof v.rows === 'number' ? Math.max(1, Math.round(v.rows)) : 1;
  const cols = typeof v.cols === 'number' ? Math.max(1, Math.round(v.cols)) : 1;
  return rows === 1 && cols === 1 ? null : { rows, cols };
}

/**
 * Every span on the table, resolved and clipped. A span whose anchor is gone,
 * or that would overlap an earlier span, is dropped from the index (its
 * entry stays stored, harmless, until the next write cleans it).
 */
export function spanIndex(table: TableMap, record: TableRecord = tableRecord(table)): SpanIndex {
  const map = readMap<unknown>(table, 'spans');
  if (map === null || map.size === 0) return EMPTY_INDEX;
  const rowAt = new Map(record.rows.map((id, i) => [id, i]));
  const colAt = new Map(record.columns.map((c, i) => [c.id, i]));
  const byAnchor = new Map<CellKey, CellSpan>();
  const covered = new Map<CellKey, CellKey>();
  const keys = Array.from(map.keys()).sort();
  for (const key of keys) {
    const extent = readExtent(map.get(key));
    if (extent === null) continue;
    const { rowId, colId } = splitCellKey(key);
    const r0 = rowAt.get(rowId);
    const c0 = colAt.get(colId);
    if (r0 === undefined || c0 === undefined) continue;
    const rowIds = record.rows.slice(r0, r0 + extent.rows);
    const colIds = record.columns.slice(c0, c0 + extent.cols).map((c) => c.id);
    if (rowIds.length === 1 && colIds.length === 1) continue;
    const anchor = cellKey(rowId, colId);
    const cells: CellKey[] = [];
    let clash = false;
    for (const r of rowIds) {
      for (const c of colIds) {
        const k = cellKey(r, c);
        if (k === anchor) continue;
        if (covered.has(k) || byAnchor.has(k)) clash = true;
        cells.push(k);
      }
    }
    if (clash || covered.has(anchor)) continue;
    byAnchor.set(anchor, {
      anchor,
      rowId,
      colId,
      rowIds,
      colIds,
      rows: rowIds.length,
      cols: colIds.length,
    });
    for (const k of cells) covered.set(k, anchor);
  }
  return { byAnchor, covered };
}

/** The span anchored at the cell, or null. */
export function spanAt(table: TableMap, rowId: Id, colId: Id): CellSpan | null {
  return spanIndex(table).byAnchor.get(cellKey(rowId, colId)) ?? null;
}

/** The span that hides the cell (the cell is covered, not the anchor), or null. */
export function spanCovering(table: TableMap, rowId: Id, colId: Id): CellSpan | null {
  const index = spanIndex(table);
  const anchor = index.covered.get(cellKey(rowId, colId));
  return anchor === undefined ? null : (index.byAnchor.get(anchor) ?? null);
}

export type MergeRefusal = 'unknown-cell' | 'past-edge' | 'overlaps';

/**
 * How far a span anchored at the cell could reach without running past the
 * table: the rows below and columns after the anchor, inclusive of itself.
 */
export function mergeRoom(record: TableRecord, rowId: Id, colId: Id): SpanExtent | null {
  const r0 = record.rows.indexOf(rowId);
  const c0 = record.columns.findIndex((c) => c.id === colId);
  if (r0 < 0 || c0 < 0) return null;
  return { rows: record.rows.length - r0, cols: record.columns.length - c0 };
}

/**
 * Merge the cells from the anchor across `extent` (rows × cols). Refuses,
 * writing nothing, when the extent runs past the table or overlaps another
 * span. An extent of 1 × 1 unmerges. Returns the refusal, or null on success.
 */
export function mergeCells(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  colId: Id,
  extent: SpanExtent,
): MergeRefusal | null {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const record = tableRecord(table);
    const room = mergeRoom(record, rowId, colId);
    if (room === null) return 'unknown-cell';
    const rows = Math.max(1, Math.round(extent.rows));
    const cols = Math.max(1, Math.round(extent.cols));
    if (rows > room.rows || cols > room.cols) return 'past-edge';
    const anchor = cellKey(rowId, colId);
    const index = spanIndex(table, record);
    if (index.covered.has(anchor)) return 'overlaps';
    const r0 = record.rows.indexOf(rowId);
    const c0 = record.columns.findIndex((c) => c.id === colId);
    for (const r of record.rows.slice(r0, r0 + rows)) {
      for (const c of record.columns.slice(c0, c0 + cols)) {
        const k = cellKey(r, c.id);
        if (k === anchor) continue;
        const owner = index.covered.get(k);
        if ((owner !== undefined && owner !== anchor) || index.byAnchor.has(k)) return 'overlaps';
      }
    }
    const map = nestedMap(table, 'spans', rows > 1 || cols > 1);
    if (map === null) return null;
    if (rows === 1 && cols === 1) map.delete(anchor);
    else map.set(anchor, { rows, cols });
    return null;
  });
}

/**
 * Unmerge the span at the cell — its anchor, or a cell it covers. Returns
 * false when the cell is not part of any span.
 */
export function unmergeCells(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): boolean {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const index = spanIndex(table);
    const key = cellKey(rowId, colId);
    const anchor = index.byAnchor.has(key) ? key : index.covered.get(key);
    if (anchor === undefined) return false;
    const map = nestedMap(table, 'spans', false);
    if (map === null) return false;
    map.delete(anchor);
    return true;
  });
}
