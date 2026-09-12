/**
 * The commit path for cell text (GRID-06 + PRD §20 id-bound references).
 *
 * `commitCellText` is what every editor must call instead of `setCellText`
 * for typed text: a formula is bound to ids once, here, against the
 * geometry and labels at this moment, and stored in its bound form. Plain
 * text passes straight through. It is one `transact` (the one inside
 * `setCellText`), so one undo step and one sync message.
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
import type { CellKey, Id } from '../ids.js';
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
): void {
  const table = gd.tables.get(tableId);
  if (!text.startsWith('=') || table === undefined) {
    setCellText(gd, tableId, rowId, colId, text);
    return;
  }
  const index = options.index ?? workbookIndexOf(gd);
  setCellText(gd, tableId, rowId, colId, index.bind(readString(table, 'sheetId'), text));
}
