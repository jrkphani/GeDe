/**
 * Computed columns (SET-08, SET-09, SET-11, SET-12; ADR-056, SPEC §2).
 *
 * One set formula fills a table's rows, one per result element or tuple. It
 * is the third reconciler of the shape pulls (`pull.ts`) and `Split()`
 * children (`split.ts`) already have: the engine evaluates the table's one
 * formula once, as the synthetic cell `computedFormulaKey(driver)` of its
 * first computed column, and the main thread hands `{ tableId, columnId,
 * items }` (`computedItemsOf`) to `reconcileComputed`, which edits the rows
 * by the minimal diff (`rows.ts`) under `COMPUTED_ORIGIN`, so it is never an undo step.
 *
 * A row's id derives from its key (`computedRowId`), so every replica names
 * the same row the same way and two concurrent reconciles converge. A typed
 * value beside a computed cell lives on that row and follows its key through
 * any reorder (SET-11). A row whose key left the result stays, marked
 * `lostFrom`, while it holds a typed value, and leaves otherwise (SET-12); a
 * key that returns reclaims its row. A refused result (a capped Cross or
 * Power) is not handed off, so the table keeps its rows.
 *
 * The reconciler writes rows only — ids, order, `computedKey`, `lostFrom` and,
 * where a key's text cannot be split back, its tuple members — never cell
 * text. A computed cell's value is projected at read time from its row's
 * provenance (`computedCellText`, doc/schema.ts), so computed text and a
 * person's text never share a cell key: a value typed under a computed
 * column's key (concurrently with Fill column) stays in the document, hidden
 * while the column is computed, and the column is refused after the merge as
 * it would have been locally (SET-10).
 */
import * as Y from 'yjs';

import { rowMetaFor } from '../doc/mutations.js';
import {
  cellsMap,
  cellText,
  columnsArray,
  fragmentText,
  isFormula,
  readString,
  rowMeta,
  rowMetaMap,
  rowsArray,
  tableRecord,
  tupleMembers,
  type ColumnRecord,
  type ComputedSpec,
  type GedeDoc,
  type TableMap,
  type TableRecord,
} from '../doc/schema.js';
import { computedFormulaKey, workbookCellId, type WorkbookCellId } from '../engine/types.js';
import type { CellValue } from '../formula/evaluate.js';
import { isSetFunctionName } from '../formula/ast.js';
import { parse } from '../formula/parser.js';
import { dedupe } from '../formula/sets.js';
import { cellKey, type Id } from '../ids.js';
import { RowEditor } from './rows.js';
import { deterministicId } from './split.js';

/** Transaction origin of a computed reconcile: never an undo step. */
export const COMPUTED_ORIGIN = 'ref-computed';

/**
 * Row-meta key, internal to this reconciler: the row a computed row followed
 * when it was removed ('' at the top), so a concurrently typed note brings it
 * back to its place rather than to the end (SPEC §2.3).
 */
const AFTER = 'computedAfter';

/** Row-meta key: a tuple key's members, stored only when `tupleMembers` cannot split the key back. */
const MEMBERS = 'computedMembers';

/**
 * Table key: the reconciler has filled this table's rows at least once, so a table with
 * no computed column left may still hold computed rows to clear (`computedItemsOf`).
 */
const FILLED = 'computedRows';

/** Column key: set when a Fill column was refused after a merge (`observeRefusedFills`). */
const REFUSED = 'fillRefused';

/** The row a result key fills in a table: the same on every replica (SPEC §2.2). */
export function computedRowId(tableId: Id, key: string): Id {
  return deterministicId(`${tableId}\u0000${key}`);
}

/** What the cells map stores under a cell, whatever the column: '' when nothing. */
function storedText(table: TableMap, rowId: Id, colId: Id): string {
  const value = cellsMap(table).get(cellKey(rowId, colId));
  if (value === undefined) return '';
  return isFormula(value) ? value : fragmentText(value);
}

/**
 * Whether a row holds something a person typed or picked (SET-11, SET-12): an entered
 * value or a mapping pick (REF-03). A pulled value does not.
 */
