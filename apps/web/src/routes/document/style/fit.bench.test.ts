import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  openDocument,
  setCellText,
  setTableLook,
  tableById,
  tableMap,
  TYPE_SIZE_PX,
} from '@gede/core';

import { fitRowsToContent, memoised, type FitMeasure } from './fit.js';

/**
 * PRD §20 budget for the auto-height pass (ADR-049): a whole-table re-measure
 * of the 160 × 22 fixture — every cell wrapping a sentence — under one frame.
 * The measurer is a fake (jsdom has no canvas): per-character widths, so this
 * times the wrapping and the row arithmetic; in Chrome `measureText` runs once
 * per distinct word and font and is memoised. The bound is generous (three
 * frames; 10 ms measured while this was written) so a slow CI runner does not
 * fail it; the number itself is printed for the PR.
 */
const fake: FitMeasure = memoised({
  measure: (text, font) => text.length * (TYPE_SIZE_PX[font.size] / 2),
});

describe('auto-height budget (PRD §20, ADR-049)', () => {
  it('GRID-09 a full pass over 160 columns × 22 rows of wrapped sentences stays inside the budget', () => {
    const gd = openDocument(new Y.Doc());
    const sheet = createSheet(gd);
    const id = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 160, rows: 22 });
    const rec = tableById(gd, id)!;
    const table = tableMap(gd, id)!;
    gd.doc.transact(() => {
      for (const [ri, rowId] of rec.rows.entries()) {
        for (const [ci, col] of rec.columns.entries()) {
          setCellText(
            gd,
            id,
            rowId,
            col.id,
            `Row ${String(ri)} column ${String(ci)} holds a sentence long enough to wrap into a few lines of text`,
          );
        }
      }
    });
    setTableLook(gd, id, { wrap: true });
    const record = tableById(gd, id)!;
    // Warm the word cache the way a second edit finds it, then time a whole-table pass.
    fitRowsToContent(table, record, { locale: 'en-US', measure: fake });
    const t0 = performance.now();
    const needs = fitRowsToContent(table, record, { locale: 'en-US', measure: fake });
    const ms = performance.now() - t0;
    console.log(`auto-height pass, 160 × 22 wrapped cells: ${ms.toFixed(1)} ms`);
    expect(needs).toHaveLength(22);
    expect(needs.every((n) => n.units >= 3)).toBe(true);
    expect(ms).toBeLessThan(48);
  });
});
