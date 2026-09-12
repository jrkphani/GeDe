/**
 * Row hierarchy — the outline (PRD §4, §15; HIER-02, HIER-03, HIER-05, HIER-06).
 *
 * Depth is per-row data (HIER-10): a row at depth *d* is a child of the
 * nearest row above it at a depth shallower than *d* (HIER-03). Nothing here
 * touches Yjs; these are pure projections over a table's row order and its
 * stored depths, so the same functions serve the grid, the inspector panel,
 * geometry and the property tests. `hier/mutations.ts` writes.
 *
 * Stored depths are trusted only after `effectiveDepths`: a merge can leave a
 * row deeper than the row above it allows (two replicas nested different rows
 * at once, or one deleted the parent while the other nested under it), and
 * the invariant of HIER-02 must hold for every reader regardless.
 */
import type { Id } from '../ids.js';
import {
  outlineColumnId,
  rowMeta,
  tableRecord,
  type TableMap,
  type TableRecord,
} from '../doc/schema.js';

/** What the outline needs to know about one row, in row order. */
export interface OutlineInput {
  readonly depth: number;
  readonly collapsed: boolean;
}

/**
 * HIER-02 as an invariant: the first row is at depth 0 and every row is at
 * most one level deeper than the row immediately above it. Whole, non-negative
 * depths; anything stored out of range is clamped rather than thrown, because
 * a document written by a newer client must still render.
 */
export function effectiveDepths(depths: readonly number[]): number[] {
  const out: number[] = new Array<number>(depths.length);
  let previous = -1;
  for (let i = 0; i < depths.length; i += 1) {
    const raw = depths[i] ?? 0;
    const wanted = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
    const depth = Math.min(wanted, previous + 1);
    out[i] = depth;
    previous = depth;
  }
  return out;
}

/** True when `effectiveDepths` would return the same array — the stored depths already obey HIER-02. */
export function isValidDepths(depths: readonly number[]): boolean {
  const effective = effectiveDepths(depths);
  return effective.every((d, i) => d === depths[i]);
}

/**
 * HIER-03: the index of the nearest row above `index` at a shallower depth,
 * or null at the top level. Expects effective depths.
 */
export function parentIndex(depths: readonly number[], index: number): number | null {
  const depth = depths[index];
  if (depth === undefined || depth === 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    if ((depths[i] ?? 0) < depth) return i;
  }
  return null;
}

/**
 * Exclusive end of the subtree rooted at `index`: the first row after it that
 * is not deeper, else the row count. Expects effective depths.
 */
export function subtreeEnd(depths: readonly number[], index: number): number {
  const depth = depths[index];
  if (depth === undefined) return index;
  let end = index + 1;
  while (end < depths.length && (depths[end] ?? 0) > depth) end += 1;
  return end;
}

/** HIER-05: a row has descendants when the row after it is deeper. Expects effective depths. */
export function hasDescendants(depths: readonly number[], index: number): boolean {
  const depth = depths[index];
  const next = depths[index + 1];
  return depth !== undefined && next !== undefined && next > depth;
}

/**
 * HIER-02: a row may nest when it is not already one deeper than the row above
 * it; the first row never nests. Expects effective depths.
 */
export function canNest(depths: readonly number[], index: number): boolean {
  if (index <= 0 || index >= depths.length) return false;
  return (depths[index] ?? 0) < (depths[index - 1] ?? 0) + 1;
}

/** HIER-02: promote stops at depth 0. Expects effective depths. */
export function canPromote(depths: readonly number[], index: number): boolean {
  return (depths[index] ?? 0) > 0;
}

/**
 * HIER-06: a row is hidden when any of its ancestors is collapsed — the whole
 * subtree, not only the immediate children. Collapsing a row without
 * descendants hides nothing. Stored depths are normalised first.
 */
