/**
 * Format writes (FMT-01, FMT-02, FMT-06). Each runs in one transaction with
 * the document's local origin, like every mutation in `doc/mutations.ts`.
 * Kept apart from that file so the grid's edits and the format's edits do
 * not collide in one module.
 */
import * as Y from 'yjs';

import {
  cellsMap,
  columnsArray,
  readString,
  tableMap,
  textFragment,
  type GedeDoc,
  type TableMap,
} from '../doc/schema.js';
import { cellKey, type Id } from '../ids.js';
import { effectiveCellFormat } from './column.js';
import { readFormatOpts, type FormatKind, type FormatOpts } from './types.js';
import { marksAt } from '../text/algebra.js';
import { docNode, paragraphNode, plainText, textNode } from '../text/types.js';
import { fragmentToRich, writeRich } from '../text/yjs.js';
import { canonicalText } from './value.js';

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

/**
 * Set a column's format. Every cell without an override, and every row added
 * later, follows it (FMT-06). Stored text is not rewritten: display re-renders
 * from the same text (FMT-02).
 */
export function setColumnFormat(
  gd: GedeDoc,
  tableId: Id,
  colId: Id,
  format: FormatKind,
  opts: FormatOpts = {},
): void {
  transact(gd, () => {
    const column = columnsArray(requireTable(gd, tableId))
      .toArray()
      .find((c) => readString(c, 'id') === colId);
    if (column === undefined) throw new RangeError(`no column ${colId} in ${tableId}`);
    column.set('format', format);
    column.set('formatOpts', readFormatOpts(opts));
  });
}

/** Override one cell's format, or clear the override with `null` so it inherits again. */
export function setCellFormat(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  colId: Id,
  format: FormatKind | null,
  opts: FormatOpts = {},
): void {
  transact(gd, () => {
    const table = requireTable(gd, tableId);
    const existing = table.get('cellFormat');
    let map: Y.Map<unknown>;
    if (existing instanceof Y.Map) {
      map = existing as Y.Map<unknown>;
    } else {
      if (format === null) return;
      map = new Y.Map<unknown>();
      table.set('cellFormat', map);
    }
    const key = cellKey(rowId, colId);
    if (format === null) {
      map.delete(key);
      return;
    }
    map.set(key, { format, formatOpts: readFormatOpts(opts) });
  });
}

/**
 * Commit typed text under the cell's effective format: numbers and dates are
 * stored canonically (FMT-02, FMT-04), Automatic and Text keep the text as
 * typed (FMT-01), invalid text is kept as typed so the cell can show it
 * tinted (FMT-05). Formulas (`=…`) and marks are left to the editor; this is
 * the plain-text commit path. Returns the text stored.
 */
export function commitFormattedText(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  colId: Id,
  text: string,
): string {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const cells = cellsMap(table);
    const key = cellKey(rowId, colId);
    if (text === '') {
      cells.delete(key);
      return '';
    }
    if (text.startsWith('=')) {
      if (cells.get(key) !== text) cells.set(key, text);
      return text;
    }
    const stored = canonicalText(text, effectiveCellFormat(table, rowId, colId));
    const current = cells.get(key);
    if (current instanceof Y.XmlFragment) {
      const rich = fragmentToRich(current);
      if (plainText(rich) === stored) return stored;
      // The typed text was canonicalised: the cell keeps the marks its text began with,
      // as the renderer does for a formatted value.
      const marks = plainText(rich) === text ? marksAt(rich, 0) : [];
      writeRich(current, docNode([paragraphNode([textNode(stored, marks)])]));
      return stored;
    }
    cells.set(key, textFragment(stored));
    return stored;
  });
}
