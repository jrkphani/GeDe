/**
 * Projection Worker, the pure half (ARCHITECTURE §1.3 "Projection Worker",
 * §1.5.2): a `Y.Doc` in, the rows of the relational projection out. Nothing
 * here touches the database; `worker.ts` writes what this returns.
 *
 * The projection is rebuildable and is never read to reconstruct a document
 * (packages/db/CLAUDE.md). Per cell: `text_plain` is the text the editor
 * shows — flattened rich text, or for a computed cell what it evaluates to,
 * followed on a second line by the expression as the person reads it (the
 * GIN index searches both, FIND-03 "cell values, formula expressions") —
 * `rich` is the ProseMirror JSON of the cell's `Y.XmlFragment`, `formula` is
 * the stored source of a formula cell. Derived columns (REF-04) own their
 * cells and store nothing per row: the engine evaluates one synthetic formula
 * per row, and each is projected as a row of its own (`text_plain` the
 * value, `formula` the synthesised source), mirroring what Find indexes in
 * the SPA (#125). Evaluation is the same `FormulaEngine` the browser runs, in
 * this process, over the snapshot's bytes. Graphs (GRAPH-01..11) project one
 * row per half of a pair — pair id, kind, source table, dimension columns,
 * geometry and the slice — only while bound to a table that is itself
 * projected (`graphs.table_id` is NOT NULL and a foreign key); an unbound
 * pair, or one whose table is gone, has nothing to search or audit and is
 * skipped until it binds again.
 */
import * as Y from 'yjs';

import {
  cellKey,
  cellsMap,
  derivedCellSource,
  evaluatedText,
  FormulaEngine,
  fragmentText,
  graphsOnSheet,
  isFormula,
  listSheets,
  openDocument,
  rowMeta,
  splitCellKey,
  tablesOnSheet,
  workbookCellId,
  workbookIndexOf,
  workbookSnapshot,
  type CellKey,
  type CellResult,
  type GraphKind,
  type GraphSlice,
  type TableMap,
  type TableRecord,
} from '@gede/core';

export interface ProjectedSheet {
  readonly id: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly label: string;
  readonly parentContext: string | null;
}

export interface ProjectedTable {
  readonly id: string;
  readonly sheetId: string;
  readonly title: string;
  readonly gridCol: number;
  readonly gridRow: number;
}

export interface ProjectedColumn {
  readonly id: string;
  readonly tableId: string;
  readonly ordinal: number;
  readonly label: string;
  readonly widthUnits: number;
}

export interface ProjectedRow {
  readonly id: string;
  readonly tableId: string;
  readonly ordinal: number;
  readonly depth: number;
  readonly collapsed: boolean;
}

