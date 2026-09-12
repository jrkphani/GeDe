/**
 * The Yjs document layer (ARCHITECTURE-DIGEST §1.5.3, normative).
 *
 * One `Y.Doc` per workscape. Its share map carries four top-level types:
 *
 *   sheets  Y.Array<Y.Map>   id, label, ordinal, parentContext
 *   tables  Y.Map<Y.Map>     by id: sheetId, title, gridCol, gridRow,
 *                            columns Y.Array<Y.Map{id,label,width}>,
 *                            rows Y.Array<rowId>,
 *                            cells Y.Map keyed `rowId:colId` → Y.XmlFragment | formula string,
 *                            rowMeta Y.Map<rowId → Y.Map{depth,collapsed,height}>
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

import { cellKey, type CellKey, type Id } from '../ids.js';

/** Lattice rows a table's title bar occupies (DS: title bar 44 px = 2 × 22). */
export const TABLE_TITLE_ROWS = 2;
/** Lattice rows the column-header row occupies (GRID-11: 0 or 1; Wave 1 is always 1). */
export const TABLE_HEADER_ROWS = 1;
/** Default column width in lattice units. */
export const DEFAULT_COLUMN_WIDTH = 1;
/** Default row height in lattice units; a wrapped row is 2 (GRID-09). */
export const DEFAULT_ROW_HEIGHT = 1;

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
  /** 1-based position in the strip, derived from array order (DOC-03). */
  readonly ordinal: number;
  /** Graph context a child sheet was opened from, else null (PRD §11). */
  readonly parentContext: string | null;
}

export interface ColumnRecord {
  readonly id: Id;
  readonly label: string;
  /** Whole lattice units (GRID-01). */
  readonly width: number;
}

export interface RowMeta {
  readonly depth: number;
  readonly collapsed: boolean;
  /** Whole lattice units; 2 when wrapped (GRID-09). */
  readonly height: number;
}

export interface TableRecord {
  readonly id: Id;
  readonly sheetId: Id;
  readonly title: string;
  /** Lattice origin of the table's top-left corner (title bar included). */
  readonly gridCol: number;
  readonly gridRow: number;
  readonly columns: readonly ColumnRecord[];
  readonly rows: readonly Id[];
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

export function columnRecord(map: ColumnMap): ColumnRecord {
  return {
    id: readString(map, 'id'),
    label: readString(map, 'label'),
    width: Math.max(1, Math.round(readNumber(map, 'width', DEFAULT_COLUMN_WIDTH))),
  };
}

export function tableRecord(map: TableMap): TableRecord {
  return {
    id: readString(map, 'id'),
    sheetId: readString(map, 'sheetId'),
    title: readString(map, 'title'),
    gridCol: Math.max(0, Math.round(readNumber(map, 'gridCol', 0))),
    gridRow: Math.max(0, Math.round(readNumber(map, 'gridRow', 0))),
    columns: columnsArray(map).toArray().map(columnRecord),
    rows: rowsArray(map).toArray(),
  };
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
    return { depth: 0, collapsed: false, height: DEFAULT_ROW_HEIGHT };
  }
  return {
    depth: Math.max(0, Math.round(readNumber(meta, 'depth', 0))),
    collapsed: readBoolean(meta, 'collapsed', false),
    height: Math.max(1, Math.round(readNumber(meta, 'height', DEFAULT_ROW_HEIGHT))),
  };
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
