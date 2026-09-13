/**
 * Fit rows and columns to content (INSP-04, GRID-08, GRID-09, ADR-049):
 * measure what each cell shows — the laid-out text under its format, in the
 * cell's font, wrapped into its column when the cell wraps — and turn the
 * widest into whole lattice units of width, or the tallest into whole units
 * of height. Measuring is a DOM job (canvas `measureText`), so it lives
 * here; the writes go through `GridCommands` as one transaction each, and
 * the editing replica stores the heights so every other replica addresses
 * by the same numbers without measuring (non-negotiable 3).
 */
import {
  BOLD_WEIGHT,
  cellAppearanceFor,
  cellAppearanceOverride,
  cellFormatFor,
  cellRich,
  cellsMap,
  evaluatedText,
  isFormula,
  LATTICE,
  lineBoxPx,
  mergeAppearance,
  richFromText,
  rowMeta,
  rowsForLines,
  rowsForSize,
  spanIndex,
  TYPE_SIZE_PX,
  workbookCellId,
  type CellKey,
  type CellValue,
  type ColumnRecord,
  type FontFamily,
  type FontWeight,
  type FormatLocale,
  type Id,
  type SpanIndex,
  type TableMap,
  type TableRecord,
  type TypeSize,
  type WorkbookCellId,
} from '@gede/core';

import { layoutCell, type CellLayout } from '../cell/layout.js';

/** Horizontal room a cell spends on padding and its right rule, in canvas px (`.gd-cell`). */
const CELL_CHROME_PX = 17;
/** Vertical room a wrapped cell spends above its first line (`.gd-cell--wrap` padding-top, 2 px). */
const WRAP_PAD_PX = 2;
/**
 * Fit has no ceiling on either axis (#167 criterion 6: Numbers has none): a
 * column is as wide as its widest line, a row as tall as its tallest cell.
 */

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

/** A font's cache key, computed once per font object (a run's font serves every word of the run). */
const fontKeys = new WeakMap<MeasureFont, string>();
function fontKey(font: MeasureFont): string {
  const hit = fontKeys.get(font);
  if (hit !== undefined) return hit;
  const key = `${font.family}|${String(font.weight)}|${font.size}|${font.italic === true ? 'i' : 'r'}`;
  fontKeys.set(font, key);
  return key;
}

/**
 * Canvas `measureText` in the token fonts, memoised per font and string —
 * a wrap measures every word of every wrapped cell, and the same words
 * recur across a column. Null where no 2D context exists (jsdom).
 */
export function canvasMeasure(root: HTMLElement = document.documentElement): FitMeasure | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const styles = getComputedStyle(root);
  const families: Record<FontFamily, string> = {
    ui: styles.getPropertyValue('--font-ui').trim() || 'sans-serif',
    mono: styles.getPropertyValue('--font-mono').trim() || 'monospace',
  };
  return memoised({
    measure: (text, font) => {
      ctx.font = `${font.italic === true ? 'italic ' : ''}${String(font.weight)} ${String(TYPE_SIZE_PX[font.size])}px ${families[font.family]}`;
      return ctx.measureText(text).width;
    },
  });
}

/** Cap on remembered measurements: past it the cache starts over (bounded memory, PRD §20). */
const CACHE_LIMIT = 20_000;

/** A measure that remembers each (font, text) it has answered. */
export function memoised(inner: FitMeasure): FitMeasure {
  // Two levels — font, then text — so a word costs one map lookup, no key building.
  let byFont = new Map<string, Map<string, number>>();
  let size = 0;
  return {
    measure: (text, font) => {
      const key = fontKey(font);
      let widths = byFont.get(key);
      if (widths === undefined) {
        widths = new Map();
        byFont.set(key, widths);
      }
      const hit = widths.get(text);
      if (hit !== undefined) return hit;
      if (size >= CACHE_LIMIT) {
        byFont = new Map();
        widths = new Map();
        byFont.set(key, widths);
        size = 0;
      }
      const width = inner.measure(text, font);
      widths.set(text, width);
      size += 1;
      return width;
    },
  };
}

export interface FitOptions {
  locale: FormatLocale;
  measure: FitMeasure;
  /** A formula cell's evaluated value (FX-07); absent means its text is measured as empty. */
  cellValue?: ((cellId: WorkbookCellId) => CellValue | undefined) | undefined;
  /** Restrict `fitColumnsToContent` / `fitRowsToContent` to these ids (a menu fits one). */
  only?: readonly Id[] | undefined;
  /**
   * Widths to measure against instead of the stored ones (a drag previews a
   * width before it commits): column id → units.
   */
  widths?: ReadonlyMap<Id, number> | undefined;
}

function shownLayout(
  table: TableMap,
  record: TableRecord,
  rowId: Id,
  column: ColumnRecord,
  o: FitOptions,
) {
  const key = `${rowId}:${column.id}` as const;
  const content = cellsMap(table).get(key);
  const rich = isFormula(content)
    ? richFromText(evaluatedText(o.cellValue?.(workbookCellId(record.id, key))))
    : cellRich(table, rowId, column.id);
  return {
    layout: layoutCell(rich, cellFormatFor(table, column, rowId), o.locale),
    formula: isFormula(content),
  };
}

