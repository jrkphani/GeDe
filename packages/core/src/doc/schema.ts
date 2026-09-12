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
 *   graphs  Y.Map<Y.Map>     by id (Wave 2 fills these in; the slot exists so
 *                            Fit already frames them, DOC-07)
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

export interface GraphRecord {
  readonly id: Id;
  readonly sheetId: Id;
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

export function columnRecord(map: ColumnMap): ColumnRecord {
  const format = map.get('format');
  return {
    id: readString(map, 'id'),
    label: readString(map, 'label'),
    width: Math.max(1, Math.round(readNumber(map, 'width', DEFAULT_COLUMN_WIDTH))),
    hidden: readBoolean(map, 'hidden', false),
    wrap: readBoolean(map, 'wrap', false),
    source: readColumnSource(map),
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

export function graphRecord(map: GraphMap): GraphRecord {
  return {
    id: readString(map, 'id'),
    sheetId: readString(map, 'sheetId'),
    gridCol: Math.max(0, Math.round(readNumber(map, 'gridCol', 0))),
    gridRow: Math.max(0, Math.round(readNumber(map, 'gridRow', 0))),
    widthUnits: Math.max(1, Math.round(readNumber(map, 'widthUnits', 1))),
    heightUnits: Math.max(1, Math.round(readNumber(map, 'heightUnits', 1))),
  };
}

export function graphsOnSheet(gd: GedeDoc, sheetId: Id): GraphRecord[] {
  const out: GraphRecord[] = [];
  gd.graphs.forEach((map) => {
    if (readString(map, 'sheetId') === sheetId) out.push(graphRecord(map));
  });
  return out;
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
  };
}

/**
 * Whether a cell takes typing (GRID-04). Derived, linked and pulled columns,
 * category-band rows and `Split()` child rows (HIER-07) are read-only; the
 * reason names which, so the grid can say so rather than merely tint the
 * cell (A11Y-04).
 */
export type ReadOnlyReason = Exclude<ColumnSource, 'entered'> | 'group' | 'splitChild';

/** The row-level read-only reason, or null: a category band, else a split child. */
export function rowReadOnlyReason(
  meta: RowMeta,
): Extract<ReadOnlyReason, 'group' | 'splitChild'> | null {
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
