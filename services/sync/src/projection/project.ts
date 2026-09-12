/**
 * Projection Worker, the pure half (ARCHITECTURE §1.3 "Projection Worker",
 * §1.5.2): a `Y.Doc` in, the rows of the relational projection out. Nothing
 * here touches the database; `worker.ts` writes what this returns.
 *
 * The projection is rebuildable and is never read to reconstruct a document
 * (packages/db/CLAUDE.md). Per cell: `text_plain` is the text the editor
 * shows (formula source or flattened rich text — the GIN index searches it,
 * FIND-03), `rich` is the ProseMirror JSON of the cell's `Y.XmlFragment`,
 * `formula` is the source of a formula cell. Graphs are not projected yet:
 * the CRDT slot holds only geometry, while `graphs` needs `pair_id`, `kind`
 * and `table_id` (Wave 2 graphs work).
 */
import * as Y from 'yjs';

import {
  cellsMap,
  fragmentText,
  isFormula,
  listSheets,
  openDocument,
  rowMeta,
  splitCellKey,
  tablesOnSheet,
  type TableMap,
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

export interface Projection {
  readonly documentId: string;
  readonly sheets: readonly ProjectedSheet[];
  readonly tables: readonly ProjectedTable[];
  readonly columns: readonly ProjectedColumn[];
  readonly rows: readonly ProjectedRow[];
  readonly cells: readonly ProjectedCell[];
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

function projectCells(
  table: TableMap,
  rowIds: Set<string>,
  columnIds: Set<string>,
): ProjectedCell[] {
  const out: ProjectedCell[] = [];
  cellsMap(table).forEach((value, key) => {
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
      out.push({ rowId, columnId, textPlain: value, rich: null, formula: value });
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
  return out;
}

/** Every projection row for a document, in a deterministic order. */
export function projectDocument(doc: Y.Doc, documentId: string): Projection {
  const gd = openDocument(doc);
  const sheets: ProjectedSheet[] = [];
  const tables: ProjectedTable[] = [];
  const columns: ProjectedColumn[] = [];
  const rows: ProjectedRow[] = [];
  const cells: ProjectedCell[] = [];
  const seenSheets = new Set<string>();
  const seenTables = new Set<string>();

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
      cells.push(...projectCells(map, rowIds, columnIds));
    }
  }
  return { documentId, sheets, tables, columns, rows, cells };
}
