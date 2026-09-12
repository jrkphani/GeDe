import { LATTICE, type TableRecord } from '@gede/core';

/** The first `frozenColumns` columns that are visible (GRID-10). */
export function frozenColumns(record: TableRecord): TableRecord['columns'] {
  return record.columns.slice(0, record.frozenColumns).filter((c) => !c.hidden);
}

/** Pixel width of the frozen columns at zoom 1. */
export function frozenWidthPx(record: TableRecord): number {
  return frozenColumns(record).reduce((acc, c) => acc + c.width, 0) * LATTICE.col;
}

/**
 * GRID-10: where the pinned panel sits, as a canvas-pixel offset from the
 * table's left edge, or null when no panel is due. A panel is due while the
 * viewport's left edge has scrolled past the table's left edge but the table
 * still has unfrozen columns on screen — then the frozen columns ride along
 * the viewport edge so they stay readable.
 */
export function pinnedPanelOffset(record: TableRecord, viewportLeftPx: number): number | null {
  if (record.frozenColumns <= 0) return null;
  const frozenPx = frozenWidthPx(record);
  if (frozenPx === 0) return null;
  const left = record.gridCol * LATTICE.col;
  const width =
    record.columns.filter((c) => !c.hidden).reduce((a, c) => a + c.width, 0) * LATTICE.col;
  if (viewportLeftPx <= left) return null;
  if (viewportLeftPx >= left + width - frozenPx) return null;
  return viewportLeftPx - left;
}
