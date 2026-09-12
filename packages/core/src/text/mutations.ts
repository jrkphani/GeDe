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
import { commitCellText, projectCellText } from '../engine/commit.js';
import { cellKey, type Id } from '../ids.js';
import { replaceSpan } from './algebra.js';
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

/**
 * FIND-08 on a rich cell: replace one UTF-16 span of the cell's plain text
 * and keep the marks around it. A formula cell is edited as the expression
 * the person reads (its stored id tokens projected to today's addresses, the
 * same text Find indexed) and re-bound on the way back through
 * `commitCellText`, so a replace never stores an unbound reference.
 * False when the span does not fit the cell's current text — Replace never
 * rewrites more than the match it can locate — or the row or column went.
 */
export function replaceInCell(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  colId: Id,
  span: { readonly from: number; readonly to: number },
  replacement: string,
): boolean {
  const table = tableMap(gd, tableId);
  if (table === null) return false;
  const stored = cellsMap(table).get(cellKey(rowId, colId));
  if (isFormula(stored)) {
    const shown = projectCellText(gd, stored);
    if (span.from < 0 || span.to > shown.length || span.from >= span.to) return false;
    const next = shown.slice(0, span.from) + replacement + shown.slice(span.to);
    return commitCellText(gd, tableId, rowId, colId, next);
  }
  const current = cellRich(table, rowId, colId);
  const length = plainText(current).length;
  if (span.from < 0 || span.to > length || span.from >= span.to) return false;
  return setCellRich(
    gd,
    tableId,
    rowId,
    colId,
    replaceSpan(current, span.from, span.to, replacement),
  );
}
