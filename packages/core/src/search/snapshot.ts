/**
 * The search snapshot (FIND-03): a serialisable projection of everything Find
 * can see — cell values, formula expressions, reference paths, graph
 * dimension values and library document names. The main thread builds it
 * from the Yjs document (per table, so an edit re-indexes one table) and posts
 * it to the search Worker; nothing here is a Yjs type or a class instance.
 */
import * as Y from 'yjs';

import { splitCellKey, type Id } from '../ids.js';
import { parse } from '../formula/parser.js';
import { references } from '../formula/ast.js';
import {
  cellsMap,
  columnsArray,
  fragmentText,
  isFormula,
  listSheets,
  readString,
  rowsArray,
  tableMap,
  type ColumnMap,
  type GedeDoc,
  type GraphMap,
  type TableMap,
} from '../doc/schema.js';
import { foldGraphemes } from './graphemes.js';
import { resolveFormat } from './format.js';
import type { FormatKind } from './query.js';

/** Which text of an entry matched. */
export type SearchField = 'value' | 'formula' | 'reference' | 'dimension' | 'name';

export interface SearchText {
  readonly field: SearchField;
  readonly text: string;
  /** Case-folded grapheme clusters of `text`, computed once at index time. */
  readonly folded: readonly string[];
}

export interface CellEntry {
  readonly kind: 'cell';
  /** `${tableId}/${rowId}:${colId}` — unique across the document. */
  readonly id: string;
  readonly sheetId: Id;
  readonly sheetOrdinal: number;
  readonly tableId: Id;
  readonly tableTitle: string;
  readonly rowId: Id;
  readonly colId: Id;
  readonly rowIndex: number;
  readonly colIndex: number;
  readonly colLabel: string;
  readonly format: FormatKind;
  /** FIND-08: derived, linked and pulled cells are never rewritten. */
  readonly readOnly: boolean;
  readonly texts: readonly SearchText[];
}

export interface GraphEntry {
  readonly kind: 'graph';
  readonly id: string;
  readonly sheetId: Id;
  readonly sheetOrdinal: number;
  readonly graphId: Id;
  readonly title: string;
  readonly readOnly: true;
  readonly texts: readonly SearchText[];
}

export interface DocumentEntry {
  readonly kind: 'document';
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly readOnly: true;
  readonly texts: readonly SearchText[];
}

export type SearchEntry = CellEntry | GraphEntry | DocumentEntry;

export interface TableEntries {
  readonly tableId: Id;
  readonly sheetId: Id;
  readonly entries: readonly CellEntry[];
}

export interface SearchSnapshot {
  readonly tables: readonly TableEntries[];
  readonly graphs: readonly GraphEntry[];
  readonly documents: readonly DocumentEntry[];
}

export interface DocumentName {
  readonly id: string;
  readonly title: string;
}

function text(field: SearchField, value: string): SearchText {
  return { field, text: value, folded: foldGraphemes(value) };
}

/**
 * TODO(grid branch): replace with the shared read-only cell predicate once
 * derived, linked and pulled columns land. Until then a column flagged
 * `derived`, `linked` or `pulled` (or carrying a `source`) is read-only, and
 * everything else is a plain cell.
 */
export function isReadOnlyCell(column: ColumnMap): boolean {
  for (const key of ['derived', 'linked', 'pulled']) {
    if (column.get(key) === true) return true;
  }
  return column.get('source') !== undefined;
}

/** The texts Find sees for one cell: its value, or a formula's source plus each reference it names. */
export function cellTexts(content: Y.XmlFragment | string): SearchText[] {
  if (!isFormula(content)) {
    const value = fragmentText(content);
    return value === '' ? [] : [text('value', value)];
  }
  const out: SearchText[] = [text('formula', content)];
  const ast = parse(content);
  if (ast.ok) {
    const seen = new Set<string>();
    for (const ref of references(ast.value)) {
      const source = content.slice(ref.span.start, ref.span.end);
      if (source === '' || seen.has(source)) continue;
      seen.add(source);
      out.push(text('reference', source));
    }
  }
  return out;
}