function fontOf(table: TableMap, column: ColumnRecord, rowId: Id): MeasureFont {
  const a = cellAppearanceFor(table, column, rowId);
  return { family: a.font ?? 'ui', weight: a.weight ?? 400, size: a.size ?? 'cell' };
}

function runFont(font: MeasureFont, run: CellLayout['paragraphs'][number][number]): MeasureFont {
  const bold = run.marks.some((m) => m.type === 'bold');
  const italic = run.marks.some((m) => m.type === 'italic');
  return { ...font, weight: bold ? BOLD_WEIGHT : font.weight, italic };
}

function runWidth(
  run: CellLayout['paragraphs'][number][number],
  font: MeasureFont,
  measure: FitMeasure,
): number {
  const script = run.marks.some((m) => m.type === 'superscript' || m.type === 'subscript');
  const width = measure.measure(run.text, runFont(font, run));
  return script ? width * 0.75 : width;
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
      line += runWidth(run, font, measure);
    }
    widest = Math.max(widest, line);
  }
  return widest;
}

const WHITESPACE = /\s/;

/** Split text into words and the whitespace between them, in order, nothing dropped; memoised per string. */
const TOKEN_CACHE_LIMIT = 5000;
let tokenCache = new Map<string, readonly string[]>();
function tokens(text: string): readonly string[] {
  const hit = tokenCache.get(text);
  if (hit !== undefined) return hit;
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache = new Map();
  const out = text.match(/\s+|\S+/g) ?? [];
  tokenCache.set(text, out);
  return out;
}

/**
 * Lines a paragraph takes when wrapped into `widthPx`, the way the cell's
 * `white-space: normal; overflow-wrap: anywhere` lays it out: words move to
 * the next line whole, and a word wider than the line breaks wherever it must.
 * Each run keeps its own marks while it is measured. Never below one line.
 */
export function wrappedLines(
  runs: readonly CellLayout['paragraphs'][number][number][],
  font: MeasureFont,
  widthPx: number,
  measure: FitMeasure,
): number {
  if (widthPx <= 0) return 1;
  let lines = 1;
  let line = 0;
  for (const run of runs) {
    if (run.text === '') continue;
    const f = runFont(font, run);
    const script = run.marks.some((m) => m.type === 'superscript' || m.type === 'subscript');
    const scale = script ? 0.75 : 1;
    for (const token of tokens(run.text)) {
      const width = measure.measure(token, f) * scale;
      // A token is all whitespace or none: its first character says which.
      if (WHITESPACE.test(token.charAt(0))) {
        // Trailing whitespace hangs past the edge; it never starts a line of its own.
        line += width;
        continue;
      }
      if (line + width <= widthPx || line === 0) {
        if (width > widthPx) {
          // A single word wider than the line breaks by character (`anywhere`): as many
          // full lines as it fills, with the remainder starting the next.
          const extra = Math.max(0, Math.ceil(width / widthPx) - 1);
          lines += extra;
          line = width - extra * widthPx;
        } else {
          line += width;
        }
        continue;
      }
      lines += 1;
      if (width > widthPx) {
        const extra = Math.max(0, Math.ceil(width / widthPx) - 1);
        lines += extra;
        line = width - extra * widthPx;
      } else {
        line = width;
      }
    }
  }
  return Math.max(1, lines);
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
        const { layout } = shownLayout(table, record, rowId, column, o);
        if (layout.text === '') continue;
        widest = Math.max(widest, widestLine(layout, fontOf(table, column, rowId), o.measure));
      }
      const units = Math.ceil((widest + CELL_CHROME_PX) / LATTICE.col);
      return { colId: column.id, units: Math.max(1, units) };
    });
}

/** What one row needs, and why — the tallest cell names the reason for the announcement. */
export interface RowNeed {
  readonly rowId: Id;
  /** Whole lattice units the row's tallest cell needs; 1 for an empty or compact row. */
  readonly units: number;
}

interface RowNeedContext {
  readonly table: TableMap;
  readonly record: TableRecord;
  readonly o: FitOptions;
  readonly spans: SpanIndex;
  readonly tableWrap: boolean;
  /** Heights as stored, updated row by row with what this pass computes (a span's rows sum). */
  readonly heights: Map<Id, number>;
  readonly visible: readonly ColumnRecord[];
}

function widthUnitsOf(ctx: RowNeedContext, column: ColumnRecord): number {
  return ctx.o.widths?.get(column.id) ?? column.width;
}

/**
 * Whole units one cell needs at `widthPx`: its lines at its type size's line
 * box. `rowWrap` is the row's own wrap, read once per row by the caller.
 */
