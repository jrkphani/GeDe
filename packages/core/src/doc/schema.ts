/**
 * The Yjs document layer (ARCHITECTURE-DIGEST §1.5.3, normative).
 *
 * One `Y.Doc` per workscape. Its share map carries four top-level types:
 *
 *   sheets  Y.Array<Y.Map>   id, label, parentContext, seeded (ordinal is array order)
 *   tables  Y.Map<Y.Map>     by id: sheetId, title, gridCol, gridRow,
 *                            columns Y.Array<Y.Map{id,label,width}>,
 *                            rows Y.Array<rowId>,
 *                            cells Y.Map keyed `rowId:colId` → Y.XmlFragment | formula string,
 *                            rowMeta Y.Map<rowId → Y.Map{depth,collapsed,height}>,
 *                            cellFormat Y.Map keyed `rowId:colId` → {format, formatOpts}
 *                            (per-cell override of the column's `format`/`formatOpts`, FMT-01)
 *   graphs  Y.Map<Y.Map>     by id: sheetId, pairId, kind ring|coverage, tableId ('' when
 *                            unbound), dimensions (JSON array of column ids), slice (JSON
 *                            {rowAxis, colAxis, pins}), gridCol, gridRow, widthUnits,
 *                            heightUnits (GRAPH-01..11; `graph/` reads and writes them)
 *   meta    Y.Map            title, createdAt
 *
 * They are top-level shared types rather than keys of one nested map so two
 * clients that open an empty document concurrently cannot each create their
 * own `tables` map and lose one of them on merge — Yjs resolves top-level
 * types by name.
 *
 * Ids are ULIDs generated client-side. A1 addresses are never stored; see
 * `geometry.ts`. Everything in this module reads; `mutations.ts` writes.
 */
import * as Y from 'yjs';

import {
  isFormatKind,
  readFormatOpts,
  type CellFormat,
  type FormatKind,
  type FormatOpts,
} from '../format/types.js';
import { isMethodName, type MethodName } from '../formula/ast.js';
import { cellKey, type CellKey, type Id } from '../ids.js';

/** Lattice rows a table's title bar occupies (DS: title bar 44 px = 2 × 22). */
export const TABLE_TITLE_ROWS = 2;
/**
 * Default lattice rows the column-header row occupies (GRID-11: a table's
 * `headerRows` is 0 or 1; this is the value when the key is absent).
 */
export const TABLE_HEADER_ROWS = 1;
/** Default footer count-strip rows (GRID-11: 0 or 1; absent means none). */
export const DEFAULT_FOOTER_ROWS = 0;
/** Default column width in lattice units. */
export const DEFAULT_COLUMN_WIDTH = 1;
/** Default row height in lattice units; a wrapped row is 2 (GRID-09). */
export const DEFAULT_ROW_HEIGHT = 1;
/** Lattice rows a wrapped row occupies (GRID-09) — exactly two, never more. */
export const WRAPPED_ROW_HEIGHT = 2;

export type SheetMap = Y.Map<unknown>;
export type TableMap = Y.Map<unknown>;
export type ColumnMap = Y.Map<unknown>;
export type RowMetaMap = Y.Map<unknown>;
export type GraphMap = Y.Map<unknown>;
export type CellContent = Y.XmlFragment | string;

/** Handle to one open document: the doc plus its four top-level types. */
export interface GedeDoc {
  readonly doc: Y.Doc;
  readonly sheets: Y.Array<SheetMap>;
  readonly tables: Y.Map<TableMap>;
  readonly graphs: Y.Map<GraphMap>;
  readonly meta: Y.Map<unknown>;
  /**
   * Transaction origin for local, user-initiated edits. The undo manager tracks
   * exactly this origin, so remote updates and programmatic seeding stay out
   * of the undo stack.
   */
  readonly origin: object;
}

export interface SheetRecord {
  readonly id: Id;
  readonly label: string;
  /** 1-based position in the strip, derived from array order (DOC-03); never stored. */
  readonly ordinal: number;
  /** True for the sheet a client created to give an empty document its first sheet. */
  readonly seeded: boolean;
  /** Graph context a child sheet was opened from, else null (PRD §11). */
  readonly parentContext: string | null;
}

