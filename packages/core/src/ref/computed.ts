/**
 * Computed columns (SET-08, SET-09, SET-11, SET-12; ADR-056, SPEC §2).
 *
 * One set formula fills a table's rows, one per result element or tuple. It
 * is the third reconciler of the shape pulls (`pull.ts`) and `Split()`
 * children (`split.ts`) already have: the engine evaluates the table's one
 * formula once, as the synthetic cell `computedFormulaKey(driver)` of its
 * first computed column, and the main thread hands `{ tableId, items,
 * members }` (`computedItemsOf`) to `reconcileComputed`, which edits the rows
 * by the minimal diff (`rows.ts`) under `COMPUTED_ORIGIN`, so it is never an undo step.
 *
 * A row's id derives from its key (`computedRowId`), so every replica names
 * the same row the same way and two concurrent reconciles converge. A typed
 * value beside a computed cell lives on that row and follows its key through
 * any reorder (SET-11). A row whose key left the result stays, marked
 * `lostFrom`, while it holds a typed value, and leaves otherwise (SET-12); a
 * key that returns reclaims its row. A refused result (a capped Cross or
 * Power, an error, no formula) is handed off with no items: the table keeps its
 * rows, which are only kept sound (deduped, a removed typed row brought back).
 * A computed row cannot be deleted by a person (`deleteRow` refuses it, ADR-056
 * ruling c); changing the formula is how it goes.
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

import { addColumn, deleteColumn, rowMetaFor } from '../doc/mutations.js';
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
import { cellKey, newId, type Id } from '../ids.js';
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

/**
 * Table key: every row id the reconciler has given a key, with that key. A row and its
 * meta deleted by an older client while another replica re-inserted it leaves the row
 * with no meta; this record gives it its key back so it is reconciled like any other.
 * ponytail: one entry per key ever filled, dropped only when the table stops being
 * computed; prune keys with no row and no meta on snapshot if documents grow.
 */
const KEYS = 'computedIds';

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
 * Known limit (Yjs map undo): undoing a change that won a concurrent change restores
 * neither the losing value nor the previous one, so both replicas converge on no formula;
 * the columns stay computed and the rows stay put until a formula is typed again.
 */
export function setTableFormula(gd: GedeDoc, tableId: Id, formula: string): boolean {
  const table = gd.tables.get(tableId);
  if (table === undefined || !isSetFormula(formula)) return false;
  gd.doc.transact(() => {
    table.set('computedFormula', formula);
    refitSpread(gd, tableId, table, spreadWidth(formula));
  }, gd.origin);
  return true;
}

/**
 * The number of sets a top-level `Cross` multiplies, or null for any other formula — and
 * for a `Cross` of the wrong arity (fewer than two sets), which evaluates to an error and
 * so reconciles nothing (SPEC §2.4): the spread is not re-fitted to it.
 */
function spreadWidth(formula: string | null): number | null {
  if (formula === null) return null;
  const parsed = parse(formula);
  return parsed.ok &&
    parsed.value.kind === 'call' &&
    parsed.value.name === 'Cross' &&
    parsed.value.args.length >= 2
    ? parsed.value.args.length
    : null;
}

/** A table's spread member columns, in column order. */
function spreadColumns(table: TableMap): (ColumnRecord & { computed: ComputedSpec })[] {
  return computedColumns(tableRecord(table).columns).filter((c) => c.computed.shape === 'spread');
}

/**
 * SET-09 ruling (b): a spread table has one member column per set of its `Cross`. A
 * member past the width, or a second column for the same member (two replicas growing
 * the spread at once), goes; a missing member is added after the last one, in the
 * spread's Fill step, under an id derived from that step and its index, so replicas
 * adding the same member at once (or a merge of a widen with a narrow) converge on one
 * column. Typed neighbour columns are never touched. Returns writes.
 */
