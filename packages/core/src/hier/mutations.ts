/**
 * Hierarchy writes (HIER-01, HIER-02, HIER-06, HIER-07, HIER-10). Every
 * function is one `transact` under the document's local origin, so a nest, a
 * promote or a collapse-all is one undo step and one sync message however
 * many rows it touches. Validity (HIER-02) is decided here, on the effective
 * depths, and the same predicates (`canNest`, `canPromote` in `outline.ts`)
 * drive the disabled state of the controls, so the grid can never ask for
 * something the document refuses.
 *
 * Nest and promote move a row *with its subtree*: the children keep their
 * depth relative to the row, so a valid outline stays valid — promoting a
 * parent on its own would leave its children two levels below it, which
 * HIER-02 forbids. (The handover prototype moved the row alone and left the
 * invariant to chance; the PRD's invariant wins.)
 */
import type { Id } from '../ids.js';
import { rowMetaFor, settleCollapsed } from '../doc/mutations.js';
import {
  columnsArray,
  readString,
  rowMeta,
  rowMetaMap,
  rowsArray,
  tableMap,
  tableRecord,
  type GedeDoc,
  type TableMap,
} from '../doc/schema.js';
import { canNest, canPromote, effectiveDepths, hasDescendants, subtreeEnd } from './outline.js';

function transact<T>(gd: GedeDoc, fn: () => T): T {
  let out!: T;
  gd.doc.transact(() => {
    out = fn();
  }, gd.origin);
  return out;
}

function requireTable(gd: GedeDoc, tableId: Id): TableMap {
  const table = tableMap(gd, tableId);
  if (table === null) throw new RangeError(`no table ${tableId}`);
  return table;
}

/** Store a depth, writing nothing when the row already reads that way (no empty undo steps). */
function writeDepth(table: TableMap, rowId: Id, depth: number): void {
  const existing = rowMetaMap(table).get(rowId);
  if (existing === undefined) {
    if (depth === 0) return;
    rowMetaFor(table, rowId).set('depth', depth);
    return;
  }
  if (existing.get('depth') !== depth) existing.set('depth', depth);
}

function writeCollapsed(table: TableMap, rowId: Id, collapsed: boolean): void {
  const existing = rowMetaMap(table).get(rowId);
  if (existing === undefined) {
    if (!collapsed) return;
    rowMetaFor(table, rowId).set('collapsed', true);
    return;
  }
  if (existing.get('collapsed') !== collapsed) existing.set('collapsed', collapsed);
}

/**
 * Shift a row and its subtree by `delta` levels when HIER-02 allows it.
 * Returns the row's new depth, or null when refused (unknown row, first row
 * nesting, already one deeper than the row above, promote at depth 0).
 */
function shiftSubtree(gd: GedeDoc, tableId: Id, rowId: Id, delta: 1 | -1): number | null {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const rows = rowsArray(table).toArray();
    const index = rows.indexOf(rowId);
    if (index < 0) return null;
    const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
    const allowed = delta === 1 ? canNest(depths, index) : canPromote(depths, index);
    if (!allowed) return null;
    const end = subtreeEnd(depths, index);
    for (let i = index; i < end; i += 1) {
      const id = rows[i];
      if (id !== undefined) writeDepth(table, id, (depths[i] ?? 0) + delta);
    }
    // A promote can take the last child out from under a collapsed parent (HIER-06).
    if (delta === -1) settleCollapsed(table);
    return (depths[index] ?? 0) + delta;
  });
}

/**
 * HIER-01 / KEYS-06 `⌘]`: nest the row one level under the row above it, its
 * subtree with it. Returns the new depth, or null when HIER-02 refuses.
 */
export function nestRow(gd: GedeDoc, tableId: Id, rowId: Id): number | null {
  return shiftSubtree(gd, tableId, rowId, 1);
}

/**
 * HIER-01 / KEYS-06 `⌘[`: promote the row one level, its subtree with it.
 * Returns the new depth, or null at depth 0.
 */
export function promoteRow(gd: GedeDoc, tableId: Id, rowId: Id): number | null {
  return shiftSubtree(gd, tableId, rowId, -1);
}

/**
 * HIER-06: collapse or expand one row. Rows without descendants cannot be
 * collapsed (nothing to hide; the chevron is not drawn for them). Returns the
 * state stored, or null when the row is unknown or childless.
 */
export function setRowCollapsed(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  collapsed: boolean,
): boolean | null {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const rows = rowsArray(table).toArray();
    const index = rows.indexOf(rowId);
    if (index < 0) return null;
    const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
    if (collapsed && !hasDescendants(depths, index)) return null;
    writeCollapsed(table, rowId, collapsed);
    return collapsed;
  });
}

