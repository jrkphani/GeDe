/**
 * Appearance vocabularies (INSP-04..07, MENU-04). Every value here names a
 * token or a closed option set; the renderer maps names to `packages/tokens`
 * custom properties, so no colour, size or weight is ever stored as a
 * literal. Readers guard at runtime: a value outside a vocabulary reads as
 * absent, so a document written by a newer client never breaks an older one.
 *
 * Nothing in this module changes a cell's A1 address (non-negotiable 3):
 * fills, borders, typography, alignment, table styles, stacking, pinning and
 * spans are presentation over the same lattice positions.
 */
import { isHighlightToken, isTextColourToken } from '../text/types.js';
import type { HighlightToken, TextColourToken } from '../text/types.js';

// ---------------------------------------------------------------------------
// Table look (INSP-04)
// ---------------------------------------------------------------------------

/**
 * Table styles: the prototype's six swatches are unnamed header-band +
 * alternate-band colour pairs (Work Scape Canvas `tableStyles`, 1–6). The
 * design system gives each hue one job — amber is the live state, forest the
 * brand, "grey = everything else, no third meaning" (DS §2) — so a table
 * band may only be neutral: Plain (the prototype's 6) and Slate (its 1). The
 * blue, green, red and amber pairs are not offered (ADR-034).
 */
export const TABLE_STYLES = ['plain', 'slate'] as const;
export type TableStyle = (typeof TABLE_STYLES)[number];
export const TABLE_STYLE_LABELS: Readonly<Record<TableStyle, string>> = {
  plain: 'Plain',
  slate: 'Slate',
};

/** Table outline weights: the PRD's hairline / strong / accent (INSP-05) plus none. */
export const OUTLINE_WEIGHTS = ['none', 'hairline', 'strong', 'accent'] as const;
export type OutlineWeight = (typeof OUTLINE_WEIGHTS)[number];

/** Gridline density (PRD §7: Off, Light, High Contrast), per table. */
export const GRIDLINE_DENSITIES = ['off', 'light', 'contrast'] as const;
export type GridlineDensity = (typeof GRIDLINE_DENSITIES)[number];
export const GRIDLINE_LABELS: Readonly<Record<GridlineDensity, string>> = {
  off: 'Off',
  light: 'Light',
  contrast: 'High contrast',
};

/** Lattice rows the caption strip occupies when shown (prototype: one 22 px row at the foot). */
export const CAPTION_ROWS = 1;

export interface TableLook {
  readonly style: TableStyle;
  /** The title text in the title bar; the bar itself keeps its two lattice rows either way. */
  readonly titleShown: boolean;
  readonly caption: string;
  /**
   * The caption strip: one lattice row at the foot of the table, after the
   * footer (the prototype's placement). It extends the table's footprint and
   * moves no cell address (RESP-01, non-negotiable 3).
   */
  readonly captionShown: boolean;
  readonly outline: OutlineWeight;
  readonly gridlines: GridlineDensity;
  readonly alternating: boolean;
}

export const DEFAULT_TABLE_LOOK: TableLook = {
  style: 'plain',
  titleShown: true,
  caption: '',
  captionShown: false,
  outline: 'hairline',
  gridlines: 'light',
  alternating: false,
};

// ---------------------------------------------------------------------------
// Cell and column appearance (INSP-05, INSP-06)
// ---------------------------------------------------------------------------

/** The positional border matrix (INSP-05): all, any single edge, outline, paired, none. */
export const BORDER_EDGES = [
  'all',
  'top',
  'right',
  'bottom',
  'left',
  'outline',
  'top-bottom',
  'left-right',
  'none',
] as const;
export type BorderEdges = (typeof BORDER_EDGES)[number];
export const BORDER_EDGE_LABELS: Readonly<Record<BorderEdges, string>> = {
  all: 'All edges',
  top: 'Top edge',
  right: 'Right edge',
  bottom: 'Bottom edge',
  left: 'Left edge',
  outline: 'Outline only',
  'top-bottom': 'Top and bottom',
  'left-right': 'Left and right',
  none: 'No border',
};