function sheetOrdinals(gd: GedeDoc): Map<Id, number> {
  const map = new Map<Id, number>();
  for (const sheet of listSheets(gd)) map.set(sheet.id, sheet.ordinal);
  return map;
}

function tableEntriesOf(
  tableId: Id,
  table: TableMap,
  ordinals: ReadonlyMap<Id, number>,
): TableEntries {
  const sheetId = readString(table, 'sheetId');
  const sheetOrdinal = ordinals.get(sheetId) ?? Number.MAX_SAFE_INTEGER;
  const tableTitle = readString(table, 'title');
  const columns = columnsArray(table).toArray();
  const colIndex = new Map<Id, number>();
  columns.forEach((c, i) => colIndex.set(readString(c, 'id'), i));
  const rowIndex = new Map<Id, number>();
  rowsArray(table)
    .toArray()
    .forEach((rowId, i) => rowIndex.set(rowId, i));
  const entries: CellEntry[] = [];
  cellsMap(table).forEach((content, key) => {
    const { rowId, colId } = splitCellKey(key);
    const ci = colIndex.get(colId);
    const ri = rowIndex.get(rowId);
    if (ci === undefined || ri === undefined) return; // orphaned cell: not addressable
    const column = columns[ci];
    if (column === undefined) return;
    const texts = cellTexts(content);
    if (texts.length === 0) return;
    const value = texts[0]?.text ?? '';
    entries.push({
      kind: 'cell',
      id: `${tableId}/${key}`,
      sheetId,
      sheetOrdinal,
      tableId,
      tableTitle,
      rowId,
      colId,
      rowIndex: ri,
      colIndex: ci,
      colLabel: readString(column, 'label'),
      format: resolveFormat(value, column.get('format')),
      readOnly: isReadOnlyCell(column),
      texts,
    });
  });
  entries.sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);
  return { tableId, sheetId, entries };
}

/** Index one table; null when it no longer exists. */
export function tableEntries(gd: GedeDoc, tableId: Id): TableEntries | null {
  const table = tableMap(gd, tableId);
  if (table === null) return null;
  return tableEntriesOf(tableId, table, sheetOrdinals(gd));
}

function stringsOf(value: unknown): string[] {
  const list = value instanceof Y.Array ? value.toArray() : Array.isArray(value) ? value : [];
  return list.filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * Graph dimension values. The graphs map is empty until the graph work lands;
 * this reads the shape it will store (`dims` / `dimensions` as string lists,
 * a `title`) tolerantly, so the index covers graphs the day they appear.
 */
export function graphEntriesOf(gd: GedeDoc): GraphEntry[] {
  const ordinals = sheetOrdinals(gd);
  const out: GraphEntry[] = [];
  gd.graphs.forEach((graph: GraphMap, graphId) => {
    const sheetId = readString(graph, 'sheetId');
    const title = readString(graph, 'title');
    const dims = [...stringsOf(graph.get('dims')), ...stringsOf(graph.get('dimensions'))];
    const texts = dims.map((d) => text('dimension', d));
    if (title !== '') texts.unshift(text('dimension', title));
    if (texts.length === 0) return;
    out.push({
      kind: 'graph',
      id: `graph/${graphId}`,
      sheetId,
      sheetOrdinal: ordinals.get(sheetId) ?? Number.MAX_SAFE_INTEGER,
      graphId,
      title,
      readOnly: true,
      texts,
    });
  });
  return out;
}

export function documentEntriesOf(documents: readonly DocumentName[]): DocumentEntry[] {
  return documents
    .filter((d) => d.title !== '')
    .map((d) => ({
      kind: 'document',
      id: `document/${d.id}`,
      docId: d.id,
      title: d.title,
      readOnly: true,
      texts: [text('name', d.title)],
    }));
}

/** Everything Find can see, as plain data. */
export function buildSearchSnapshot(
  gd: GedeDoc,
  documents: readonly DocumentName[] = [],
): SearchSnapshot {
  const ordinals = sheetOrdinals(gd);
  const tables: TableEntries[] = [];
  gd.tables.forEach((table, tableId) => {
    tables.push(tableEntriesOf(tableId, table, ordinals));
  });
  return { tables, graphs: graphEntriesOf(gd), documents: documentEntriesOf(documents) };
}
