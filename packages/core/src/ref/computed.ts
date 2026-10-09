/**
 * Computed columns (SET-08, SET-09, SET-11, SET-12; ADR-056, SPEC §2).
 *
 * One set formula fills a table's rows, one per result element or tuple. It
 * is the third reconciler of the shape pulls (`pull.ts`) and `Split()`
 * children (`split.ts`) already have: the engine evaluates the column's
 * formula once, as the synthetic cell `computedFormulaKey(column)`, and the
 * main thread hands `{ tableId, columnId, items }` (`computedItemsOf`) to
 * `reconcileComputed`, which edits the rows by the minimal diff (`rows.ts`)
 * under `COMPUTED_ORIGIN`, so it is never an undo step.
 *
 * A row's id derives from its key (`computedRowId`), so every replica names
 * the same row the same way and two concurrent reconciles converge. A typed
 * value beside a computed cell lives on that row and follows its key through
 * any reorder (SET-11). A row whose key left the result stays, marked
 * `lostFrom`, while it holds a typed value, and leaves otherwise (SET-12); a
 * key that returns reclaims its row. A refused result (a capped Cross or
 * Power) is not handed off, so the table keeps its rows.
 */
import { rowMetaFor } from '../doc/mutations.js';
import {
  cellsMap,
  cellText,
  columnsArray,
  isFormula,
  readString,
  rowMeta,
  rowMetaMap,
  rowsArray,
  tableRecord,
  textFragment,
  type ColumnRecord,
  type ComputedSpec,
  type GedeDoc,
} from '../doc/schema.js';
import { computedFormulaKey, workbookCellId, type WorkbookCellId } from '../engine/types.js';
import type { CellValue } from '../formula/evaluate.js';
import { parse } from '../formula/parser.js';
import { dedupe } from '../formula/sets.js';
import { cellKey, type Id } from '../ids.js';
import { RowEditor } from './rows.js';
import { deterministicId } from './split.js';

/** Transaction origin of a computed reconcile: never an undo step. */
export const COMPUTED_ORIGIN = 'ref-computed';

/** The row a result key fills in a table: the same on every replica (SPEC §2.2). */
export function computedRowId(tableId: Id, key: string): Id {
  return deterministicId(`${tableId}\u0000${key}`);
}

function computedColumns(columns: readonly ColumnRecord[]): (ColumnRecord & {
  computed: ComputedSpec;
})[] {
  return columns.filter((c): c is ColumnRecord & { computed: ComputedSpec } => c.computed !== null);
}

/**
 * SET-10: make a column computed. Refused (false) while any of its cells holds
 * a typed value, or while another column of the table is computed from a
 * different formula; a computed column's own cells are not typed, so its
 * formula can be replaced. Under the person's origin: it is an undo step.
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
  // One formula per table (spread columns share it): a second formula would never be filled.
  const other = tableRecord(table).columns.find(
    (c) => c.id !== colId && c.computed !== null && c.computed.formula !== spec.formula,
  );
  if (other !== undefined) return false;
  if (column.get('source') !== 'computed') {
    const typed = rowsArray(table)
      .toArray()
      .some((rowId) => cellText(table, rowId, colId) !== '');
    if (typed) return false;
  }
  gd.doc.transact(() => {
    column.set('source', 'computed');
    column.set('computed', { ...spec });
    column.delete('derive');
    column.delete('link');
    column.delete('pull');
  }, gd.origin);
  return true;
}

/** What the engine hands the main thread for one computed table (SPEC §2.4). */
export interface ComputedItems {
  readonly tableId: Id;
  readonly columnId: Id;
  readonly items: readonly string[];
  /** A `Cross` tuple's members by its key, for a spread column (SET-09). */
  readonly members: ReadonlyMap<string, readonly string[]>;
}

/**
 * The result of every computed table's formula as the engine evaluated it.
 * A table still evaluating, or whose formula was refused or yields no set,
 * is left out, so its rows stay as they are.
 */