/** A ProseMirror node as JSON (`Node.toJSON()` shape). */
export interface ProseMirrorNode {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
  readonly content?: ProseMirrorNode[];
  readonly text?: string;
  readonly marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface ProjectedCell {
  readonly rowId: string;
  readonly columnId: string;
  readonly textPlain: string;
  readonly rich: ProseMirrorNode | null;
  readonly formula: string | null;
}

/** One half of a graph pair (`graphs` table); `slice` is the stored JSON as-is. */
export interface ProjectedGraph {
  readonly id: string;
  readonly sheetId: string;
  readonly pairId: string;
  readonly kind: GraphKind;
  readonly tableId: string;
  /** Dimension column ids that are still columns of the table, in checklist order. */
  readonly dimensionColumns: readonly string[];
  readonly gridCol: number;
  readonly gridRow: number;
  readonly widthUnits: number;
  readonly heightUnits: number;
  readonly slice: GraphSlice;
}

export interface Projection {
  readonly documentId: string;
  readonly sheets: readonly ProjectedSheet[];
  readonly tables: readonly ProjectedTable[];
  readonly columns: readonly ProjectedColumn[];
  readonly rows: readonly ProjectedRow[];
  readonly cells: readonly ProjectedCell[];
  readonly graphs: readonly ProjectedGraph[];
}

function attrsOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** A `Y.XmlText` delta → ProseMirror text nodes; delta attributes are marks (y-prosemirror's mapping). */
function textNodes(text: Y.XmlText): ProseMirrorNode[] {
  const delta: unknown = text.toDelta();
  if (!Array.isArray(delta)) return [];
  const out: ProseMirrorNode[] = [];
  for (const op of delta) {
    if (typeof op !== 'object' || op === null) continue;
    const { insert, attributes } = op as { insert?: unknown; attributes?: unknown };
    if (typeof insert !== 'string' || insert === '') continue;
    const marks = Object.entries(attrsOf(attributes) ?? {}).map(([type, value]) => {
      const attrs = attrsOf(value);
      return attrs === undefined ? { type } : { type, attrs };
    });
    out.push(
      marks.length === 0 ? { type: 'text', text: insert } : { type: 'text', text: insert, marks },
    );
  }
  return out;
}

function elementNode(element: Y.XmlElement): ProseMirrorNode {
  const content = element.toArray().flatMap((child) => {
    if (child instanceof Y.XmlText) return textNodes(child);
    if (child instanceof Y.XmlElement) return [elementNode(child)];
    return [];
  });
  const attrs = attrsOf(element.getAttributes());
  const node: ProseMirrorNode = { type: element.nodeName };
  return {
    ...node,
    ...(attrs === undefined ? {} : { attrs }),
    ...(content.length === 0 ? {} : { content }),
  };
}

/**
 * The ProseMirror `doc` JSON for a cell's fragment (a list of `paragraph` nodes in Wave 1).
 * TODO(wave2/richtext-formats, PR #57): replace this and `textNodes`/`elementNode` with
 * `fragmentToRich` from `@gede/core` once it is on main, so the projection and the
 * editor share one Yjs → ProseMirror mapping.
 */
export function fragmentToProseMirror(fragment: Y.XmlFragment): ProseMirrorNode {
  const content = fragment.toArray().flatMap((node) => {
    if (node instanceof Y.XmlElement) return [elementNode(node)];
    if (node instanceof Y.XmlText) return [{ type: 'paragraph', content: textNodes(node) }];
    return [];
  });
  return content.length === 0 ? { type: 'doc' } : { type: 'doc', content };
}

/**
 * Evaluate every formula in the document once, as the browser's engine would
 * (derived columns included: the engine synthesises their cells). Results are
 * keyed by `workbookCellId`; an error or a blank has no text.
 */
function evaluateAll(gd: ReturnType<typeof openDocument>): Map<string, CellResult> {
  const engine = new FormulaEngine();
  const outcome = engine.apply([{ type: 'reset', snapshot: workbookSnapshot(gd) }]);
  return new Map(outcome.results.map((r) => [r.cellId, r]));
}

/** What a computed cell shows: its value's plain text, '' for an error, a blank or no result. */
function shownText(results: ReadonlyMap<string, CellResult>, tableId: string, key: CellKey) {
  const result = results.get(workbookCellId(tableId, key));
  if (result?.error !== null) return ''; // no result, or an error: nothing shown
  return evaluatedText(result.value);
}

/** FIND-03: the value first, then the expression, so both are searched and the value reads first. */
function computedTextPlain(shown: string, expression: string): string {
  return shown === '' ? expression : `${shown}\n${expression}`;
}

function projectCells(
  table: TableRecord,
  map: TableMap,
  rowIds: Set<string>,
  columnIds: Set<string>,
  project: (source: string) => string,
  results: ReadonlyMap<string, CellResult>,
): ProjectedCell[] {
  const out: ProjectedCell[] = [];
  const cells = cellsMap(map);
  cells.forEach((value, key) => {
    let rowId: string;
    let columnId: string;
    try {
      ({ rowId, colId: columnId } = splitCellKey(key));
    } catch {
      return; // not a cell key; never written by the client
    }
    // A cell whose row or column no longer exists cannot satisfy the foreign keys.
    if (!rowIds.has(rowId) || !columnIds.has(columnId)) return;
    if (isFormula(value)) {
      // The stored source holds id tokens (PRD §20); what is searched and audited is the
      // value shown and the expression as the person reads it today (FIND-03). `formula`
      // keeps the stored form.
      out.push({
        rowId,
        columnId,
        textPlain: computedTextPlain(shownText(results, table.id, key as CellKey), project(value)),
        rich: null,
        formula: value,
      });
      return;
    }
    if (!(value instanceof Y.XmlFragment)) return;
    out.push({
      rowId,
      columnId,
      textPlain: fragmentText(value),
      rich: fragmentToProseMirror(value),
      formula: null,
    });
  });
  // Derived columns (REF-04): one projected row per table row that has no document cell
  // of its own (a Split child's piece is a document cell and was projected above).
  for (const column of table.columns) {
    if (column.derive === null || !columnIds.has(column.id)) continue;
    for (const rowId of rowIds) {
      const key = cellKey(rowId, column.id);
      if (cells.has(key)) continue;
      const shown = shownText(results, table.id, key);
      if (shown === '') continue; // no result (unevaluated, blank or an error): nothing to search
      const source = derivedCellSource(table.id, rowId, column.derive);
      out.push({
        rowId,
        columnId: column.id,
        textPlain: computedTextPlain(shown, project(source)),
        rich: null,
        formula: source,
      });
    }
  }
  return out;
}

/** Every projection row for a document, in a deterministic order. */
export function projectDocument(doc: Y.Doc, documentId: string): Projection {
  const gd = openDocument(doc);
  const index = workbookIndexOf(gd);
  const results = evaluateAll(gd);
  const project = (source: string): string =>
    source.includes('{') ? index.project(source) : source;
  const sheets: ProjectedSheet[] = [];
  const tables: ProjectedTable[] = [];
  const columns: ProjectedColumn[] = [];
  const rows: ProjectedRow[] = [];
  const cells: ProjectedCell[] = [];
  const graphs: ProjectedGraph[] = [];
  const seenSheets = new Set<string>();
  const seenTables = new Set<string>();
  const seenGraphs = new Set<string>();
  /** Column ids per projected table, so a graph's dimensions never name a column that is gone. */
  const columnsOf = new Map<string, Set<string>>();

  for (const sheet of listSheets(gd)) {
    if (sheet.id === '' || seenSheets.has(sheet.id)) continue;
    seenSheets.add(sheet.id);
    sheets.push({
      id: sheet.id,
      documentId,
      ordinal: sheet.ordinal,
      label: sheet.label,
      parentContext: sheet.parentContext,
    });
    for (const table of tablesOnSheet(gd, sheet.id)) {
      if (table.id === '' || seenTables.has(table.id)) continue;
      const map = gd.tables.get(table.id);
      if (map === undefined) continue;
      seenTables.add(table.id);
      tables.push({
        id: table.id,
        sheetId: sheet.id,
        title: table.title,
        gridCol: table.gridCol,
        gridRow: table.gridRow,
      });
      const columnIds = new Set<string>();
      columnsOf.set(table.id, columnIds);
      table.columns.forEach((column, index) => {
        if (column.id === '' || columnIds.has(column.id)) return;
        columnIds.add(column.id);
        columns.push({
          id: column.id,
          tableId: table.id,
          ordinal: index + 1,
          label: column.label,
          widthUnits: column.width,
        });
      });
      const rowIds = new Set<string>();
      table.rows.forEach((rowId, index) => {
        if (typeof rowId !== 'string' || rowId === '' || rowIds.has(rowId)) return;
        rowIds.add(rowId);
        const meta = rowMeta(map, rowId);
        rows.push({
          id: rowId,
          tableId: table.id,
          ordinal: index + 1,
          depth: meta.depth,
          collapsed: meta.collapsed,
        });
      });
      cells.push(...projectCells(table, map, rowIds, columnIds, project, results));
    }
  }
  // Graphs after every table: `table_id` must reference a projected table.
  for (const sheet of listSheets(gd)) {
    if (sheet.id === '') continue;
    for (const graph of graphsOnSheet(gd, sheet.id)) {
      if (graph.id === '' || seenGraphs.has(graph.id)) continue;
      if (graph.tableId === null) continue;
      const tableColumns = columnsOf.get(graph.tableId);
      if (tableColumns === undefined) continue;
      seenGraphs.add(graph.id);
      graphs.push({
        id: graph.id,
        sheetId: sheet.id,
        pairId: graph.pairId,
        kind: graph.kind,
        tableId: graph.tableId,
        dimensionColumns: graph.dimensions.filter((id) => tableColumns.has(id)),
        gridCol: graph.gridCol,
        gridRow: graph.gridRow,
        widthUnits: graph.widthUnits,
        heightUnits: graph.heightUnits,
        slice: graph.slice,
      });
    }
  }
  return { documentId, sheets, tables, columns, rows, cells, graphs };
}
