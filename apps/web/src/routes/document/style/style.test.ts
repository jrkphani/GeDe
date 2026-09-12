/**
 * The style module off the DOM: fit-to-content from a measured width to
 * whole units (GRID-01), the rules client against a labelled FAKE Worker
 * and on the main thread, and the traversal over merged spans (MENU-04).
 */
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  handleRulesRequest,
  isRulesRequest,
  LATTICE,
  mergeCells,
  openDocument,
  setCellText,
  setColumnAppearance,
  setColumnWidth,
  spanIndex,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
  type RulesResponse,
} from '@gede/core';

import { nextCell, type TraversalTable } from '../../../doc/selection.js';
import { fitColumnsToContent, fitRowsToContent, MAX_FIT_UNITS, type FitMeasure } from './fit.js';
import { createRuleEvaluator } from './rules-client.js';

function fixture(): { gd: GedeDoc; tableId: Id; rows: readonly Id[]; cols: readonly Id[] } {
  const gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 3 });
  const rec = tableById(gd, tableId)!;
  return { gd, tableId, rows: rec.rows, cols: rec.columns.map((c) => c.id) };
}

/** A FAKE measurer: 7 canvas px per character, doubled for the h2 size, so widths are arithmetic. */
const perChar: FitMeasure = {
  measure: (text, font) => text.length * (font.size === 'h2' ? 14 : 7),
};

describe('INSP-04 fit to content', () => {
  it('INSP-04 GRID-01 columns fit their widest cell (or label) in whole units, at least one, capped; the font in force is measured', () => {
    const { gd, tableId, rows, cols } = fixture();
    const table = tableMap(gd, tableId)!;
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'x'.repeat(40)); // 280 px + chrome → 2 units
    setCellText(gd, tableId, rows[1]!, cols[1]!, 'x'.repeat(400)); // far past the cap
    setColumnAppearance(gd, tableId, cols[2]!, { size: 'h2' });
    setCellText(gd, tableId, rows[2]!, cols[2]!, 'x'.repeat(12)); // 168 px at h2 → 2 units
    const widths = fitColumnsToContent(table, tableById(gd, tableId)!, {
      locale: 'en-US',
      measure: perChar,
    });
    expect(widths).toEqual([
      { colId: cols[0], units: 2 },
      { colId: cols[1], units: MAX_FIT_UNITS },
      { colId: cols[2], units: 2 },
    ]);
    // Every width is a whole number of lattice columns.
    for (const w of widths) expect(Number.isInteger(w.units)).toBe(true);
  });

  it('INSP-04 GRID-09 rows wrap when any cell runs past its column; the rest read compact; a wrapped column is not counted twice', () => {
    const { gd, tableId, rows, cols } = fixture();
    const table = tableMap(gd, tableId)!;
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'x'.repeat(30)); // 210 px > 160 → wraps
    setCellText(gd, tableId, rows[1]!, cols[0]!, 'short');
    setColumnWidth(gd, tableId, cols[1]!, 2);
    setCellText(gd, tableId, rows[2]!, cols[1]!, 'x'.repeat(30)); // 210 px < 320 → fits
    const fit = fitRowsToContent(table, tableById(gd, tableId)!, {
      locale: 'en-US',
      measure: perChar,
    });
    expect(fit).toEqual([
      { rowId: rows[0], wrapped: true },
      { rowId: rows[1], wrapped: false },
      { rowId: rows[2], wrapped: false },
    ]);
    expect(LATTICE.col).toBe(160);
  });
});

/** A FAKE Worker: runs the same handler through a message hop, with a hook to go silent. */
class FakeRulesWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  static silent = false;
  static spawned = 0;
  constructor() {
    FakeRulesWorker.spawned += 1;
  }
  postMessage(request: unknown): void {
    if (FakeRulesWorker.silent || !isRulesRequest(request)) return;
    const response: RulesResponse = handleRulesRequest(request);
    queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent<unknown>));
  }
  terminate(): void {
    /* nothing to stop */
  }
}

