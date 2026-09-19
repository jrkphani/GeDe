/**
 * Derived columns (REF-04, PRD §4 "column lineage", §18 Format — Derive).
 *
 * A derived column is `@Source.Method(args)` over every row of one table.
 * The column map stores the spec (`source: 'derived'`, `derive: {…}`); the
 * engine synthesises one bound formula per row from it (`derivedCellSource`)
 * and recomputes on every upstream change through the dependency graph. The
 * column's cells are never written by anyone, so they are read-only in every
 * path (REF-05).
 */
import * as Y from 'yjs';

import { newColumn } from '../doc/mutations.js';
import {
  columnsArray,
  readColumnSource,
  readString,
  tableRecord,
  type ColumnMap,
  deriveArgValues,
  type ColumnRecord,
  type DeriveSpec,
  type GedeDoc,
  type TableMap,
  type TableRecord,
} from '../doc/schema.js';
import { formatMethodCall } from '../formula/methods.js';
import { formatEntitySegment } from '../engine/entities.js';
import type { Id } from '../ids.js';

function transact<T>(gd: GedeDoc, fn: () => T): T {
  let out!: T;
  gd.doc.transact(() => {
    out = fn();
  }, gd.origin);
  return out;
}

function requireTable(gd: GedeDoc, tableId: Id): TableMap {
  const table = gd.tables.get(tableId);
  if (table === undefined) throw new RangeError(`no table ${tableId}`);
  return table;
}

function columnMapOf(table: TableMap, colId: Id): ColumnMap | undefined {
  return columnsArray(table)
    .toArray()
    .find((c) => readString(c, 'id') === colId);
}

/**
 * `@Source.Method(args)` — the signature a derived column shows in its
 * header and the inspector's pipeline list (REF-04). The source is named by
 * its label today, so a rename re-spells it; the stored spec holds the id.
 */
export function deriveSignature(record: TableRecord, spec: DeriveSpec): string {
  const source = record.columns.find((c) => c.id === spec.sourceColId);
  const label = source === undefined ? '#REF' : formatEntitySegment(source.label || '#REF');
  return `@${label}.${formatMethodCall(spec.method, deriveArgValues(spec))}`;
}

/** The derived columns of a table in column order, each with its signature. */
export function derivedColumnsOf(record: TableRecord): readonly {
  readonly column: ColumnRecord;
  readonly spec: DeriveSpec;
  readonly signature: string;
}[] {
  const out: { column: ColumnRecord; spec: DeriveSpec; signature: string }[] = [];
  for (const column of record.columns) {
    if (column.derive === null) continue;
    out.push({ column, spec: column.derive, signature: deriveSignature(record, column.derive) });
  }
  return out;
}

/**
 * The lineage a table shows above its header (REF-04): the span of source
 * columns and the span of the derived pipeline, in column order. Hidden
 * columns take no span. Empty when the table has no derived column.
 */
export interface LineageBand {
  readonly kind: 'source' | 'derived';
  /** Lattice units the band covers. */
  readonly units: number;
  readonly label: string;
}

export function lineageOf(record: TableRecord): readonly LineageBand[] {
  const derived = record.columns.filter((c) => c.derive !== null && !c.hidden);
  if (derived.length === 0) return [];
  const bands: LineageBand[] = [];
  for (const column of record.columns) {
    if (column.hidden) continue;
    const kind: LineageBand['kind'] = column.derive === null ? 'source' : 'derived';
    const last = bands[bands.length - 1];
    if (last?.kind === kind) {
      bands[bands.length - 1] = { ...last, units: last.units + column.width };
    } else {
      bands.push({ kind, units: column.width, label: '' });
    }
  }
  const steps = derived.length;
  return bands.map((band) => ({
    ...band,
    label:
      band.kind === 'source'
        ? `source · ${record.title}`
        : `derived pipeline ▸ ${String(steps)} ${steps === 1 ? 'step' : 'steps'}`,
  }));
}

function specIsValid(record: TableRecord, spec: DeriveSpec, selfId?: Id): boolean {
  const source = record.columns.find((c) => c.id === spec.sourceColId);
  return source !== undefined && source.id !== selfId;
}

/**
 * Add a derived column after `afterColId` (default: the source column, so
 * the pipeline reads left to right), labelled with its signature. Returns
 * the new column id, or null when the source column does not exist. One
 * transaction, one undo step.
 */
export function addDerivedColumn(
  gd: GedeDoc,
  tableId: Id,
  spec: DeriveSpec,
  afterColId?: Id,
): Id | null {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const record = tableRecord(table);
    if (!specIsValid(record, spec)) return null;
    const columns = columnsArray(table);
    const { id, map } = newColumn(deriveSignature(record, spec));
    map.set('source', 'derived');
    map.set('derive', { sourceColId: spec.sourceColId, method: spec.method, args: [...spec.args] });
    const anchor = afterColId ?? spec.sourceColId;
    const after = columns.toArray().findIndex((c) => readString(c, 'id') === anchor);
    columns.insert(after < 0 ? columns.length : after + 1, [map]);
    return id;
  });
}

/**
 * Replace a derived column's spec (the inspector's edit). The label follows
 * the new signature. False when the column is not derived or the spec names
 * a missing source (or itself).
 */
export function setDerivedColumn(gd: GedeDoc, tableId: Id, colId: Id, spec: DeriveSpec): boolean {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const record = tableRecord(table);
    const column = columnMapOf(table, colId);
    if (column === undefined || readString(column, 'source') !== 'derived') return false;
    if (!specIsValid(record, spec, colId)) return false;
    column.set('derive', {
      sourceColId: spec.sourceColId,
      method: spec.method,
      args: [...spec.args],
    });
    column.set('label', deriveSignature(record, spec));
    return true;
  });
}

function refreshInTransaction(table: TableMap): number {
  const record = tableRecord(table);
  let changed = 0;
  for (const column of columnsArray(table).toArray()) {
    if (!(column instanceof Y.Map)) continue;
    const spec = record.columns.find((c) => c.id === readString(column, 'id'))?.derive ?? null;
    if (spec === null) continue;
    const label = deriveSignature(record, spec);
    if (readString(column, 'label') !== label) {
      column.set('label', label);
      changed += 1;
    }
  }
  return changed;
}

/**
 * Re-spell derived labels after a source column was renamed or deleted, so
 * the header keeps naming the source — `@#REF.…` once it is gone (REF-04).
 * Idempotent. `renameColumn` calls it; the grid's delete command calls it.
 */
export function refreshDerivedLabels(gd: GedeDoc, tableId: Id): number {
  return transact(gd, () => refreshInTransaction(requireTable(gd, tableId)));
}

/**
 * Rename a column and re-spell the derived columns that name it, in one
 * transaction (one undo step). Only an entered column can be renamed by
 * hand: a derived column's label is its signature (REF-04), a pulled one's
 * is `↰ Table · Column` (REF-02) and a mapping column's names its target
 * (REF-03) — each is rewritten from its spec, so a typed name would not
 * survive the next reconcile. False when the column is missing or not entered.
 * The label is stored as given; the caller trims and refuses an empty one.
 */
export function renameColumn(gd: GedeDoc, tableId: Id, colId: Id, label: string): boolean {
  return transact(gd, () => {
    const table = requireTable(gd, tableId);
    const column = columnMapOf(table, colId);
    if (column === undefined || readColumnSource(column) !== 'entered') return false;
    if (readString(column, 'label') !== label) column.set('label', label);
    refreshInTransaction(table);
    return true;
  });
}
