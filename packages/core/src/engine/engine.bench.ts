/**
 * PRD §20 budgets, measured on the engine alone (no Worker hop, no React):
 *
 *   keystroke on a 1,000-cell sheet → recompute      < 16 ms
 *   edit at the head of a 500-row =Sum chain          < 50 ms
 *
 * Run with `npx vitest bench src/engine` from packages/core. Not part of verify.
 */
import { bench, describe } from 'vitest';

import { cellKey } from '../ids.js';
import { chainSheet, colIdAt, TABLE_ID, thousandCellSheet } from './__fixtures__/sheets.js';
import { FormulaEngine } from './engine.js';

describe('FormulaEngine budgets (PRD §20)', () => {
  const thousand = thousandCellSheet();
  const engine1 = new FormulaEngine();
  engine1.apply([{ type: 'reset', snapshot: { tables: [thousand.table] } }]);
  let tick = 0;
  bench(
    'keystroke on a 1,000-cell sheet (one input cell changes; its row Sum and the column total recompute)',
    () => {
      tick += 1;
      engine1.apply([
        {
          type: 'cells',
          tableId: TABLE_ID,
          cells: {
            [cellKey(thousand.rowIds[5] ?? '', colIdAt(0))]: { kind: 'text', text: String(tick) },
          },
        },
      ]);
    },
  );

  const chain = chainSheet();
  const engine2 = new FormulaEngine();
  engine2.apply([{ type: 'reset', snapshot: { tables: [chain.table] } }]);
  let head = 0;
  bench('edit the head of a 500-row =Sum chain (499 dependents recompute in order)', () => {
    head += 1;
    engine2.apply([
      {
        type: 'cells',
        tableId: TABLE_ID,
        cells: {
          [cellKey(chain.rowIds[0] ?? '', colIdAt(0))]: { kind: 'text', text: String(head) },
        },
      },
    ]);
  });

  bench('open a 1,000-cell sheet cold (reset: parse, resolve and evaluate every formula)', () => {
    new FormulaEngine().apply([{ type: 'reset', snapshot: { tables: [thousand.table] } }]);
  });
});