export function toggleRowCollapsed(gd: GedeDoc, tableId: Id, rowId: Id): boolean | null {
  const table = tableMap(gd, tableId);
  if (table === null) return null;
  return setRowCollapsed(gd, tableId, rowId, !rowMeta(table, rowId).collapsed);
}

/** HIER-06: collapse every row that has descendants, in one undo step. Returns the ids collapsed. */
export function collapseAll(gd: GedeDoc, tableId: Id): Id[] {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const rows = rowsArray(table).toArray();
    const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
    const changed: Id[] = [];
    rows.forEach((id, i) => {
      if (!hasDescendants(depths, i) || rowMeta(table, id).collapsed) return;
      writeCollapsed(table, id, true);
      changed.push(id);
    });
    return changed;
  });
}

/** HIER-06: expand every collapsed row, in one undo step. Returns the ids expanded. */
export function expandAll(gd: GedeDoc, tableId: Id): Id[] {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const changed: Id[] = [];
    for (const id of rowsArray(table).toArray()) {
      if (!rowMeta(table, id).collapsed) continue;
      writeCollapsed(table, id, false);
      changed.push(id);
    }
    return changed;
  });
}

/**
 * HIER-04: designate the column that carries the outline, or null to fall
 * back to the first visible column. Returns false when the column is not in
 * the table.
 */
export function setOutlineColumn(gd: GedeDoc, tableId: Id, colId: Id | null): boolean {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    if (colId === null) {
      if (table.get('outlineColumn') !== undefined) table.delete('outlineColumn');
      return true;
    }
    const known = columnsArray(table)
      .toArray()
      .some((c) => readString(c, 'id') === colId);
    if (!known) return false;
    if (table.get('outlineColumn') !== colId) table.set('outlineColumn', colId);
    return true;
  });
}

/**
 * HIER-07: flag rows `Split()` produced. The formula engine calls this in the
 * same transaction that inserts the rows beneath their parent; the flag makes
 * them read-only (`cellReadOnlyReason` → `splitChild`) and they collapse with
 * the parent like any child. Depth is set to one under `parentRowId` so the
 * rows sit in the parent's subtree whatever depth the parent has. Returns
 * false when the parent or a row is not in the table.
 */
export function markSplitChildren(
  gd: GedeDoc,
  tableId: Id,
  parentRowId: Id,
  rowIds: readonly Id[],
): boolean {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const rows = rowsArray(table).toArray();
    const parentIndex = rows.indexOf(parentRowId);
    if (parentIndex < 0 || rowIds.some((id) => !rows.includes(id))) return false;
    const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
    const depth = (depths[parentIndex] ?? 0) + 1;
    for (const id of rowIds) {
      const meta = rowMetaFor(table, id);
      if (meta.get('depth') !== depth) meta.set('depth', depth);
      if (meta.get('splitChild') !== true) meta.set('splitChild', true);
    }
    return true;
  });
}

/**
 * HIER-07: `markSplitChildren` for many parents at once — the effective depths
 * are computed once for the table, so a first materialisation of a whole
 * column is one walk, not one per parent. Parents or rows not in the table
 * are skipped. Returns how many rows were written.
 */
export function markSplitChildrenBatch(
  gd: GedeDoc,
  tableId: Id,
  groups: ReadonlyMap<Id, readonly Id[]>,
): number {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const rows = rowsArray(table).toArray();
    const index = new Map(rows.map((id, i) => [id, i]));
    const depths = effectiveDepths(rows.map((id) => rowMeta(table, id).depth));
    let written = 0;
    for (const [parentRowId, rowIds] of groups) {
      const parentIndex = index.get(parentRowId);
      if (parentIndex === undefined) continue;
      const depth = (depths[parentIndex] ?? 0) + 1;
      for (const id of rowIds) {
        if (!index.has(id)) continue;
        const meta = rowMetaFor(table, id);
        let touched = false;
        if (meta.get('depth') !== depth) {
          meta.set('depth', depth);
          touched = true;
        }
        if (meta.get('splitChild') !== true) {
          meta.set('splitChild', true);
          touched = true;
        }
        if (touched) written += 1;
      }
    }
    return written;
  });
}

/** HIER-07: the reverse of `markSplitChildren`, when a split is removed and its rows become ordinary. */
export function clearSplitChildren(gd: GedeDoc, tableId: Id, rowIds: readonly Id[]): void {
  transact(gd, () => {
    const table = requireTable(gd, tableId);
    for (const id of rowIds) {
      const meta = rowMetaMap(table).get(id);
      if (meta?.get('splitChild') === true) meta.set('splitChild', false);
    }
  });
}

/** Depths of a table's rows as stored, in row order — a fixture helper for tests and the projection. */
export function rowDepths(gd: GedeDoc, tableId: Id): number[] {
  const table = requireTable(gd, tableId);
  return tableRecord(table).rows.map((id) => rowMeta(table, id).depth);
}
