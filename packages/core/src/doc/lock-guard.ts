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
 * unlocks and edits at once is refused whole), or the table is new and its place is locked.
 * What counts as an edit: a table added or removed, its own keys (title, place, look…), its
 * columns, its cell formats and spans, and the text of a cell on a row a person owns. Left
 * alone because machines write them in a locked table too — a computed table follows its
 * formula, a pulled or split row follows its source — and no replica can tell, from the
 * update, whose hand wrote them: row membership and row meta, the reconcilers' bookkeeping
 * keys, and the cells of a pulled, split, followed or computed row.
 */
import * as Y from 'yjs';

import type { Id } from '../ids.js';
import { isCellKey, splitCellKey } from '../ids.js';
import { anyLock, lockReasonOfTable } from './sections.js';
import { openDocument, rowMeta, rowReadOnlyReason, tableMap, type GedeDoc } from './schema.js';

/** Table keys the reconcilers write (`ref/computed.ts`): not an edit. */
const MACHINE_TABLE_KEYS: ReadonlySet<string> = new Set(['computedRows', 'computedIds']);
/** Table members whose changes are row membership and row meta: not an edit (see above). */
const ROW_MEMBERS: ReadonlySet<string> = new Set(['rows', 'rowMeta']);

/** Origin of the write that puts locked tables back (never an undo step on any replica). */
export const LOCK_RESTORE_ORIGIN = 'lock-restore';

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
    const edit = (tableId: Id): void => {
      const known = gd.tables.has(tableId);
      if ((known ? lockReasonOfTable(gd, tableId) : lockReasonOfTable(after, tableId)) !== null) {
        offending.add(tableId);
      }
    };
    const machineCell = (tableId: Id, key: string): boolean => {
      const table = tableMap(after, tableId);
      if (table === null || !isCellKey(key)) return false;
      const meta = rowMeta(table, splitCellKey(key).rowId);
      return rowReadOnlyReason(meta) !== null || meta.computedKey !== null;
    };
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
        } else if (!ROW_MEMBERS.has(member)) {
          edit(tableId);
        }
      }
    });
    Y.applyUpdate(copy, update);
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
  Y.applyUpdate(gd.doc, update, origin);
  if (saved.length === 0) return [];
  gd.doc.transact(() => {
    for (const [id, table] of saved) {
      if (table === null) gd.tables.delete(id);
      else gd.tables.set(id, table);
    }
  }, LOCK_RESTORE_ORIGIN);
  return offending;
}