function cellNeed(
  ctx: RowNeedContext,
  rowId: Id,
  column: ColumnRecord,
  widthPx: number,
  rowWrap: boolean | null,
): number {
  const { table, record, o } = ctx;
  const { layout } = shownLayout(table, record, rowId, column, o);
  // One read of the cell's override serves the font and the wrap (cell > row > column > table).
  const override = cellAppearanceOverride(table, rowId, column.id);
  const a = override === null ? column.appearance : mergeAppearance(column.appearance, override);
  const font: MeasureFont = {
    family: a.font ?? 'ui',
    weight: a.weight ?? 400,
    size: a.size ?? 'cell',
  };
  if (layout.text === '') {
    // An empty cell still needs its type size's line box (ADR-034).
    return rowsForSize(font.size, false);
  }
  const indic = layout.lang !== null;
  const wrap = override?.wrap ?? rowWrap ?? column.wrap ?? ctx.tableWrap;
  let lines = 0;
  if (wrap) {
    for (const runs of layout.paragraphs) {
      lines += wrappedLines(runs, font, widthPx - CELL_CHROME_PX, o.measure);
    }
  } else {
    lines = Math.max(1, layout.paragraphs.length);
  }
  // The formula expression and the reference path are paint (ADR-024, ADR-043, #167
  // criterion 16): they share the value's line or take a line the row already has, and
  // never drive the height.
  return rowsForLines(lines, lineBoxPx(font.size, indic), wrap ? WRAP_PAD_PX : 0);
}

/**
 * Whole lattice units one row needs so that none of its cells clips a line
 * it should show (GRID-09, ADR-049): for each visible cell, the lines its
 * text takes — every paragraph one line, wrapped into the column's width
 * when the cell wraps — at the line box of its type size (Indic text at the
 * 1.7 floor, I18N-03), or the single line box a display size needs even
 * unwrapped (ADR-034). A merged span is measured over the span's width, and
 * what its lines need beyond the span's other rows goes to the span's *last*
 * row (ADR-033, #167 criterion 15) — deterministic on every replica. Covered
 * cells need nothing of their own row. Never below one unit.
 */
function rowNeed(ctx: RowNeedContext, rowId: Id): number {
  const { spans } = ctx;
  const rowWrap = rowMeta(ctx.table, rowId).wrap;
  let units = 1;
  for (const column of ctx.visible) {
    const key: CellKey = `${rowId}:${column.id}`;
    const anchorKey = spans.covered.get(key);
    const span = spans.byAnchor.get(anchorKey ?? key) ?? null;
    if (span === null) {
      units = Math.max(
        units,
        cellNeed(ctx, rowId, column, widthUnitsOf(ctx, column) * LATTICE.col, rowWrap),
      );
      continue;
    }
    // A span counts once, on its last row, over its whole width.
    if (span.rowIds.at(-1) !== rowId || span.colIds[0] !== column.id) continue;
    const widthPx = span.colIds.reduce((acc, id) => {
      const c = ctx.visible.find((v) => v.id === id);
      return c === undefined ? acc : acc + widthUnitsOf(ctx, c) * LATTICE.col;
    }, 0);
    const anchorColumn = ctx.visible.find((v) => v.id === span.colId);
    if (anchorColumn === undefined) continue;
    const otherRows = span.rowIds
      .filter((id) => id !== rowId)
      .reduce((acc, id) => acc + (ctx.heights.get(id) ?? 1), 0);
    const anchorWrap = span.rowId === rowId ? rowWrap : rowMeta(ctx.table, span.rowId).wrap;
    units = Math.max(
      units,
      cellNeed(ctx, span.rowId, anchorColumn, widthPx, anchorWrap) - otherRows,
    );
  }
  return Math.max(1, units);
}

/** Rows a change to `rows` may re-measure: the rows themselves and the last row of any span they sit in. */
export function rowsToMeasure(table: TableMap, record: TableRecord, rows: readonly Id[]): Id[] {
  const spans = spanIndex(table, record);
  const out = new Set(rows);
  for (const span of spans.byAnchor.values()) {
    if (span.rowIds.some((id) => out.has(id))) {
      const last = span.rowIds.at(-1);
      if (last !== undefined) out.add(last);
    }
  }
  return record.rows.filter((id) => out.has(id));
}

function context(table: TableMap, record: TableRecord, o: FitOptions): RowNeedContext {
  return {
    table,
    record,
    o,
    spans: spanIndex(table, record),
    tableWrap: record.look.wrap,
    heights: new Map(record.rows.map((rowId) => [rowId, rowMeta(table, rowId).height])),
    visible: record.columns.filter((c) => !c.hidden),
  };
}

/**
 * Whole units every row (or the rows in `only`) needs to show its content,
 * in row order. The Fit control writes these with the hand-set floor cleared;
 * the editing replica's auto-fit writes them above the floor.
 */
export function fitRowsToContent(table: TableMap, record: TableRecord, o: FitOptions): RowNeed[] {
  const ctx = context(table, record, o);
  const only = o.only === undefined ? undefined : new Set(o.only);
  // In row order, so a span's earlier rows are already what this pass makes them when its
  // last row takes what the span still needs (#167 criterion 15).
  return record.rows
    .filter((rowId) => only === undefined || only.has(rowId))
    .map((rowId) => {
      const units = rowNeed(ctx, rowId);
      ctx.heights.set(rowId, units);
      return { rowId, units };
    });
}
