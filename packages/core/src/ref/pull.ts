/**
 * Row pulls (REF-02, PRD §14 "a table mirrors rows from any table on any
 * sheet, filtered by a contains-expression; the receiving column renames
 * itself after its source; values stay live").
 *
 * Shape. The receiving column stores `source: 'pulled'` and
 * `pull: { tableId, colId, filter }` and is labelled `↰ Table · Column`.
 * The mirrored rows are real rows of the receiving table so that they have
 * addresses, sort, group and reference like any row — but they are owned by
 * the reconciler, not by a person:
 *
 *   - a pulled row's id is its source row's id (provenance and determinism
 *     in one: two replicas that reconcile the same source produce the same
 *     row, and `rowMeta.pulledFrom` names the source table);
 *   - its cell in the receiving column is `={c:T:R:C}`, a bound reference
 *     (ADR-023), so the value is evaluated by the engine in the Worker and
 *     recomputes on every upstream change through the dependency graph;
 *   - every cell of a pulled row is read-only (`rowReadOnlyReason`, REF-05).
 *
 * Reconciling. `reconcilePull` is idempotent and deterministic: it computes
 * the rows the source yields today, compares them with the pulled block the
 * table holds, and writes only the difference — nothing when nothing moved.
 * It runs under `REF_ORIGIN`, which the undo manager does not track, so a
 * source edit stays one undo step; binding the pull (`setPull`) reconciles
 * inside its own local transaction, so that is one step too, rows included.
 * Concurrent reconciles converge because the diff is minimal (`rows.ts`):
 * identical values on the same keys merge to one; a row two replicas both
 * inserted is deduplicated by the next reconcile on every replica (the same
 * item, the same delete) without a new insert; a replica that sees the
 * other's finished result writes nothing. Own rows keep their places — the
 * pulled rows only keep source order among themselves.
 *
 * The filter is a plain contains test over the source row's cells, on the
 * thread that reconciles; a formula or derived cell contributes the value the
 * engine already evaluated (`PullReader.cellValue`) — nothing is evaluated
 * here. Every source row is mirrored unless the filter excludes it (PRD §14
 * names only the contains expression).
 */
import { rowMetaFor } from '../doc/mutations.js';
import {
  cellsMap,
  cellText,
  columnsArray,
  isFormula,
  readColumnSource,
  readPulledFrom,
  readPullSpec,
  readString,
  rowMeta,
  rowMetaMap,
  rowsArray,
  tableRecord,
  type GedeDoc,
  type PullSpec,
  type TableMap,
  type TableRecord,
} from '../doc/schema.js';
import { encodeBound } from '../formula/bound.js';
import type { CellValue } from '../formula/evaluate.js';
import { cellKey, type CellKey, type Id } from '../ids.js';
import { evaluatedText } from '../sort/engine.js';
import { orderMembers, RowEditor } from './rows.js';

/** Transaction origin of a reconcile: never an undo step (nothing a person did). */
export const REF_ORIGIN = 'ref-reconcile';

function requireTable(gd: GedeDoc, tableId: Id): TableMap {
  const table = gd.tables.get(tableId);
  if (table === undefined) throw new RangeError(`no table ${tableId}`);
  return table;
}

/** `↰ Table · Column` — how the receiving column names its source (PRD §14). */
export function pullLabel(gd: GedeDoc, spec: PullSpec): string {
  const table = gd.tables.get(spec.tableId);
  const record = table === undefined ? null : tableRecord(table);
  const column = record?.columns.find((c) => c.id === spec.colId);
  return `↰ ${record?.title ?? '#REF'} · ${column?.label ?? '#REF'}`;
}

/** The pull a table carries: its receiving column and spec, or null. One per table. */
export function pullOf(table: TableMap): { readonly colId: Id; readonly spec: PullSpec } | null {
  for (const column of columnsArray(table).toArray()) {
    if (readColumnSource(column) !== 'pulled') continue;
    const spec = readPullSpec(column.get('pull'));
    if (spec !== null) return { colId: readString(column, 'id'), spec };
  }
  return null;
}

/** The stored form of a pulled cell: the source cell, bound by id. */
export function pulledCellSource(spec: PullSpec, rowId: Id): string {
  return `=${encodeBound({ kind: 'cell', tableId: spec.tableId, rowId, colId: spec.colId, spelling: 'address' })}`;
}

/**
 * How the reconciler reads a source row's text for the contains filter.
 * `cellValue` supplies the engine's evaluated value for a formula or derived
 * cell (the app passes `engineFor(doc).result`), so a pull may filter on a
 * derived column; without it such cells read as empty for the filter (their
 * mirrored value is the engine's either way). `rowText` is a cache hook:
 * `observePulls` keeps one per source row and drops it when a cell of that
 * row changes, so a keystroke re-reads one row, not the table.
 */
export interface PullReader {
  readonly cellValue?: ((tableId: Id, key: CellKey) => CellValue | null | undefined) | undefined;
  readonly rowText?:
    | ((source: TableMap, record: TableRecord, rowId: Id, compute: () => string) => string)
    | undefined;
}

