/**
 * Red-team round 6 (SET-10, SET-11, SET-12): the three ways a note was lost while
 * computed text and a person's text shared one cell key. Computed values are now
 * projected from row provenance and never written to the cells map, so none of
 * these paths has anything to overwrite. Each runs in both client-id orders.
 */
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  cellsMap,
  cellText,
  createSheet,
  createTable,
  openDocument,
  setCellText,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { FormulaEngine } from '../engine/engine.js';
import { observeWorkbook } from '../engine/snapshot.js';
import type { CellResult } from '../engine/types.js';
import { cellKey, type Id } from '../ids.js';
import { tableEntries } from '../search/snapshot.js';
import {
  computedItemsOf,
  computedRowId,
  reconcileComputed,
  setComputedColumn,
  setTableFormula,
} from './computed.js';

function replica(clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const gd = openDocument(doc);
  const results = new Map<string, CellResult>();
  const engine = new FormulaEngine();
  observeWorkbook(gd, (changes) => {
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
  });
  return { doc, gd, results };
}

type Replica = ReturnType<typeof replica>;

function handOff(r: Replica): void {
  for (const h of computedItemsOf(r.gd, (id) => r.results.get(id))) {
    reconcileComputed(r.gd, h.tableId, h.items, h.members);
  }
}

/** One-way: what `from` has that `to` lacks. */
function send(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function sync(a: Replica, b: Replica): void {
  send(a.doc, b.doc);
  send(b.doc, a.doc);
}

/** Both replicas hand off and exchange until the document settles. */
function settle(a: Replica, b: Replica): void {
  for (let i = 0; i < 4; i += 1) {
    handOff(a);
    handOff(b);
    sync(a, b);
  }
}

/** A table on `a` whose first column is computed; rows a and b filled; the second column takes notes. */
function setUp(a: Replica) {
  const sheetId = createSheet(a.gd);
  const tableId = createTable(a.gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0 });
  const [range = '', notes = ''] = tableById(a.gd, tableId)?.columns.map((c) => c.id) ?? [];
  setTableFormula(a.gd, tableId, '=Union("a", "b")');
  setComputedColumn(a.gd, tableId, range, { shape: 'column' });
  handOff(a);
  return { tableId, range, notes };
}

function textAt(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id): string {
  const table = tableMap(gd, tableId);
  return table === null ? '' : cellText(table, rowId, colId);
}

/** One keystroke at the end of the cell, as the editor binding types: into the fragment in place. */
function keystroke(gd: GedeDoc, tableId: Id, rowId: Id, colId: Id, ch: string): void {
  const table = tableMap(gd, tableId);
  const fragment = table === null ? undefined : cellsMap(table).get(cellKey(rowId, colId));
  const paragraph = fragment instanceof Y.XmlFragment ? fragment.get(0) : undefined;
  const text = paragraph instanceof Y.XmlElement ? paragraph.get(0) : undefined;
  if (!(text instanceof Y.XmlText)) {
    setCellText(gd, tableId, rowId, colId, ch);
    return;
  }
  gd.doc.transact(() => {
    text.insert(text.length, ch);
  }, gd.origin);
}

