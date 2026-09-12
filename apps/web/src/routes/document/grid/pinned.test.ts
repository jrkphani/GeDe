import { describe, expect, it } from 'vitest';
import { LATTICE, type TableRecord } from '@gede/core';

import { frozenColumns, frozenWidthPx, pinnedPanelOffset } from './pinned.js';

const col = (id: string, width = 1, hidden = false) => ({
  id,
  label: id,
  width,
  hidden,
  wrap: false,
  source: 'entered' as const,
  format: 'auto' as const,
  formatOpts: {},
});

/** A table at column 2 (x = 320 px) with columns of 1, 2 and 1 units: 640 px wide. */
const table = (frozen: number, columns = [col('a'), col('b', 2), col('c')]): TableRecord => ({
  id: 't',
  sheetId: 's',
  title: 'T',
  gridCol: 2,
  gridRow: 0,
  columns,
  rows: ['r1'],
  frozenColumns: frozen,
  headerRows: 1,
  footerRows: 0,
});

describe('pinned panel (GRID-10)', () => {
  it('GRID-10 the frozen columns are the leading visible ones, and their width is in lattice units', () => {
    expect(frozenColumns(table(0))).toEqual([]);
    expect(frozenColumns(table(2)).map((c) => c.id)).toEqual(['a', 'b']);
    expect(frozenWidthPx(table(2))).toBe(3 * LATTICE.col);
    expect(
      frozenColumns(table(2, [col('a', 1, true), col('b'), col('c')])).map((c) => c.id),
    ).toEqual(['b']);
  });

  it('GRID-10 the panel appears only while the table is scrolled under the viewport edge with unfrozen columns still on screen', () => {
    const t = table(1);
    expect(pinnedPanelOffset(t, 0)).toBeNull(); // table fully to the right of the edge
    expect(pinnedPanelOffset(t, 320)).toBeNull(); // edge exactly on the table's left
    expect(pinnedPanelOffset(t, 321)).toBe(1);
    expect(pinnedPanelOffset(t, 500)).toBe(180);
    // 320 + 640 − 160 = 800: past here only the frozen column would remain, so no panel.
    expect(pinnedPanelOffset(t, 799)).toBe(479);
    expect(pinnedPanelOffset(t, 800)).toBeNull();
    expect(pinnedPanelOffset(table(0), 500)).toBeNull();
    // Every frozen column hidden: nothing to carry.
    expect(pinnedPanelOffset(table(1, [col('a', 1, true), col('b')]), 400)).toBeNull();
  });
});