function refitSpread(gd: GedeDoc, tableId: Id, table: TableMap, width: number | null): number {
  const spread = spreadColumns(table);
  if (spread.length === 0 || width === null) return 0;
  let writes = 0;
  const fill = spread[0]?.computed.fill ?? newId();
  const derived = (index: number): Id =>
    deterministicId(`${tableId}\u0000${fill}\u0000${String(index)}`);
  /**
   * Member index → the column kept for it: a column a person filled wins over one this
   * re-fit added (a spread Fill made one column at a time keeps the person's column), then
   * column order. Both are the same on every replica, so replicas keep the same column.
   */
  const keep = new Map<number, ColumnRecord>();
  for (const c of spread) {
    const index = c.computed.spreadIndex ?? 0;
    const held = keep.get(index);
    if (index < width && (held === undefined || (held.id === derived(index) && c.id !== held.id))) {
      keep.set(index, c);
    }
  }
  // By record, not id: replicas adding the same member at once leave two columns with its id.
  const keptRecords = new Set(keep.values());
  for (const c of spread) {
    if (!keptRecords.has(c)) writes += deleteColumn(gd, tableId, c.id) ? 1 : 0;
  }
  const kept = new Map([...keep].map(([index, c]) => [index, c.id]));
  for (let index = 0; index < width; index += 1) {
    if (kept.has(index)) continue;
    // Beside its neighbouring member, so member order is column order whatever merged.
    const below = [...kept.keys()].filter((i) => i < index);
    const above = [...kept.keys()].filter((i) => i > index);
    const id = addColumn(gd, tableId, {
      label: `x${String(index + 1)}`,
      afterColId: below.length > 0 ? kept.get(Math.max(...below)) : undefined,
      beforeColId:
        below.length === 0 && above.length > 0 ? kept.get(Math.min(...above)) : undefined,
      id: derived(index),
    });
    kept.set(index, id);
    const map = columnsArray(table)
      .toArray()
      .find((c) => readString(c, 'id') === id);
    map?.set('source', 'computed');
    map?.set('computed', { shape: 'spread', spreadIndex: index, fill });
    writes += 1;
  }
  return writes;
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
  return setComputedColumns(gd, tableId, [{ colId, spec }]);
}

/**
 * SET-09, SET-10: one Fill column step over several columns (a spread Fill's member
 * columns): all of them or none, as one undo step. The step's id is stamped on each
 * column, so a refusal after a merge reverts this step's columns together and no other.
 */
export function setComputedColumns(
  gd: GedeDoc,
  tableId: Id,
  columns: readonly { readonly colId: Id; readonly spec: ComputedSpec }[],
): boolean {
  const table = gd.tables.get(tableId);
  if (table === undefined || columns.length === 0) return false;
  const maps = columnsArray(table).toArray();
  const targets = columns.map(({ colId, spec }) => ({
    spec,
    map: maps.find((c) => readString(c, 'id') === colId),
  }));
  const rows = rowsArray(table).toArray();
  for (const { map } of targets) {
    if (map === undefined) return false;
    const colId = readString(map, 'id');
    if (map.get('source') !== 'computed' && rows.some((r) => cellText(table, r, colId) !== '')) {
      return false;
    }
  }
  // A spread is one unit, however many steps made it: a spread column joins the table's
  // spread Fill, so a refusal after a merge reverts the whole spread (SET-09, SET-10).
  const spreadFill = spreadColumns(table)[0]?.computed.fill;
  const fill =
    spreadFill !== undefined && columns.every(({ spec }) => spec.shape === 'spread')
      ? spreadFill
      : newId();
  gd.doc.transact(() => {
    for (const { map, spec } of targets) {
      if (map === undefined) continue;
      map.set('source', 'computed');
      map.set('computed', { ...spec, fill });
      map.delete(REFUSED);
      map.delete('derive');
      map.delete('link');
      map.delete('pull');
    }
  }, gd.origin);
  return true;
}

/** What the engine hands the main thread for one computed table (SPEC §2.4). */
export interface ComputedItems {
  readonly tableId: Id;
  /**
   * The result's keys, or null when there is no result to fill from (still evaluating,
   * refused, or no formula): the reconciler then only keeps the rows sound — duplicates
   * dropped, a Fill that met typed text refused, a removed row holding typed text back.
   */
  readonly items: readonly string[] | null;
  /** A `Cross` tuple's members by its key, for a spread column (SET-09). */
  readonly members: ReadonlyMap<string, readonly string[]>;
}

/**
 * The result of every computed table's formula as the engine evaluated it.
 * A table still evaluating, or whose formula was refused or yields no set,
 * is handed off with no items, so its rows stay as they are (SPEC §2.4) but are
 * still kept sound (`ComputedItems.items`). A table that has computed rows
 * but no computed column any more (an undo of Fill column) is handed off with
 * no column and no items, so the reconciler clears the computed rows it left.
 * `only` limits the hand-off to those tables (the ones a transaction touched).
 */
