/**
 * `Split()` children (HIER-07, PRD §4 "when a cell is divided the resulting
 * array renders as collapsible child rows beneath the parent cell").
 *
 * A derived column whose method is `Split` evaluates, per row, to a list
 * (`formula/methods.ts`). The engine hands those lists to the main thread as
 * results; this module turns them into rows: for parent row P with pieces
 * p₀…pₙ the table holds rows `P~0 … P~n` directly beneath P, one depth
 * deeper, each flagged `splitChild` (the outline's contract, HIER-07) with
 * `splitOf = { rowId: P, index }` as provenance, and the piece as the
 * child's text in the split column. Children are read-only
 * (`rowReadOnlyReason` → `splitChild`) and collapse with their parent
 * through the ordinary outline (`depth`, `collapsed`).
 *
 * Like pulls, the reconcile is deterministic (child ids derive from the
 * parent's), idempotent and a minimal diff (`rows.ts`), runs under
 * `SPLIT_ORIGIN`, and converges across replicas. The flag and depth go
 * through `markSplitChildren` (ADR-025), inside the reconcile's transaction. One `Split` column per table renders children; a second one
 * evaluates but is shown joined in its own cell.
 */
import { rowMetaFor } from '../doc/mutations.js';
import {
  cellsMap,
  cellText,
  isFormula,
  readSplitOf,
  rowMeta,
  rowMetaMap,
  rowsArray,
  tableRecord,
  textFragment,
  type GedeDoc,
  type TableMap,
  type TableRecord,
} from '../doc/schema.js';
import { workbookCellId, type WorkbookCellId } from '../engine/types.js';
import type { CellValue } from '../formula/evaluate.js';
import { markSplitChildren } from '../hier/mutations.js';
import { effectiveDepths } from '../hier/outline.js';
import { cellKey, type Id } from '../ids.js';
import { orderMembers, RowEditor } from './rows.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(text: string, seed: bigint): bigint {
  let hash = seed;
  for (const ch of text) {
    for (const byte of new TextEncoder().encode(ch)) {
      hash ^= BigInt(byte);
      hash = (hash * FNV_PRIME) & MASK64;
    }
  }
  return hash;
}

/**
 * Transaction origin of a split reconcile: never an undo step, and distinct
 * from `REF_ORIGIN` so a pull whose source gained child rows re-reconciles.
 */
export const SPLIT_ORIGIN = 'ref-split';

/**
 * Deterministic child id: the same parent and index name the same row on
 * every replica, so two reconcilers converge. Shaped like a ULID (26
 * Crockford base32 characters, first in 0–7) because ids travel inside
 * bound tokens (`{c:T:R:C}`, ADR-023), whose grammar is the ULID alphabet.
 * 128 bits of FNV-1a over `parent~index`; not time-ordered, and never needs
 * to be — a child's place is its position behind its parent.
 */
export function splitChildId(parentRowId: Id, index: number): Id {
  const key = `${parentRowId}~${String(index)}`;
  const bits = (fnv1a64(key, 0xcbf29ce484222325n) << 64n) | fnv1a64(key, 0x84222325cbf29ce4n);
  let out = '';
  for (let i = 25; i >= 0; i -= 1) {
    out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)] ?? '0';
  }
  // 26 × 5 = 130 bits; the top two are zero, so the first character is 0–7 as a ULID's is.
  return out;
}

/** The first `Split` derived column of a table, whose pieces become child rows. */
export function splitColumnOf(record: TableRecord): Id | null {
  return record.columns.find((c) => c.derive?.method === 'Split')?.id ?? null;
}

/** Pieces per parent row, as the engine evaluated them. */
export type SplitPieces = ReadonlyMap<Id, readonly string[]>;

/** A `Split()` child row: `splitOf` names its parent and piece. */
function isChild(table: TableMap, id: Id): boolean {
  return rowMeta(table, id).splitOf !== null;
}