/** The lower-cased text of every cell in a row, joined, for the contains filter. */
export function sourceRowText(
  source: TableMap,
  record: TableRecord,
  rowId: Id,
  reader: PullReader = {},
): string {
  const cells = cellsMap(source);
  const parts: string[] = [];
  for (const column of record.columns) {
    const key = cellKey(rowId, column.id);
    const content = cells.get(key);
    if (content === undefined) {
      // A derived column's cell is never stored; only the engine knows it.
      if (column.derive !== null) parts.push(evaluatedText(reader.cellValue?.(record.id, key)));
      continue;
    }
    if (isFormula(content)) parts.push(evaluatedText(reader.cellValue?.(record.id, key)));
    else parts.push(cellText(source, rowId, column.id));
  }
  return parts.join('\u0000').toLowerCase();
}

/**
 * Whether a source row is mirrored: every row, unless a filter is set, in
 * which case some cell of the row must contain it (case-insensitive, any
 * column; a formula or derived cell by its evaluated value when the reader
 * can supply one). PRD §14 names only the contains expression, so a blank
 * source cell is mirrored too.
 */
export function rowMatchesPull(
  source: TableMap,
  record: TableRecord,
  rowId: Id,
  spec: PullSpec,
  reader: PullReader = {},
): boolean {
  const needle = spec.filter.trim().toLowerCase();
  if (needle === '') return true;
  const compute = (): string => sourceRowText(source, record, rowId, reader);
  const text =
    reader.rowText === undefined ? compute() : reader.rowText(source, record, rowId, compute);
  return text.includes(needle);
}

/** The source rows a table's pull yields today, in source order. Null without a pull or source. */
export function pullPlan(
  gd: GedeDoc,
  tableId: Id,
  reader: PullReader = {},
): { readonly colId: Id; readonly spec: PullSpec; readonly rows: readonly Id[] } | null {
  const table = gd.tables.get(tableId);
  if (table === undefined) return null;
  const pull = pullOf(table);
  if (pull === null) return null;
  const source = gd.tables.get(pull.spec.tableId);
  if (source === undefined || pull.spec.tableId === tableId) return null;
  const record = tableRecord(source);
  if (!record.columns.some((c) => c.id === pull.spec.colId)) return null;
  const rows: Id[] = [];
  const seen = new Set<Id>();
  for (const rowId of record.rows) {
    if (seen.has(rowId)) continue;
    // A pulled row of the source is not pulled again: provenance stays one hop (ADR-032).
    if (rowMeta(source, rowId).pulledFrom !== null) continue;
    if (!rowMatchesPull(source, record, rowId, pull.spec, reader)) continue;
    seen.add(rowId);
    rows.push(rowId);
  }
  return { colId: pull.colId, spec: pull.spec, rows };
}

/**
 * Bring the table's pulled block in line with its plan. Call inside a
 * transaction. Returns the number of writes made (0 = nothing moved).
 */
function reconcileInTransaction(gd: GedeDoc, tableId: Id, reader: PullReader): number {
  const table = requireTable(gd, tableId);
  const plan = pullPlan(gd, tableId, reader);
  const metas = rowMetaMap(table);
  const cells = cellsMap(table);
  const editor = new RowEditor(rowsArray(table));
  const isPulled = (id: Id): boolean => rowMeta(table, id).pulledFrom !== null;
  const desired = plan?.rows ?? [];
  const desiredSet = new Set(desired);
  let writes = 0;

  // Minimal diff (see rows.ts): the same four steps on every replica settle on the same rows.
  editor.dedupe();
  const removed = editor.remove((id) => isPulled(id) && !desiredSet.has(id));
  for (const id of removed) {
    metas.delete(id);
    const prefix = `${id}:`;
    const doomed: string[] = [];
    cells.forEach((_v, key) => {
      if (key.startsWith(prefix)) doomed.push(key);
    });
    for (const key of doomed) cells.delete(key);
    writes += 1;
  }
  // A missing row goes after the nearest preceding pulled row that exists, else before the
  // nearest following one, else at the end — so the block keeps source order as it fills.
  desired.forEach((id, i) => {
    if (editor.has(id)) return;
    let at = editor.ids.length;
    for (let j = i - 1; j >= 0; j -= 1) {
      const before = editor.indexOf(desired[j] ?? '');
      if (before >= 0) {
        at = before + 1;
        break;
      }
    }
    if (at === editor.ids.length) {
      for (let j = i + 1; j < desired.length; j += 1) {
        const after = editor.indexOf(desired[j] ?? '');
        if (after >= 0) {
          at = after;
          break;
        }
      }
    }
    editor.insertAt(at, id);
  });
  orderMembers(editor, desired);
  // Own rows first, the mirrored block last (ADR-032): a row appended after the block —
  // `addRow` puts a new row at the end — moves up before it, one row at a time.
  const inBlock = (id: Id): boolean => {
    // A row inserted this pass is pulled too; its provenance is written below.
    if (isPulled(id) || desiredSet.has(id)) return true;
    const parent = rowMeta(table, id).splitOf?.rowId;
    return parent !== undefined && (isPulled(parent) || desiredSet.has(parent));
  };
  for (let guard = editor.ids.length; guard > 0; guard -= 1) {
    const first = editor.ids.findIndex(inBlock);
    if (first < 0) break;
    const stray = editor.ids.findIndex((id, i) => i > first && !inBlock(id));
    if (stray < 0) break;
    editor.move(editor.ids[stray] ?? '', first);
  }
  writes += editor.writes;
  if (plan === null) return writes;

  for (const rowId of desired) {
    const meta = rowMetaFor(table, rowId);
    const provenance = readPulledFrom(meta.get('pulledFrom'));
    if (provenance?.tableId !== plan.spec.tableId || provenance.rowId !== rowId) {
      meta.set('pulledFrom', { tableId: plan.spec.tableId, rowId });
      writes += 1;
    }
    const key = cellKey(rowId, plan.colId);
    const source = pulledCellSource(plan.spec, rowId);
    if (cells.get(key) !== source) {
      cells.set(key, source);
      writes += 1;
    }
  }
  return writes;
}

