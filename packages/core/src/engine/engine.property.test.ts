import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellAddress,
  cellText,
  createSheet,
  createTable,
  openDocument,
  setCellText,
  setRowHeight,
  setTablePosition,
  tableById,
  tableMap,
} from '../doc/index.js';
import { commitCellText, workbookIndexOf } from './commit.js';
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
  const reported: string[][] = [];
  observeWorkbook(gd, (changes) => {
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
    reported.push(out.results.map((r) => r.cellId));
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
    commitCellText(
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
  return { gd, tableId, engine, results, reported, rowId, colId, addr, id, write, valueOf };
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

  test('FX-06 structural edits — rows inserted anywhere, the table moved, rows resized — never change what a formula reads (PRD §20 id-bound references)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 12 }),
        fc.nat(),
        fc.array(
          fc.oneof(
            fc.record({ op: fc.constant('insert' as const), after: fc.nat() }),
            fc.record({
              op: fc.constant('move' as const),
              col: fc.nat({ max: 20 }),
              row: fc.nat({ max: 40 }),
            }),
            fc.record({ op: fc.constant('wrap' as const), row: fc.nat() }),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        (rows, pickTarget, edits) => {
          const h = setUp(rows);
          // Rows 0..rows-2 hold i+1; the last row holds `=Sum(<target>)`.
          const target = pickTarget % (rows - 1);
          for (let i = 0; i < rows - 1; i += 1) h.write(i, { value: i + 1, reads: [] });
          const formulaRowId = h.rowId(rows - 1);
          const targetRowId = h.rowId(target);
          h.write(rows - 1, { value: 0, reads: [target] });
          const formulaId = h.id(rows - 1);
          expect(h.results.get(formulaId)?.value).toEqual({ kind: 'number', value: target + 1 });
          const reports = h.reported.length;
          for (const edit of edits) {
            const count = tableById(h.gd, h.tableId)!.rows.length;
            if (edit.op === 'insert') {
              const inserted = addRow(h.gd, h.tableId, h.rowId(edit.after % count));
              setCellText(h.gd, h.tableId, inserted, h.colId(), '1000');
            } else if (edit.op === 'move') {
              setTablePosition(h.gd, h.tableId, { col: edit.col, row: edit.row });
            } else {
              setRowHeight(h.gd, h.tableId, h.rowId(edit.row % count), 1 + (edit.row % 3));
            }
          }
          // The stored source is untouched, the binding holds, and nothing was re-evaluated.
          expect(h.results.get(formulaId)?.value).toEqual({ kind: 'number', value: target + 1 });
          expect(h.engine.dependenciesOf(formulaId)).toEqual(
            new Set([workbookCellId(h.tableId, cellKey(targetRowId, h.colId()))]),
          );
          expect(h.reported.slice(reports).flat()).toEqual([]);
          // The projection follows the cell: it names wherever the target row sits now.
          const map = tableMap(h.gd, h.tableId)!;
          const shown = workbookIndexOf(h.gd).project(cellText(map, formulaRowId, h.colId()));
          expect(shown).toBe(`=Sum(${cellAddress(map, targetRowId, h.colId())})`);
        },
      ),
      { numRuns: 40 },
    );
  });
});