export const BORDER_WEIGHTS = ['hairline', 'strong', 'accent'] as const;
export type BorderWeight = (typeof BORDER_WEIGHTS)[number];

export interface CellBorder {
  readonly edges: BorderEdges;
  readonly weight: BorderWeight;
}

/** Which of the four sides a border setting draws; `all` and `outline` are the same four sides on one cell. */
export function borderSides(edges: BorderEdges): {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
} {
  switch (edges) {
    case 'all':
    case 'outline':
      return { top: true, right: true, bottom: true, left: true };
    case 'top':
      return { top: true, right: false, bottom: false, left: false };
    case 'right':
      return { top: false, right: true, bottom: false, left: false };
    case 'bottom':
      return { top: false, right: false, bottom: true, left: false };
    case 'left':
      return { top: false, right: false, bottom: false, left: true };
    case 'top-bottom':
      return { top: true, right: false, bottom: true, left: false };
    case 'left-right':
      return { top: false, right: true, bottom: false, left: true };
    case 'none':
      return { top: false, right: false, bottom: false, left: false };
  }
}

/** The two families the design system ships (DS §2: "One grotesque, one mono"). */
export const FONT_FAMILIES = ['ui', 'mono'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
export const FONT_FAMILY_LABELS: Readonly<Record<FontFamily, string>> = {
  ui: 'Helvetica Neue',
  mono: 'IBM Plex Mono',
};

/**
 * The four-step weight scale (INSP-06), ending where the design system's
 * scale ends: DS §2 has no 700, so the steps are 300 / 400 / 500 / 600 (the
 * prototype's Thin / Regular / Medium / Bold) and the Bold mark is 600 too.
 */
export const FONT_WEIGHTS = [300, 400, 500, 600] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];
export const FONT_WEIGHT_LABELS: Readonly<Record<FontWeight, string>> = {
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
};
/** The weight the Bold mark and a rule's bold output render at: the scale's heaviest. */
export const BOLD_WEIGHT: FontWeight = 600;

/**
 * Sizes on the design system's type scale (DS §2), never below the 11 px cell
 * floor — so `mono-cell` (10 px) and `label` (9 px) are not offered. The
 * whole scale above the floor is: a size whose line box does not fit the
 * 22 px compact row takes the two-unit wrapped row the lattice already has
 * (GRID-09, ADR-024), and choosing it wraps the row.
 */
export const TYPE_SIZES = ['cell', 'body-sm', 'body', 'h3', 'h2', 'h1', 'display'] as const;
export type TypeSize = (typeof TYPE_SIZES)[number];
/** Pixel size at the 16 px root, for the control's label only; the renderer uses the rem token. */
export const TYPE_SIZE_PX: Readonly<Record<TypeSize, number>> = {
  cell: 11.5,
  'body-sm': 13,
  body: 15,
  h3: 16,
  h2: 20,
  h1: 28,
  display: 40,
};

/**
 * The line box of each size on the grid, as `document.css` sets it: the cell
 * scale's 1.35 up to body, 1.3 for h3 (20.8 px, the most a compact cell's
 * 21 px content box takes), the DS scale's own leading from h2 up. Indic
 * scripts always take the 1.7 the design system makes a floor (I18N-03,
 * `:lang(ta)` in @gede/ui, so matras never clip) — which is why h1 and
 * display cannot be shown for Indic text even on the wrapped row (47.6 and
 * 68 px against 43).
 */
export const INDIC_LINE_HEIGHT = 1.7;
export const TYPE_SIZE_LINE: Readonly<Record<TypeSize, number>> = {
  cell: 1.35,
  'body-sm': 1.35,
  body: 1.35,
  h3: 1.3,
  h2: 1.25,
  h1: 1.15,
  display: 1.05,
};