/**
 * Reconcile one table's pull under `origin` (default `REF_ORIGIN`, untracked
 * by undo). Returns the number of writes; transacts only when there are any.
 */
export function reconcilePull(
  gd: GedeDoc,
  tableId: Id,
  origin: unknown = REF_ORIGIN,
  reader: PullReader = {},
): number {
  if (gd.tables.get(tableId) === undefined) return 0;
  let writes = 0;
  gd.doc.transact(() => {
    writes = reconcileInTransaction(gd, tableId, reader);
  }, origin);
  return writes;
}

/** Tables that carry a pull or hold pulled rows, in id order. */
export function tablesWithPulls(gd: GedeDoc): Id[] {
  const out: Id[] = [];
  gd.tables.forEach((table, id) => {
    if (pullOf(table) !== null) {
      out.push(id);
      return;
    }
    // Orphans: an undone pull leaves rows a later reconcile added; they go too.
    const orphaned = [...rowMetaMap(table).values()].some(
      (meta) => readPulledFrom(meta.get('pulledFrom')) !== null,
    );
    if (orphaned) out.push(id);
  });
  return out.sort();
}

/**
 * Reconcile every pull in the document, repeating while a pass changes
 * something (a table that pulls from a table that pulls settles on the
 * second pass). Bounded, so a pathological chain cannot spin.
 */
export function reconcileAllPulls(
  gd: GedeDoc,
  origin: unknown = REF_ORIGIN,
  reader: PullReader = {},
): number {
  let total = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    let writes = 0;
    for (const tableId of tablesWithPulls(gd)) {
      writes += reconcilePull(gd, tableId, origin, reader);
    }
    total += writes;
    if (writes === 0) break;
  }
  return total;
}

/**
 * Bind a pull (REF-02): `colId` in `tableId` mirrors `spec.colId` of
 * `spec.tableId` for the rows whose text contains `spec.filter`. The
 * receiving column renames itself after its source. A table has one pull;
 * binding another replaces it. One transaction — column, label and rows —
 * so one undo step. False when a table or column is missing or the source
 * is the table itself.
 */
export function setPull(
  gd: GedeDoc,
  tableId: Id,
  colId: Id,
  spec: PullSpec,
  reader: PullReader = {},
): boolean {
  const table = gd.tables.get(tableId);
  const source = gd.tables.get(spec.tableId);
  if (table === undefined || source === undefined || spec.tableId === tableId) return false;
  if (!tableRecord(source).columns.some((c) => c.id === spec.colId)) return false;
  const columns = columnsArray(table).toArray();
  const column = columns.find((c) => readString(c, 'id') === colId);
  if (column === undefined) return false;
  const columnSource = readColumnSource(column);
  if (columnSource === 'derived' || columnSource === 'linked') return false;
  gd.doc.transact(() => {
    for (const other of columns) {
      if (other !== column && readColumnSource(other) === 'pulled') {
        other.set('source', 'entered');
        other.delete('pull');
      }
    }
    column.set('source', 'pulled');
    column.set('pull', { tableId: spec.tableId, colId: spec.colId, filter: spec.filter });
    column.set('label', pullLabel(gd, spec));
    reconcileInTransaction(gd, tableId, reader);
  }, gd.origin);
  return true;
}

/** Unbind a table's pull: the mirrored rows go, the column takes typing again. */
export function clearPull(gd: GedeDoc, tableId: Id): boolean {
  const table = gd.tables.get(tableId);
  if (table === undefined) return false;
  const pull = pullOf(table);
  if (pull === null) return false;
  gd.doc.transact(() => {
    const column = columnsArray(table)
      .toArray()
      .find((c) => readString(c, 'id') === pull.colId);
    if (column !== undefined) {
      column.set('source', 'entered');
      column.delete('pull');
    }
    reconcileInTransaction(gd, tableId, {});
  }, gd.origin);
  return true;
}
