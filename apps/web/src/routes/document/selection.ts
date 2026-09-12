/**
 * Selection is viewer state, not document state: it lives in React and is
 * mirrored into awareness so collaborators see it (SHARE-04).
 */
import type { Id } from '@gede/core';

export interface CellSelection {
  readonly tableId: Id;
  readonly rowId: Id;
  readonly colId: Id;
}

export interface Selection {
  readonly tableId: Id;
  readonly cell: Omit<CellSelection, 'tableId'> | null;
}

export function sameCell(a: CellSelection | null, b: CellSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tableId === b.tableId && a.rowId === b.rowId && a.colId === b.colId;
}

export function selectedCell(selection: Selection | null): CellSelection | null {
  const cell = selection?.cell;
  if (selection === null || cell === null || cell === undefined) return null;
  return { tableId: selection.tableId, ...cell };
}