/**
 * Where a column's values come from (GRID-04). Only `entered` cells take
 * typing; the derive, link and pull features set the others when they bind a
 * column, and the grid renders those cells locked.
 */
export type ColumnSource = 'entered' | 'derived' | 'linked' | 'pulled';

/**
 * A derived column (REF-04): `@Source.Method(args)` applied to every row's
 * cell in `sourceColId`. Stored on the column map under `derive` as plain
 * JSON; the engine synthesises one bound formula per row from it.
 */
/** A method argument: positional text, or named (`Style="Highlight"`). */
export type DeriveArg = string | { readonly name: string; readonly value: string };

export interface DeriveSpec {
  readonly sourceColId: Id;
  readonly method: MethodName;
  readonly args: readonly DeriveArg[];
}

/** A spec's arguments as the evaluator and the signature take them. */
export function deriveArgValues(spec: DeriveSpec): { name?: string; value: string }[] {
  return spec.args.map((a) =>
    typeof a === 'string' ? { value: a } : { name: a.name, value: a.value },
  );
}

/** A mapping column (REF-03): cells pick from the distinct values of `colId` in `tableId`. */
export interface LinkSpec {
  readonly tableId: Id;
  readonly colId: Id;
}

/**
 * A pull (REF-02): the table mirrors the rows of `tableId` whose cells
 * contain `filter` (any column, case-insensitive; empty matches every
 * row with a value in `colId`), writing `colId`'s value into this column.
 */
export interface PullSpec {
  readonly tableId: Id;
  readonly colId: Id;
  readonly filter: string;
}

/** Where a pulled row came from (REF-02 provenance); the row is read-only. */
export interface PulledFrom {
  readonly tableId: Id;
  readonly rowId: Id;
}

/** A `Split()` child (HIER-07): piece `index` of its parent row's split column. */
export interface SplitOf {
  readonly rowId: Id;
  readonly index: number;
}

export interface ColumnRecord {
  readonly id: Id;
  readonly label: string;
  /** Whole lattice units (GRID-01). */
  readonly width: number;
  /** A hidden column has no lattice width; what follows it moves left (GRID-02). */
  readonly hidden: boolean;
  /** Every cell in the column wraps, so each row is two lattice units (GRID-09). */
  readonly wrap: boolean;
  readonly source: ColumnSource;
  /** Set when `source` is `derived` (REF-04). */
  readonly derive: DeriveSpec | null;
  /** Set when `source` is `linked` (REF-03). */
  readonly link: LinkSpec | null;
  /** Set when `source` is `pulled` (REF-02). */
  readonly pull: PullSpec | null;
  /** Data format every cell in the column inherits (FMT-01, FMT-06). Missing key → `auto`. */
  readonly format: FormatKind;
  /** Options for `format` (decimals, currency, date pattern, text case). */
  readonly formatOpts: FormatOpts;
}

export interface RowMeta {
  /** Outline depth, 0 at the top level (HIER-01..03, HIER-10). Stored, never derived from position. */
  readonly depth: number;
  /** A collapsed row hides every row of its subtree (HIER-06, HIER-10). */
  readonly collapsed: boolean;
  /** Whole lattice units; 2 when the row itself is wrapped (GRID-09). */
  readonly height: number;
  /**
   * A stored category-band row: its cells are not editable (GRID-04). Grouping
   * (`sort/`, SORT-05) renders bands as view rows over the projection and never
   * sets this; it stays so a document that carries one still reads correctly.
   */
  readonly group: boolean;
  /**
   * A row `Split()` produced beneath its parent (HIER-07): rendered as a nested
   * child, read-only, collapsing with the parent. The formula engine sets it
   * when it materialises the split; nothing else writes it.
   */
  readonly splitChild: boolean;
  /** Mirrored from another table (REF-02): read-only, with its provenance. */
  readonly pulledFrom: PulledFrom | null;
  /** Which parent and piece a `Split()` child came from (HIER-07 provenance); null otherwise. */
  readonly splitOf: SplitOf | null;
}

/** Header and footer counts are 0 or 1 (GRID-11). */
export type StripCount = 0 | 1;