/** The lattice row in px; mirrored here so this module stays free of the lattice import cycle. */
const ROW_PX = 22;
/** The cell's bottom rule (`.gd-cell`, border-box): a row's content box is one pixel shorter. */
const RULE_PX = 1;
/** A line box within half a pixel of the content box is inside it: it re-centres, nothing clips. */
const SUBPIXEL = 0.5;

/** What a cell's content box can show on `rows` lattice rows. */
export function rowContentPx(rows: 1 | 2): number {
  return rows * ROW_PX - RULE_PX;
}

/**
 * Lattice rows a size's line box needs: 1 when it fits the compact row's
 * content box, 2 when it fits the wrapped row's (GRID-09), null when it fits
 * neither — h1 and display on Indic text, which the inspector refuses with
 * that reason (INSP-11).
 */
export function rowsForSize(size: TypeSize, indic: boolean): 1 | 2 | null {
  const px = TYPE_SIZE_PX[size] * (indic ? INDIC_LINE_HEIGHT : TYPE_SIZE_LINE[size]);
  if (px <= rowContentPx(1) + SUBPIXEL) return 1;
  if (px <= rowContentPx(2) + SUBPIXEL) return 2;
  return null;
}

/** INSP-11: why a size cannot be chosen for Indic text, or undefined when it can. */
export function sizeRefusal(size: TypeSize, indic: boolean): string | undefined {
  return rowsForSize(size, indic) === null
    ? `${String(TYPE_SIZE_PX[size])} px needs more than a wrapped row for Tamil, Hindi or Telugu text at the 1.7 line height`
    : undefined;
}

export const H_ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export type HAlign = (typeof H_ALIGNS)[number];
export const V_ALIGNS = ['top', 'middle', 'bottom'] as const;
export type VAlign = (typeof V_ALIGNS)[number];

/**
 * What a column or a cell can set. Every field is optional: absent means
 * "inherit" — a cell inherits its column, a column inherits the defaults
 * (Automatic alignment: numbers right, text left, FMT-02; middle vertically;
 * the cell scale; regular weight; the UI family; no fill; ink).
 */
/**
 * A fill is one ramp tint, or the explicit `none` a cell writes to show no
 * fill over a column that has one (INSP-10: "applies to cell B5 only"); an
 * absent field inherits.
 */
export type FillValue = HighlightToken | 'none';

export interface Appearance {
  readonly fill?: FillValue;
  readonly border?: CellBorder;
  readonly font?: FontFamily;
  readonly weight?: FontWeight;
  readonly size?: TypeSize;
  readonly textColour?: TextColourToken;
  readonly hAlign?: HAlign;
  readonly vAlign?: VAlign;
}

export type AppearanceKey = keyof Appearance;
export const APPEARANCE_KEYS: readonly AppearanceKey[] = [
  'fill',
  'border',
  'font',
  'weight',
  'size',
  'textColour',
  'hAlign',
  'vAlign',
];

function oneOf<T extends string | number>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

export function isTableStyle(value: unknown): value is TableStyle {
  return oneOf(TABLE_STYLES, value);
}
export function isOutlineWeight(value: unknown): value is OutlineWeight {
  return oneOf(OUTLINE_WEIGHTS, value);
}
export function isGridlineDensity(value: unknown): value is GridlineDensity {
  return oneOf(GRIDLINE_DENSITIES, value);
}
export function isBorderEdges(value: unknown): value is BorderEdges {
  return oneOf(BORDER_EDGES, value);
}
export function isBorderWeight(value: unknown): value is BorderWeight {
  return oneOf(BORDER_WEIGHTS, value);
}
export function isFontFamily(value: unknown): value is FontFamily {
  return oneOf(FONT_FAMILIES, value);
}
export function isFontWeight(value: unknown): value is FontWeight {
  return oneOf(FONT_WEIGHTS, value);
}
export function isTypeSize(value: unknown): value is TypeSize {
  return oneOf(TYPE_SIZES, value);
}
export function isHAlign(value: unknown): value is HAlign {
  return oneOf(H_ALIGNS, value);
}
export function isVAlign(value: unknown): value is VAlign {
  return oneOf(V_ALIGNS, value);
}

