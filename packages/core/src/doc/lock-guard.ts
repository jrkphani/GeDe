/**
 * SET-18, SPEC §4: the sync service's check of a received update against the lock. A client
 * checks too, but only the service can refuse an edit from a client that does not.
 *
 * A refused update is still applied: a client's later updates build on its earlier ones, so
 * dropping one would leave every one after it waiting for it for good. Its effect on the locked
 * tables is undone instead. Each is put back as it was, in a write the room broadcasts, so the
 * client that sent it converges on the locked content.
 *
 * The update is applied to a copy of the document and the tables it changes are read off the
 * copy's events. A change counts when the table was locked before the update (an edit that
 * unlocks and edits at once is refused whole), or locked where the update leaves it (a table
 * moved into a locked lane, a new table in one).
 *
 * What counts as an edit: a table added or removed, its own keys (title, place, look...), its
 * columns, its cell formats and spans, a row added or removed that a person owns, and the text
 * of a cell on such a row. Row order alone is not an edit. Machines write some things in a
 * locked table too (a computed table follows its formula, a pulled or split row follows its
 * source) and no replica can tell from the update whose hand wrote them. So the reconcilers'
 * bookkeeping keys, and rows whose meta before the update marks them as machine-written, are
 * left alone.
 *
 * A row the update adds is read by its own meta only in a machine-driven table (a computed
 * formula, a non-entered column or a family of sets, judged as the table was before the update;
 * a formula in a cell does not make one), and only when each tag is backed by what the
 * reconciler would derive. The update never vouches for itself. A computed row has the id its
 * key gives it, the table's formula and a computedIds entry. A pulled row has its source row's
 * id, a source row that exists, and a pull spec on the receiving table. A split child has the
 * id its parent and index give it, a parent row and a Split column from before the update. A
 * followed row has the id its referencing row and source row give it, with both the row and the
 * set from before the update. A category band is never backed: nothing writes one. A computedIds
 * entry counts only beside its row. A row that stays keeps its tag. Anything unbacked is a
 * person's row.
 *
 * The only cell a reconciler writes on a pulled row is the pull column bound to the source cell,
 * so a pulled row's other text and a computed row's text are edits.
 *
 * A split child's text must be the piece its parent's source cell divides into, and a followed
 * row's text what its set holds, both re-derived here; any other text on them is an edit.
 *
 * shortcut: the service has no formula engine, so it cannot check a computed row's key against
 * the result (it shows until the next reconcile drops it); when rows carry a signed
 * provenance, close it.
 *
 * A locked sheet is put back if deleted, with all its tables; a locked section's name and
 * columns are put back.
 */
import * as Y from 'yjs';