export interface TableRecord {
  readonly id: Id;
  readonly sheetId: Id;
  readonly title: string;
  /** Lattice origin of the table's top-left corner (title bar included). */
  readonly gridCol: number;
  readonly gridRow: number;
  readonly columns: readonly ColumnRecord[];
  readonly rows: readonly Id[];
  /** Leading columns that are shaded and carried by the pinned panel (GRID-10). */
  readonly frozenColumns: number;
  readonly headerRows: StripCount;
  readonly footerRows: StripCount;
  /**
   * The column that carries the outline — indentation, ↳ and the chevron
   * (HIER-04, HIER-05). `null` means "the first visible column"; see
   * `outlineColumnId`. Stored as `outlineColumn`.
   */
  readonly outlineColumn: Id | null;
}

/** The two halves of a graph pair (GRAPH-01, GRAPH-02). */
export type GraphKind = 'ring' | 'coverage';

/**
 * The coverage slice (GRAPH-08): two dimension columns on the axes and every
 * other dimension pinned to one parameter value. A null axis means "the
 * default" (the first dimension for rows, the next for columns); a pin absent
 * from `pins` defaults to the selected context's binding, else the first
 * parameter. Shared by the pair, stored on both halves.
 */
export interface GraphSlice {
  readonly rowAxis: Id | null;
  readonly colAxis: Id | null;
  readonly pins: Readonly<Record<Id, string>>;
}

export const EMPTY_SLICE: GraphSlice = { rowAxis: null, colAxis: null, pins: {} };

/** Default footprint of a graph object in lattice units (PRD §19 "roomy, 6 × 28"). */
export const GRAPH_DEFAULT_WIDTH_UNITS = 6;
export const GRAPH_DEFAULT_HEIGHT_UNITS = 28;
/** Smallest box a graph can be resized to (GRAPH-11). */
export const GRAPH_MIN_WIDTH_UNITS = 2;
export const GRAPH_MIN_HEIGHT_UNITS = 8;

export interface GraphRecord {
  readonly id: Id;
  readonly sheetId: Id;
  /** Both halves of a pair carry the same `pairId` (GRAPH-02). */
  readonly pairId: Id;
  readonly kind: GraphKind;
  /**
   * The source table; null while unbound (pointing mode, GRAPH-03). The id is kept
   * as stored when the table has since been deleted: readers resolve it with
   * `tableById` and treat a miss as unbound.
   */
  readonly tableId: Id | null;
  /** Column ids marked as dimensions, in checklist order (GRAPH-05). */
  readonly dimensions: readonly Id[];
  readonly slice: GraphSlice;
  readonly gridCol: number;
  readonly gridRow: number;
  readonly widthUnits: number;
  readonly heightUnits: number;
}

export interface DocumentMeta {
  readonly title: string;
  readonly createdAt: string | null;
}

/** Open (or lazily create) the four top-level types of a document. */
export function openDocument(doc: Y.Doc): GedeDoc {
  return {
    doc,
    sheets: doc.getArray<SheetMap>('sheets'),
    tables: doc.getMap<TableMap>('tables'),
    graphs: doc.getMap<GraphMap>('graphs'),
    meta: doc.getMap<unknown>('meta'),
    origin: { gede: 'local' },
  };
}

// ---------------------------------------------------------------------------
// Typed readers over untyped Y.Maps. Each guards at runtime so a document
// written by a newer client never crashes an older reader.
// ---------------------------------------------------------------------------

export function readString(map: Y.Map<unknown>, key: string, fallback = ''): string {
  const v = map.get(key);
  return typeof v === 'string' ? v : fallback;
}

