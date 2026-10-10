/**
 * Add table's kinds and Fill column (SET-01, SET-08, SET-09, SET-10; ADR-056, SPEC §5).
 *
 * What the kind picker and the operand picker write, as one undo step each. Nothing here
 * evaluates: a computed table stores its one formula (`setTableFormula`) and the columns it
 * fills (`setComputedColumns`); the engine's Worker evaluates it and the reconciler fills the
 * rows (`use-reconcile.ts`). An operand is a set table's range column, bound by id
 * (`{k:table:column}`), so the formula follows the set through moves, renames and new rows.
 */
import {
  cellText,
  createTable,
  encodeBound,
  renameColumn,
  rowsArray,
  setComputedColumns,
  setTableFormula,
  setTableTitle,
  spreadMemberLabel,
  tableById,
  tableMap,
  tablesOnSheet,
  type ComputedSpec,
  type GedeDoc,
  type Id,
  type LatticeUnits,
  type Pixels,
  type TableKind,
  type TableRecord,
} from '@gede/core';

import { translate } from '../../../i18n/index.js';
import { activeLocale } from '../../../locale.js';

/** SET-01: the kinds in the order the picker lists them; Plain table is preselected. */
export const TABLE_KINDS: readonly TableKind[] = [
  'plain',
  'simple',
  'family',
  'computed',
  'product',
];

/** A computed kind asks for its operation and sets before it adds anything. */
export function isComputedKind(kind: TableKind): kind is 'computed' | 'product' {
  return kind === 'computed' || kind === 'product';
}

export type SetOperation = 'Union' | 'Inter' | 'Diff' | 'Power' | 'Cross';
export type ProductShape = 'column' | 'spread';

/** The operations Computed by formula offers; a Cartesian product is Cross. */
export const FORMULA_OPERATIONS: readonly SetOperation[] = ['Union', 'Inter', 'Diff', 'Power'];

/** How many sets an operation takes as the picker asks for them. */
export function operandCount(op: SetOperation): { readonly min: number; readonly max: number } {
  if (op === 'Power') return { min: 1, max: 1 };
  if (op === 'Cross') return { min: 2, max: Number.POSITIVE_INFINITY };
  return { min: 2, max: 2 };
}

/** What the operand picker settled on: the operation, its sets in order, and a Cross's shape. */
export interface SetPick {
  readonly op: SetOperation;
  readonly sets: readonly Id[];
  readonly shape: ProductShape;
}

/** A set on the sheet as the picker offers it: the table and its range column. */
export interface SheetSet {
  readonly tableId: Id;
  readonly title: string;
  readonly colId: Id;
  /** The first elements, for the picker's preview. */
  readonly elements: readonly string[];
  /** More elements than `elements` holds. */
  readonly more: boolean;
}

const PREVIEW = 6;

/**
 * SET-02: a set table's range column — the first column of a simple set or a family, the
 * first one-column computed column of a computed table. A product spread across columns
 * has no single range column and is not offered.
 */
function rangeColumn(record: TableRecord): Id | null {
  if (record.kind === 'simple' || record.kind === 'family') return record.columns[0]?.id ?? null;
  const computed = record.columns.filter((c) => c.computed !== null);
  if (computed.length === 0) return record.columns[0]?.id ?? null;
  return computed.find((c) => c.computed?.shape === 'column')?.id ?? null;
}

/** The set tables on a sheet, in sheet order, each with its range column (SET-02). */
export function setsOnSheet(gd: GedeDoc, sheetId: Id): SheetSet[] {
  const out: SheetSet[] = [];
  for (const record of tablesOnSheet(gd, sheetId)) {
    if (record.kind === 'plain') continue;
    const colId = rangeColumn(record);
    const table = tableMap(gd, record.id);
    if (colId === null || table === null) continue;
    const elements: string[] = [];
    let more = false;
    for (const rowId of rowsArray(table).toArray()) {
      const text = cellText(table, rowId, colId).trim();
      if (text === '' || elements.includes(text)) continue;
      if (elements.length === PREVIEW) {
        more = true;
        break;
      }
      elements.push(text);
    }
    out.push({ tableId: record.id, title: record.title, colId, elements, more });
  }
  return out;
}

/** The picked sets as `{ a, b, … }`, for the picker's preview. */
export function elementsPreview(set: SheetSet): string {
  if (set.elements.length === 0) return '∅';
  return `{ ${set.elements.join(', ')}${set.more ? ', …' : ''} }`;
}

/** The stored formula: each set its range column bound by id. */
export function pickFormula(gd: GedeDoc, pick: SetPick): string | null {
  const operands: string[] = [];
  for (const tableId of pick.sets) {
    const record = tableById(gd, tableId);
    const colId = record === null ? null : rangeColumn(record);
    if (colId === null) return null;
    operands.push(encodeBound({ kind: 'column', columns: [{ tableId, colId }] }));
  }
  return `=${pick.op}(${operands.join(', ')})`;
}

const OPERATOR: Readonly<Record<Exclude<SetOperation, 'Power'>, string>> = {
  Union: ' ∪ ',
  Inter: ' ∩ ',
  Diff: ' ∖ ',
  Cross: ' × ',
};