describe('INSP-05 the rules client', () => {
  const input = {
    tableId: 't',
    colId: 'c',
    rules: [{ id: 'r', when: { trigger: 'contains' as const, text: 'due' }, style: {} }],
    cells: [
      { key: 'a:c' as const, text: 'overdue' },
      { key: 'b:c' as const, text: 'paid' },
    ],
  };

  it('INSP-05 evaluates through the Worker and on the main thread alike; a newer request for the same column makes the older answer stale', async () => {
    const main = createRuleEvaluator({ worker: false });
    expect(main.mode).toBe('main');
    await expect(main.evaluate(input)).resolves.toEqual({
      ok: true,
      matches: [{ key: 'a:c', ruleId: 'r' }],
    });
    const worker = createRuleEvaluator({
      worker: true,
      spawn: () => new FakeRulesWorker() as unknown as Worker,
    });
    expect(worker.mode).toBe('worker');
    const first = worker.evaluate(input);
    const second = worker.evaluate(input);
    await expect(first).resolves.toMatchObject({ ok: false, stale: true });
    await expect(second).resolves.toEqual({ ok: true, matches: [{ key: 'a:c', ruleId: 'r' }] });
    worker.dispose();
  });

  it('INSP-05 a Worker that never answers is recycled after the watchdog and the next call gets a fresh one', async () => {
    vi.useFakeTimers();
    try {
      FakeRulesWorker.spawned = 0;
      FakeRulesWorker.silent = true;
      const worker = createRuleEvaluator({
        worker: true,
        spawn: () => new FakeRulesWorker() as unknown as Worker,
        timeoutMs: 50,
      });
      const pending = worker.evaluate(input);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({ ok: false, error: /timed out/ });
      FakeRulesWorker.silent = false;
      const again = worker.evaluate(input);
      await vi.advanceTimersByTimeAsync(1);
      await expect(again).resolves.toMatchObject({ ok: true });
      expect(FakeRulesWorker.spawned).toBe(2);
      worker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MENU-04 traversal over merged spans', () => {
  it('MENU-04 GRID-05 arrows and Tab skip the cells a span covers: from the anchor past its own span, into a span onto its anchor', () => {
    const { gd, tableId, rows, cols } = fixture();
    mergeCells(gd, tableId, rows[0]!, cols[0]!, { rows: 2, cols: 2 });
    const record = tableById(gd, tableId)!;
    const table: TraversalTable = {
      rows: record.rows,
      columns: record.columns.map((c) => ({ id: c.id, hidden: c.hidden })),
      covered: spanIndex(tableMap(gd, tableId)!, record).covered,
    };
    const anchor = { rowId: rows[0]!, colId: cols[0]! };
    // Right from the anchor lands after the two covered columns.
    expect(nextCell(table, anchor, 'right')).toEqual({
      kind: 'cell',
      rowId: rows[0],
      colId: cols[2],
    });
    // Down from the anchor lands under the span.
    expect(nextCell(table, anchor, 'down')).toEqual({
      kind: 'cell',
      rowId: rows[2],
      colId: cols[0],
    });
    // Left from D5 lands on the anchor, not on the covered C5.
    expect(nextCell(table, { rowId: rows[0]!, colId: cols[2]! }, 'left')).toEqual({
      kind: 'cell',
      rowId: rows[0],
      colId: cols[0],
    });
    // Up from C7 (under the span's covered C6) lands on the anchor.
    expect(nextCell(table, { rowId: rows[2]!, colId: cols[1]! }, 'up')).toEqual({
      kind: 'cell',
      rowId: rows[0],
      colId: cols[0],
    });
    // Without spans the traversal is unchanged.
    const plain: TraversalTable = { rows: table.rows, columns: table.columns };
    expect(nextCell(plain, anchor, 'right')).toEqual({
      kind: 'cell',
      rowId: rows[0],
      colId: cols[1],
    });
  });
});
