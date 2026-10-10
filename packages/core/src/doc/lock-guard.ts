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
 * update adds is read by its own meta only in a machine-driven table (a computed formula or a
 * non-entered column, judged as the table was before the update; a formula in a cell does not
 * make one), and only when the tag is backed: a computed key needs the table's formula and its
 * computedIds entry, a pulled row needs a source table and row that exist once the update lands and a pull spec on
 * the receiving table. Anything else is a person's row. A tag is backed only by what the
 * reconciler would derive, never by a voucher the update writes itself: a computed row has the id
 * its key gives it, a pulled row its source row's id, and the only cell a reconciler writes is the
 * pull column bound to the source cell, so a pulled row's other text and a computed row's text are
 * edits. shortcut: the key of a computed row (shown until the next reconcile drops it), and a
 * split, followed or band tag with its cells, are trusted in a machine-driven table; the sync
 * service has no formula engine, so when rows carry a signed provenance, close them.
 * Row order alone is not an edit. A locked sheet is put back if deleted, with all its tables;
 * a locked section's name and columns are put back.
 */
import * as Y from 'yjs';

import type { Id } from '../ids.js';
import { computedRowId } from '../ref/computed.js';
import { pulledCellSource, pullOf } from '../ref/pull.js';
import { isCellKey, splitCellKey } from '../ids.js';
import {
  anyLock,
  listSections,
  lockReasonOfTable,
  SECTION_PREFIX,
  isSheetLocked,
  sheetHasLock,
} from './sections.js';
import {
  cellsMap,
  columnsArray,
  readColumnSource,
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
    // Only a table the reconcilers drive (as it was before the update) has machine rows or keys.
    const machineTable = (tableId: Id): boolean => {
      const t = tableMap(gd, tableId);
      return (
        t !== null &&
        (readString(t, 'computedFormula') !== '' ||
          columnsArray(t)
            .toArray()
            .some((c) => readColumnSource(c) !== 'entered'))
      );
    };
    // A machine tag on a row the update adds counts only when the document backs it. The
    // voucher cannot be one the update writes itself (a client writes computedIds too), so each
    // tag must match what the reconciler derives: a computed row has the id its key gives it,
    // the table's formula and its computedIds entry; a pulled row has its source row's id, a
    // pull of the receiving table from that source, and a source row that is not itself pulled.
    const tagBacked = (tableId: Id, meta: ReturnType<typeof rowMeta>, rowId: Id): boolean => {
      const before = tableMap(gd, tableId);
      if (before === null) return false;
      const { pulledFrom, computedKey } = meta;
      if (computedKey !== null) {
        const ids = tableMap(after, tableId)?.get('computedIds');
        if (
          readString(before, 'computedFormula') === '' ||
          !(ids instanceof Y.Map) ||
          ids.get(rowId) !== computedKey ||
          rowId !== computedRowId(tableId, computedKey)
        )
          return false;
      }
      if (pulledFrom !== null) {
        const source = tableMap(after, pulledFrom.tableId);
        if (
          source === null ||
          pulledFrom.rowId !== rowId ||
          pullOf(before)?.spec.tableId !== pulledFrom.tableId ||
          !rowsArray(source).toArray().includes(rowId) ||
          rowMeta(source, rowId).pulledFrom !== null
        )
          return false;
      }
      return true;
    };
    // A row's provenance is read from the document as it was: an update cannot vouch for its
    // own writes by setting `pulledFrom` on a row a person owns. A row the update adds has no
    // earlier meta: its own counts only in a machine-driven table.
    const machineMeta = (tableId: Id, rowId: Id): ReturnType<typeof rowMeta> | null => {
      const before = tableMap(gd, tableId);
      const owned = before !== null && rowsArray(before).toArray().includes(rowId);
      const table = owned ? before : machineTable(tableId) ? tableMap(after, tableId) : null;
      if (table === null) return null;
      const meta = rowMeta(table, rowId);
      if (rowReadOnlyReason(meta) === null && meta.computedKey === null) return null;
      return owned || tagBacked(tableId, meta, rowId) ? meta : null;
    };
    const machineRow = (tableId: Id, rowId: Id): boolean => machineMeta(tableId, rowId) !== null;
    // A reconciler writes exactly one cell on a pulled row (the pull column, bound to its source
    // cell) and none on a computed row (nothing computed is stored: text there is a person's).
    const machineCell = (tableId: Id, key: string): boolean => {
      if (!isCellKey(key)) return false;
      const { rowId, colId } = splitCellKey(key);
      const meta = machineMeta(tableId, rowId);
      if (meta?.computedKey !== null) return false;
      if (meta.pulledFrom === null) return true;
      const before = tableMap(gd, tableId);
      const pull = before === null ? null : pullOf(before);
      const now = tableMap(after, tableId);
      if (pull === null || now === null || colId !== pull.colId) return false;
      const value = cellsMap(now).get(key);
      return value === undefined
        ? !rowsOf(now).has(rowId)
        : value === pulledCellSource(pull.spec, rowId);
    };
    const rowsMoved = new Set<Id>();
    after.tables.observeDeep((events) => {
      for (const event of events) {
        const [tableId, member, cellKey] = event.path as [string?, string?, string?];
        const keys = event.target instanceof Y.Map ? [...event.changes.keys.keys()] : [];
        if (tableId === undefined) {
          for (const id of keys) edit(id);
        } else if (member === undefined) {
          if (keys.some((k) => !(MACHINE_TABLE_KEYS.has(k) && machineTable(tableId))))
            edit(tableId);
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
  // The sheets' tables and locked sections go back with them.
  const kept = new Set(sheets.map((k) => k.id));
  const tables =
    sheets.length === 0
      ? []
      : [...gd.tables.entries()].filter(([, t]) => kept.has(readString(t, 'sheetId')));
  const lanes = sheets.flatMap((k) =>
    listSections(gd, k.id)
      .filter((s) => s.locked || isSheetLocked(gd, k.id))
      .map((s) => ({ ...s, sheetId: k.id })),
  );
  const savedTables = tables.map(([id, t]) => [id, readString(t, 'sheetId'), t.clone()] as const);
  Y.applyUpdate(gd.doc, update, origin);
  const gone = sheets.filter((k) => !gd.sheets.toArray().some((s) => readString(s, 'id') === k.id));
  const renamed = lanes.filter((s) => {
    const m = gd.sheets
      .toArray()
      .find((x) => readString(x, 'id') === s.sheetId)
      ?.get(`${SECTION_PREFIX}${s.id}`);
    return (
      m instanceof Y.Map &&
      (m.get('name') !== s.name ||
        m.get('firstColumn') !== s.firstColumn ||
        m.get('lastColumn') !== s.lastColumn)
    );
  });
  if (saved.length === 0 && gone.length === 0 && renamed.length === 0) return [];
  gd.doc.transact(() => {
    for (const k of gone) {
      gd.sheets.insert(Math.min(k.i, gd.sheets.length), [k.s]);
      for (const [id, sheet, t] of savedTables)
        if (sheet === k.id && !gd.tables.has(id)) gd.tables.set(id, t);
    }
    for (const s of renamed) {
      const m = gd.sheets
        .toArray()
        .find((x) => readString(x, 'id') === s.sheetId)
        ?.get(`${SECTION_PREFIX}${s.id}`) as Y.Map<unknown>;
      m.set('name', s.name);
      m.set('firstColumn', s.firstColumn);
      m.set('lastColumn', s.lastColumn);
    }
    for (const [id, table] of saved) {
      if (table === null) gd.tables.delete(id);
      else gd.tables.set(id, table);
    }
  }, LOCK_RESTORE_ORIGIN);
  return [...offending, ...gone.map((k) => k.id), ...renamed.map((s) => s.sheetId)];
}