import type { Id } from '../ids.js';
import { computedRowId } from '../ref/computed.js';
import { pulledCellSource, pullOf } from '../ref/pull.js';
import { splitChildId, splitColumnOf } from '../ref/split.js';
import { applyMethod } from '../formula/methods.js';
import { cellRich } from '../text/mutations.js';
import { followedCellDerived, followedRowId } from './set-table.js';
import { cellKey, isCellKey, splitCellKey } from '../ids.js';
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
  cellText,
  columnsArray,
  deriveArgValues,
  isFormula,
  readColumnSource,
  openDocument,
  readString,
  rowMeta,
  rowReadOnlyReason,
  rowsArray,
  tableMap,
  tableRecord,
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
          tableRecord(t).kind === 'family' ||
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
      // A split child needs its parent row and a Split column, both from before the update.
      const { splitOf, splitChild } = meta;
      if (splitOf !== null || splitChild) {
        if (
          splitOf === null ||
          splitColumnOf(tableRecord(before)) === null ||
          !rowsOf(before).has(splitOf.rowId) ||
          splitChildId(splitOf.rowId, splitOf.index) !== rowId
        )
          return false;
      }
      // A followed row needs the referencing row and the set it follows, from before the update.
      const ref = meta.setRefOf;
      if (ref !== null) {
        const followed = tableMap(gd, ref.tableId);
        if (
          followed === null ||
          !rowsOf(before).has(ref.rowId) ||
          !rowsArray(followed)
            .toArray()
            .some((s) => followedRowId(ref.rowId, s) === rowId)
        )
          return false;
      }
      // Nothing writes a stored category band, so none is backed.
      return !meta.group;
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
      return (owned ? tagKept(tableId, rowId, meta) : tagBacked(tableId, meta, rowId))
        ? meta
        : null;
    };
    // A row that stays keeps its provenance: a pulled row its source, a computed row the key its
    // id gives it (the reconciler drops the key only once the table has no computed column).
    const tagKept = (tableId: Id, rowId: Id, meta: ReturnType<typeof rowMeta>): boolean => {
      const now = tableMap(after, tableId);
      if (now === null || !rowsOf(now).has(rowId)) return true;
      const next = rowMeta(now, rowId);
      if (
        meta.pulledFrom !== null &&
        (next.pulledFrom?.tableId !== meta.pulledFrom.tableId ||
          next.pulledFrom.rowId !== meta.pulledFrom.rowId)
      )
        return false;
      if (meta.computedKey === null) return true;
      return next.computedKey === null
        ? !machineTable(tableId)
        : computedRowId(tableId, next.computedKey) === rowId;
    };
    // The reconciler's computedIds entries: each row id maps to the key that gives that id.
    const idsBacked = (tableId: Id, ids: unknown, only?: readonly string[]): boolean => {
      if (!(ids instanceof Y.Map)) return true;
      return (only ?? [...ids.keys()]).every((id) => {
        const key: unknown = ids.get(id);
        return (
          key === undefined ||
          (typeof key === 'string' &&
            computedRowId(tableId, key) === id &&
            rowsOf(tableMap(after, tableId)).has(id))
        );
      });
    };
    const machineRow = (tableId: Id, rowId: Id): boolean => machineMeta(tableId, rowId) !== null;
    // A reconciler writes exactly one cell on a pulled row (the pull column, bound to its source
    // cell) and none on a computed row (nothing computed is stored: text there is a person's).
    const machineCell = (tableId: Id, key: string): boolean => {
      if (!isCellKey(key)) return false;
      const { rowId, colId } = splitCellKey(key);
      const meta = machineMeta(tableId, rowId);
      if (meta?.computedKey !== null) return false;
      if (meta.pulledFrom === null) {
        // A split child holds the piece its parent's source cell divides into; a followed
        // row holds its set's source text. Any other text there is an edit.
        const now = tableMap(after, tableId);
        if (now === null || !rowsOf(now).has(rowId)) return true;
        if (meta.splitChild || meta.splitOf !== null)
          return splitCellDerived(now, rowId, colId, meta);
        if (meta.setRefOf !== null) return followedCellDerived(after, tableId, rowId, colId);
        return true;
      }
      const before = tableMap(gd, tableId);
      const pull = before === null ? null : pullOf(before);
      const now = tableMap(after, tableId);
      if (pull === null || now === null || colId !== pull.colId) return false;
      const value = cellsMap(now).get(key);
      return value === undefined
        ? !rowsOf(now).has(rowId)
        : value === pulledCellSource(pull.spec, rowId);
    };
    const splitCellDerived = (
      now: TableMap,
      rowId: Id,
      colId: Id,
      meta: ReturnType<typeof rowMeta>,
    ): boolean => {
      const spec = tableRecord(now).columns.find((c) => c.id === colId)?.derive;
      const parent = meta.splitOf;
      if (spec?.method !== 'Split' || parent === null) return false;
      // shortcut: a Split over a formula cell cannot be re-derived without the engine, so
      // its children are refused in a locked table; when that bites, ship the engine's pieces.
      if (isFormula(cellsMap(now).get(cellKey(parent.rowId, spec.sourceColId)))) return false;
      const pieces = applyMethod(
        'Split',
        deriveArgValues(spec),
        cellRich(now, parent.rowId, spec.sourceColId),
      );
      const piece =
        pieces.ok && pieces.value.kind === 'list' ? pieces.value.items[parent.index] : null;
      return (
        piece?.kind === 'text' &&
        !isFormula(cellsMap(now).get(cellKey(rowId, colId))) &&
        cellText(now, rowId, colId) === piece.text
      );
    };
    const rowsMoved = new Set<Id>();
    after.tables.observeDeep((events) => {
      for (const event of events) {
        const [tableId, member, cellKey] = event.path as [string?, string?, string?];
        const keys = event.target instanceof Y.Map ? [...event.changes.keys.keys()] : [];
        if (tableId === undefined) {
          for (const id of keys) edit(id);
        } else if (member === undefined) {
          if (
            keys.some(
              (k) =>
                !(
                  MACHINE_TABLE_KEYS.has(k) &&
                  machineTable(tableId) &&
                  (k !== 'computedIds' ||
                    idsBacked(tableId, tableMap(after, tableId)?.get('computedIds')))
                ),
            )
          )
            edit(tableId);
        } else if (member === 'cells') {
          const changed = cellKey === undefined ? keys : [cellKey];
          if (changed.some((k) => !machineCell(tableId, k))) edit(tableId);
        } else if (member === 'rows') {
          rowsMoved.add(tableId);
        } else if (member === 'rowMeta') {
          const rows = cellKey === undefined ? keys : [cellKey];
          if (rows.some((r) => !machineRow(tableId, r))) edit(tableId);
        } else if (member === 'computedIds' && machineTable(tableId)) {
          if (!idsBacked(tableId, event.target, keys)) edit(tableId);
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
