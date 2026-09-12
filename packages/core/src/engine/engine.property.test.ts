import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellAddress,
  createSheet,
  createTable,
  openDocument,
  setCellText,
  tableById,
  tableMap,
} from '../doc/index.js';
import { cellKey, type Id } from '../ids.js';
import { FormulaEngine } from './engine.js';
import { observeWorkbook } from './snapshot.js';
import { workbookCellId, type CellResult } from './types.js';

/**
 * Model: N cells in one column. Cell i is either a number or `=Sum(<cells below i in the DAG>)`.
 * Edges only point from higher to lower index, so the model is acyclic and its
 * expected values are a straightforward fold.
 */
interface ModelCell {
  readonly value: number;
  /** Indices this cell sums; empty means a plain number. */
  readonly reads: readonly number[];
}

const modelArb = fc
  .integer({ min: 2, max: 24 })
  .chain((n) =>
    fc.tuple(
      fc.constant(n),
      fc.array(
        fc.record({
          value: fc.integer({ min: -50, max: 50 }),
          reads: fc.array(fc.nat({ max: n - 1 }), { maxLength: 4 }),
        }),
        { minLength: n, maxLength: n },
      ),
    ),
  )
  .map(([n, cells]) =>
    cells
      .map((c, i): ModelCell => ({
        value: c.value,
        reads: [...new Set(c.reads.filter((j) => j < i))],
      }))
      .slice(0, n),
  );

function expected(model: readonly ModelCell[]): number[] {
  const out: number[] = [];
  model.forEach((cell, i) => {
    out[i] =
      cell.reads.length === 0 ? cell.value : cell.reads.reduce((a, j) => a + (out[j] ?? 0), 0);
  });
  return out;
}

function setUp(rows: number) {
  const doc = new Y.Doc();
  const gd = openDocument(doc);
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 1, rows });
  const engine = new FormulaEngine();
  const results = new Map<string, CellResult>();
  observeWorkbook(gd, (changes) => {
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
  });
  const record = () => {
    const t = tableById(gd, tableId);
    if (t === null) throw new Error('table vanished');
    return t;
  };
  const rowId = (i: number): Id => {
    const id = record().rows[i];
    if (id === undefined) throw new Error('no row');
    return id;
  };
  const colId = (): Id => {
    const id = record().columns[0]?.id;
    if (id === undefined) throw new Error('no column');
    return id;
  };
  const addr = (i: number): string => {
    const map = tableMap(gd, tableId);
    const a = map === null ? null : cellAddress(map, rowId(i), colId());
    if (a === null) throw new Error('no address');
    return a;
  };
  const id = (i: number) => workbookCellId(tableId, cellKey(rowId(i), colId()));
  const write = (i: number, cell: ModelCell) => {
    setCellText(
      gd,
      tableId,
      rowId(i),
      colId(),
      cell.reads.length === 0 ? String(cell.value) : `=Sum(${cell.reads.map(addr).join(', ')})`,
    );
  };
  const valueOf = (i: number, cell: ModelCell): number => {
    if (cell.reads.length === 0) return cell.value;
    const r = results.get(id(i));
    if (r?.value?.kind !== 'number')
      throw new Error(`no numeric result at ${addr(i)}: ${JSON.stringify(r)}`);
    return r.value.value;
  };
  return { gd, tableId, engine, results, rowId, colId, addr, id, write, valueOf };
}

describe('FormulaEngine properties', () => {
  test('FX-06 random DAGs converge to the fold, in any write order and after random edits', () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: -50, max: 50 })), { maxLength: 6 }),
        (model, edits) => {
          const h = setUp(model.length);
          // Write in a shuffled order so dependents often arrive before their inputs.
          const order = model
            .map((_, i) => i)
            .sort((a, b) => ((a * 7919) % 13) - ((b * 7919) % 13));
          for (const i of order) h.write(i, model[i]!);
          let current = model;
          const check = () => {
            const want = expected(current);
            current.forEach((cell, i) => {
              expect(h.valueOf(i, cell)).toBe(want[i]);
            });
          };
          check();
          for (const [pick, value] of edits) {
            const i = pick % current.length;
            current = current.map((c, j) => (j === i ? { value, reads: [] } : c));
            h.write(i, current[i]!);
            check();
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  test('GRID-02 after inserting a row above a referenced cell, every reference resolves to the cell now at that address', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 12 }),
        fc.nat(),
        fc.nat(),
        (rows, pickTarget, pickInsert) => {
          const h = setUp(rows);
          // Rows 0..rows-2 hold i+1; the last row holds `=Sum(<target>)`.
          const target = 1 + (pickTarget % (rows - 2));
          for (let i = 0; i < rows - 1; i += 1) h.write(i, { value: i + 1, reads: [] });
          const formulaRow = rows - 1;
          const address = h.addr(target);
          h.write(formulaRow, { value: 0, reads: [target] });
          expect(h.valueOf(formulaRow, { value: 0, reads: [target] })).toBe(target + 1);

          // Insert after row `after` (0 ≤ after < target): the new row lands at ordinal after+1 ≤ target.
          const after = pickInsert % target;
          addRow(h.gd, h.tableId, h.rowId(after));
          const inserted = after + 1;
          // The formula text is unchanged, so the address now names whatever sits there (GRID-02).
          const map = tableMap(h.gd, h.tableId)!;
          const record = tableById(h.gd, h.tableId)!;
          const nowAt = record.rows.findIndex(
            (rowId) => cellAddress(map, rowId, h.colId()) === address,
          );
          expect(nowAt).toBe(target);
          const formulaId = h.id(formulaRow + 1);
          expect(h.engine.dependenciesOf(formulaId)).toEqual(new Set([h.id(nowAt)]));
          const value = inserted === target ? 0 : target; // the new blank row, or the row that slid down into the address
          expect(h.results.get(formulaId)?.value).toEqual({ kind: 'number', value });
        },
      ),
      { numRuns: 40 },
    );
  });
});
