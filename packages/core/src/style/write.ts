/** Shared write helpers for the style mutations: one transaction under the local origin each. */
import * as Y from 'yjs';

import {
  columnsArray,
  readString,
  tableMap,
  type ColumnMap,
  type GedeDoc,
  type TableMap,
} from '../doc/schema.js';
import type { Id } from '../ids.js';

export function transact<T>(gd: GedeDoc, fn: () => T): T {
  let out!: T;
  gd.doc.transact(() => {
    out = fn();
  }, gd.origin);
  return out;
}

export function requireTable(gd: GedeDoc, tableId: Id): TableMap {
  const table = tableMap(gd, tableId);
  if (table === null) throw new RangeError(`no table ${tableId}`);
  return table;
}

export function requireColumn(table: TableMap, tableId: Id, colId: Id): ColumnMap {
  const column = columnsArray(table)
    .toArray()
    .find((c) => readString(c, 'id') === colId);
  if (column === undefined) throw new RangeError(`no column ${colId} in ${tableId}`);
  return column;
}

/**
 * A nested map on the table, created on first write (like `cellFormat`).
 * Returns null when it does not exist and `create` is false.
 */
export function nestedMap(table: TableMap, key: string, create: boolean): Y.Map<unknown> | null {
  const existing = table.get(key);
  if (existing instanceof Y.Map) return existing as Y.Map<unknown>;
  if (!create) return null;
  const map = new Y.Map<unknown>();
  table.set(key, map);
  return map;
}
