/**
 * The commit path for cell text (GRID-06 + PRD §20 id-bound references).
 *
 * `commitCellText` is what every editor must call instead of `setCellText`
 * for typed text: a formula is bound to ids once, here, against the
 * geometry and labels at this moment, and stored in its bound form. Plain
 * text passes straight through. It is one `transact` (the one inside
 * `setCellText`), so one undo step and one sync message; returns what
 * `setCellText` returns (false when the row or column went away).
 */
import {
  cellsMap,
  fragmentText,
  isFormula,
  readString,
  type GedeDoc,
  type TableMap,
} from '../doc/schema.js';
import { setCellText } from '../doc/mutations.js';
import { cellKey, type CellKey, type Id } from '../ids.js';
import { tableStructure } from './snapshot.js';
import type { TableStructure } from './types.js';
import { WorkbookIndex } from './workbook-index.js';

/** A fresh index over the whole document. Callers that need it often should cache by document version. */
export function workbookIndexOf(gd: GedeDoc): WorkbookIndex {
  const tables: TableStructure[] = [];
  gd.tables.forEach((table: TableMap) => {
    tables.push(tableStructure(table));
  });
  return new WorkbookIndex(tables, (tableId: Id, key: CellKey) => {
    const table = gd.tables.get(tableId);
    if (table === undefined) return '';
    const content = cellsMap(table).get(key);
    if (content === undefined || isFormula(content)) return '';
    return fragmentText(content);
  });
}

export interface CommitOptions {
  /** An index the caller already holds for this document state; built when absent. */
  readonly index?: WorkbookIndex | undefined;
}

/**
 * Write what the person typed. Formulas (`=` prefix) are bound to ids on the
 * cell's sheet; everything else is stored as `setCellText` stores it.
 * Returns what `setCellText` returns.
 */
export function commitCellText(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  colId: Id,
  text: string,
  options: CommitOptions = {},
): boolean {
  const table = gd.tables.get(tableId);
  if (!text.startsWith('=') || table === undefined) {
    return setCellText(gd, tableId, rowId, colId, text);
  }
  const index = options.index ?? workbookIndexOf(gd);
  // The source the cell held: a `#REF` / `#hidden` the editor showed keeps its token.
  const current = cellsMap(table).get(cellKey(rowId, colId));
  const previous = isFormula(current) ? current : undefined;
  return setCellText(
    gd,
    tableId,
    rowId,
    colId,
    index.bind(readString(table, 'sheetId'), text, previous),
  );
}

/** The stored formula as the person reads it today; plain text passes through. */
export function projectCellText(gd: GedeDoc, source: string, index?: WorkbookIndex): string {
  if (!source.startsWith('=') || !source.includes('{')) return source;
  return (index ?? workbookIndexOf(gd)).project(source);
}
