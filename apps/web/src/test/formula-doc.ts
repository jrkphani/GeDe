/**
 * A real Y.Doc with one sheet and one table, for the formula UI tests. The
 * engine behind it is the real engine on the inline transport (no Worker in
 * jsdom); nothing is mocked.
 */
import * as Y from 'yjs';
import {
  cellAddress,
  cellKey,
  cellText,
  commitCellText,
  createSheet,
  createTable,
  openDocument,
  tableById,
  tableMap,
  type CellKey,
  type GedeDoc,
  type Id,
  type TableMap,
} from '@gede/core';

import { engineFor } from '../doc/engine.js';

export interface TestDoc {
  readonly doc: Y.Doc;
  readonly gd: GedeDoc;
  readonly sheetId: Id;
  readonly tableId: Id;
  readonly table: TableMap;
  rowId(r: number): Id;
  colId(c: number): Id;
  key(r: number, c: number): CellKey;
  addr(r: number, c: number): string;
  /** Commit as the editor does: formulas are bound to ids on the way in. */
  set(r: number, c: number, text: string): void;
  /** The stored source (bound form). */
  stored(r: number, c: number): string;
  /** Wait for the engine to answer everything posted so far. */
  settled(): Promise<void>;
}

export function testDoc(rows = 4, cols = 3, at = { col: 1, row: 1 }): TestDoc {
  const doc = new Y.Doc();
  const gd = openDocument(doc);
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at, columns: cols, rows });
  const table = tableMap(gd, tableId);
  if (table === null) throw new Error('no table');
  const record = () => {
    const t = tableById(gd, tableId);
    if (t === null) throw new Error('no table');
    return t;
  };
  const rowId = (r: number) => {
    const id = record().rows[r];
    if (id === undefined) throw new Error('no row');
    return id;
  };
  const colId = (c: number) => {
    const id = record().columns[c]?.id;
    if (id === undefined) throw new Error('no column');
    return id;
  };
  return {
    doc,
    gd,
    sheetId,
    tableId,
    table,
    rowId,
    colId,
    key: (r, c) => cellKey(rowId(r), colId(c)),
    addr: (r, c) => cellAddress(table, rowId(r), colId(c)) ?? '',
    set: (r, c, text) => {
      commitCellText(gd, tableId, rowId(r), colId(c), text);
    },
    stored: (r, c) => cellText(table, rowId(r), colId(c)),
    settled: () => engineFor(doc).settled(),
  };
}
