/**
 * What a cell looks like (INSP-05, INSP-06, MENU-04), resolved once per cell
 * render from the column's appearance, the cell's override, the column's
 * matched rule and the span the cell anchors — and turned into the class
 * names, custom properties and data attributes `document.css` paints from.
 * Every value is a token name; the stylesheet maps names to `packages/tokens`
 * custom properties, so no colour, size or weight is written here.
 *
 * Nothing here moves a cell (non-negotiable 3): fills and typography are
 * paint; borders are an inset pseudo-element; a span is a wider box over the
 * same lattice positions.
 */
import type { CSSProperties } from 'react';
import {
  borderSides,
  cellAppearanceFor,
  cellKey,
  describeRule,
  isEmptyAppearance,
  LATTICE,
  resolveLook,
  type Appearance,
  type CellFormat,
  type CellSpan,
  type ColumnRecord,
  type Id,
  type ResolvedLook,
  type RuleOutcome,
  type SpanIndex,
  type TableMap,
} from '@gede/core';

export interface CellLook {
  readonly appearance: Appearance;
  readonly rule: RuleOutcome | null;
  /** The span this cell anchors, or null. */
  readonly span: CellSpan | null;
  /** True when another cell's span hides this one: it renders as an empty placeholder. */
  readonly covered: boolean;
  /**
   * The anchor box of a span in lattice units — the widths of the columns
   * and heights of the rows it covers, as the table renders them now (a
   * column drag previews a width before it commits). Null off a span.
   */
  readonly spanUnits: { readonly widthUnits: number; readonly heightUnits: number } | null;
}

export const PLAIN_LOOK: CellLook = {
  appearance: {},
  rule: null,
  span: null,
  covered: false,
  spanUnits: null,
};

/**
 * Resolve the look of one cell. `rules` is the column's matched rules from
 * the rules Worker (`useColumnRules`), keyed by cell; `spans` the table's
 * span index, computed once per table render.
 */
export function styleOf(
  table: TableMap,
  column: ColumnRecord,
  rowId: Id,
  rule: RuleOutcome | null,
  spans: SpanIndex,
  /** Geometry of a span's anchor box, asked for only when the cell anchors one. */
  spanUnits: (span: CellSpan) => CellLook['spanUnits'],
): CellLook {
  const key = cellKey(rowId, column.id);
  const appearance = cellAppearanceFor(table, column, rowId);
  const span = spans.byAnchor.get(key) ?? null;
  const covered = spans.covered.has(key);
  // The common case — nothing set anywhere — shares one object, so the memoised cell's
  // props comparison is a reference check and a 10,000-cell table pays nothing for it.
  if (rule === null && span === null && !covered && isEmptyAppearance(appearance)) {
    return PLAIN_LOOK;
  }
  return { appearance, rule, span, covered, spanUnits: span === null ? null : spanUnits(span) };
}

export function looksEqual(a: CellLook, b: CellLook): boolean {
  if (a === b) return true;
  if (a.covered !== b.covered) return false;
  if ((a.span === null) !== (b.span === null)) return false;
  if (a.span !== null && b.span !== null) {
    if (a.span.rows !== b.span.rows || a.span.cols !== b.span.cols) return false;
    if (
      a.spanUnits?.widthUnits !== b.spanUnits?.widthUnits ||
      a.spanUnits?.heightUnits !== b.spanUnits?.heightUnits
    )
      return false;
  }
  if ((a.rule === null) !== (b.rule === null)) return false;
  if (a.rule !== null && b.rule !== null) {
    if (
      a.rule.rule.id !== b.rule.rule.id ||
      a.rule.fill !== b.rule.fill ||
      a.rule.textColour !== b.rule.textColour ||
      a.rule.mark !== b.rule.mark ||
      describeRule(a.rule.rule) !== describeRule(b.rule.rule)
    )
      return false;
  }
  const x = a.appearance;
  const y = b.appearance;
  return (
    x.fill === y.fill &&
    x.font === y.font &&
    x.weight === y.weight &&
    x.size === y.size &&
    x.textColour === y.textColour &&
    x.hAlign === y.hAlign &&
    x.vAlign === y.vAlign &&
    x.border?.edges === y.border?.edges &&
    x.border?.weight === y.border?.weight
  );
}

export interface LookPaint {
  /** Classes on the cell root, beside the grid's own. */
  readonly className: string;
  /** Custom properties the stylesheet reads (border sides, span size). */
  readonly style: CSSProperties;
  /** `data-*` attributes: fill, ink, font, weight, size, alignment, rule. */
  readonly data: Readonly<Record<string, string | undefined>>;
  readonly resolved: ResolvedLook;
  /** The matched rule spelled out, for the glyph's label; null when none matched. */
  readonly ruleLabel: string | null;
}

/**
 * The paint for a cell: the resolved look as attributes. `format` decides
 * Automatic alignment (numbers right, FMT-02). A span's anchor box is sized
 * from `spanUnits`, so no other cell is touched.
 */
export function paintLook(look: CellLook, format: CellFormat): LookPaint {
  const resolved = resolveLook(look.appearance, look.rule, format);
  const a = look.appearance;
  const classes: string[] = [];
  const style: Record<string, string> & CSSProperties = {};
  if (a.border !== undefined) {
    const sides = borderSides(a.border.edges);
    classes.push('gd-cell--bordered');
    style['--gd-border-colour'] = `var(--rule-${a.border.weight})`;
    style['--gd-border-width'] = a.border.weight === 'hairline' ? '1px' : '2px';
    style['--gd-bt'] = sides.top ? '1' : '0';
    style['--gd-br'] = sides.right ? '1' : '0';
    style['--gd-bb'] = sides.bottom ? '1' : '0';
    style['--gd-bl'] = sides.left ? '1' : '0';
  }
  if (look.span !== null && look.spanUnits !== null) {
    classes.push('gd-cell--span');
    style.width = `${String(look.spanUnits.widthUnits * LATTICE.col)}px`;
    style.height = `${String(look.spanUnits.heightUnits * LATTICE.row)}px`;
  }
  if (look.covered) classes.push('gd-cell--covered');
  if (look.rule !== null) classes.push('gd-cell--rule');
  const mark = look.rule?.mark;
  return {
    className: classes.join(' '),
    style,
    data: {
      'data-fill': resolved.fill,
      'data-ink': resolved.textColour,
      'data-font': a.font,
      'data-weight': a.weight === undefined ? undefined : String(a.weight),
      'data-size': a.size,
      'data-halign': a.hAlign ?? (resolved.hAlign === 'right' ? 'right' : undefined),
      'data-valign': a.vAlign,
      'data-mark': mark,
      'data-rule': look.rule?.rule.id,
      'data-ink-adjusted': resolved.inkAdjusted ? 'true' : undefined,
    },
    resolved,
    ruleLabel: look.rule === null ? null : `Rule: ${describeRule(look.rule.rule)}`,
  };
}
