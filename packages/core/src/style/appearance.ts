/**
 * Column and cell appearance (INSP-05, INSP-06, INSP-10): fill, border,
 * typography and alignment, column-scoped by default with a cell override —
 * the same shape as the data format (FMT-06). The column stores its
 * `appearance` on the column map; overrides live in the table's
 * `cellAppearance` map keyed like `cells`. A row appended later has no
 * override, so it inherits by construction.
 */
import type { CellFormat } from '../format/types.js';
import { cellKey, type Id } from '../ids.js';
import type { HighlightToken } from '../text/types.js';
import {
  readMap,
  readTriState,
  rowMeta,
  rowsArray,
  tableLook,
  type ColumnRecord,
  type GedeDoc,
  type TableMap,
} from '../doc/schema.js';
import { readableTextColour } from './contrast.js';
import type { RuleOutcome } from './rules.js';
import {
  APPEARANCE_KEYS,
  appearanceEqual,
  isEmptyAppearance,
  mergeAppearance,
  readAppearance,
  type Appearance,
  type AppearanceKey,
  type CellBorder,
  type HAlign,
} from './types.js';
import { nestedMap, requireColumn, requireTable, transact } from './write.js';

/** The per-cell override map, or null on a table none has been written to. */
export function cellAppearanceMap(table: TableMap): ReturnType<typeof readMap<unknown>> {
  return readMap<unknown>(table, 'cellAppearance');
}

/** The override stored for one cell (possibly partial), or null when it inherits its column. */
export function cellAppearanceOverride(table: TableMap, rowId: Id, colId: Id): Appearance | null {
  const entry = cellAppearanceMap(table)?.get(cellKey(rowId, colId));
  if (entry === undefined) return null;
  const read = readAppearance(entry);
  return isEmptyAppearance(read) ? null : read;
}

/**
 * The appearance in force for one cell: the column's, with the cell's own
 * fields on top. Resolved per cell against a column the grid already
 * resolved, as `cellFormatFor` does.
 */
export function cellAppearanceFor(
  table: TableMap,
  column: ColumnRecord | null,
  rowId: Id,
): Appearance {
  if (column === null) return {};
  const override = cellAppearanceOverride(table, rowId, column.id);
  return override === null ? column.appearance : mergeAppearance(column.appearance, override);
}

/**
 * Whether one cell wraps (GRID-09, ADR-049): the cell's own override, else
 * its row's, else its column's, else the table's default. Presentation only —
 * the row's height is stored separately, measured by the editing replica.
 */
export function effectiveWrap(
  table: TableMap,
  column: Pick<ColumnRecord, 'id' | 'wrap'> | null,
  rowId: Id,
  tableWrap: boolean = tableLook(table).wrap,
): boolean {
  if (column === null) return tableWrap;
  const cell = cellAppearanceOverride(table, rowId, column.id)?.wrap;
  if (cell !== undefined) return cell;
  const row = rowMeta(table, rowId).wrap;
  if (row !== null) return row;
  return column.wrap ?? tableWrap;
}

/** Which scope decides a cell's wrap today, for the inspector's sentence (INSP-10). */
export type WrapScope = 'cell' | 'row' | 'column' | 'table';
export function wrapScopeOf(
  table: TableMap,
  column: Pick<ColumnRecord, 'id' | 'wrap'>,
  rowId: Id,
): WrapScope {
  if (cellAppearanceOverride(table, rowId, column.id)?.wrap !== undefined) return 'cell';
  if (rowMeta(table, rowId).wrap !== null) return 'row';
  if (column.wrap !== null) return 'column';
  return 'table';
}

/** How many cells of a column carry their own appearance (the inspector names them). */
export function countAppearanceOverrides(table: TableMap, colId: Id): number {
  const map = cellAppearanceMap(table);
  if (map === null) return 0;
  let n = 0;
  for (const rowId of rowsArray(table).toArray()) {
    if (cellAppearanceOverride(table, rowId, colId) !== null) n += 1;
  }
  return n;
}