/** The set's name, by its operands' titles (`E × C × B`, `𝒫(E)`); the table's title. */
export function pickName(gd: GedeDoc, pick: SetPick): string {
  const titles = pick.sets.map((id) => tableById(gd, id)?.title ?? '');
  return pick.op === 'Power' ? `𝒫(${titles[0] ?? ''})` : titles.join(OPERATOR[pick.op]);
}

/** The formula as the picker shows it: `= Cross(E, C, B)`, the sets by title. */
export function pickDisplay(gd: GedeDoc, pick: SetPick): string {
  const titles = pick.sets.map((id) => tableById(gd, id)?.title ?? '');
  return `= ${pick.op}(${titles.join(', ')})`;
}

/** Whether a pick can be added: every set named and on the sheet, as many as the operation takes. */
export function pickReady(gd: GedeDoc, pick: SetPick): boolean {
  const { min, max } = operandCount(pick.op);
  return pick.sets.length >= min && pick.sets.length <= max && pickFormula(gd, pick) !== null;
}

function spreads(pick: SetPick): boolean {
  return pick.op === 'Cross' && pick.shape === 'spread';
}

const t = (key: Parameters<typeof translate>[1]): string => translate(activeLocale(), key);

export interface AddTableOptions {
  readonly sheetId: Id;
  readonly at: LatticeUnits | Pixels;
  readonly kind: TableKind;
  /** Required for a computed kind. */
  readonly pick?: SetPick | undefined;
}

/**
 * SET-01: add a table of `kind`, as one undo step. Plain is today's table (3 × 5). A simple
 * set or a family starts with its range and a description column and one element row. A
 * computed kind starts with no rows: its range column (or, for a Cross spread one column
 * per set, headed `x1 ∈ E`) is filled from the pick's formula, with a note column beside
 * it, and the table is titled by the set it computes when that title is free.
 */
export function addTableOfKind(gd: GedeDoc, options: AddTableOptions): Id | null {
  const { sheetId, at, kind, pick } = options;
  if (kind === 'plain') return createTable(gd, { sheetId, at, columns: 3, rows: 5 });
  if (!isComputedKind(kind)) {
    let id: Id = '';
    gd.doc.transact(() => {
      id = createTable(gd, { sheetId, at, columns: 2, rows: 1, kind });
      const [range, description] = tableById(gd, id)?.columns ?? [];
      if (range !== undefined) renameColumn(gd, id, range.id, t('set.column.range'));
      if (description !== undefined) {
        renameColumn(gd, id, description.id, t('set.column.description'));
      }
    }, gd.origin);
    return id;
  }
  if (pick === undefined || !pickReady(gd, pick)) return null;
  const formula = pickFormula(gd, pick);
  if (formula === null) return null;
  const members = spreads(pick) ? pick.sets.length : 1;
  let id: Id = '';
  gd.doc.transact(() => {
    id = createTable(gd, { sheetId, at, columns: members + 1, rows: 0, kind });
    const columns = tableById(gd, id)?.columns ?? [];
    const filled: { colId: Id; spec: ComputedSpec }[] = [];
    columns.slice(0, members).forEach((c, index) => {
      renameColumn(
        gd,
        id,
        c.id,
        members > 1 ? spreadMemberLabel(gd, formula, index) : t('set.column.range'),
      );
      filled.push({
        colId: c.id,
        spec: members > 1 ? { shape: 'spread', spreadIndex: index } : { shape: 'column' },
      });
    });
    const note = columns[members];
    if (note !== undefined) renameColumn(gd, id, note.id, t('set.column.note'));
    setComputedColumns(gd, id, filled);
    setTableFormula(gd, id, formula);
    setTableTitle(gd, id, pickName(gd, pick));
  }, gd.origin);
  return id;
}

/**
 * SET-10: why Fill column with formula… is unavailable on a column, or undefined. A
 * column is filled only while it is empty; a computed column already follows its table's
 * one formula (ADR-056 ruling a).
 */
export function fillColumnReason(gd: GedeDoc, tableId: Id, colId: Id): string | undefined {
  const record = tableById(gd, tableId);
  const table = tableMap(gd, tableId);
  const column = record?.columns.find((c) => c.id === colId);
  if (record === null || table === null || column === undefined) return undefined;
  if (column.source === 'computed') return t('set.readOnly.computed');
  return record.rows.some((rowId) => cellText(table, rowId, colId) !== '')
    ? t('fill.notEmpty')
    : undefined;
}

/**
 * SET-10: Fill column with formula…, as one undo step. In One column per set the column is
 * the first member, headed `x1 ∈ E`; the re-fit adds the others beside it, each headed by
 * its set. False — nothing written — when the column holds a typed value.
 */
export function fillColumnWith(gd: GedeDoc, tableId: Id, colId: Id, pick: SetPick): boolean {
  if (fillColumnReason(gd, tableId, colId) !== undefined || !pickReady(gd, pick)) return false;
  const formula = pickFormula(gd, pick);
  if (formula === null) return false;
  let ok = false;
  gd.doc.transact(() => {
    if (spreads(pick)) renameColumn(gd, tableId, colId, spreadMemberLabel(gd, formula, 0));
    const spec: ComputedSpec = spreads(pick)
      ? { shape: 'spread', spreadIndex: 0 }
      : { shape: 'column' };
    ok =
      setComputedColumns(gd, tableId, [{ colId, spec }]) && setTableFormula(gd, tableId, formula);
  }, gd.origin);
  return ok;
}