export function hiddenRows(rows: readonly OutlineInput[]): boolean[] {
  const depths = effectiveDepths(rows.map((r) => r.depth));
  const ancestors: { depth: number; collapsed: boolean }[] = [];
  let collapsedAbove = 0;
  return rows.map((row, i) => {
    const depth = depths[i] ?? 0;
    while (ancestors.length > 0 && (ancestors[ancestors.length - 1]?.depth ?? 0) >= depth) {
      const gone = ancestors.pop();
      if (gone?.collapsed === true) collapsedAbove -= 1;
    }
    const hidden = collapsedAbove > 0;
    ancestors.push({ depth, collapsed: row.collapsed });
    if (row.collapsed) collapsedAbove += 1;
    return hidden;
  });
}

/** One row of a table's outline as the grid and the inspector render it. */
export interface OutlineRow {
  readonly id: Id;
  /** Effective depth (HIER-02 applied), 0 at the top level. */
  readonly depth: number;
  readonly collapsed: boolean;
  /** Under a collapsed ancestor: not drawn, no lattice height, no address (HIER-06). */
  readonly hidden: boolean;
  /** Shows the chevron (HIER-05). */
  readonly hasChildren: boolean;
  /** HIER-03: the nearest row above at a shallower depth, or null at depth 0. */
  readonly parent: Id | null;
  /** HIER-07. */
  readonly splitChild: boolean;
  readonly canNest: boolean;
  readonly canPromote: boolean;
}

export interface TableOutline {
  readonly rows: readonly OutlineRow[];
  /** The column that carries indentation, ↳ and the chevron, or null when every column is hidden (HIER-04). */
  readonly column: Id | null;
  /**
   * HIER-08: while the table is grouped, group bands own the outline column —
   * depth is kept in the data but not shown. Readers draw no indent, prefix or
   * chevron when this is true.
   */
  readonly grouped: boolean;
}

/** The outline of every row of a table, in row order, from the document. */
export function tableOutline(
  table: TableMap,
  record: TableRecord = tableRecord(table),
): TableOutline {
  const metas = record.rows.map((rowId) => rowMeta(table, rowId));
  const depths = effectiveDepths(metas.map((m) => m.depth));
  const hidden = hiddenRows(
    metas.map((m, i) => ({ depth: depths[i] ?? 0, collapsed: m.collapsed })),
  );
  const rows = record.rows.map((id, i): OutlineRow => {
    const parent = parentIndex(depths, i);
    return {
      id,
      depth: depths[i] ?? 0,
      collapsed: metas[i]?.collapsed ?? false,
      hidden: hidden[i] ?? false,
      hasChildren: hasDescendants(depths, i),
      parent: parent === null ? null : (record.rows[parent] ?? null),
      splitChild: metas[i]?.splitChild ?? false,
      canNest: canNest(depths, i),
      canPromote: canPromote(depths, i),
    };
  });
  return { rows, column: outlineColumnId(record), grouped: record.groupBy !== null };
}

/** The outline entry of one row, or null when the row is not in the table. */
export function rowOutline(table: TableMap, rowId: Id): OutlineRow | null {
  return tableOutline(table).rows.find((r) => r.id === rowId) ?? null;
}

/**
 * HIER-03 applied upward: the row's ancestors, nearest first, ending at its
 * top-level ancestor. Empty for a top-level or unknown row.
 */
export function ancestorIds(table: TableMap, rowId: Id): Id[] {
  const outline = tableOutline(table);
  const byId = new Map(outline.rows.map((r) => [r.id, r]));
  const out: Id[] = [];
  let cursor = byId.get(rowId)?.parent ?? null;
  while (cursor !== null) {
    out.push(cursor);
    cursor = byId.get(cursor)?.parent ?? null;
  }
  return out;
}

/** Ids of the rows hidden under collapsed ancestors (HIER-06). */
export function hiddenRowIds(table: TableMap, record: TableRecord = tableRecord(table)): Set<Id> {
  const out = new Set<Id>();
  for (const row of tableOutline(table, record).rows) if (row.hidden) out.add(row.id);
  return out;
}
