/**
 * Fit rows and columns to content (INSP-04): measure what each cell shows —
 * the laid-out text under its format, in the column's font — and turn the
 * widest into whole lattice units (GRID-01), or decide which rows need the
 * two-unit wrapped height (GRID-09). Measuring is a DOM job (canvas
 * `measureText`), so it lives here; the writes go through `GridCommands`
 * as one transaction each.
 */
import {
  cellAppearanceFor,
  cellFormatFor,
  cellRich,
  cellsMap,
  evaluatedText,
  isFormula,
  LATTICE,
  richFromText,
  TYPE_SIZE_PX,
  workbookCellId,
  type CellValue,
  type FontFamily,
  type FontWeight,
  type FormatLocale,
  type Id,
  type TableMap,
  type TableRecord,
  type TypeSize,
  type WorkbookCellId,
} from '@gede/core';

import { layoutCell } from '../cell/layout.js';

/** Horizontal room a cell spends on padding and its right rule, in canvas px (`.gd-cell`). */
const CELL_CHROME_PX = 17;
/** Widest a fitted column goes, in units: past this a column is a paragraph, not a field. */
export const MAX_FIT_UNITS = 8;

export interface FitMeasure {
  /** Width of the text in canvas px at the cell's font, or 0 when nothing can be measured. */
  measure(text: string, font: { family: FontFamily; weight: FontWeight; size: TypeSize }): number;
}

/** Canvas `measureText` in the token fonts; null where no 2D context exists (jsdom). */
export function canvasMeasure(root: HTMLElement = document.documentElement): FitMeasure | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const styles = getComputedStyle(root);
  const families: Record<FontFamily, string> = {
    ui: styles.getPropertyValue('--font-ui').trim() || 'sans-serif',
    mono: styles.getPropertyValue('--font-mono').trim() || 'monospace',
  };
  return {
    measure: (text, font) => {
      ctx.font = `${String(font.weight)} ${String(TYPE_SIZE_PX[font.size])}px ${families[font.family]}`;
      return ctx.measureText(text).width;
    },
  };
}

export interface FitOptions {
  locale: FormatLocale;
  measure: FitMeasure;
  /** A formula cell's evaluated value (FX-07); absent means its text is measured as empty. */
  cellValue?: ((cellId: WorkbookCellId) => CellValue | undefined) | undefined;
}

function shownText(table: TableMap, record: TableRecord, rowId: Id, colId: Id, o: FitOptions) {
  const column = record.columns.find((c) => c.id === colId) ?? null;
  const key = `${rowId}:${colId}` as const;
  const content = cellsMap(table).get(key);
  const rich = isFormula(content)
    ? richFromText(evaluatedText(o.cellValue?.(workbookCellId(record.id, key))))
    : cellRich(table, rowId, colId);
  return layoutCell(rich, cellFormatFor(table, column, rowId), o.locale).text;
}

function fontOf(table: TableMap, record: TableRecord, rowId: Id, colId: Id) {
  const column = record.columns.find((c) => c.id === colId) ?? null;
  const a = cellAppearanceFor(table, column, rowId);
  return { family: a.font ?? 'ui', weight: a.weight ?? 400, size: a.size ?? 'cell' } as const;
}

/** Widest cell per visible column → whole units, at least 1, at most `MAX_FIT_UNITS`. */
export function fitColumnsToContent(
  table: TableMap,
  record: TableRecord,
  o: FitOptions,
): { colId: Id; units: number }[] {
  return record.columns
    .filter((c) => !c.hidden)
    .map((column) => {
      let widest = o.measure.measure(column.label, {
        family: 'ui',
        weight: 500,
        size: 'cell',
      });
      for (const rowId of record.rows) {
        const text = shownText(table, record, rowId, column.id, o);
        if (text === '') continue;
        widest = Math.max(widest, o.measure.measure(text, fontOf(table, record, rowId, column.id)));
      }
      const units = Math.ceil((widest + CELL_CHROME_PX) / LATTICE.col);
      return { colId: column.id, units: Math.min(MAX_FIT_UNITS, Math.max(1, units)) };
    });
}

/**
 * Which rows need the wrapped height: a row wraps when any of its cells'
 * text runs past its column's width. Every other row reads compact.
 */
export function fitRowsToContent(
  table: TableMap,
  record: TableRecord,
  o: FitOptions,
): { rowId: Id; wrapped: boolean }[] {
  return record.rows.map((rowId) => {
    let wrapped = false;
    for (const column of record.columns) {
      if (column.hidden || column.wrap) continue;
      const text = shownText(table, record, rowId, column.id, o);
      if (text === '') continue;
      const width = o.measure.measure(text, fontOf(table, record, rowId, column.id));
      if (width + CELL_CHROME_PX > column.width * LATTICE.col) {
        wrapped = true;
        break;
      }
    }
    return { rowId, wrapped };
  });
}
