/**
 * Main-thread reads over the Y.Doc that the formula UI needs without a round
 * trip to the Worker: which forms a column admits (FX-02), the `@` entity
 * index for autocomplete (FX-04), and operand geometry for outlines while a
 * draft is being typed (FX-08). None of this evaluates anything.
 */
import {
  buildEntityIndex,
  buildSheetIndex,
  cellKey,
  cellsMap,
  inferCellValue,
  inferColumnFormat,
  isFormula,
  fragmentText,
  parse,
  readString,
  resolveOperands,
  tableRecord,
  tableStructure,
  type CellKey,
  type EntityIndex,
  type GedeDoc,
  type Id,
  type InferredFormat,
  type OperandOutline,
  type SheetIndex,
  type TableMap,
  type TableStructure,
  type UnitBounds,
} from '@gede/core';

/** Automatic inference over a column's text cells (formula cells are skipped). */
export function columnFormatOf(table: TableMap, colId: Id): InferredFormat {
  const record = tableRecord(table);
  const cells = cellsMap(table);
  const values = record.rows.map((rowId) => {
    const content = cells.get(cellKey(rowId, colId));
    if (content === undefined || isFormula(content)) return { kind: 'blank' as const };
    return inferCellValue(fragmentText(content));
  });
  return inferColumnFormat(values);
}

function structures(gd: GedeDoc): TableStructure[] {
  const out: TableStructure[] = [];
  gd.tables.forEach((table) => {
    out.push(tableStructure(table));
  });
  return out;
}

/** Plain text of a cell for row labels; formula cells have no label. */
function textOf(gd: GedeDoc, tableId: Id, key: CellKey): string {
  const table = gd.tables.get(tableId);
  if (table === undefined) return '';
  const content = cellsMap(table).get(key);
  if (content === undefined || isFormula(content)) return '';
  return fragmentText(content);
}

export function entityIndexOf(gd: GedeDoc): EntityIndex {
  return buildEntityIndex(structures(gd), (tableId, key) => textOf(gd, tableId, key));
}

export function sheetIndexOf(gd: GedeDoc, sheetId: Id): SheetIndex {
  return buildSheetIndex(sheetId, structures(gd));
}

/** The sheet a table sits on, or null when the table is gone. */
export function sheetOfTable(gd: GedeDoc, tableId: Id): Id | null {
  const table = gd.tables.get(tableId);
  return table === undefined ? null : readString(table, 'sheetId');
}

/**
 * Operands of a formula text as blocks on `sheetId`, resolved against the
 * current geometry (FX-08 "during editing the outline updates live"). An
 * unparseable draft yields the operands parsed so far: none.
 */
export function operandsOfDraft(gd: GedeDoc, sheetId: Id, text: string): OperandOutline[] {
  const parsed = parse(text);
  if (!parsed.ok) return [];
  const index = sheetIndexOf(gd, sheetId);
  const entities = text.includes('@') ? entityIndexOf(gd).byKey : null;
  const rectOf = (cellId: string): UnitBounds | null => {
    // An entity may live on another sheet; only same-sheet cells are outlined.
    const cell = index.byCellId.get(cellId);
    return cell === undefined
      ? null
      : { col: cell.ref.col, row: cell.ref.row, cols: cell.cols, rows: cell.rows };
  };
  return resolveOperands(index, parsed.value, entities, rectOf);
}