export function readNumber(map: Y.Map<unknown>, key: string, fallback: number): number {
  const v = map.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function readBoolean(map: Y.Map<unknown>, key: string, fallback: boolean): boolean {
  const v = map.get(key);
  return typeof v === 'boolean' ? v : fallback;
}

export function readArray<T>(map: Y.Map<unknown>, key: string): Y.Array<T> | null {
  const v = map.get(key);
  return v instanceof Y.Array ? (v as Y.Array<T>) : null;
}

export function readMap<T>(map: Y.Map<unknown>, key: string): Y.Map<T> | null {
  const v = map.get(key);
  return v instanceof Y.Map ? (v as Y.Map<T>) : null;
}

export function sheetRecord(map: SheetMap, index: number): SheetRecord {
  const parent = map.get('parentContext');
  return {
    id: readString(map, 'id'),
    label: readString(map, 'label'),
    ordinal: index + 1,
    seeded: readBoolean(map, 'seeded', false),
    parentContext: typeof parent === 'string' ? parent : null,
  };
}

export function listSheets(gd: GedeDoc): SheetRecord[] {
  return gd.sheets.toArray().map(sheetRecord);
}

export function sheetById(gd: GedeDoc, sheetId: Id): SheetRecord | null {
  const index = gd.sheets.toArray().findIndex((s) => readString(s, 'id') === sheetId);
  if (index < 0) return null;
  return sheetRecord(gd.sheets.get(index), index);
}

export function tableMap(gd: GedeDoc, tableId: Id): TableMap | null {
  return gd.tables.get(tableId) ?? null;
}

export function columnsArray(table: TableMap): Y.Array<ColumnMap> {
  const arr = readArray<ColumnMap>(table, 'columns');
  if (arr === null) throw new RangeError('table has no columns array');
  return arr;
}

export function rowsArray(table: TableMap): Y.Array<Id> {
  const arr = readArray<Id>(table, 'rows');
  if (arr === null) throw new RangeError('table has no rows array');
  return arr;
}

export function cellsMap(table: TableMap): Y.Map<CellContent> {
  const map = readMap<CellContent>(table, 'cells');
  if (map === null) throw new RangeError('table has no cells map');
  return map;
}

export function rowMetaMap(table: TableMap): Y.Map<RowMetaMap> {
  const map = readMap<RowMetaMap>(table, 'rowMeta');
  if (map === null) throw new RangeError('table has no rowMeta map');
  return map;
}

const COLUMN_SOURCES: readonly ColumnSource[] = ['entered', 'derived', 'linked', 'pulled'];

export function readColumnSource(map: ColumnMap): ColumnSource {
  const v = map.get('source');
  return typeof v === 'string' && (COLUMN_SOURCES as readonly string[]).includes(v)
    ? (v as ColumnSource)
    : 'entered';
}

function readStripCount(map: Y.Map<unknown>, key: string, fallback: StripCount): StripCount {
  const v = map.get(key);
  if (v === 0 || v === 1) return v;
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDeriveArg(value: unknown): DeriveArg {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.name === 'string' && typeof value.value === 'string') {
    return { name: value.name, value: value.value };
  }
  return '';
}

/** The `derive` spec on a column map, or null when absent or malformed (a newer client's shape). */
export function readDeriveSpec(value: unknown): DeriveSpec | null {
  if (!isRecord(value)) return null;
  const { sourceColId, method, args } = value;
  if (typeof sourceColId !== 'string' || sourceColId === '') return null;
  if (typeof method !== 'string' || !isMethodName(method)) return null;
  return {
    sourceColId,
    method,
    args: Array.isArray(args) ? args.map(readDeriveArg) : [],
  };
}

function readTarget(value: unknown): { tableId: Id; colId: Id } | null {
  if (!isRecord(value)) return null;
  const { tableId, colId } = value;
  if (typeof tableId !== 'string' || typeof colId !== 'string') return null;
  if (tableId === '' || colId === '') return null;
  return { tableId, colId };
}

export function readLinkSpec(value: unknown): LinkSpec | null {
  return readTarget(value);
}

export function readPullSpec(value: unknown): PullSpec | null {
  const target = readTarget(value);
  if (target === null || !isRecord(value)) return null;
  const { filter } = value;
  return { ...target, filter: typeof filter === 'string' ? filter : '' };
}

export function readPulledFrom(value: unknown): PulledFrom | null {
  if (!isRecord(value)) return null;
  const { tableId, rowId } = value;
  if (typeof tableId !== 'string' || typeof rowId !== 'string') return null;
  if (tableId === '' || rowId === '') return null;
  return { tableId, rowId };
}

export function readSplitOf(value: unknown): SplitOf | null {
  if (!isRecord(value)) return null;
  const { rowId, index } = value;
  if (typeof rowId !== 'string' || rowId === '') return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  return { rowId, index };
}

export function columnRecord(map: ColumnMap): ColumnRecord {
  const format = map.get('format');
  const source = readColumnSource(map);
  return {
    id: readString(map, 'id'),
    label: readString(map, 'label'),
    width: Math.max(1, Math.round(readNumber(map, 'width', DEFAULT_COLUMN_WIDTH))),
    hidden: readBoolean(map, 'hidden', false),
    wrap: readBoolean(map, 'wrap', false),
    source,
    derive: source === 'derived' ? readDeriveSpec(map.get('derive')) : null,
    link: source === 'linked' ? readLinkSpec(map.get('link')) : null,
    pull: source === 'pulled' ? readPullSpec(map.get('pull')) : null,
    format: isFormatKind(format) ? format : 'auto',
    formatOpts: readFormatOpts(map.get('formatOpts')),
  };
}

/**
 * Per-cell format overrides (FMT-01 "cell-level override"), keyed like
 * `cells`. Absent on tables created before Wave 2; `null` then, and the
 * writer in `format/mutations.ts` creates it on first use.
 */
export function cellFormatMap(table: TableMap): Y.Map<unknown> | null {
  return readMap<unknown>(table, 'cellFormat');
}

/** The override stored for one cell, or null when it inherits the column's format. */
export function cellFormatOverride(table: TableMap, rowId: Id, colId: Id): CellFormat | null {
  const entry = cellFormatMap(table)?.get(cellKey(rowId, colId));
  if (typeof entry !== 'object' || entry === null || !('format' in entry)) return null;
  if (!isFormatKind(entry.format)) return null;
  return {
    kind: entry.format,
    opts: readFormatOpts('formatOpts' in entry ? entry.formatOpts : undefined),
  };
}

export function tableRecord(map: TableMap): TableRecord {
  const columns = columnsArray(map).toArray().map(columnRecord);
  return {
    id: readString(map, 'id'),
    sheetId: readString(map, 'sheetId'),
    title: readString(map, 'title'),
    gridCol: Math.max(0, Math.round(readNumber(map, 'gridCol', 0))),
    gridRow: Math.max(0, Math.round(readNumber(map, 'gridRow', 0))),
    columns,
    rows: rowsArray(map).toArray(),
    frozenColumns: Math.min(
      columns.length,
      Math.max(0, Math.round(readNumber(map, 'frozenColumns', 0))),
    ),
    headerRows: readStripCount(map, 'headerRows', TABLE_HEADER_ROWS),
    footerRows: readStripCount(map, 'footerRows', DEFAULT_FOOTER_ROWS),
    outlineColumn: readColumnRef(map, 'outlineColumn', columns),
  };
}

/** A stored column id, or null when absent or no longer a column of the table. */
function readColumnRef(map: TableMap, key: string, columns: readonly ColumnRecord[]): Id | null {
  const v = map.get(key);
  return typeof v === 'string' && columns.some((c) => c.id === v) ? v : null;
}

/**
 * The column that shows the outline (HIER-04): the designated one when it is
 * set and visible, else the first visible column; null when every column is
 * hidden.
 */
export function outlineColumnId(record: TableRecord): Id | null {
  const designated = record.columns.find((c) => c.id === record.outlineColumn && !c.hidden);
  if (designated !== undefined) return designated.id;
  return record.columns.find((c) => !c.hidden)?.id ?? null;
}

export function tableById(gd: GedeDoc, tableId: Id): TableRecord | null {
  const map = tableMap(gd, tableId);
  return map === null ? null : tableRecord(map);
}

/** Tables on a sheet in creation order (ULIDs sort by time). */
export function tablesOnSheet(gd: GedeDoc, sheetId: Id): TableRecord[] {
  const out: TableRecord[] = [];
  gd.tables.forEach((map) => {
    if (readString(map, 'sheetId') === sheetId) out.push(tableRecord(map));
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const GRAPH_KINDS: readonly GraphKind[] = ['ring', 'coverage'];

export function readGraphKind(map: GraphMap): GraphKind {
  const v = map.get('kind');
  return typeof v === 'string' && (GRAPH_KINDS as readonly string[]).includes(v)
    ? (v as GraphKind)
    : 'ring';
}

/** A stored id list (plain JSON array); anything malformed reads as empty. */
export function readIdList(value: unknown): Id[] {
  if (!Array.isArray(value)) return [];
  const out: Id[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The stored slice, or the empty slice when absent or malformed (a newer client's shape). */
export function readGraphSlice(value: unknown): GraphSlice {
  if (!isRecord(value)) return EMPTY_SLICE;
  const { rowAxis, colAxis, pins } = value;
  const out: Record<Id, string> = {};
  if (isRecord(pins)) {
    for (const [k, v] of Object.entries(pins)) {
      if (k !== '' && typeof v === 'string') out[k] = v;
    }
  }
  return {
    rowAxis: typeof rowAxis === 'string' && rowAxis !== '' ? rowAxis : null,
    colAxis: typeof colAxis === 'string' && colAxis !== '' ? colAxis : null,
    pins: out,
  };
}

export function graphRecord(map: GraphMap): GraphRecord {
  const tableId = readString(map, 'tableId');
  return {
    id: readString(map, 'id'),
    sheetId: readString(map, 'sheetId'),
    pairId: readString(map, 'pairId') || readString(map, 'id'),
    kind: readGraphKind(map),
    tableId: tableId === '' ? null : tableId,
    dimensions: readIdList(map.get('dimensions')),
    slice: readGraphSlice(map.get('slice')),
    gridCol: Math.max(0, Math.round(readNumber(map, 'gridCol', 0))),
    gridRow: Math.max(0, Math.round(readNumber(map, 'gridRow', 0))),
    widthUnits: Math.max(1, Math.round(readNumber(map, 'widthUnits', 1))),
    heightUnits: Math.max(1, Math.round(readNumber(map, 'heightUnits', 1))),
  };
}

export function graphMap(gd: GedeDoc, graphId: Id): GraphMap | null {
  return gd.graphs.get(graphId) ?? null;
}

export function graphById(gd: GedeDoc, graphId: Id): GraphRecord | null {
  const map = graphMap(gd, graphId);
  return map === null ? null : graphRecord(map);
}

/** Graphs on a sheet in creation order (ULIDs sort by time); the ring of a pair precedes its coverage. */
export function graphsOnSheet(gd: GedeDoc, sheetId: Id): GraphRecord[] {
  const out: GraphRecord[] = [];
  gd.graphs.forEach((map) => {
    if (readString(map, 'sheetId') === sheetId) out.push(graphRecord(map));
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Both halves of a pair, ring first, wherever they sit (GRAPH-02). */
export function graphsInPair(gd: GedeDoc, pairId: Id): GraphRecord[] {
  const out: GraphRecord[] = [];
  gd.graphs.forEach((map) => {
    const record = graphRecord(map);
    if (record.pairId === pairId) out.push(record);
  });
  return out.sort((a, b) =>
    a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind === 'ring' ? -1 : 1,
  );
}

/** Objects (tables + graphs) on a sheet, for the tab's object count (DOC-03). */
export function objectCount(gd: GedeDoc, sheetId: Id): number {
  return tablesOnSheet(gd, sheetId).length + graphsOnSheet(gd, sheetId).length;
}

export function rowMeta(table: TableMap, rowId: Id): RowMeta {
  const meta = rowMetaMap(table).get(rowId);
  if (meta === undefined) {
    return {
      depth: 0,
      collapsed: false,
      height: DEFAULT_ROW_HEIGHT,
      group: false,
      splitChild: false,
      pulledFrom: null,
      splitOf: null,
    };
  }
  return {
    depth: Math.max(0, Math.round(readNumber(meta, 'depth', 0))),
    collapsed: readBoolean(meta, 'collapsed', false),
    // A row is one unit or wrapped (two); anything else stored is clamped so addressing stays exact.
    height:
      Math.round(readNumber(meta, 'height', DEFAULT_ROW_HEIGHT)) >= WRAPPED_ROW_HEIGHT
        ? WRAPPED_ROW_HEIGHT
        : DEFAULT_ROW_HEIGHT,
    group: readBoolean(meta, 'group', false),
    splitChild: readBoolean(meta, 'splitChild', false),
    pulledFrom: readPulledFrom(meta.get('pulledFrom')),
    splitOf: readSplitOf(meta.get('splitOf')),
  };
}

/**
 * Whether a cell takes typing (GRID-04). Derived, linked and pulled columns,
 * pulled rows (REF-02), category-band rows and `Split()` child rows (HIER-07)
 * are read-only; the reason names which, so the grid can say so rather than
 * merely tint the cell (A11Y-04). Every write path — grid commit, find and
 * replace, paste — consults this (REF-05).
 */
export type ReadOnlyReason = Exclude<ColumnSource, 'entered'> | 'group' | 'splitChild';

/** The row-level read-only reason, or null: a pulled row, else a category band, else a split child. */
export function rowReadOnlyReason(
  meta: RowMeta,
): Extract<ReadOnlyReason, 'pulled' | 'group' | 'splitChild'> | null {
  if (meta.pulledFrom !== null) return 'pulled';
  if (meta.group) return 'group';
  if (meta.splitChild) return 'splitChild';
  return null;
}

export function cellReadOnlyReason(table: TableMap, rowId: Id, colId: Id): ReadOnlyReason | null {
  const column = columnsArray(table)
    .toArray()
    .find((c) => readString(c, 'id') === colId);
  if (column !== undefined) {
    const source = readColumnSource(column);
    if (source !== 'entered') return source;
  }
  return rowReadOnlyReason(rowMeta(table, rowId));
}

export function documentMeta(gd: GedeDoc): DocumentMeta {
  const createdAt = gd.meta.get('createdAt');
  return {
    title: readString(gd.meta, 'title'),
    createdAt: typeof createdAt === 'string' ? createdAt : null,
  };
}

// ---------------------------------------------------------------------------
// Cell content. Rich text is a ProseMirror-compatible Y.XmlFragment of
// `paragraph` elements; a formula is stored as its source string. Wave 1 reads
// and writes plain text only; the fragment shape is what the ProseMirror
// binding expects, so nothing migrates when rich text arrives.
// ---------------------------------------------------------------------------

export function isFormula(value: CellContent | undefined): value is string {
  return typeof value === 'string';
}

function xmlTextPlain(text: Y.XmlText): string {
  // `toDelta()` is untyped upstream; each op is `{ insert, attributes? }`.
  const delta: unknown = text.toDelta();
  if (!Array.isArray(delta)) return '';
  return delta
    .map((op: unknown) =>
      typeof op === 'object' && op !== null && 'insert' in op && typeof op.insert === 'string'
        ? op.insert
        : '',
    )
    .join('');
}

/** Plain-text projection of a fragment: paragraphs joined by newlines, marks dropped. */
export function fragmentText(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((node) => {
      if (node instanceof Y.XmlText) return xmlTextPlain(node);
      if (node instanceof Y.XmlElement) {
        return node
          .toArray()
          .map((child) => (child instanceof Y.XmlText ? xmlTextPlain(child) : ''))
          .join('');
      }
      return '';
    })
    .join('\n');
}

/** Build the fragment for plain text: one `paragraph` per line. Prelim until inserted. */
export function textFragment(text: string): Y.XmlFragment {
  const fragment = new Y.XmlFragment();
  const paragraphs = text.split('\n').map((line) => {
    const p = new Y.XmlElement('paragraph');
    if (line !== '') p.insert(0, [new Y.XmlText(line)]);
    return p;
  });
  fragment.insert(0, paragraphs);
  return fragment;
}

/** The cell's text as the editor shows it: formula source or plain text; '' when empty. */
export function cellText(table: TableMap, rowId: Id, colId: Id): string {
  const value = cellsMap(table).get(cellKey(rowId, colId));
  if (value === undefined) return '';
  if (isFormula(value)) return value;
  return fragmentText(value);
}

export function cellValue(table: TableMap, key: CellKey): CellContent | undefined {
  return cellsMap(table).get(key);
}
