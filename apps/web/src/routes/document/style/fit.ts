/**
 * Fit rows and columns to content (INSP-04): measure what each cell shows —
 * the laid-out text under its format, in the column's font — and turn the
 * widest into whole lattice units (GRID-01), or decide which rows need the
 * two-unit wrapped height (GRID-09). Measuring is a DOM job (canvas
 * `measureText`), so it lives here; the writes go through `GridCommands`
 * as one transaction each.
 */
import {
  BOLD_WEIGHT,
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

import { layoutCell, type CellLayout } from '../cell/layout.js';

/** Horizontal room a cell spends on padding and its right rule, in canvas px (`.gd-cell`). */
const CELL_CHROME_PX = 17;
/** Widest a fitted column goes, in units: past this a column is a paragraph, not a field. */
export const MAX_FIT_UNITS = 8;

/** The font one run of text is measured in: the cell's, with the run's marks applied. */
export interface MeasureFont {
  readonly family: FontFamily;
  readonly weight: FontWeight;
  readonly size: TypeSize;
  readonly italic?: boolean | undefined;
}

export interface FitMeasure {
  /** Width of the text in canvas px at the font, or 0 when nothing can be measured. */
  measure(text: string, font: MeasureFont): number;
}

/** Whether this browser can measure text at all (a 2D canvas context exists). Cached. */
let measurable: boolean | null = null;
export function canMeasure(): boolean {
  measurable ??=
    typeof document !== 'undefined' && document.createElement('canvas').getContext('2d') !== null;
  return measurable;
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
      ctx.font = `${font.italic === true ? 'italic ' : ''}${String(font.weight)} ${String(TYPE_SIZE_PX[font.size])}px ${families[font.family]}`;
      return ctx.measureText(text).width;
    },
  };
}

export interface FitOptions {
  locale: FormatLocale;
  measure: FitMeasure;
  /** A formula cell's evaluated value (FX-07); absent means its text is measured as empty. */
  cellValue?: ((cellId: WorkbookCellId) => CellValue | undefined) | undefined;
  /** Restrict `fitColumnsToContent` to these columns (the column menu fits one). */
  only?: readonly Id[] | undefined;
}

function shownLayout(table: TableMap, record: TableRecord, rowId: Id, colId: Id, o: FitOptions) {
  const column = record.columns.find((c) => c.id === colId) ?? null;
  const key = `${rowId}:${colId}` as const;
  const content = cellsMap(table).get(key);
  const rich = isFormula(content)
    ? richFromText(evaluatedText(o.cellValue?.(workbookCellId(record.id, key))))
    : cellRich(table, rowId, colId);
  return layoutCell(rich, cellFormatFor(table, column, rowId), o.locale);
}

function fontOf(table: TableMap, record: TableRecord, rowId: Id, colId: Id): MeasureFont {
  const column = record.columns.find((c) => c.id === colId) ?? null;
  const a = cellAppearanceFor(table, column, rowId);
  return { family: a.font ?? 'ui', weight: a.weight ?? 400, size: a.size ?? 'cell' };
}

/**
 * The widest line of what a cell shows: each paragraph is one line, and each
 * run is measured in the cell's font with its own marks — a bold run is
 * wider (600), an italic one slants; superscript and subscript are drawn at
 * three quarters. A formula's evaluated text is one run.
 */
export function widestLine(layout: CellLayout, font: MeasureFont, measure: FitMeasure): number {
  let widest = 0;
  for (const runs of layout.paragraphs) {
    let line = 0;
    for (const run of runs) {
      if (run.text === '') continue;
      const bold = run.marks.some((m) => m.type === 'bold');
      const italic = run.marks.some((m) => m.type === 'italic');
      const script = run.marks.some((m) => m.type === 'superscript' || m.type === 'subscript');
      const width = measure.measure(run.text, {
        ...font,
        weight: bold ? BOLD_WEIGHT : font.weight,
        italic,
      });
      line += script ? width * 0.75 : width;
    }
    widest = Math.max(widest, line);
  }
  return widest;
}

/** Widest cell per visible column → whole units, at least 1, at most `MAX_FIT_UNITS`. */
export function fitColumnsToContent(
  table: TableMap,
  record: TableRecord,
  o: FitOptions,
): { colId: Id; units: number }[] {
  return record.columns
    .filter((c) => !c.hidden && (o.only === undefined || o.only.includes(c.id)))
    .map((column) => {
      let widest = o.measure.measure(column.label, {
        family: 'ui',
        weight: 500,
        size: 'cell',
      });
      for (const rowId of record.rows) {
        const layout = shownLayout(table, record, rowId, column.id, o);
        if (layout.text === '') continue;
        widest = Math.max(
          widest,
          widestLine(layout, fontOf(table, record, rowId, column.id), o.measure),
        );
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
      const layout = shownLayout(table, record, rowId, column.id, o);
      if (layout.text === '') continue;
      const width = widestLine(layout, fontOf(table, record, rowId, column.id), o.measure);
      if (width + CELL_CHROME_PX > column.width * LATTICE.col) {
        wrapped = true;
        break;
      }
    }
    return { rowId, wrapped };
  });
}