export function computedItemsOf(
  gd: GedeDoc,
  resultOf: (
    cellId: WorkbookCellId,
  ) => { readonly value: CellValue | null; readonly error: unknown } | undefined,
): ComputedItems[] {
  const out: ComputedItems[] = [];
  gd.tables.forEach((table, tableId) => {
    const [driver] = computedColumns(tableRecord(table).columns);
    if (driver === undefined) return;
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

/**
 * A tuple's members, `(a, (1, 2), c)` → `a`, `(1, 2)`, `c`: split at top-level
 * commas, kept in position (a member may repeat). Anything not a tuple is one
 * member. The fallback when no members came with the key (a tuple that passed
 * through Union, or a restored row): a member with an unbalanced bracket
 * cannot be split back from the rendering, which is why `Cross` carries them.
 */
export function tupleMembers(key: string): string[] {
  if (!key.startsWith('(') || !key.endsWith(')')) return [key];
  const inner = key.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '(' || ch === '{') depth += 1;
    else if ((ch === ')' || ch === '}') && depth > 0) depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return out;
}

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
    const record = tableRecord(table);
    const computed = computedColumns(record.columns);
    const [driver] = computed;
    if (driver === undefined) return;
    const keys = dedupe(result);
    const wanted = keys.map((key) => computedRowId(tableId, key));
    const wantedSet = new Set(wanted);
    // Only what a person typed holds a lost row (SET-12): a pulled or linked value does not.
    const entered = record.columns.filter((c) => c.source === 'entered');
    const metas = rowMetaMap(table);
    const cells = cellsMap(table);
    const editor = new RowEditor(rowsArray(table));
    const keyOf = (id: Id): string | null => rowMeta(table, id).computedKey;
    const isLost = (id: Id): boolean => !wantedSet.has(id) && keyOf(id) !== null;
    const typed = (id: Id): boolean => entered.some((c) => cellText(table, id, c.id) !== '');

    editor.dedupe();
    // A removed row keeps its meta (its key): a note typed on it concurrently, or redone
    // after it went, brings the row back as lost on every replica alike (same id, SET-12).
    // ponytail: one small meta per key that ever left; compact on snapshot if it matters.
    for (const [id, meta] of metas) {
      if (typeof meta.get('computedKey') === 'string' && !editor.has(id) && typed(id)) {
        editor.insertAt(editor.ids.length, id);
      }
    }
    // A key that left: gone without a trace unless the row holds something typed (SET-12).
    for (const id of editor.remove((id) => isLost(id) && !typed(id))) {
      metas.get(id)?.delete('lostFrom');
      for (const c of record.columns) cells.delete(cellKey(id, c.id));
      writes += 1;
    }
    const lost: [Id, string][] = [];
    for (const id of editor.ids) {
      if (!isLost(id)) continue;
      lost.push([id, keyOf(id) ?? '']);
      const meta = rowMetaFor(table, id);
      if (meta.get('lostFrom') !== driver.id) {
        meta.set('lostFrom', driver.id);
        writes += 1;
      }
    }
    // Result order among the computed rows; lost and hand-added rows keep their places.
    editor.arrange(wanted);
    writes += editor.writes;

    /** The computed cells of row `id` read `key` (a lost row keeps showing its key). */
    const fill = (id: Id, key: string): void => {
      const parts = members.get(key) ?? tupleMembers(key);
      for (const column of computed) {
        if (column.computed.formula !== driver.computed.formula) continue;
        const text =
          column.computed.shape === 'spread'
            ? (parts[column.computed.spreadIndex ?? 0] ?? '')
            : key;
        const cell = cellKey(id, column.id);
        const content = cells.get(cell);
        if (
          content === undefined ||
          isFormula(content) ||
          cellText(table, id, column.id) !== text
        ) {
          cells.set(cell, textFragment(text));
          writes += 1;
        }
      }
    };
    keys.forEach((key, i) => {
      const id = wanted[i] ?? '';
      const meta = rowMetaFor(table, id);
      if (meta.get('computedKey') !== key) {
        meta.set('computedKey', key);
        writes += 1;
      }
      if (meta.has('lostFrom')) {
        meta.delete('lostFrom');
        writes += 1;
      }
      fill(id, key);
    });
    for (const [id, key] of lost) fill(id, key);
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