/**
 * What the renderer draws, after the rules and the contrast guard: a rule's
 * fill and colour beat the appearance's; a text colour under 4.5:1 on the
 * fill reads as `ink` (A11Y-03); Automatic alignment keeps numbers right
 * (FMT-02).
 */
export interface ResolvedLook {
  readonly appearance: Appearance;
  readonly rule: RuleOutcome | null;
  /** The tint to paint, or undefined: an explicit `none` resolves to no fill. */
  readonly fill: HighlightToken | undefined;
  /** The border to draw, or undefined: a rule's beats the appearance's; `none` edges draw nothing. */
  readonly border: CellBorder | undefined;
  readonly textColour: Appearance['textColour'];
  /** `hAlign`, or the format's own when Automatic. */
  readonly hAlign: HAlign;
  /** True when the requested text colour was replaced by `ink` for contrast. */
  readonly inkAdjusted: boolean;
}

export function resolveLook(
  appearance: Appearance,
  rule: RuleOutcome | null,
  format: CellFormat,
): ResolvedLook {
  const own = appearance.fill === 'none' ? undefined : appearance.fill;
  const fill = rule?.fill ?? own;
  const wanted = rule?.textColour ?? appearance.textColour;
  const textColour = readableTextColour(fill, wanted);
  const numeric = format.kind === 'number' || format.kind === 'currency';
  const border = rule?.border ?? appearance.border;
  return {
    appearance,
    rule,
    fill,
    border: border?.edges === 'none' ? undefined : border,
    textColour,
    hAlign: appearance.hAlign ?? (numeric ? 'right' : 'left'),
    inkAdjusted: wanted !== undefined && textColour !== wanted,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** A patch: a field set to `null` clears it (back to inherit); `undefined` leaves it. */
export type AppearancePatch = { readonly [K in AppearanceKey]?: Appearance[K] | null };

function applyPatch(base: Appearance, patch: AppearancePatch): Appearance {
  const out: Record<string, unknown> = {};
  for (const key of APPEARANCE_KEYS) {
    const value = patch[key];
    if (value === null) continue; // cleared: back to inherit
    const next = value ?? base[key];
    if (next !== undefined) out[key] = next;
  }
  return readAppearance(out);
}

/**
 * Set fields of a column's appearance (INSP-10 column scope). Every cell
 * without its own value for the field, and every row added later, follows
 * it. Returns what the column now stores.
 */
export function setColumnAppearance(
  gd: GedeDoc,
  tableId: Id,
  colId: Id,
  patch: AppearancePatch,
): Appearance {
  return transact(gd, () => {
    const column = requireColumn(requireTable(gd, tableId), tableId, colId);
    // ADR-049: column-scope wrap has one home, the column's own `wrap` key (null inherits
    // the table's); the appearance map never carries it, so the two cannot disagree.
    const { wrap, ...rest } = patch;
    if (wrap !== undefined) {
      if (wrap === null) column.delete('wrap');
      else if (readTriState(column.get('wrap')) !== wrap) column.set('wrap', wrap);
    }
    const next = applyPatch(readAppearance(column.get('appearance')), rest);
    const current = readAppearance(column.get('appearance'));
    if (!appearanceEqual(current, next)) {
      if (isEmptyAppearance(next)) column.delete('appearance');
      else column.set('appearance', next);
    }
    return next;
  });
}

/**
 * Set fields of one cell's override (INSP-10 cell scope), or clear the whole
 * override with `null` so the cell follows its column again. Returns the
 * override now stored, or null.
 */
export function setCellAppearance(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  colId: Id,
  patch: AppearancePatch | null,
): Appearance | null {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const map = nestedMap(table, 'cellAppearance', patch !== null);
    if (map === null) return null;
    const key = cellKey(rowId, colId);
    if (patch === null) {
      map.delete(key);
      return null;
    }
    const next = applyPatch(readAppearance(map.get(key)), patch);
    if (isEmptyAppearance(next)) {
      map.delete(key);
      return null;
    }
    map.set(key, next);
    return next;
  });
}
