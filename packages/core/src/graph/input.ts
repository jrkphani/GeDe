/**
 * Builds the derivation's input from a table in the document. The value
 * reader is injected so the browser can hand in the engine's evaluated value
 * for a formula cell while the sync service and tests read stored text.
 */
import { cellText, rowMeta, tableRecord, type TableMap, type TableRecord } from '../doc/schema.js';
import type { Id } from '../ids.js';
import { isGraphDimensionCandidate } from '../ref/graph.js';
import type { GraphInput, GraphInputColumn, GraphInputRow } from './derive.js';

/** Plain text of a cell as the graph should read it. */
export type GraphValueReader = (rowId: Id, colId: Id) => string;

/** REF-05: the columns a graph may use as dimensions. */
export function eligibleColumns(record: TableRecord): GraphInputColumn[] {
  return record.columns.map((c) => ({
    id: c.id,
    label: c.label,
    eligible: isGraphDimensionCandidate(c),
  }));
}

/**
 * Rows that can be contexts: every data row except category bands and
 * `Split()` children (neither is a row a person typed). Values are read for
 * every eligible column so the inspector's distinct counts and the derivation
 * share one pass.
 */
export function graphInputOf(
  table: TableMap,
  dimensions: readonly Id[],
  read: GraphValueReader = (rowId, colId) => cellText(table, rowId, colId),
  record: TableRecord = tableRecord(table),
): GraphInput {
  const columns = eligibleColumns(record);
  const wanted = columns.filter((c) => c.eligible).map((c) => c.id);
  const rows: GraphInputRow[] = [];
  for (const rowId of record.rows) {
    const meta = rowMeta(table, rowId);
    if (meta.group || meta.splitChild) continue;
    const values: Record<Id, string> = {};
    for (const colId of wanted) values[colId] = read(rowId, colId);
    rows.push({ id: rowId, values });
  }
  return { columns, rows, dimensions };
}
