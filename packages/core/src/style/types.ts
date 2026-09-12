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
 * Table styles: the prototype's six swatches are header-band + alternate-band
 * colour pairs (Work Scape Canvas `tableStyles`, styles 1–6). The token ramps
 * express four of them — Plain (style 6), Slate (1), Forest (3), Amber (5);
 * the blue (2) and red (4) pairs have no ramp in `packages/tokens` and are not
 * offered until one exists.
 */
export const TABLE_STYLES = ['plain', 'slate', 'forest', 'amber'] as const;
export type TableStyle = (typeof TABLE_STYLES)[number];
export const TABLE_STYLE_LABELS: Readonly<Record<TableStyle, string>> = {
  plain: 'Plain',
  slate: 'Slate',
  forest: 'Forest',
  amber: 'Amber',
};

/** Table outline weights: the PRD's hairline / strong / accent (INSP-05) plus none. */
export const TABLE_OUTLINES = ['none', 'hairline', 'strong', 'accent'] as const;
export type TableOutline = (typeof TABLE_OUTLINES)[number];

/** Gridline density (PRD §7: Off, Light, High Contrast), per table. */
export const GRIDLINE_DENSITIES = ['off', 'light', 'contrast'] as const;
export type GridlineDensity = (typeof GRIDLINE_DENSITIES)[number];
export const GRIDLINE_LABELS: Readonly<Record<GridlineDensity, string>> = {
  off: 'Off',
  light: 'Light',
  contrast: 'High contrast',
};

export interface TableLook {
  readonly style: TableStyle;
  /** The title text in the title bar; the bar itself keeps its two lattice rows either way. */
  readonly titleShown: boolean;
  readonly caption: string;
  /** The caption line under the title, inside the same bar: no address moves (RESP-01). */
  readonly captionShown: boolean;
  readonly outline: TableOutline;
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

/** The four-step weight scale (INSP-06). */
export const FONT_WEIGHTS = [400, 500, 600, 700] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];
export const FONT_WEIGHT_LABELS: Readonly<Record<FontWeight, string>> = {
  400: 'Regular',
  500: 'Medium',
  600: 'Semibold',
  700: 'Bold',
};

/**
 * Sizes on the design system's type scale (DS §2), never below the 11 px cell
 * floor — so `mono-cell` (10 px) and `label` (9 px) are not offered.
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
export interface Appearance {
  readonly fill?: HighlightToken;
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
export function isTableOutline(value: unknown): value is TableOutline {
  return oneOf(TABLE_OUTLINES, value);
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
  if (isHighlightToken(v.fill)) out.fill = v.fill;
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
