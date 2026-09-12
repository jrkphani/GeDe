import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { cellAddress, parseAddress } from '../index.js';
import { cellKey, type Id } from '../ids.js';
import {
  addRow,
  createSheet,
  createTable,
  deleteTable,
  openDocument,
  setCellText,
  setRowDepth,
  setTablePosition,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
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
  const stop = observeWorkbook(gd, (changes) => {
    batches.push(changes);
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
  });
  const sheetId = createSheet(gd);
  return { doc, gd, engine, results, batches, sheetId, stop };
}

interface Grid {
  tableId: Id;
  /** Cell id and address helpers by (row ordinal, column ordinal). */
  id(r: number, c: number): string;
  addr(r: number, c: number): string;
  set(r: number, c: number, text: string): void;
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
  return {
    tableId,
    rowId,
    colId,
    id: (r, c) => workbookCellId(tableId, cellKey(rowId(r), colId(c))),
    addr: (r, c) => {
      const map = tableMap(gd, tableId);
      const a = map === null ? null : cellAddress(map, rowId(r), colId(c));
      if (a === null) throw new Error('no address');
      return a;
    },
    set: (r, c, text) => {
      setCellText(gd, tableId, rowId(r), colId(c), text);
    },
  };
}

function numberOf(result: CellResult | undefined): number | undefined {
  return result?.value?.kind === 'number' ? result.value.value : undefined;
}

describe('FormulaEngine over a Y.Doc', () => {
  test('FX-06 a Sum evaluates, and editing a referenced cell updates the dependent', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 4, 2);
    g.set(0, 0, '10');
    g.set(1, 0, '20');
    g.set(2, 0, `=Sum(${g.addr(0, 0)}:${g.addr(1, 0)})`);
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
    // Downstream of the cycle is in error too, and says so.
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

  test('FX-02 blanks count as zero and a text cell in range names the offender', () => {
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

  test('FX-02 a whole column sums every populated cell in that lattice column', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 2);
    g.set(0, 0, '2');
    g.set(1, 0, '3');
    g.set(2, 0, '4');
    const letters = g.addr(0, 0).replace(/\d+$/, '');
    g.set(0, 1, `=Sum(${letters}:${letters})`);
    expect(numberOf(h.results.get(g.id(0, 1)))).toBe(9);
    g.set(2, 0, '');
    expect(numberOf(h.results.get(g.id(0, 1)))).toBe(5);
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

  test('FX-03 an @ entity list resolves rows by table title and first-column label', () => {
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
    expect(h.results.get(b.id(0, 0))?.value).toEqual({ kind: 'text', text: 'Lukla, 3440' });
    // Renaming the label re-resolves: the old path is now unknown.
    a.set(0, 0, 'Lukla airstrip');
    expect(h.results.get(b.id(0, 0))?.error).toMatchObject({ kind: 'unknown-entity' });
    b.set(0, 0, `=Sum(@"${title}"."Lukla airstrip"."${col}")`);
    expect(numberOf(h.results.get(b.id(0, 0)))).toBe(2860);
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
    expect(h.engine.entityIndex().entries.map((e) => e.text)).toContain(
      `@"${title}".Nepal.Everest`,
    );
  });

  test('FX-08 results carry each operand with its index, block and cells', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 2);
    g.set(2, 1, `=Sum(${g.addr(0, 0)}:${g.addr(1, 0)}, ${g.addr(0, 1)})`);
    const operands = h.results.get(g.id(2, 1))!.operands;
    expect(operands.map((o) => [o.index, o.kind, o.label])).toEqual([
      [0, 'range', `${g.addr(0, 0)}:${g.addr(1, 0)}`],
      [1, 'address', g.addr(0, 1)],
    ]);
    const start = parseAddress(g.addr(0, 0));
    if (!start.ok) throw new Error('bad address');
    expect(operands[0]!.rect).toEqual({
      col: start.value.col,
      row: start.value.row,
      cols: 1,
      rows: 2,
    });
    expect(operands[0]!.cellIds).toEqual([g.id(0, 0), g.id(1, 0)]);
    expect(operands[1]!.cellIds).toEqual([g.id(0, 1)]);
  });

  test('GRID-02 addresses re-resolve after a row is inserted above the referenced cell', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 3, 1);
    g.set(1, 0, '40');
    const target = g.addr(1, 0);
    g.set(2, 0, `=Sum(${target})`);
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(40);
    // Insert a row above: `target` now names the new, empty row and the 40 moved down.
    addRow(h.gd, g.tableId, g.rowId(0));
    expect(g.addr(1, 0)).toBe(target);
    expect(numberOf(h.results.get(g.id(3, 0)))).toBe(0);
    expect(h.engine.dependenciesOf(g.id(3, 0))).toEqual(new Set([g.id(1, 0)]));
    // Filling the cell that now sits at the address updates the formula.
    g.set(1, 0, '41');
    expect(numberOf(h.results.get(g.id(3, 0)))).toBe(41);
  });

  test('GRID-02 moving a table re-resolves the addresses inside it', () => {
    const h = harness();
    const g = grid(h.gd, h.sheetId, 2, 1);
    g.set(0, 0, '3');
    g.set(1, 0, `=Sum(${g.addr(0, 0)})`);
    expect(numberOf(h.results.get(g.id(1, 0)))).toBe(3);
    setTablePosition(h.gd, g.tableId, { col: 4, row: 4 });
    // The formula text still says the old address, which is now empty canvas.
    expect(numberOf(h.results.get(g.id(1, 0)))).toBe(0);
    expect(h.results.get(g.id(1, 0))!.operands[0]!.cellIds).toEqual([]);
  });

  test('FX-06 deleting a table withdraws its results and dependents see blank', () => {
    const h = harness();
    const a = grid(h.gd, h.sheetId, 1, 1, { col: 1, row: 1 });
    const b = grid(h.gd, h.sheetId, 1, 1, { col: 5, row: 1 });
    a.set(0, 0, '9');
    b.set(0, 0, `=Sum(${a.addr(0, 0)})`);
    expect(numberOf(h.results.get(b.id(0, 0)))).toBe(9);
    deleteTable(h.gd, a.tableId);
    expect(numberOf(h.results.get(b.id(0, 0)))).toBe(0);
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

    // Replica B: same document state, edits a cell; the update reaches A as a remote transaction.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(h.doc));
    const rgd = openDocument(remote);
    setCellText(rgd, g.tableId, g.rowId(1), g.colId(0), '2');
    Y.applyUpdate(h.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(h.doc)), 'remote');
    expect(numberOf(h.results.get(g.id(2, 0)))).toBe(3);
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
});