export function computedItemsOf(
  gd: GedeDoc,
  resultOf: (
    cellId: WorkbookCellId,
  ) => { readonly value: CellValue | null; readonly error: unknown } | undefined,
  only?: ReadonlySet<Id>,
): ComputedItems[] {
  const out: ComputedItems[] = [];
  gd.tables.forEach((table, tableId) => {
    if (only !== undefined && !only.has(tableId)) return;
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
      // A row the reconciler keyed, left with no meta by an older client's delete.
      const keyed = table.get(KEYS);
      if (!leftover && keyed instanceof Y.Map) {
        leftover = [...keyed.keys()].some(
          (id) => rows.has(id) && rowMeta(table, id).computedKey === null,
        );
      }
      if (leftover) out.push({ tableId, items: [], members: new Map() });
      return;
    }
    const result = resultOf(workbookCellId(tableId, computedFormulaKey(driver.id)));
    const value = result?.error === null ? result.value : undefined;
    const items: string[] = [];
    const members = new Map<string, readonly string[]>();
    if (value?.kind === 'list') {
      for (const item of value.items) {
        if (item.kind !== 'text') continue;
        items.push(item.text);
        if (item.members !== undefined) members.set(item.text, item.members);
      }
    } else if (value === undefined || (value !== null && value.kind !== 'blank')) {
      out.push({ tableId, items: null, members });
      return;
    }
    out.push({ tableId, items, members });
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
  result: readonly string[] | null,
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

    // A row the reconciler keyed that has no key now lost its meta to an older client's
    // delete merged with a re-insert (ADR-056 ruling c): it gets its key back, and is then
    // kept, labelled or removed like any computed row.
    const known = table.get(KEYS);
    const keyed = known instanceof Y.Map ? (known as Y.Map<unknown>) : null;
    for (const id of keyed === null ? [] : editor.ids) {
      const key = keyed?.get(id);
      if (typeof key !== 'string' || keyOf(id) !== null) continue;
      rowMetaFor(table, id).set('computedKey', key);
      writes += 1;
    }

    // SET-10 after a merge: a column made computed while another replica typed into it is
    // refused here, as it would have been locally. Nothing computed is ever stored, so
    // anything stored under a computed column's key is a person's — on a removed row too,
    // which then comes back below. A spread Fill column makes its member columns computed
    // in one step (`setComputedColumns`), so that step's columns are refused as one unit:
    // never half of a tuple (SET-09), and never an earlier step's columns.
    let record = tableRecord(table);
    const candidates = [...editor.ids, ...metas.keys()];
    const filled = computedColumns(record.columns);
    const typedInto = filled.filter((c) =>
      candidates.some((id) => storedText(table, id, c.id) !== ''),
    );
    if (typedInto.length > 0) {
      const refused = new Set(typedInto.map((c) => c.id));
      const steps = new Set(typedInto.map((c) => c.computed.fill).filter((f) => f !== undefined));
      const all = new Set(
        filled
          .filter(
            (c) =>
              refused.has(c.id) || (c.computed.fill !== undefined && steps.has(c.computed.fill)),
          )
          .map((c) => c.id),
      );
      for (const map of columnsArray(table).toArray()) {
        const id = readString(map, 'id');
        if (!all.has(id)) continue;
        map.set('source', 'entered');
        map.delete('computed');
        // The flag names the column that held the typed value: that is the one announced.
        if (refused.has(id)) map.set(REFUSED, true);
        writes += 1;
      }
    }
    // SET-09 after a merge: two replicas re-fitting the spread at once leave a member twice,
    // or (a widen merged with a narrow) none at all.
    writes += refitSpread(gd, tableId, table, spreadWidth(record.computedFormula));
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
    // ponytail: one small meta per key that ever left, plus whatever (empty) cells the row
    // kept: they are not deleted with the row, since an edit inside one would be lost, and
    // the grid's orphan sweep skips them (`orphanCellKeys`). Compact on snapshot if it matters.
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
        // With no result to say otherwise, it is back because its key left: it says so.
        if (driver !== undefined && result === null && meta.get('lostFrom') !== driver.id) {
          meta.set('lostFrom', driver.id);
          writes += 1;
        }
      }
    }

    // No result to fill from: the rows stay as they are (SPEC §2.4), except a lost row
    // whose typed values were cleared, which leaves (SET-12): its key left the result
    // already, and a key that returns brings it back under the same id.
    if (driver !== undefined && result === null) {
      removeWhere((id) => metas.get(id)?.has('lostFrom') === true && !typed(id));
      writes += editor.writes;
      return;
    }

    if (driver === undefined) {
      // No computed column left: the rows it filled go unless they hold a typed value; those
      // stay as plain rows.
      removeWhere((id) => keyOf(id) !== null && !typed(id));
      for (const id of editor.ids) {
        const meta = metas.get(id);
        if (meta?.has('computedKey') !== true) continue;
        keyed?.delete(id);
        meta.delete('computedKey');
        meta.delete('lostFrom');
        meta.delete(MEMBERS);
        writes += 1;
      }
      writes += editor.writes;
      return;
    }

    const keys = dedupe(result ?? []);
    const wanted = keys.map((key) => computedRowId(tableId, key));
    const wantedSet = new Set(wanted);
    const isLost = (id: Id): boolean => !wantedSet.has(id) && keyOf(id) !== null;
    if (table.get(FILLED) !== true) {
      table.set(FILLED, true);
      writes += 1;
    }
    const keysById = keyed ?? new Y.Map<unknown>();
    if (keyed === null) {
      table.set(KEYS, keysById);
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
      const id = wanted[i] ?? '';
      const meta = rowMetaFor(table, id);
      if (meta.get('computedKey') !== key) {
        meta.set('computedKey', key);
        writes += 1;
      }
      if (keysById.get(id) !== key) {
        keysById.set(id, key);
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
