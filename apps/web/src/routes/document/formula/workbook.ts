/**
 * Main-thread reads over the Y.Doc that the formula UI needs without a round
 * trip to the Worker: which forms a column admits (FX-02), the `@` entity
 * index for autocomplete (FX-04), binding at commit and projection for
 * display (PRD §20), and operand geometry for outlines (FX-08). Everything
 * goes through the per-document cached `WorkbookIndex`; none of it evaluates.
 */
import type * as Y from 'yjs';
import {
  AUTO_FORMAT,
  columnById,
  columnFormat,
  parse,
  readString,
  type CellFormat,
  type Id,
  type OperandOutline,
  type TableMap,
} from '@gede/core';

import { projectFormulaFor, workbookIndexFor } from '../../../doc/workbook-index.js';

/** The column's data format as set in the inspector (FMT-01); Automatic when the column is unknown. */
export function columnFormatOf(table: TableMap, colId: Id): CellFormat {
  const column = columnById(table, colId);
  return column === null ? AUTO_FORMAT : columnFormat(column);
}

/**
 * FX-02 "Offered only when the column is Number or Currency": the column's
 * format decides, never what its cells happen to contain. An Automatic
 * column is not offered Sum; formatting it is the affordance.
 */
export function isSummable(format: CellFormat): boolean {
  return format.kind === 'number' || format.kind === 'currency';
}

/** The document a table map belongs to; a prelim map (not yet integrated) has none. */
export function docOf(table: TableMap): Y.Doc {
  const doc = table.doc;
  if (doc === null) throw new Error('the table map is not integrated into a document');
  return doc;
}

export function sheetOfTable(table: TableMap): Id {
  return readString(table, 'sheetId');
}

/** The stored (id-bound) formula as the person should read it today. */
export function projectSource(doc: Y.Doc, source: string): string {
  return projectFormulaFor(doc, source);
}

/**
 * Parse a draft as it is being typed: an unclosed call (`=Sum(B5, B6`) is
 * read as if its parentheses were closed, so the outlines can follow the
 * keystrokes (PRD §22 "typing or extending a range updates the outline live").
 */
function parseDraft(text: string) {
  const direct = parse(text);
  if (direct.ok) return direct;
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
  }
  if (depth === 0) return direct;
  const trimmed = text.replace(/[\s,]+$/u, '');
  return parse(`${trimmed}${')'.repeat(depth)}`);
}

/**
 * Operands of a formula text as blocks on `sheetId`, resolved against the
 * current geometry (FX-08 "during editing the outline updates live"). Takes
 * a typed draft or a stored source. A draft that cannot be read yields none.
 */
export function operandsOf(
  doc: Y.Doc,
  sheetId: Id,
  text: string,
  stored = false,
): OperandOutline[] {
  const parsed = parseDraft(text);
  if (!parsed.ok) return [];
  return workbookIndexFor(doc).operands(sheetId, parsed.value, stored);
}