function holdsTyped(table: TableMap, record: TableRecord, rowId: Id): boolean {
  return record.columns.some(
    (c) =>
      (c.source === 'entered' || c.source === 'linked') && storedText(table, rowId, c.id) !== '',
  );
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function computedColumns(columns: readonly ColumnRecord[]): (ColumnRecord & {
  computed: ComputedSpec;
})[] {
  return columns.filter((c): c is ColumnRecord & { computed: ComputedSpec } => c.computed !== null);
}

/**
 * SET-08: the table's one computed formula. Stored once on the table, so this
 * one mutation re-points every computed column at once and two people
 * changing it concurrently converge on one formula (the later write wins).
 * Under the person's origin: it is an undo step.
 */
export function setTableFormula(gd: GedeDoc, tableId: Id, formula: string): boolean {
  const table = gd.tables.get(tableId);
  if (table === undefined || !isSetFormula(formula)) return false;
  gd.doc.transact(() => {
    table.set('computedFormula', formula);
  }, gd.origin);
  return true;
}

/**
 * Whether `formula` can fill a table: its top-level call is a set operator. Text, a
 * number or any other call yields no set and would leave the table silently unfilled;
 * a wrong argument count is still accepted, since it evaluates to an error the
 * column header shows (SPEC §2.4).
 */
function isSetFormula(formula: string): boolean {
  if (!formula.startsWith('=')) return false;
  const parsed = parse(formula);
  return parsed.ok && parsed.value.kind === 'call' && isSetFunctionName(parsed.value.name);
}

/**
 * SET-10: make a column computed in `spec`'s role; it fills from the table's
 * formula (`setTableFormula`). Refused (false) while any of its cells holds a
 * typed value; a computed column's own cells are not typed, so its role can
 * be changed. Under the person's origin: it is an undo step.
 */
export function setComputedColumn(
  gd: GedeDoc,
  tableId: Id,
  colId: Id,
  spec: ComputedSpec,
): boolean {
  const table = gd.tables.get(tableId);
  if (table === undefined) return false;
  const column = columnsArray(table)
    .toArray()
    .find((c) => readString(c, 'id') === colId);
  if (column === undefined) return false;
  if (column.get('source') !== 'computed') {
    const typed = rowsArray(table)
      .toArray()
      .some((rowId) => cellText(table, rowId, colId) !== '');
    if (typed) return false;
  }
  gd.doc.transact(() => {
    column.set('source', 'computed');
    column.set('computed', { ...spec });
    column.delete(REFUSED);
    column.delete('derive');
    column.delete('link');
    column.delete('pull');
  }, gd.origin);
  return true;
}

/** What the engine hands the main thread for one computed table (SPEC §2.4). */
export interface ComputedItems {
  readonly tableId: Id;
  /** The column the formula is evaluated as; null when the table has none left. */
  readonly columnId: Id | null;
  readonly items: readonly string[];
  /** A `Cross` tuple's members by its key, for a spread column (SET-09). */
  readonly members: ReadonlyMap<string, readonly string[]>;
}

/**
 * The result of every computed table's formula as the engine evaluated it.
 * A table still evaluating, or whose formula was refused or yields no set,
 * is left out, so its rows stay as they are. A table that has computed rows
 * but no computed column any more (an undo of Fill column) is handed off with
 * no column and no items, so the reconciler clears the computed rows it left.
 */
export function computedItemsOf(
  gd: GedeDoc,
  resultOf: (
    cellId: WorkbookCellId,
  ) => { readonly value: CellValue | null; readonly error: unknown } | undefined,
): ComputedItems[] {
  const out: ComputedItems[] = [];
  gd.tables.forEach((table, tableId) => {
    const record = tableRecord(table);
    const [driver] = computedColumns(record.columns);
    if (driver === undefined) {
      // A table never filled costs nothing. One that was is left over while a computed row
      // is still in it, or a removed one holds a typed value (a note typed concurrently, SET-12).
      // ponytail: a scan of a once-computed table's row metas per hand-off.
      if (table.get(FILLED) !== true) return;
      const rows = new Set(record.rows);
      // Two replicas restoring the same row at once leave it twice until a pass dedupes it.
      let leftover = rows.size !== record.rows.length;
      for (const [id, meta] of leftover ? [] : rowMetaMap(table)) {
        if (typeof meta.get('computedKey') !== 'string') continue;
        if (rows.has(id) || holdsTyped(table, record, id)) {
          leftover = true;
          break;
        }
      }
      if (leftover) out.push({ tableId, columnId: null, items: [], members: new Map() });
      return;
    }
    const result = resultOf(workbookCellId(tableId, computedFormulaKey(driver.id)));
    if (result?.error !== null) return;
    const value = result.value;
    const items: string[] = [];
    const members = new Map<string, readonly string[]>();
    if (value !== null && value.kind === 'list') {
      for (const item of value.items) {
        if (item.kind !== 'text') continue;
        items.push(item.text);
        if (item.members !== undefined) members.set(item.text, item.members);
      }
    } else if (value !== null && value.kind !== 'blank') return;
    out.push({ tableId, columnId: driver.id, items, members });
  });
  return out;
}

export { tupleMembers };

/**
 * Fill one computed table's rows from its formula's result (SPEC §2.3).
 * `members` gives a tuple key's members for a spread column (`computedItemsOf`).
 * Returns the number of writes; nothing is transacted when nothing moved.
 */
export function reconcileComputed(
  gd: GedeDoc,
  tableId: Id,
  result: readonly string[],
  members: ReadonlyMap<string, readonly string[]> = new Map(),
  origin: unknown = COMPUTED_ORIGIN,
): number {
  const table = gd.tables.get(tableId);
  if (table === undefined) return 0;
  let writes = 0;
  gd.doc.transact(() => {
    const metas = rowMetaMap(table);
    const editor = new RowEditor(rowsArray(table));
    const keyOf = (id: Id): string | null => rowMeta(table, id).computedKey;
    editor.dedupe();

    // SET-10 after a merge: a column made computed while another replica typed into it is
    // refused here, as it would have been locally. Nothing computed is ever stored, so
    // anything stored under a computed column's key is a person's — on a removed row too,
    // which then comes back below.
    let record = tableRecord(table);
    const columnMaps = columnsArray(table).toArray();
    const candidates = [...editor.ids, ...metas.keys()];
    for (const column of computedColumns(record.columns)) {
      if (!candidates.some((id) => storedText(table, id, column.id) !== '')) continue;
      const map = columnMaps.find((c) => readString(c, 'id') === column.id);
      map?.set('source', 'entered');
      map?.delete('computed');
      map?.set(REFUSED, true);
      writes += 1;
    }
    if (writes > 0) record = tableRecord(table);
    const [driver] = computedColumns(record.columns);

    const typed = (id: Id): boolean => holdsTyped(table, record, id);
    /** Rows matching `doomed` go; each remembers the row it followed, to come back there. */
    const removeWhere = (doomed: (id: Id) => boolean): void => {
      let previous = '';
      for (const id of editor.ids) {
        if (!doomed(id)) previous = id;
        else if (metas.get(id)?.get(AFTER) !== previous) rowMetaFor(table, id).set(AFTER, previous);
      }
      for (const id of editor.remove(doomed)) {
        const meta = metas.get(id);
        if (meta?.has('lostFrom') !== true) continue;
        meta.delete('lostFrom');
        writes += 1;
      }
    };

    // A removed row keeps its meta (its key): a note typed on it concurrently, or redone
    // after it went, brings the row back on every replica alike (same id, SET-12) — as a
    // lost row while the table is computed, as a plain row once it is not.
    // ponytail: one small meta per key that ever left; compact on snapshot if it matters.
    for (const [id, meta] of metas) {
      if (typeof meta.get('computedKey') === 'string' && !editor.has(id) && typed(id)) {
        const after = meta.get(AFTER);
        const at =
          after === ''
            ? 0
            : typeof after === 'string' && editor.has(after)
              ? editor.indexOf(after) + 1
              : editor.ids.length;
        editor.insertAt(at, id);
      }
    }

    if (driver === undefined) {
      // No computed column left: the rows it filled go unless they hold a typed value; those
      // stay as plain rows.
      removeWhere((id) => keyOf(id) !== null && !typed(id));
      for (const id of editor.ids) {
        const meta = metas.get(id);
        if (meta?.has('computedKey') !== true) continue;
        meta.delete('computedKey');
        meta.delete('lostFrom');
        meta.delete(MEMBERS);
        writes += 1;
      }
      writes += editor.writes;
      return;
    }

    const keys = dedupe(result);
    const wanted = keys.map((key) => computedRowId(tableId, key));
    const wantedSet = new Set(wanted);
    const isLost = (id: Id): boolean => !wantedSet.has(id) && keyOf(id) !== null;
    if (table.get(FILLED) !== true) {
      table.set(FILLED, true);
      writes += 1;
    }

    // A key that left: gone without a trace unless the row holds something typed (SET-12).
    // A lost row keeps its key and members, so its computed cells still show them.
    removeWhere((id) => isLost(id) && !typed(id));
    for (const id of editor.ids) {
      if (!isLost(id)) continue;
      const meta = rowMetaFor(table, id);
      if (meta.get('lostFrom') !== driver.id) {
        meta.set('lostFrom', driver.id);
        writes += 1;
      }
    }
    // Result order among the computed rows; lost and hand-added rows keep their places.
    editor.arrange(wanted);
    writes += editor.writes;

    keys.forEach((key, i) => {
      const meta = rowMetaFor(table, wanted[i] ?? '');
      if (meta.get('computedKey') !== key) {
        meta.set('computedKey', key);
        writes += 1;
      }
      if (meta.has('lostFrom')) {
        meta.delete('lostFrom');
        writes += 1;
      }
      // SET-09: members only where the key cannot be split back (a member with an
      // unbalanced bracket); the same on every replica, since they follow from the key.
      const given = members.get(key);
      if (given === undefined) return;
      const stored: unknown = meta.get(MEMBERS);
      if (sameList(given, tupleMembers(key))) {
        if (stored !== undefined) {
          meta.delete(MEMBERS);
          writes += 1;
        }
      } else if (!Array.isArray(stored) || !sameList(stored, given)) {
        meta.set(MEMBERS, [...given]);
        writes += 1;
      }
    });
  }, origin);
  return writes;
}

const OPERATORS: Readonly<Record<string, string>> = {
  Union: ' ∪ ',
  Inter: ' ∩ ',
  Diff: ' ∖ ',
  Cross: ' × ',
};

/**
 * The operands of a computed column's formula, as SET-12's label reads them
 * ("no longer in E × C"): `=Cross(@E, @C)` → `E × C`. Takes the formula as
 * displayed (projected), so operands read as a person typed them; an `@`
 * path drops its sigil. Anything else reads as the formula without its `=`.
 */
export function computedOperandsLabel(displayFormula: string): string {
  const plain = displayFormula.replace(/^=/, '');
  const parsed = parse(displayFormula);
  if (!parsed.ok || parsed.value.kind !== 'call') return plain;
  const { name, args } = parsed.value;
  const text = args.map((arg) =>
    arg.kind === 'entity' ? arg.path.join('.') : displayFormula.slice(arg.span.start, arg.span.end),
  );
  const op = OPERATORS[name];
  if (op !== undefined) return text.join(op);
  if (name === 'Comp' && text.length === 2) return `${text[1] ?? ''} ∖ ${text[0] ?? ''}`;
  if (name === 'Power' && text.length === 1) return `𝒫(${text[0] ?? ''})`;
  return plain;
}

/**
 * SET-10 after a merge: `onRefused(tableId, colId)` once on each replica when a Fill
 * column is refused because a cell of the column holds a typed value (the reconciler
 * sets the column back to entered, here or on another replica). Returns the stop.
 */
export function observeRefusedFills(
  gd: GedeDoc,
  onRefused: (tableId: Id, colId: Id) => void,
): () => void {
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    for (const event of events) {
      const column = event.target;
      if (!(column instanceof Y.Map) || event.changes.keys.get(REFUSED)?.action !== 'add') continue;
      const table = column.parent?.parent;
      if (!(table instanceof Y.Map) || table.parent !== gd.tables) continue;
      onRefused(readString(table as Y.Map<unknown>, 'id'), readString(column, 'id'));
    }
  };
  gd.tables.observeDeep(observer);
  return () => {
    gd.tables.unobserveDeep(observer);
  };
}
