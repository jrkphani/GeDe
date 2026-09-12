import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { cellAddress } from '../doc/geometry.js';
import { cellKey, type Id } from '../ids.js';
import {
  addRow,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  deleteTable,
  openDocument,
  setCellText,
  setRowDepth,
  setColumnHidden,
  setRowWrapped,
  setTablePosition,
  setTableTitle,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { commitCellText, workbookIndexOf } from './commit.js';
import { FormulaEngine } from './engine.js';
import { observeWorkbook } from './snapshot.js';
import { workbookCellId, type CellResult, type WorkbookChange } from './types.js';
import { cellErrorLabel } from './errors.js';

/** A document, an engine fed by `observeWorkbook`, and the results it has produced. */
function harness() {
  const doc = new Y.Doc();
  const gd = openDocument(doc);
  const engine = new FormulaEngine();
  const results = new Map<string, CellResult>();
  const batches: WorkbookChange[][] = [];
  /** Results reported per apply, so a test can assert that nothing was re-evaluated. */
  const reported: string[][] = [];
  const stop = observeWorkbook(gd, (changes) => {
    batches.push(changes);
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
    reported.push(out.results.map((r) => r.cellId));
  });
  const sheetId = createSheet(gd);
  return { doc, gd, engine, results, batches, reported, sheetId, stop };
}

interface Grid {
  tableId: Id;
  id(r: number, c: number): string;
  addr(r: number, c: number): string;
  /** Commit as the editor does: formulas are bound to ids on the way in. */
  set(r: number, c: number, text: string): void;
  /** The stored source (bound form). */
  stored(r: number, c: number): string;
  /** The stored source projected to today's addresses, as the editor shows it. */
  shown(r: number, c: number): string;
  rowId(r: number): Id;
  colId(c: number): Id;
}

function grid(gd: GedeDoc, sheetId: Id, rows: number, cols: number, at = { col: 1, row: 1 }): Grid {
  const tableId = createTable(gd, { sheetId, at, columns: cols, rows });
  const record = () => {
    const t = tableById(gd, tableId);
    if (t === null) throw new Error('table vanished');
    return t;
  };
  const rowId = (r: number) => {
    const id = record().rows[r];
    if (id === undefined) throw new Error(`no row ${String(r)}`);
    return id;
  };
  const colId = (c: number) => {
    const id = record().columns[c]?.id;
    if (id === undefined) throw new Error(`no column ${String(c)}`);
    return id;
  };
  const map = () => {
    const m = tableMap(gd, tableId);
    if (m === null) throw new Error('no map');
    return m;
  };
  return {
    tableId,
    rowId,
    colId,
    id: (r, c) => workbookCellId(tableId, cellKey(rowId(r), colId(c))),
    addr: (r, c) => {
      const a = cellAddress(map(), rowId(r), colId(c));
      if (a === null) throw new Error('no address');
      return a;
    },
    set: (r, c, text) => {
      commitCellText(gd, tableId, rowId(r), colId(c), text);
    },
    stored: (r, c) => cellText(map(), rowId(r), colId(c)),
    shown: (r, c) => workbookIndexOf(gd).project(cellText(map(), rowId(r), colId(c))),
  };
}

function numberOf(result: CellResult | undefined): number | undefined {
  return result?.value?.kind === 'number' ? result.value.value : undefined;
}

describe('FormulaEngine over a Y.Doc', () => {
  test('FX-06 a Sum evaluates, is stored id-bound, and editing a referenced cell updates the dependent', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 4, 2);
    g.set(0, 0, '10');
    g.set(1, 0, '20');
    g.set(2, 0, `=Sum(${g.addr(0, 0)}:${g.addr(1, 0)})`);
    expect(g.stored(2, 0)).toBe(
      `=Sum({r:${g.tableId}:${g.rowId(0)}:${g.colId(0)}:${g.rowId(1)}:${g.colId(0)}})`,
    );
    expect(g.shown(2, 0)).toBe(`=Sum(${g.addr(0, 0)}:${g.addr(1, 0)})`);
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(30);
    const v1 = h.results.get(g.id(2, 0))?.version;
    g.set(1, 0, '25');
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(35);
    expect(h.results.get(g.id(2, 0))?.version).not.toBe(v1);
    // The last transaction shipped one cell, not the sheet.
    const last = h.batches[h.batches.length - 1];
    expect(last).toEqual([
      {
        type: 'cells',
        tableId: g.tableId,
        cells: { [cellKey(g.rowId(1), g.colId(0))]: { kind: 'text', text: '25' } },
      },
    ]);
    h.stop();
  });

  test('FX-06 formulas may reference formulas; a chain re-evaluates in topological order', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 4, 1);
    g.set(0, 0, '1');
    g.set(1, 0, `=Sum(${g.addr(0, 0)})`);
    g.set(2, 0, `=Sum(${g.addr(1, 0)})`);
    g.set(3, 0, `=Sum(${g.addr(2, 0)}, ${g.addr(1, 0)})`);
    expect(numberOf(h.results.get(g.id(3, 0)))).toBe(2);
    g.set(0, 0, '5');
    expect(numberOf(h.results.get(g.id(1, 0)))).toBe(5);
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(5);
    expect(numberOf(h.results.get(g.id(3, 0)))).toBe(10);
  });

  test('FX-06 a reference loop reports circular on every member and clears when broken', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 1);
    g.set(0, 0, `=Sum(${g.addr(1, 0)})`);
    g.set(1, 0, `=Sum(${g.addr(0, 0)})`);
    g.set(2, 0, `=Sum(${g.addr(1, 0)})`);
    expect(h.results.get(g.id(0, 0))?.error).toEqual({ kind: 'circular' });
    expect(h.results.get(g.id(1, 0))?.error).toEqual({ kind: 'circular' });
    expect(cellErrorLabel(h.results.get(g.id(2, 0))!.error!)).toBe('⚠ circular');
    g.set(1, 0, '7');
    expect(numberOf(h.results.get(g.id(0, 0)))).toBe(7);
    expect(h.results.has(g.id(1, 0))).toBe(false);
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(7);
  });

  test('FX-06 a self-reference is the smallest cycle', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 1, 1);
    g.set(0, 0, `=Sum(${g.addr(0, 0)})`);
    expect(h.results.get(g.id(0, 0))?.error).toEqual({ kind: 'circular' });
  });

  test('FX-02 blanks count as zero and a text cell in range names the offender by its current address', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 4, 1);
    g.set(0, 0, '1,200');
    g.set(3, 0, `=Sum(${g.addr(0, 0)}:${g.addr(2, 0)})`);
    expect(numberOf(h.results.get(g.id(3, 0)))).toBe(1200);
    g.set(1, 0, 'Base camp');
    expect(h.results.get(g.id(3, 0))?.error).toEqual({
      kind: 'text-in-range',
      address: g.addr(1, 0),
    });
  });

  test('FX-02 a whole column binds to the table columns under it and sums every populated cell', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 2);
    g.set(0, 0, '2');
    g.set(1, 0, '3');
    g.set(2, 0, '4');
    const letters = g.addr(0, 0).replace(/\d+$/, '');
    g.set(0, 1, `=Sum(${letters}:${letters})`);
    expect(g.stored(0, 1)).toBe(`=Sum({k:${g.tableId}:${g.colId(0)}})`);
    expect(g.shown(0, 1)).toBe(`=Sum(${letters}:${letters})`);
    expect(numberOf(h.results.get(g.id(0, 1)))).toBe(9);
    g.set(2, 0, '');
    expect(numberOf(h.results.get(g.id(0, 1)))).toBe(5);
    // A row appended to the table joins the column.
    const added = addRow(h.gd, g.tableId);
    setCellText(h.gd, g.tableId, added, g.colId(0), '10');
    expect(numberOf(h.results.get(g.id(0, 1)))).toBe(15);
  });

  test('FX-02 mixed currencies are an error, never a conversion', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 1);
    g.set(0, 0, 'SGD 10');
    g.set(1, 0, 'USD 5');
    g.set(2, 0, `=Sum(${g.addr(0, 0)}:${g.addr(1, 0)})`);
    expect(h.results.get(g.id(2, 0))?.error).toMatchObject({ kind: 'mixed-currency' });
    g.set(1, 0, 'S$ 5');
    expect(h.results.get(g.id(2, 0))?.value).toEqual({ kind: 'currency', value: 15, code: 'SGD' });
  });

  test('FX-01 Concat joins literals, addresses and @ paths end to end, keeping typed spellings', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 2, 2);
    g.set(0, 0, 'Camp');
    g.set(0, 1, '1,200');
    g.set(1, 0, `=Concat(${g.addr(0, 0)}, " at ", ${g.addr(0, 1)}, "m")`);
    expect(h.results.get(g.id(1, 0))?.value).toEqual({ kind: 'text', text: 'Camp at 1,200m' });
  });

  test('FX-03 a list echoes any typed separator between references', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 2, 2);
    g.set(0, 0, 'Tamil');
    g.set(0, 1, 'Hindi');
    g.set(1, 0, `=${g.addr(0, 0)} / ${g.addr(0, 1)}`);
    expect(h.results.get(g.id(1, 0))?.value).toEqual({ kind: 'text', text: 'Tamil / Hindi' });
  });

  test('FX-03 an @ entity list binds to the row by id, so renaming the label keeps the reference and re-spells it', () => {
    const h = harness();
    const a = grid(h.gd, h.sheetId, 2, 2, { col: 1, row: 1 });
    const b = grid(h.gd, h.sheetId, 1, 1, { col: 10, row: 1 });
    a.set(0, 0, 'Lukla');
    a.set(0, 1, '2860');
    a.set(1, 0, 'Namche');
    a.set(1, 1, '3440');
    const title = tableById(h.gd, a.tableId)!.title;
    const col = tableById(h.gd, a.tableId)!.columns[1]!.label;
    b.set(0, 0, `=@"${title}".Lukla, @"${title}".Namche."${col}"`);
    expect(b.stored(0, 0)).toBe(
      `={e:${a.tableId}:${a.rowId(0)}:${a.colId(0)}}, {e:${a.tableId}:${a.rowId(1)}:${a.colId(1)}}`,
    );
    expect(h.results.get(b.id(0, 0))?.value).toEqual({ kind: 'text', text: 'Lukla, 3440' });
    // PRD §20: the reference stores the id; the label is presentation.
    a.set(0, 0, 'Lukla airstrip');
    expect(h.results.get(b.id(0, 0))?.value).toEqual({
      kind: 'text',
      text: 'Lukla airstrip, 3440',
    });
    expect(b.shown(0, 0)).toBe(`=@"${title}"."Lukla airstrip", @"${title}".Namche."${col}"`);
    // An @ path that names nothing stays as typed and reports unknown reference.
    b.set(0, 0, `=@"${title}".Nowhere`);
    expect(b.stored(0, 0)).toBe(`=@"${title}".Nowhere`);
    expect(h.results.get(b.id(0, 0))?.error).toMatchObject({ kind: 'unknown-entity' });
  });

  test('FX-04 nested rows are qualified by their parent row', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 2);
    g.set(0, 0, 'Nepal');
    g.set(1, 0, 'Everest');
    g.set(1, 1, '8849');
    setRowDepth(h.gd, g.tableId, g.rowId(1), 1);
    const title = tableById(h.gd, g.tableId)!.title;
    const col = tableById(h.gd, g.tableId)!.columns[1]!.label;
    g.set(2, 1, `=Sum(@"${title}".Nepal.Everest."${col}")`);
    expect(numberOf(h.results.get(g.id(2, 1)))).toBe(8849);
    expect(h.engine.index.entityIndex().entries.map((e) => e.text)).toContain(
      `@"${title}".Nepal.Everest`,
    );
  });

  test('FX-08 results carry each operand with its index, kind and cells', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 2);
    g.set(2, 1, `=Sum(${g.addr(0, 0)}:${g.addr(1, 0)}, ${g.addr(0, 1)})`);
    const operands = h.results.get(g.id(2, 1))!.operands;
    expect(operands).toEqual([
      { index: 0, kind: 'range', cellIds: [g.id(0, 0), g.id(1, 0)], missing: false },
      { index: 1, kind: 'address', cellIds: [g.id(0, 1)], missing: false },
    ]);
  });

  test('FX-06 inserting a row above a referenced cell keeps the value; the shown address moves with the cell', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 1);
    g.set(1, 0, '40');
    const before = g.addr(1, 0);
    g.set(2, 0, `=Sum(${before})`);
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(40);
    const reports = h.reported.length;
    addRow(h.gd, g.tableId, g.rowId(0));
    // Row ordinals shifted: the 40 is now row 2, the formula row 3.
    expect(g.addr(2, 0)).not.toBe(before);
    expect(numberOf(h.results.get(g.id(3, 0)))).toBe(40);
    expect(h.engine.dependenciesOf(g.id(3, 0))).toEqual(new Set([g.id(2, 0)]));
    expect(g.shown(3, 0)).toBe(`=Sum(${g.addr(2, 0)})`);
    // Nothing moved in the dependency set, so nothing was re-evaluated.
    expect(h.reported.slice(reports).flat()).toEqual([]);
  });

  test('FX-06 moving a table changes every address and no value', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 2, 1);
    g.set(0, 0, '3');
    g.set(1, 0, `=Sum(${g.addr(0, 0)})`);
    expect(numberOf(h.results.get(g.id(1, 0)))).toBe(3);
    const reports = h.reported.length;
    setTablePosition(h.gd, g.tableId, { col: 4, row: 4 });
    expect(numberOf(h.results.get(g.id(1, 0)))).toBe(3);
    expect(g.shown(1, 0)).toBe(`=Sum(${g.addr(0, 0)})`);
    expect(h.reported.slice(reports).flat()).toEqual([]);
  });

  test('FX-06 wrapping a row or renaming the table re-evaluates nothing', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 1);
    g.set(0, 0, '3');
    g.set(2, 0, `=Sum(${g.addr(0, 0)}:${g.addr(1, 0)})`);
    const reports = h.reported.length;
    setRowWrapped(h.gd, g.tableId, g.rowId(0), true);
    setTableTitle(h.gd, g.tableId, 'Renamed');
    expect(h.reported.slice(reports).flat()).toEqual([]);
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(3);
  });

  test('FX-06 deleting a referenced row is ⚠ reference removed; undo restores the binding and the value', () => {
    const h = harness();
    const undo = createUndoManager(h.gd);
    const g = grid(h.gd, h.sheetId, 3, 1);
    g.set(0, 0, '2');
    g.set(1, 0, '3');
    g.set(2, 0, `=Sum(${g.addr(0, 0)})`);
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(2);
    const doomed = g.rowId(0);
    const formulaId = g.id(2, 0);
    // The undo manager merges edits inside its capture window; the delete must be its own step.
    undo.stopCapturing();
    // Delete row 0 the way the grid does: remove it from the rows array.
    h.gd.doc.transact(() => {
      const map = tableMap(h.gd, g.tableId)!;
      const rows = map.get('rows') as Y.Array<Id>;
      rows.delete(rows.toArray().indexOf(doomed), 1);
    }, h.gd.origin);
    const r = h.results.get(formulaId);
    expect(r?.error).toEqual({ kind: 'reference-removed', label: 'a cell' });
    expect(cellErrorLabel(r!.error!)).toBe('⚠ reference removed');
    // The 3 slid into the old address; the formula does not read it.
    expect(
      workbookIndexOf(h.gd).project(cellText(tableMap(h.gd, g.tableId)!, g.rowId(1), g.colId(0))),
    ).toBe('=Sum(#REF)');
    undo.undo();
    expect(numberOf(h.results.get(formulaId))).toBe(2);
    expect(h.engine.dependenciesOf(formulaId)).toEqual(
      new Set([workbookCellId(g.tableId, cellKey(doomed, g.colId(0)))]),
    );
  });

  test('FX-06 a range grows when a row is inserted inside it and shrinks when an interior row is deleted; rows inserted just outside stay outside', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 5, 1);
    g.set(1, 0, '1');
    g.set(2, 0, '1');
    g.set(3, 0, '1');
    g.set(4, 0, `=Sum(${g.addr(1, 0)}:${g.addr(3, 0)})`);
    expect(numberOf(h.results.get(g.id(4, 0)))).toBe(3);
    const top = g.rowId(1);
    const bottom = g.rowId(3);
    // Inside: after the first bound row.
    const inside = addRow(h.gd, g.tableId, top);
    setCellText(h.gd, g.tableId, inside, g.colId(0), '10');
    expect(numberOf(h.results.get(g.id(5, 0)))).toBe(13);
    // Just above the range (after row 0) and just below (after the bottom corner): not included.
    const above = addRow(h.gd, g.tableId, g.rowId(0));
    setCellText(h.gd, g.tableId, above, g.colId(0), '100');
    const below = addRow(h.gd, g.tableId, bottom);
    setCellText(h.gd, g.tableId, below, g.colId(0), '100');
    const formulaId = g.id(7, 0);
    expect(numberOf(h.results.get(formulaId))).toBe(13);
    expect(g.shown(7, 0)).toBe(`=Sum(${g.addr(2, 0)}:${g.addr(5, 0)})`);
    // Delete the interior row: the range shrinks, no error.
    h.gd.doc.transact(() => {
      const rows = tableMap(h.gd, g.tableId)!.get('rows') as Y.Array<Id>;
      rows.delete(rows.toArray().indexOf(inside), 1);
    }, h.gd.origin);
    expect(numberOf(h.results.get(g.id(6, 0)))).toBe(3);
  });

  test('FX-06 deleting the referenced table is ⚠ reference removed, and the results of its own formulas are withdrawn', () => {
    const h = harness();
    const a = grid(h.gd, h.sheetId, 1, 1, { col: 1, row: 1 });
    const b = grid(h.gd, h.sheetId, 1, 1, { col: 5, row: 1 });
    a.set(0, 0, '9');
    b.set(0, 0, `=Sum(${a.addr(0, 0)})`);
    expect(numberOf(h.results.get(b.id(0, 0)))).toBe(9);
    deleteTable(h.gd, a.tableId);
    expect(h.results.get(b.id(0, 0))?.error).toEqual({
      kind: 'reference-removed',
      label: 'a cell',
    });
  });

  test('FX-06 an address over empty canvas stays positional and reads the cell a table later puts there', () => {
    const h = harness();
    const a = grid(h.gd, h.sheetId, 1, 1, { col: 1, row: 1 });
    a.set(0, 0, '=Sum(H20)');
    expect(a.stored(0, 0)).toBe('=Sum(H20)');
    expect(numberOf(h.results.get(a.id(0, 0)))).toBe(0);
    // A table whose first data cell lands on H20: col H = 7, data row 19 = gridRow 16 + 3.
    const b = grid(h.gd, h.sheetId, 1, 1, { col: 7, row: 16 });
    expect(b.addr(0, 0)).toBe('H20');
    b.set(0, 0, '5');
    expect(numberOf(h.results.get(a.id(0, 0)))).toBe(5);
  });

  test('FX-07 a formula that does not parse reports where, and turning it back into text withdraws the result', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 1, 1);
    g.set(0, 0, '=Sum(');
    const r = h.results.get(g.id(0, 0));
    expect(r?.error?.kind).toBe('parse');
    expect(cellErrorLabel(r!.error!)).toBe('⚠ invalid formula');
    g.set(0, 0, 'plain');
    expect(h.results.has(g.id(0, 0))).toBe(false);
  });

  test('FX-06 a remote edit on a second replica re-evaluates locally', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 1);
    g.set(0, 0, '1');
    g.set(2, 0, `=Sum(${g.addr(0, 0)}:${g.addr(1, 0)})`);
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(1);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(h.doc));
    const rgd = openDocument(remote);
    setCellText(rgd, g.tableId, g.rowId(1), g.colId(0), '2');
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(h.doc)), 'remote');
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(3);
  });

  test('FX-06 two replicas that insert a row and edit a formula concurrently converge to the same results', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 1);
    g.set(0, 0, '1');
    g.set(1, 0, '2');
    g.set(2, 0, `=Sum(${g.addr(0, 0)}:${g.addr(1, 0)})`);
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(h.doc));
    const ogd = openDocument(other);
    const otherEngine = new FormulaEngine();
    const otherResults = new Map<string, CellResult>();
    observeWorkbook(ogd, (changes) => {
      for (const r of otherEngine.apply(changes).results) otherResults.set(r.cellId, r);
    });
    // Offline, A inserts a row above the range; B re-enters the formula reading only the first cell.
    const formulaRow = g.rowId(2);
    const first = g.addr(0, 0);
    const inserted = addRow(h.gd, g.tableId, g.rowId(0));
    setCellText(h.gd, g.tableId, inserted, g.colId(0), '100');
    commitCellText(ogd, g.tableId, formulaRow, g.colId(0), `=Sum(${first})`);
    Y.applyUpdate(other, Y.encodeStateAsUpdate(h.doc, Y.encodeStateVector(other)), 'remote');
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(h.doc)), 'remote');
    const id = workbookCellId(g.tableId, cellKey(formulaRow, g.colId(0)));
    expect(cellText(tableMap(h.gd, g.tableId)!, formulaRow, g.colId(0))).toBe(
      cellText(tableMap(ogd, g.tableId)!, formulaRow, g.colId(0)),
    );
    expect(h.results.get(id)?.value).toEqual(otherResults.get(id)?.value);
    expect(numberOf(h.results.get(id))).toBe(1);
  });

  test('FX-06 unchanged results are not re-reported', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 2, 2);
    g.set(0, 0, '1');
    g.set(1, 0, `=Sum(${g.addr(0, 0)})`);
    const before = h.results.get(g.id(1, 0))?.version;
    g.set(0, 1, 'unrelated');
    expect(h.results.get(g.id(1, 0))?.version).toBe(before);
  });

  test('GRID-02 a hidden column keeps its bound references and its value; it just has no address', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 2, 3);
    g.set(0, 1, '8');
    g.set(1, 2, `=Sum(${g.addr(0, 1)})`);
    expect(numberOf(h.results.get(g.id(1, 2)))).toBe(8);
    const addressBefore = g.addr(1, 2);
    setColumnHidden(h.gd, g.tableId, g.colId(1), true);
    expect(numberOf(h.results.get(g.id(1, 2)))).toBe(8);
    // The formula's own address moved left by one column; the hidden operand has no address to show.
    expect(g.addr(1, 2)).not.toBe(addressBefore);
    expect(g.shown(1, 2)).toBe('=Sum(#hidden)');
    setColumnHidden(h.gd, g.tableId, g.colId(1), false);
    expect(g.shown(1, 2)).toBe(`=Sum(${g.addr(0, 1)})`);
  });
});
