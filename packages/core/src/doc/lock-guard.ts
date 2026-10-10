/**
 * SET-18, SPEC §4: the sync service's check of a received update against the lock. A client
 * checks too, but only the service can refuse an edit from a client that does not.
 *
 * A refused update is still applied: a client's later updates build on its earlier ones, so
 * dropping one would leave every one after it waiting for it for good. Its effect on the locked
 * tables is undone instead — each is put back as it was, in a write the room broadcasts, so the
 * client that sent it converges on the locked content.
 *
 * An update is applied to a copy of the document and the tables it changes are read off the
 * copy's events. A change counts when the table was locked before the update (an edit that
 * unlocks and edits at once is refused whole), or locked where the update leaves it (a table
 * moved into a locked lane, a new table in one).
 * What counts as an edit: a table added or removed, its own keys (title, place, look…), its
 * columns, its cell formats and spans, a row added or removed that a person owns, and the
 * text of a cell on such a row. Left alone because machines write them in a locked table too
 * — a computed table follows its formula, a pulled or split row follows its source — and no
 * replica can tell, from the update, whose hand wrote them: the reconcilers' bookkeeping keys
 * and rows whose meta, as it was before the update, marks them as machine-written. A row the
 * update adds is read by its own meta, so a client can still add a row dressed as a pulled
 * one (shortcut: no replica can tell it from a reconciler's; upgrade when rows carry a
 * signed provenance). Row order alone is not an edit. A locked sheet is put back if deleted.
 */
import * as Y from 'yjs';

import type { Id } from '../ids.js';
import { isCellKey, splitCellKey } from '../ids.js';
import { anyLock, lockReasonOfTable, sheetHasLock } from './sections.js';
import {
  openDocument,
  readString,
  rowMeta,
  rowReadOnlyReason,
  rowsArray,
  tableMap,
  type GedeDoc,
  type TableMap,
} from './schema.js';

/** Table keys the reconcilers write (`ref/computed.ts`): not an edit. */
const MACHINE_TABLE_KEYS: ReadonlySet<string> = new Set(['computedRows', 'computedIds']);

/** Origin of the write that puts locked tables back (never an undo step on any replica). */
export const LOCK_RESTORE_ORIGIN = 'lock-restore';

function rowsOf(table: TableMap | null): Set<Id> {
  return new Set(table === null ? [] : rowsArray(table).toArray());
}

/**
 * The locked tables the update would edit (see above), or none. Free on a document with no
 * lock: the copy is made only when something is locked.
 * shortcut: copies the whole document per update while a lock exists, when typing in a very
 * large locked document is slow, read the touched keys off `Y.decodeUpdate` instead.
 */
export function lockedTablesEdited(gd: GedeDoc, update: Uint8Array): Id[] {
  if (!anyLock(gd)) return [];
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(gd.doc));
    const after = openDocument(copy);
    const offending = new Set<Id>();
    // Locked before the update, or locked where the update leaves the table: a table moved
    // into a locked lane is an edit of that lane.
    const edit = (tableId: Id): void => {
      if (lockReasonOfTable(gd, tableId) !== null || lockReasonOfTable(after, tableId) !== null) {
        offending.add(tableId);
      }
    };
    // A row's provenance is read from the document as it was: an update cannot vouch for its
    // own writes by setting `pulledFrom` on a row a person owns. Only a row the update adds
    // has no earlier meta, so its own is all there is to read.
    const machineRow = (tableId: Id, rowId: Id): boolean => {
      const before = tableMap(gd, tableId);
      const table =
        before !== null && rowsArray(before).toArray().includes(rowId)
          ? before
          : tableMap(after, tableId);
      if (table === null) return false;
      const meta = rowMeta(table, rowId);
      return rowReadOnlyReason(meta) !== null || meta.computedKey !== null;
    };
    const machineCell = (tableId: Id, key: string): boolean =>
      isCellKey(key) && machineRow(tableId, splitCellKey(key).rowId);
    const rowsMoved = new Set<Id>();
    after.tables.observeDeep((events) => {
      for (const event of events) {
        const [tableId, member, cellKey] = event.path as [string?, string?, string?];
        const keys = event.target instanceof Y.Map ? [...event.changes.keys.keys()] : [];
        if (tableId === undefined) {
          for (const id of keys) edit(id);
        } else if (member === undefined) {
          if (keys.some((k) => !MACHINE_TABLE_KEYS.has(k))) edit(tableId);
        } else if (member === 'cells') {
          const changed = cellKey === undefined ? keys : [cellKey];
          if (changed.some((k) => !machineCell(tableId, k))) edit(tableId);
        } else if (member === 'rows') {
          rowsMoved.add(tableId);
        } else if (member === 'rowMeta') {
          const rows = cellKey === undefined ? keys : [cellKey];
          if (rows.some((r) => !machineRow(tableId, r))) edit(tableId);
        } else {
          edit(tableId);
        }
      }
    });
    Y.applyUpdate(copy, update);
    // Row membership: a row added or removed that a person owns is an edit; one a reconciler
    // owns (pulled, split, followed, computed) is not.
    for (const tableId of rowsMoved) {
      const was = rowsOf(tableMap(gd, tableId));
      const now = rowsOf(tableMap(after, tableId));
      for (const id of [...was, ...now]) {
        if (was.has(id) !== now.has(id) && !machineRow(tableId, id)) edit(tableId);
      }
    }
    return [...offending];
  } finally {
    copy.destroy();
  }
}

/**
 * SET-18: apply a client's update to the room's document, then put back every locked table it
 * edited. Returns those tables (none when the update is clean).
 */
export function applyGuardedUpdate(gd: GedeDoc, update: Uint8Array, origin: unknown): Id[] {
  const offending = lockedTablesEdited(gd, update);
  const saved = offending.map((id) => [id, gd.tables.get(id)?.clone() ?? null] as const);
  // A sheet that carries a lock cannot be deleted by a client: it goes back where it was.
  const sheets = anyLock(gd)
    ? gd.sheets
        .toArray()
        .flatMap((s, i) => (sheetHasLock(s) ? [{ i, id: readString(s, 'id'), s: s.clone() }] : []))
    : [];
  Y.applyUpdate(gd.doc, update, origin);
  const gone = sheets.filter((k) => !gd.sheets.toArray().some((s) => readString(s, 'id') === k.id));
  if (saved.length === 0 && gone.length === 0) return [];
  gd.doc.transact(() => {
    for (const k of gone) gd.sheets.insert(Math.min(k.i, gd.sheets.length), [k.s]);
    for (const [id, table] of saved) {
      if (table === null) gd.tables.delete(id);
      else gd.tables.set(id, table);
    }
  }, LOCK_RESTORE_ORIGIN);
  return [...offending, ...gone.map((k) => k.id)];
}
