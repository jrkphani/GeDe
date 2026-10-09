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
import { orderMembers, RowEditor } from './rows.js';
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
 * a typed value; a computed column's own cells are not typed, so its formula
 * can be replaced. Under the person's origin: it is an undo step.
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
    let items: string[];
    if (value === null || value.kind === 'blank') items = [];
    else if (value.kind === 'list') {
      items = value.items.flatMap((item) => (item.kind === 'text' ? [item.text] : []));
    } else return;
    out.push({ tableId, columnId: driver.id, items });
  });
  return out;
}

/**
 * A tuple's members, `(a, (1, 2), c)` → `a`, `(1, 2)`, `c`: split at top-level
 * commas, kept in position (a member may repeat). Anything not a tuple is one member.
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
 * Returns the number of writes; nothing is transacted when nothing moved.
 */
export function reconcileComputed(
  gd: GedeDoc,
  tableId: Id,
  result: readonly string[],
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
    const computedIds = new Set(computed.map((c) => c.id));
    const others = record.columns.filter((c) => !computedIds.has(c.id));
    const metas = rowMetaMap(table);
    const cells = cellsMap(table);
    const editor = new RowEditor(rowsArray(table));
    const isLost = (id: Id): boolean =>
      !wantedSet.has(id) && rowMeta(table, id).computedKey !== null;
    const typed = (id: Id): boolean => others.some((c) => cellText(table, id, c.id) !== '');

    editor.dedupe();
    // A key that left: gone without a trace unless the row holds something typed (SET-12).
    for (const id of editor.remove((id) => isLost(id) && !typed(id))) {
      metas.delete(id);
      for (const c of record.columns) cells.delete(cellKey(id, c.id));
      writes += 1;
    }
    for (const id of editor.ids) {
      if (!isLost(id)) continue;
      const meta = rowMetaFor(table, id);
      if (meta.get('lostFrom') !== driver.id) {
        meta.set('lostFrom', driver.id);
        writes += 1;
      }
    }
    // Missing rows behind the previous wanted row; the first before the first one present.
    wanted.forEach((id, i) => {
      if (editor.has(id)) return;
      const previous = i > 0 ? editor.indexOf(wanted[i - 1] ?? '') : -1;
      if (previous >= 0) {
        editor.insertAt(previous + 1, id);
        return;
      }
      const next = wanted.find((w) => editor.has(w));
      editor.insertAt(next === undefined ? editor.ids.length : editor.indexOf(next), id);
    });
    // Result order among the computed rows; lost and hand-added rows keep their places.
    // ponytail: orderMembers is O(n²) on a full reversal; fine under the 10,000-row cap.
    orderMembers(editor, wanted);
    writes += editor.writes;

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
      const members = driver.computed.shape === 'spread' ? tupleMembers(key) : [];
      for (const column of computed) {
        if (column.computed.formula !== driver.computed.formula) continue;
        const text =
          column.computed.shape === 'spread'
            ? (members[column.computed.spreadIndex ?? 0] ?? '')
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
