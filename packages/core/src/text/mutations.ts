/**
 * Rich-text reads and writes on a cell. `setCellText` (doc/mutations.ts)
 * remains the plain-text path; these carry marks. A live y-prosemirror
 * binding writes the fragment itself and never needs `setCellRich`.
 */
import * as Y from 'yjs';

import {
  cellsMap,
  columnsArray,
  isFormula,
  readString,
  rowsArray,
  tableMap,
  type GedeDoc,
  type TableMap,
} from '../doc/schema.js';
import { cellKey, type Id } from '../ids.js';
import {
  EMPTY_DOC,
  isEmptyDoc,
  normalise,
  plainText,
  richFromText,
  type RichDoc,
} from './types.js';
import { fragmentToRich, richToFragment, writeRich } from './yjs.js';

/** The cell's rich text: a formula reads as its source, an empty cell as the empty document. */
export function cellRich(table: TableMap, rowId: Id, colId: Id): RichDoc {
  const value = cellsMap(table).get(cellKey(rowId, colId));
  if (value === undefined) return EMPTY_DOC;
  if (isFormula(value)) return richFromText(value);
  return fragmentToRich(value);
}

/** The cell's fragment when it holds rich text (not a formula, not empty), for the editor to bind. */
export function cellFragment(table: TableMap, rowId: Id, colId: Id): Y.XmlFragment | null {
  const value = cellsMap(table).get(cellKey(rowId, colId));
  return value instanceof Y.XmlFragment ? value : null;
}

/**
 * Write a rich document to a cell in one transaction. Text beginning with
 * `=` on its first line is a formula and is stored as its source; an empty
 * document clears the cell; an existing fragment is rewritten in place so
 * remote observers see one change, and an unchanged document is a no-op.
 * False when the row or column went while the editor was open — the draft
 * is dropped rather than written as a cell keyed to nothing (GRID-02).
 */
export function setCellRich(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id, doc: RichDoc): boolean {
  const table = tableMap(gd, tableId);
  if (table === null) throw new RangeError(`no table ${tableId}`);
  const next = normalise(doc);
  let written = false;
  gd.doc.transact(() => {
    if (!rowsArray(table).toArray().includes(rowId)) return;
    if (
      !columnsArray(table)
        .toArray()
        .some((c) => readString(c, 'id') === colId)
    )
      return;
    written = true;
    const cells = cellsMap(table);
    const key = cellKey(rowId, colId);
    if (isEmptyDoc(next)) {
      cells.delete(key);
      return;
    }
    const plain = plainText(next);
    const current = cells.get(key);
    if (plain.startsWith('=')) {
      if (current !== plain) cells.set(key, plain);
      return;
    }
    if (current instanceof Y.XmlFragment) {
      if (JSON.stringify(fragmentToRich(current)) === JSON.stringify(next)) return;
      writeRich(current, next);
      return;
    }
    cells.set(key, richToFragment(next));
  }, gd.origin);
  return written;
}
