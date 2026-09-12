import { describe, expect, test } from 'vitest';

import { cellKey } from '../ids.js';
import {
  chainSheet,
  colIdAt,
  rowIdAt,
  TABLE_ID,
  thousandCellSheet,
} from './__fixtures__/sheets.js';
import { FormulaEngine } from './engine.js';
import { workbookCellId } from './types.js';

/**
 * The §20 budgets as regression tripwires. The bench file reports the real
 * numbers; these assertions sit at 4× the budget so a slow CI box does not
 * fail the pipeline while a 10× regression still does.
 */
function medianMs(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

describe('FormulaEngine performance budgets (PRD §20)', () => {
  test('FX-06 a keystroke on a 1,000-cell sheet recomputes its dependents within budget', () => {
    const { table, rowIds } = thousandCellSheet();
    const engine = new FormulaEngine();
    engine.apply([{ type: 'reset', snapshot: { tables: [table] } }]);
    const total = engine.result(workbookCellId(TABLE_ID, cellKey(rowIds[0] ?? '', colIdAt(3))));
    expect(total?.value?.kind).toBe('number');
    let tick = 100;
    const ms = medianMs(20, () => {
      tick += 1;
      const out = engine.apply([
        {
          type: 'cells',
          tableId: TABLE_ID,
          cells: { [cellKey(rowIds[5] ?? '', colIdAt(0))]: { kind: 'text', text: String(tick) } },
        },
      ]);
      // The row's Sum and the column total, nothing else.
      expect(out.results.map((r) => r.cellId).sort()).toEqual(
        [
          workbookCellId(TABLE_ID, cellKey(rowIds[5] ?? '', colIdAt(3))),
          workbookCellId(TABLE_ID, cellKey(rowIds[0] ?? '', colIdAt(3))),
        ].sort(),
      );
    });
    console.warn(`keystroke, 1,000 cells: ${ms.toFixed(2)} ms (budget 16 ms)`);
    expect(ms).toBeLessThan(64);
  });

  test('FX-06 editing the head of a 500-row Sum chain recomputes every dependent within budget', () => {
    const { table, rowIds } = chainSheet();
    const engine = new FormulaEngine();
    engine.apply([{ type: 'reset', snapshot: { tables: [table] } }]);
    let head = 1;
    const ms = medianMs(10, () => {
      head += 1;
      const out = engine.apply([
        {
          type: 'cells',
          tableId: TABLE_ID,
          cells: { [cellKey(rowIds[0] ?? '', colIdAt(0))]: { kind: 'text', text: String(head) } },
        },
      ]);
      expect(out.results).toHaveLength(499);
    });
    const last = engine.result(workbookCellId(TABLE_ID, cellKey(rowIds[499] ?? '', colIdAt(0))));
    expect(last?.value).toEqual({ kind: 'number', value: head });
    expect(last?.operands[0]?.cellIds).toEqual([
      workbookCellId(TABLE_ID, cellKey(rowIdAt(498), colIdAt(0))),
    ]);
    console.warn(`500-row chain: ${ms.toFixed(2)} ms (budget 50 ms)`);
    expect(ms).toBeLessThan(200);
  });
});