describe('SET-08 red-team round 6 regressions', () => {
  for (const [ca, cb] of [
    [1, 2],
    [2, 1],
  ] as const) {
    const order = `(clients ${String(ca)},${String(cb)})`;

    test(`SET-11 SET-12 a note typed offline survives a Fill column and the removal of its row ${order}`, () => {
      const a = replica(ca);
      const { tableId, notes } = setUp(a);
      const b = replica(cb);
      sync(a, b);
      const rowB = computedRowId(tableId, 'b');
      // B is offline: its note waits while A fills the column and then drops b's key.
      setCellText(b.gd, tableId, rowB, notes, 'offline note');
      expect(setComputedColumn(a.gd, tableId, notes, { shape: 'column' })).toBe(true);
      handOff(a);
      setTableFormula(a.gd, tableId, '=Union("a", "")');
      handOff(a);
      expect(tableById(a.gd, tableId)?.rows).not.toContain(rowB);
      sync(a, b);
      settle(a, b);
      for (const gd of [a.gd, b.gd]) {
        expect(tableById(gd, tableId)?.rows).toContain(rowB);
        expect(textAt(gd, tableId, rowB, notes)).toBe('offline note');
        expect(tableById(gd, tableId)?.columns[1]?.source).toBe('entered');
      }
    });

    test(`SET-10 SET-11 a note survives when its typist leaves before the fill reaches them ${order}`, () => {
      const a = replica(ca);
      const { tableId, notes } = setUp(a);
      const b = replica(cb);
      sync(a, b);
      const rowA = computedRowId(tableId, 'a');
      setCellText(b.gd, tableId, rowA, notes, 'important');
      expect(setComputedColumn(a.gd, tableId, notes, { shape: 'column' })).toBe(true);
      handOff(a);
      // B's note reaches A, then B closes the tab: A's fill never reaches B.
      send(b.doc, a.doc);
      for (let i = 0; i < 3; i += 1) handOff(a);
      const c = replica(cb + 10);
      send(a.doc, c.doc);
      for (const gd of [a.gd, c.gd]) {
        expect(textAt(gd, tableId, rowA, notes)).toBe('important');
        expect(tableById(gd, tableId)?.columns[1]?.source).toBe('entered');
      }
    });

    test(`SET-10 SET-11 keystrokes typed during a concurrent fill all land ${order}`, () => {
      const a = replica(ca);
      const { tableId, notes } = setUp(a);
      const b = replica(cb);
      sync(a, b);
      const rowA = computedRowId(tableId, 'a');
      const word = 'important';
      keystroke(b.gd, tableId, rowA, notes, word[0] ?? '');
      expect(setComputedColumn(a.gd, tableId, notes, { shape: 'column' })).toBe(true);
      for (const ch of word.slice(1)) {
        handOff(a);
        sync(a, b);
        keystroke(b.gd, tableId, rowA, notes, ch);
      }
      settle(a, b);
      for (const gd of [a.gd, b.gd]) {
        expect(textAt(gd, tableId, rowA, notes)).toBe(word);
        expect(tableById(gd, tableId)?.columns[1]?.source).toBe('entered');
      }
    });
  }
});

describe('SET-08 computed values are projected, never stored', () => {
  test('SET-08 the reconciler writes rows only: no computed text in the cells map', () => {
    const a = replica(1);
    const { tableId, range } = setUp(a);
    const table = tableMap(a.gd, tableId);
    if (table === null) throw new Error('no table');
    const rows = tableById(a.gd, tableId)?.rows ?? [];
    expect(rows.map((r) => cellText(table, r, range))).toEqual(['a', 'b']);
    expect([...cellsMap(table).keys()]).toEqual([]);
  });

  test('SET-08 a typed value under a computed cell key is hidden while computed and shown once it is not', () => {
    const a = replica(1);
    const { tableId, range } = setUp(a);
    const table = tableMap(a.gd, tableId);
    if (table === null) throw new Error('no table');
    const column = (table.get('columns') as Y.Array<Y.Map<unknown>>).get(0);
    const setSource = (source: string): void => {
      a.gd.doc.transact(() => {
        column.set('source', source);
      });
    };
    // As a merge can leave it: a value stored under the computed column's key.
    const rowA = computedRowId(tableId, 'a');
    setSource('entered');
    setCellText(a.gd, tableId, rowA, range, 'typed');
    setSource('computed');
    expect(cellText(table, rowA, range)).toBe('a');
    // A formula elsewhere reads the projection, not the hidden value (column B is the range).
    const reader = createTable(a.gd, {
      sheetId: tableById(a.gd, tableId)?.sheetId ?? '',
      at: { col: 6, row: 1 },
      columns: 1,
      rows: 1,
    });
    const r = tableById(a.gd, reader);
    setCellText(a.gd, reader, r?.rows[0] ?? '', r?.columns[0]?.id ?? '', '=Union(B:B, "z")');
    const read = (): string =>
      JSON.stringify(
        a.results.get(`${reader}/${cellKey(r?.rows[0] ?? '', r?.columns[0]?.id ?? '')}`)?.value,
      );
    expect(read()).toContain('"a"');
    expect(read()).not.toContain('typed');
    // Find indexes what the cell shows.
    const found = (): string[] =>
      (tableEntries(a.gd, tableId)?.entries ?? []).flatMap((e) =>
        e.kind === 'cell' ? e.texts.map((t) => t.text) : [],
      );
    expect(found()).toEqual(['a', 'b']);
    setSource('entered');
    expect(cellText(table, rowA, range)).toBe('typed');
    expect(read()).toContain('typed');
    expect(found()).toContain('typed');
  });
});
