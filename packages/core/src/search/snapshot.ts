/**
 * The search snapshot (FIND-03): a serialisable projection of everything Find
 * can see — cell values, formula expressions, reference paths, graph
 * dimension values and library document names. The main thread builds it
 * from the Yjs document (per table, so an edit re-indexes one table) and posts
 * it to the search Worker, which folds and segments the text (`engine.ts`);
 * nothing here is a Yjs type or a class instance, and nothing here segments.
 */
import type * as Y from 'yjs';

import { cellKey, splitCellKey, type CellKey, type Id } from '../ids.js';
import { parse } from '../formula/parser.js';
import { references } from '../formula/ast.js';
import { workbookIndexOf } from '../engine/commit.js';
import {
  cellReadOnlyReason,
  cellsMap,
  cellText,
  columnsArray,
  fragmentText,
  graphRecord,
  isFormula,
  listSheets,
  readString,
  rowsArray,
  tableMap,
  tableRecord,
  type GedeDoc,
  type GraphMap,
  type TableMap,
} from '../doc/schema.js';
import { deriveGraph } from '../graph/derive.js';
import { graphInputOf } from '../graph/input.js';
import { spanIndex } from '../style/spans.js';
import { resolveFormat } from './format.js';
import type { FormatKind } from './query.js';

/**
 * Which text of an entry matched. `value` is typed text; `result` is what a
 * computed cell — a formula, a derived or a pulled cell — shows once
 * evaluated (FIND-03 "cell values"): found like any value, never rewritten
 * (FIND-08), since the expression or the source column is what changes it.
 */
export type SearchField =
  'value' | 'result' | 'formula' | 'reference' | 'header' | 'dimension' | 'name';

/**
 * The evaluated text of a computed cell, as the person sees it, or `undefined`
 * when the caller has no result for it (no engine, not evaluated yet). The
 * snapshot is built on the main thread from the Yjs document, which holds
 * expressions and not results: results live in the engine host, and the app
 * passes a reader over them.
 */
export type SearchValueReader = (tableId: Id, rowId: Id, colId: Id) => string | undefined;

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
  evaluated?: string,
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
  // The result last: at equal distance the expression wins the match, since
  // that is what a person can edit; the value still finds the cell.
  if (evaluated !== undefined && evaluated !== '') out.push(text('result', evaluated));
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
  valueOf: SearchValueReader | undefined,
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
  const cells = cellsMap(table);
  const push = (key: CellKey, rowId: Id, colId: Id, texts: SearchText[]) => {
    const ci = colIndex.get(colId);
    const ri = rowIndex.get(rowId);
    if (ci === undefined || ri === undefined) return; // orphaned cell: not addressable
    const column = columns[ci];
    if (column === undefined || hidden.has(colId) || covered.has(key)) return;
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
  };
  cells.forEach((content, key) => {
    const { rowId, colId } = splitCellKey(key);
    const evaluated = isFormula(content) ? valueOf?.(tableId, rowId, colId) : undefined;
    push(key as CellKey, rowId, colId, cellTexts(content, project, evaluated));
  });
  // Derived columns own their cells (REF-04): nothing is stored for a row, the
  // engine evaluates one synthetic formula per row. What the person sees there
  // is a cell value (FIND-03), indexed as a `result` and never rewritten.
  if (valueOf !== undefined) {
    for (const column of columns) {
      if (column.get('derive') === undefined || column.get('derive') === null) continue;
      const colId = readString(column, 'id');
      for (const rowId of rowIndex.keys()) {
        const key = cellKey(rowId, colId);
        if (cells.has(key)) continue; // the document's own cell (a Split child's piece) was indexed above
        const evaluated = valueOf(tableId, rowId, colId);
        if (evaluated === undefined || evaluated === '') continue;
        push(key, rowId, colId, [text('result', evaluated)]);
      }
    }
  }
  entries.sort((a, b) => a.rowIndex - b.rowIndex || a.colIndex - b.colIndex);
  return { tableId, sheetId, entries: [...headers, ...entries] };
}

/** Index one table; null when it no longer exists. */
export function tableEntries(
  gd: GedeDoc,
  tableId: Id,
  valueOf?: SearchValueReader,
): TableEntries | null {
  const table = tableMap(gd, tableId);
  if (table === null) return null;
  return tableEntriesOf(tableId, table, sheetOrdinals(gd), projectorFor(gd), valueOf);
}

/** What Find calls a graph pair: the table it reads and its kind, "Offices ring". */
export function graphTitle(tableTitle: string, kind: string): string {
  return tableTitle === '' ? kind : `${tableTitle} ${kind}`;
}

/**
 * Graph dimension values (FIND-03, GRAPH-03..05): a context graph's
 * parameters are the distinct values of its dimension columns, and its
 * dimensions are those columns' titles — what the graph draws, not the
 * column ids the map stores (#125). One entry per pair: the ring and the
 * coverage half read the same table and dimensions, so a value matches the
 * graph once, at the half that comes first in the document. A pair with no
 * table, or bound to a table that is gone, has no values to find.
 */
export function graphEntriesOf(gd: GedeDoc, valueOf?: SearchValueReader): GraphEntry[] {
  const ordinals = sheetOrdinals(gd);
  const out: GraphEntry[] = [];
  const seenPairs = new Set<string>();
  gd.graphs.forEach((graph: GraphMap, graphId) => {
    const record = graphRecord(graph);
    const pairKey = record.pairId === '' ? graphId : record.pairId;
    if (seenPairs.has(pairKey)) return;
    if (record.tableId === null) return;
    const tableId = record.tableId;
    const table = tableMap(gd, tableId);
    if (table === null) return;
    seenPairs.add(pairKey);
    const tableRec = tableRecord(table);
    const cells = cellsMap(table);
    const input = graphInputOf(
      table,
      record.dimensions,
      (rowId, colId) => {
        // A formula cell's parameter is what it shows, never its expression.
        if (isFormula(cells.get(cellKey(rowId, colId))))
          return valueOf?.(tableId, rowId, colId) ?? '';
        return cellText(table, rowId, colId);
      },
      tableRec,
    );
    const texts: SearchText[] = [];
    const seen = new Set<string>();
    const add = (value: string) => {
      if (value === '' || seen.has(value)) return;
      seen.add(value);
      texts.push(text('dimension', value));
    };
    for (const dimension of deriveGraph(input).dimensions) {
      add(dimension.label);
      for (const parameter of dimension.parameters) add(parameter.value);
    }
    if (texts.length === 0) return;
    out.push({
      kind: 'graph',
      id: `graph/${pairKey}`,
      sheetId: record.sheetId,
      sheetOrdinal: ordinals.get(record.sheetId) ?? Number.MAX_SAFE_INTEGER,
      graphId,
      title: graphTitle(tableRec.title, record.kind),
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

/**
 * Everything Find can see, as plain data. `valueOf` supplies the evaluated
 * text of computed cells (formula, derived, pulled); without it those cells
 * are found by their expressions only.
 */
export function buildSearchSnapshot(
  gd: GedeDoc,
  documents: readonly DocumentName[] = [],
  valueOf?: SearchValueReader,
): SearchSnapshot {
  const ordinals = sheetOrdinals(gd);
  const project = projectorFor(gd);
  const tables: TableEntries[] = [];
  gd.tables.forEach((table, tableId) => {
    tables.push(tableEntriesOf(tableId, table, ordinals, project, valueOf));
  });
  return {
    tables,
    graphs: graphEntriesOf(gd, valueOf),
    documents: documentEntriesOf(documents),
  };
}