export function readCellBorder(value: unknown): CellBorder | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const edges = 'edges' in value ? value.edges : undefined;
  const weight = 'weight' in value ? value.weight : undefined;
  if (!isBorderEdges(edges)) return undefined;
  return { edges, weight: isBorderWeight(weight) ? weight : 'hairline' };
}

/** A stored appearance with every off-vocabulary field dropped. Plain object in, plain object out. */
export function readAppearance(value: unknown): Appearance {
  if (typeof value !== 'object' || value === null) return {};
  const v = value as Record<string, unknown>;
  const out: {
    -readonly [K in keyof Appearance]?: Appearance[K];
  } = {};
  if (isHighlightToken(v.fill) || v.fill === 'none') out.fill = v.fill;
  const border = readCellBorder(v.border);
  if (border !== undefined) out.border = border;
  if (isFontFamily(v.font)) out.font = v.font;
  if (isFontWeight(v.weight)) out.weight = v.weight;
  if (isTypeSize(v.size)) out.size = v.size;
  if (isTextColourToken(v.textColour)) out.textColour = v.textColour;
  if (isHAlign(v.hAlign)) out.hAlign = v.hAlign;
  if (isVAlign(v.vAlign)) out.vAlign = v.vAlign;
  return out;
}

export function isEmptyAppearance(a: Appearance): boolean {
  return APPEARANCE_KEYS.every((k) => a[k] === undefined);
}

/** `over` wins field by field; an `undefined` field of `over` leaves `under`'s. */
export function mergeAppearance(under: Appearance, over: Appearance): Appearance {
  const out: { -readonly [K in keyof Appearance]?: Appearance[K] } = { ...under };
  for (const key of APPEARANCE_KEYS) {
    const value = over[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function appearanceEqual(a: Appearance, b: Appearance): boolean {
  for (const key of APPEARANCE_KEYS) {
    if (key === 'border') {
      const x = a.border;
      const y = b.border;
      if (x === y) continue;
      if (x === undefined || y === undefined) return false;
      if (x.edges !== y.edges || x.weight !== y.weight) return false;
      continue;
    }
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Character styles (INSP-06 "semantic character styles"; PRD §3 Title / Heading / Body)
// ---------------------------------------------------------------------------

export const CHARACTER_STYLES = ['title', 'heading', 'body'] as const;
export type CharacterStyle = (typeof CHARACTER_STYLES)[number];
export const CHARACTER_STYLE_LABELS: Readonly<Record<CharacterStyle, string>> = {
  title: 'Title',
  heading: 'Heading',
  body: 'Body',
};

/**
 * Each preset is a bundle of the controls above, on the design system's
 * scale: Title = h2 (20 px) semibold, Heading = h3 (16 px) semibold, Body =
 * the cell scale (11.5 px) regular. The prototype's 19 / 14 / 11.5 px sit off
 * the scale and are mapped to the nearest step.
 */
export const CHARACTER_STYLE_BUNDLES: Readonly<Record<CharacterStyle, Appearance>> = {
  title: { size: 'h2', weight: 600 },
  heading: { size: 'h3', weight: 600 },
  body: { size: 'cell', weight: 400 },
};

/** Which preset an appearance matches exactly on size and weight, or null. */
export function characterStyleOf(a: Appearance): CharacterStyle | null {
  for (const style of CHARACTER_STYLES) {
    const bundle = CHARACTER_STYLE_BUNDLES[style];
    if ((a.size ?? 'cell') === bundle.size && (a.weight ?? 400) === bundle.weight) return style;
  }
  return null;
}
