/**
 * Y.Doc → engine data. `workbookSnapshot` copies the whole document into
 * plain objects; `observeWorkbook` turns each Yjs transaction (local or
 * remote) into the smallest `WorkbookChange[]` it can name, so a keystroke
 * ships one cell, not the sheet.
 */
import * as Y from 'yjs';

import { rowHeights } from '../doc/geometry.js';
import { effectiveDepths, rowOutlineColumns } from '../hier/outline.js';
import {
  cellFormatMap,
  cellFormatOverride,
  cellsMap,
  computedCells,
  fragmentText,
  isFormula,
  readString,
  rowMeta,
  tableRecord,
  type CellContent,
  type GedeDoc,
  type TableMap,
} from '../doc/schema.js';
import { columnFormat } from '../format/column.js';
import type { CellFormat } from '../format/types.js';
import { isCellKey, splitCellKey, type CellKey, type Id } from '../ids.js';
import { plainText } from '../text/types.js';
import { fragmentToRich } from '../text/yjs.js';
import type { CellSnapshot, TableSnapshot, TableStructure, WorkbookChange } from './types.js';

export function cellSnapshot(content: CellContent | undefined): CellSnapshot | null {
  if (content === undefined) return null;
  if (isFormula(content)) return { kind: 'formula', source: content };
  const rich = fragmentToRich(content);
  const marked = rich.content.some((p) =>
    (p.content ?? []).some((n) => (n.marks?.length ?? 0) > 0),
  );
  return marked
    ? { kind: 'text', text: plainText(rich), rich }
    : { kind: 'text', text: fragmentText(content) };
}

/** Every cell-level format override in the table (FMT-01), or undefined when there is none. */
function cellFormats(table: TableMap): Record<CellKey, CellFormat> | undefined {
  const map = cellFormatMap(table);
  if (map === null || map.size === 0) return undefined;
  const out: Record<CellKey, CellFormat> = {};
  let count = 0;
  map.forEach((_entry, key) => {
    if (!isCellKey(key)) return;
    const { rowId, colId } = splitCellKey(key);
    const override = cellFormatOverride(table, rowId, colId);
    if (override === null) return;
    out[key] = override;
    count += 1;
  });
  return count === 0 ? undefined : out;
}

export function tableStructure(table: TableMap): TableStructure {
  const record = tableRecord(table);
  const overrides = cellFormats(table);
  const metas = record.rows.map((rowId) => rowMeta(table, rowId));
  const depths = effectiveDepths(metas.map((m) => m.depth));
  return {
    id: record.id,
    sheetId: record.sheetId,
    title: record.title,
    gridCol: record.gridCol,
    gridRow: record.gridRow,
    // A hidden column has no lattice presence (GRID-02): width 0, so nothing after it moves.
    // The format rides along (FMT-01..06): the engine reads every cell through it.
    columns: record.columns.map((c) => ({
      id: c.id,
      label: c.label,
      width: c.hidden ? 0 : c.width,
      ...(c.derive === null ? {} : { derive: c.derive }),
      ...(c.computed === null ? {} : { computed: c.computed }),
      format: columnFormat(c),
    })),
    ...(record.computedFormula === null ? {} : { computedFormula: record.computedFormula }),
    rows: record.rows,
    rowHeights: rowHeights(table, record),
    // Effective depths (HIER-02): a merge can leave a stored depth deeper than the
    // row above allows, and an `@` path must be qualified by the parent the reader sees.
    rowDepths: depths,
    // ADR-052: the column each row's outline is drawn in; the `@` index labels the row by it.
    rowOutlineColumns: rowOutlineColumns(record, metas, depths),
    ...(overrides === undefined ? {} : { cellFormats: overrides }),
  };
}

/**
 * The cells the engine reads: what is stored, except under a computed column,
 * whose cells are projected from row provenance (SET-08, `computedCells`).
 */
export function tableCells(table: TableMap): Record<CellKey, CellSnapshot> {
  const out: Record<CellKey, CellSnapshot> = {};
  const computed = computedCells(table);
  cellsMap(table).forEach((content, key) => {
    if (!isCellKey(key) || computed.columns.has(splitCellKey(key).colId)) return;
    const snap = cellSnapshot(content);
    if (snap !== null) out[key] = snap;
  });
  for (const [key, text] of computed.cells) out[key] = { kind: 'text', text };
  return out;
}

export function tableSnapshot(table: TableMap): TableSnapshot {
  return { ...tableStructure(table), cells: tableCells(table) };
}

export function workbookSnapshot(gd: GedeDoc): { tables: TableSnapshot[] } {
  const tables: TableSnapshot[] = [];
  gd.tables.forEach((table) => {
    tables.push(tableSnapshot(table));
  });
  return { tables };
}

/** The table a nested shared type belongs to, or null when it is not under `tables`. */
function owningTable(gd: GedeDoc, target: Y.AbstractType<unknown>): TableMap | null {
  let node: Y.AbstractType<unknown> | null = target;
  while (node !== null) {
    const parent: Y.AbstractType<unknown> | null = node.parent;
    if (parent === gd.tables) return node instanceof Y.Map ? (node as TableMap) : null;
    node = parent;
  }
  return null;
}

