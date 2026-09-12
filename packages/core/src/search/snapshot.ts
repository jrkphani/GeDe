/**
 * The search snapshot (FIND-03): a serialisable projection of everything Find
 * can see — cell values, formula expressions, reference paths, graph
 * dimension values and library document names. The main thread builds it
 * from the Yjs document (per table, so an edit re-indexes one table) and posts
 * it to the search Worker, which folds and segments the text (`engine.ts`);
 * nothing here is a Yjs type or a class instance, and nothing here segments.
 */
import * as Y from 'yjs';

import { splitCellKey, type CellKey, type Id } from '../ids.js';
import { parse } from '../formula/parser.js';
import { references } from '../formula/ast.js';
import { workbookIndexOf } from '../engine/commit.js';
import {
  cellReadOnlyReason,
  cellsMap,
  columnsArray,
  fragmentText,
  isFormula,
  listSheets,
  readString,
  rowsArray,
  tableMap,
  type GedeDoc,
  type GraphMap,
  type TableMap,
} from '../doc/schema.js';
import { spanIndex } from '../style/spans.js';
import { resolveFormat } from './format.js';
import type { FormatKind } from './query.js';

/** Which text of an entry matched. */
export type SearchField = 'value' | 'formula' | 'reference' | 'header' | 'dimension' | 'name';

export interface SearchText {
  readonly field: SearchField;
  readonly text: string;
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

/**
 * A column header (DOC-06: header cells carry addresses, so Find reaches them
 * like any cell). Read-only until a column-rename mutation exists —
 * TODO(grid branch): rewrite through `setColumnLabel` once it lands.
 */
export interface HeaderEntry {
  readonly kind: 'header';
  /** `${tableId}/header:${colId}` */
  readonly id: string;
  readonly sheetId: Id;
  readonly sheetOrdinal: number;
  readonly tableId: Id;
  readonly tableTitle: string;
  readonly colId: Id;
  readonly colIndex: number;
  readonly colLabel: string;
  readonly readOnly: true;
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

export type SearchEntry = CellEntry | HeaderEntry | GraphEntry | DocumentEntry;

export interface TableEntries {
  readonly tableId: Id;
  readonly sheetId: Id;
  /** Header entries first (one per labelled column), then cells in row, column order. */
  readonly entries: readonly (CellEntry | HeaderEntry)[];
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
  return { field, text: value };
}

/**
 * The texts Find sees for one cell: its value, or a formula's expression plus
 * each reference it names — as the person reads them (FIND-03). A stored
 * formula holds id tokens (PRD §20); `project` turns them into today's A1 /
 * `@` text before anything is indexed, so "B6" finds `=Sum(B6)` and a ULID
 * fragment finds nothing.
 */
export function cellTexts(
  content: Y.XmlFragment | string,
  project: (source: string) => string = (s) => s,
): SearchText[] {
  if (!isFormula(content)) {
    const value = fragmentText(content);
    return value === '' ? [] : [text('value', value)];
  }
  const shown = project(content);
  const out: SearchText[] = [text('formula', shown)];
  const ast = parse(shown);
  if (ast.ok) {
    const seen = new Set<string>();
    for (const ref of references(ast.value)) {
      const source = shown.slice(ref.span.start, ref.span.end);
      if (source === '' || seen.has(source)) continue;
      seen.add(source);
      out.push(text('reference', source));
    }
  }
  return out;
}

/** One workbook index per snapshot build: every formula on every table projects through it. */
function projectorFor(gd: GedeDoc): (source: string) => string {
  const index = workbookIndexOf(gd);
  return (source) => (source.includes('{') ? index.project(source) : source);
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
  project: (source: string) => string,
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
  const hidden = new Set<Id>();
  columns.forEach((c) => {
    if (c.get('hidden') === true) hidden.add(readString(c, 'id'));
  });
  const headers: HeaderEntry[] = [];
  columns.forEach((column, ci) => {
    const colId = readString(column, 'id');
    const colLabel = readString(column, 'label');
    // A hidden column has no lattice presence (GRID-02): nothing in it can be found or highlighted.
    if (colLabel === '' || hidden.has(colId)) return;
    headers.push({
      kind: 'header',
      id: `${tableId}/header:${colId}`,
      sheetId,
      sheetOrdinal,
      tableId,
      tableTitle,
      colId,
      colIndex: ci,
      colLabel,
      readOnly: true,
      texts: [text('header', colLabel)],
    });
  });
  const entries: CellEntry[] = [];
  // MENU-04 / ADR-033: a cell a merged span covers is off the grid the way a hidden column's
  // cells are — it keeps its data, but nothing in it can be found or highlighted.
  const covered = spanIndex(table).covered;
  cellsMap(table).forEach((content, key) => {
    const { rowId, colId } = splitCellKey(key);
    const ci = colIndex.get(colId);
    const ri = rowIndex.get(rowId);
    if (ci === undefined || ri === undefined) return; // orphaned cell: not addressable
    const column = columns[ci];
    if (column === undefined || hidden.has(colId) || covered.has(key as CellKey)) return;
    const texts = cellTexts(content, project);
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
      // FIND-08: derived, linked and pulled columns and category-band rows are never rewritten (GRID-04).
      readOnly: cellReadOnlyReason(table, rowId, colId) !== null,
      texts,
    });
  });
  entries.sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);
  return { tableId, sheetId, entries: [...headers, ...entries] };
}

/** Index one table; null when it no longer exists. */
export function tableEntries(gd: GedeDoc, tableId: Id): TableEntries | null {
  const table = tableMap(gd, tableId);
  if (table === null) return null;
  return tableEntriesOf(tableId, table, sheetOrdinals(gd), projectorFor(gd));
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
  const project = projectorFor(gd);
  const tables: TableEntries[] = [];
  gd.tables.forEach((table, tableId) => {
    tables.push(tableEntriesOf(tableId, table, ordinals, project));
  });
  return { tables, graphs: graphEntriesOf(gd), documents: documentEntriesOf(documents) };
}