function reconcileInTransaction(gd: GedeDoc, tableId: Id, pieces: SplitPieces): number {
  const table = gd.tables.get(tableId);
  if (table === undefined) return 0;
  const record = tableRecord(table);
  const colId = splitColumnOf(record);
  const effective: SplitPieces = colId === null ? new Map() : pieces;
  const metas = rowMetaMap(table);
  const cells = cellsMap(table);
  const editor = new RowEditor(rowsArray(table));
  let writes = 0;

  // The children every present parent should have, in order; a parent that is gone keeps none.
  const wanted = new Map<Id, Id[]>();
  const wantedSet = new Set<Id>();
  for (const rowId of editor.ids) {
    if (isChild(table, rowId)) continue;
    const parts = effective.get(rowId) ?? [];
    const ids = parts.map((_p, i) => splitChildId(rowId, i));
    wanted.set(rowId, ids);
    for (const id of ids) wantedSet.add(id);
  }

  // Minimal diff (see rows.ts): dedupe, delete, insert, then reorder one row at a time.
  editor.dedupe();
  const removed = editor.remove((id) => isChild(table, id) && !wantedSet.has(id));
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
  for (const [parentId, ids] of wanted) {
    ids.forEach((id, i) => {
      if (editor.has(id)) return;
      // Behind the previous sibling that exists, else right behind the parent.
      let anchor = editor.indexOf(parentId);
      for (let j = i - 1; j >= 0; j -= 1) {
        const sibling = editor.indexOf(ids[j] ?? '');
        if (sibling >= 0) {
          anchor = sibling;
          break;
        }
      }
      editor.insertAt(anchor + 1, id);
    });
    // Children directly behind their parent, in piece order.
    orderMembers(editor, [parentId, ...ids]);
    const parentAt = editor.indexOf(parentId);
    ids.forEach((id, i) => {
      if (editor.ids[parentAt + 1 + i] !== id) editor.move(id, parentAt + 1 + i);
    });
  }
  writes += editor.writes;
  if (colId === null) return writes;

  // The depth every child should hold: one under its parent's *effective* depth (HIER-02),
  // computed once for the table rather than once per parent inside `markSplitChildren`.
  const depths = effectiveDepths(editor.ids.map((id) => rowMeta(table, id).depth));
  for (const [parentId, ids] of wanted) {
    const parts = effective.get(parentId) ?? [];
    if (ids.length === 0) continue;
    // The outline's contract (ADR-025): flag and depth are written by `markSplitChildren`
    // (the outer transaction's origin wins, so it stays untracked by undo) — called only
    // for a parent whose children are not already flagged at that depth, since it walks
    // the whole table each time.
    const wantDepth = (depths[editor.indexOf(parentId)] ?? 0) + 1;
    const settled = ids.every((id) => {
      const meta = metas.get(id);
      return meta?.get('splitChild') === true && meta.get('depth') === wantDepth;
    });
    if (!settled) {
      markSplitChildren(gd, tableId, parentId, ids);
      writes += 1;
    }
    ids.forEach((childId, index) => {
      const meta = rowMetaFor(table, childId);
      const splitOf = readSplitOf(meta.get('splitOf'));
      if (splitOf?.rowId !== parentId || splitOf.index !== index) {
        meta.set('splitOf', { rowId: parentId, index });
        writes += 1;
      }
      const text = parts[index] ?? '';
      const key = cellKey(childId, colId);
      const content = cells.get(key);
      if (content === undefined || isFormula(content) || cellText(table, childId, colId) !== text) {
        cells.set(key, textFragment(text));
        writes += 1;
      }
    });
  }
  return writes;
}

/**
 * The pieces of every table's split column as the engine evaluated them
 * (`resultOf` answers by workbook cell id), for `reconcileSplitChildren`. A
 * table still evaluating is left out, so its rows stay as they are; a table
 * whose split column is gone but still holds children yields an empty map,
 * so they go.
 */
export function splitPiecesOf(
  gd: GedeDoc,
  resultOf: (cellId: WorkbookCellId) => { readonly value: CellValue | null } | undefined,
): Map<Id, SplitPieces> {
  const out = new Map<Id, SplitPieces>();
  gd.tables.forEach((table, tableId) => {
    const record = tableRecord(table);
    const colId = splitColumnOf(record);
    const pieces = new Map<Id, readonly string[]>();
    if (colId === null) {
      if (record.rows.some((rowId) => isChild(table, rowId))) out.set(tableId, pieces);
      return;
    }
    for (const rowId of record.rows) {
      if (isChild(table, rowId)) continue;
      const result = resultOf(workbookCellId(tableId, cellKey(rowId, colId)));
      if (result === undefined) return; // not evaluated yet: leave the rows as they are
      const value = result.value;
      pieces.set(
        rowId,
        value?.kind === 'list'
          ? value.items.map((item) => (item.kind === 'text' ? item.text : ''))
          : [],
      );
    }
    out.set(tableId, pieces);
  });
  return out;
}

/**
 * Materialise `Split()` children for one table from the pieces the engine
 * evaluated. Under `SPLIT_ORIGIN` by default (not an undo step). Returns the
 * number of writes; nothing is transacted when nothing moved.
 */
export function reconcileSplitChildren(
  gd: GedeDoc,
  tableId: Id,
  pieces: SplitPieces,
  origin: unknown = SPLIT_ORIGIN,
): number {
  if (gd.tables.get(tableId) === undefined) return 0;
  let writes = 0;
  gd.doc.transact(() => {
    writes = reconcileInTransaction(gd, tableId, pieces);
  }, origin);
  return writes;
}
