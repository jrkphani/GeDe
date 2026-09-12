/**
 * Moving focus between the objects on a sheet — tables and graphs — without a
 * pointer (A11Y-01, ADR-042, #131). Tab never leaves a table forward: past
 * its last cell it appends a row (GRID-05), so a graph below a table cannot
 * be reached by Tab. ⇧⌘→ / ⇧⌘← step through the sheet's objects in the order
 * they render — the tables, then the graphs — landing on each object's own
 * entry: a table's tab stop (its selected cell, else its first), a graph's
 * header.
 *
 * The list is the document's, not the DOM's: the canvas culls tables outside
 * the viewport (`visibleTables` in the shell), so a table the person cannot
 * see is exactly the one the chord must still reach. The shell reveals the
 * object (FIND-07's `revealBounds`) and then focuses its entry in the DOM;
 * a pinned table's inert ghost is skipped in favour of its live copy.
 */
import {
  graphRecord,
  graphsOnSheet,
  LATTICE,
  tableMap,
  tableRecord,
  tablesOnSheet,
  tableUnitBounds,
  unitBoundsToPx,
  type GedeDoc,
  type Id,
  type PixelBounds,
} from '@gede/core';

import type { CellSelection } from '../../../doc/selection.js';

export interface SheetObject {
  readonly kind: 'table' | 'graph';
  readonly id: Id;
}

/** Every object on the sheet, in render order: tables first, then graphs. */
export function sheetObjects(gd: GedeDoc, sheetId: Id): SheetObject[] {
  return [
    ...tablesOnSheet(gd, sheetId).map((t): SheetObject => ({ kind: 'table', id: t.id })),
    ...graphsOnSheet(gd, sheetId).map((g): SheetObject => ({ kind: 'graph', id: g.id })),
  ];
}

/** The object the active element sits in, or null. */
export function currentObject(active: Element | null): SheetObject | null {
  const section = active?.closest<HTMLElement>('section[data-table-id], section[data-graph-id]');
  if (section === null || section === undefined) return null;
  const { tableId, graphId } = section.dataset;
  if (tableId !== undefined) return { kind: 'table', id: tableId };
  if (graphId !== undefined) return { kind: 'graph', id: graphId };
  return null;
}

/**
 * The object `direction` steps from the current one, wrapping at either end;
 * with none current, the first (forward) or last (backward). Null on an empty
 * sheet.
 */
export function stepObject(
  objects: readonly SheetObject[],
  current: SheetObject | null,
  direction: 1 | -1,
): SheetObject | null {
  if (objects.length === 0) return null;
  const index =
    current === null
      ? -1
      : objects.findIndex((o) => o.kind === current.kind && o.id === current.id);
  if (index < 0) return objects[direction === 1 ? 0 : objects.length - 1] ?? null;
  return objects[(index + direction + objects.length) % objects.length] ?? null;
}

/** The object's rectangle on the canvas (pixels at zoom 1), for the reveal; null when gone. */
export function objectBounds(gd: GedeDoc, object: SheetObject): PixelBounds | null {
  if (object.kind === 'table') {
    const map = tableMap(gd, object.id);
    return map === null ? null : unitBoundsToPx(tableUnitBounds(map));
  }
  const map = gd.graphs.get(object.id);
  if (map === undefined) return null;
  const graph = graphRecord(map);
  return {
    x: graph.gridCol * LATTICE.col,
    y: graph.gridRow * LATTICE.row,
    width: graph.widthUnits * LATTICE.col,
    height: graph.heightUnits * LATTICE.row,
  };
}

/**
 * The cell a table is entered at: the selected cell when it is in this table,
 * else the first row's first visible column. Null for an empty table.
 */
export function tableEntry(
  gd: GedeDoc,
  tableId: Id,
  selected: CellSelection | null,
): CellSelection | null {
  if (selected !== null && selected.tableId === tableId) return selected;
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  const record = tableRecord(map);
  const rowId = record.rows[0];
  const column = record.columns.find((c) => !c.hidden);
  if (rowId === undefined || column === undefined) return null;
  return { tableId, rowId: rowId, colId: column.id };
}

/** The object's rendered section — a pinned table's live copy, never its inert ghost. */
export function objectElement(
  object: SheetObject,
  root: ParentNode = document,
): HTMLElement | null {
  const attr = object.kind === 'table' ? 'data-table-id' : 'data-graph-id';
  return (
    Array.from(root.querySelectorAll<HTMLElement>(`section[${attr}="${object.id}"]`)).find(
      (el) => el.closest('[inert]') === null,
    ) ?? null
  );
}

/** Where focus lands inside an object's section: a table's tab stop, a graph's header. */
export function objectEntry(section: HTMLElement): HTMLElement | null {
  if (section.dataset.tableId !== undefined) {
    return (
      section.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]') ??
      section.querySelector<HTMLElement>('[role="gridcell"]')
    );
  }
  return (
    section.querySelector<HTMLElement>('.gd-graph__header[tabindex]') ??
    section.querySelector<HTMLElement>('[tabindex="0"]')
  );
}