/** For a type nested in a cell fragment, the cell key it lives under. */
function owningCellKey(target: Y.AbstractType<unknown>, cells: Y.Map<CellContent>): string | null {
  let node: Y.AbstractType<unknown> | null = target;
  while (node !== null) {
    if (node.parent === cells) {
      const sub: string | null = node._item?.parentSub ?? null;
      return sub;
    }
    node = node.parent;
  }
  return null;
}

/**
 * Subscribe to the document. The listener receives one batch per transaction
 * and the initial `reset` synchronously on subscribe. Returns an unsubscribe.
 */
export function observeWorkbook(
  gd: GedeDoc,
  listener: (changes: WorkbookChange[]) => void,
): () => void {
  // SET-08: what each table's computed columns showed the engine last, so a structure change
  // (a row's provenance, a column made or no longer computed) ships only what moved.
  const shown = new Map<Id, ReturnType<typeof computedCells>>();
  const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    const changes: WorkbookChange[] = [];
    const structure = new Set<Id>();
    const removed = new Set<Id>();
    const cells = new Map<Id, Record<CellKey, CellSnapshot | null>>();
    const set = (tableId: Id, key: CellKey, snap: CellSnapshot | null): void => {
      let bucket = cells.get(tableId);
      if (bucket === undefined) {
        bucket = {};
        cells.set(tableId, bucket);
      }
      bucket[key] = snap;
    };
    const cellChange = (tableId: Id, key: string, content: CellContent | undefined): void => {
      if (!isCellKey(key)) return;
      // A value stored under a computed column's key stays hidden from the engine.
      if (shown.get(tableId)?.columns.has(splitCellKey(key).colId) === true) return;
      set(tableId, key, cellSnapshot(content));
    };
    const syncComputed = (tableId: Id, table: TableMap): void => {
      const before = shown.get(tableId);
      const now = computedCells(table);
      if (before === undefined && now.columns.size === 0) return;
      shown.set(tableId, now);
      for (const [key, text] of now.cells) {
        if (before?.cells.get(key) !== text) set(tableId, key, { kind: 'text', text });
      }
      for (const key of before?.cells.keys() ?? []) {
        if (!now.cells.has(key) && now.columns.has(splitCellKey(key).colId))
          set(tableId, key, null);
      }
      const added = [...now.columns].filter((c) => before?.columns.has(c) !== true);
      const dropped = [...(before?.columns ?? [])].filter((c) => !now.columns.has(c));
      if (added.length === 0 && dropped.length === 0) return;
      // A column made computed hides what is stored under it; one no longer computed shows it.
      const map = cellsMap(table);
      for (const key of before?.cells.keys() ?? []) {
        if (dropped.includes(splitCellKey(key).colId)) set(tableId, key, null);
      }
      map.forEach((content, key) => {
        if (!isCellKey(key)) return;
        const { colId } = splitCellKey(key);
        if (dropped.includes(colId)) set(tableId, key, cellSnapshot(content));
        else if (added.includes(colId) && !now.cells.has(key)) set(tableId, key, null);
      });
    };

    for (const event of events) {
      if (event.target === gd.tables) {
        event.changes.keys.forEach((change, key) => {
          if (change.action === 'delete') {
            removed.add(key);
            shown.delete(key);
            return;
          }
          const table = gd.tables.get(key);
          if (table !== undefined) {
            structure.add(key);
            shown.delete(key);
            const computed = computedCells(table);
            cellsMap(table).forEach((content, cellId) => {
              if (isCellKey(cellId) && !computed.columns.has(splitCellKey(cellId).colId)) {
                set(key, cellId, cellSnapshot(content));
              }
            });
          }
        });
        continue;
      }
      const table = owningTable(gd, event.target);
      if (table === null) continue;
      const tableId = readString(table, 'id');
      const map = cellsMap(table);
      if (event.target === map) {
        event.changes.keys.forEach((_change, key) => {
          cellChange(tableId, key, map.get(key));
        });
        continue;
      }
      const key = owningCellKey(event.target, map);
      if (key !== null) {
        cellChange(tableId, key, map.get(key));
        continue;
      }
      structure.add(tableId);
    }

    for (const tableId of removed) changes.push({ type: 'table-removed', tableId });
    for (const tableId of structure) {
      const table = gd.tables.get(tableId);
      if (table === undefined) continue;
      changes.push({ type: 'table', table: tableStructure(table) });
      syncComputed(tableId, table);
    }
    for (const [tableId, bucket] of cells) {
      if (removed.has(tableId)) continue;
      changes.push({ type: 'cells', tableId, cells: bucket });
    }
    if (changes.length > 0) listener(changes);
  };
  gd.tables.forEach((table, tableId) => {
    const computed = computedCells(table);
    if (computed.columns.size > 0) shown.set(tableId, computed);
  });
  listener([{ type: 'reset', snapshot: workbookSnapshot(gd) }]);
  gd.tables.observeDeep(handler);
  return () => {
    gd.tables.unobserveDeep(handler);
  };
}
