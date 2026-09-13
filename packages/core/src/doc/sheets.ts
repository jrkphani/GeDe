/**
 * Deleting a sheet (ADR-048, #165). Lives beside `mutations.ts` rather than
 * in it because the cascade is built on the graph layer's table cascade
 * (`deleteTableWithGraphs`, ADR-047), which itself builds on the table
 * mutations.
 */
import { deleteTableWithGraphs, graphsBoundTo, removeGraph } from '../graph/mutations.js';
import { splitCellKey, type Id } from '../ids.js';
import { boundTableIds } from '../ref/cross-table.js';
import {
  cellsMap,
  graphsOnSheet,
  isFormula,
  listSheets,
  rowMeta,
  tablesOnSheet,
  type GedeDoc,
} from './schema.js';

/** What `deleteSheet` removed, for the announcement and the undo toast. */
export interface DeleteSheetResult {
  readonly label: string;
  /** Tables removed with the sheet. */
  readonly tables: number;
  /**
   * Graph pairs removed: those placed on the sheet, and those elsewhere
   * bound to one of its tables (a pair is one graph to the reader).
   */
  readonly graphs: number;
  /**
   * Formula cells on other sheets that bound into a removed table and now
   * evaluate to `⚠ reference removed` (FX-06). Cells of pulled rows are not
   * counted: the pull reconciles those rows away rather than leaving an error.
   */
  readonly referencesRemoved: number;
  /** The sheet to show instead: the one after it, else the one before. */
  readonly neighbourId: Id;
}

/** A workscape keeps at least one sheet: the last one cannot be deleted. */
export function isLastSheet(gd: GedeDoc): boolean {
  return gd.sheets.length <= 1;
}

/** Formula cells outside `doomed` whose bound references point into it. */
function referencesInto(gd: GedeDoc, doomed: ReadonlySet<Id>): number {
  let count = 0;
  gd.tables.forEach((table, tableId) => {
    if (doomed.has(tableId)) return;
    cellsMap(table).forEach((content, key) => {
      if (!isFormula(content)) return;
      if (rowMeta(table, splitCellKey(key).rowId).pulledFrom !== null) return;
      for (const bound of boundTableIds(content)) {
        if (doomed.has(bound)) {
          count += 1;
          return;
        }
      }
    });
  });
  return count;
}

/**
 * Delete a sheet with everything on it — each table through
 * `deleteTableWithGraphs` (cells, rows, columns, row meta and formats travel
 * inside the table's map; every graph object bound to it goes with it,
 * wherever it sits, ADR-047), then the graph objects still placed on the
 * sheet, then the sheet — in one transaction (nested transacts join it), so
 * one undo step brings the whole sheet back at its position. Formulas elsewhere that read a removed table
 * fall to `⚠ reference removed` through the engine's `table-removed` path;
 * pulled rows from a removed table are reconciled away by `observePulls`.
 * Throws `RangeError` for the last sheet or an id that is not a sheet.
 */
export function deleteSheet(gd: GedeDoc, sheetId: Id): DeleteSheetResult {
  if (isLastSheet(gd)) throw new RangeError('a workscape keeps at least one sheet');
  const sheets = listSheets(gd);
  const index = sheets.findIndex((s) => s.id === sheetId);
  if (index < 0) throw new RangeError(`no sheet ${sheetId}`);
  const label = sheets[index]?.label ?? '';
  const neighbour = sheets[index + 1] ?? sheets[index - 1];
  if (neighbour === undefined) throw new RangeError('a workscape keeps at least one sheet');
  let result!: DeleteSheetResult;
  gd.doc.transact(() => {
    const tableIds = tablesOnSheet(gd, sheetId).map((t) => t.id);
    const doomed = new Set(tableIds);
    const referencesRemoved = referencesInto(gd, doomed);
    // Pairs counted before anything goes: the halves on the sheet, and the halves anywhere
    // bound to one of its tables (ADR-047's cascade takes those with each table).
    const pairIds = new Set<Id>();
    for (const g of graphsOnSheet(gd, sheetId)) pairIds.add(g.pairId);
    for (const id of tableIds) for (const g of graphsBoundTo(gd, id)) pairIds.add(g.pairId);
    for (const id of tableIds) deleteTableWithGraphs(gd, id);
    for (const g of graphsOnSheet(gd, sheetId)) removeGraph(gd, g.id);
    gd.sheets.delete(index, 1);
    result = {
      label,
      tables: tableIds.length,
      graphs: pairIds.size,
      referencesRemoved,
      neighbourId: neighbour.id,
    };
  }, gd.origin);
  return result;
}
