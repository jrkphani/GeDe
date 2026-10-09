/**
 * SET-10, SET-11: a typed value is never lost to a computed fill.
 *
 * A computed column's reconciler (`ref/computed.ts`) writes its text into the
 * cell, and records it in the row's meta under `computedFillKey(colId)`. When
 * a person types into a cell while another replica makes that column computed
 * and fills it, the two writes are concurrent sets of one key of the cells
 * map, and Yjs keeps one of them by client id. When the fill wins, the typed
 * value is gone from the map. Every replica that held the typed value sees
 * that happen in the remote transaction (an `update` whose old value is the
 * typed fragment and whose new value is the fill) and writes the typed text
 * back; the reconciler then finds a typed value in a computed column and
 * refuses the fill, as SET-10 refuses it locally. Installed once per document
 * by `openDocument`.
 */
import * as Y from 'yjs';

import { cellKey, isCellKey, splitCellKey, type Id } from '../ids.js';
import { cellText, rowMetaMap, tableRecord, textFragment, type GedeDoc } from './schema.js';

/** Row-meta key: the text the computed reconciler last wrote in column `colId` of the row. */
export const computedFillKey = (colId: Id): string => `computedFill:${colId}`;

/** Transaction origin of a typed value written back after a concurrent fill: not an undo step. */
export const FILL_RESTORE_ORIGIN = 'ref-computed-restore';

const guarded = new WeakSet<Y.Doc>();

/**
 * The plain text a fragment showed before `transaction`: its items deleted in
 * this transaction still count (they are not collected until it is cleaned up).
 * ponytail: plain text only; a restored note loses its marks.
 */
function textBefore(fragment: Y.XmlFragment, transaction: Y.Transaction): string {
  const shown = (item: Y.Item): boolean =>
    !item.deleted || Y.isDeleted(transaction.deleteSet, item.id);
  const inline = (type: Y.AbstractType<unknown>): string => {
    let out = '';
    for (let item = type._start; item !== null; item = item.right) {
      if (!shown(item)) continue;
      if (item.content instanceof Y.ContentString) out += item.content.str;
      else if (item.content instanceof Y.ContentType) out += inline(item.content.type);
    }
    return out;
  };
  const lines: string[] = [];
  for (let item = fragment._start; item !== null; item = item.right) {
    if (shown(item) && item.content instanceof Y.ContentType) lines.push(inline(item.content.type));
  }
  return lines.join('\n');
}

export function guardTypedCells(gd: GedeDoc): void {
  if (guarded.has(gd.doc)) return;
  guarded.add(gd.doc);
  gd.tables.observeDeep((events: Y.YEvent<Y.AbstractType<unknown>>[], transaction) => {
    if (transaction.local) return;
    const byTarget = new Map<unknown, Y.YEvent<Y.AbstractType<unknown>>>();
    for (const event of events) byTarget.set(event.target, event);
    const restores: (() => void)[] = [];
    for (const event of events) {
      const cells = event.target;
      const table = cells.parent;
      if (!(table instanceof Y.Map) || table.parent !== gd.tables || table.get('cells') !== cells) {
        continue;
      }
      const columns = tableRecord(table).columns;
      event.changes.keys.forEach((change, key) => {
        if (change.action !== 'update' || !isCellKey(key)) return;
        const old: unknown = change.oldValue;
        if (!(old instanceof Y.XmlFragment)) return;
        const { rowId, colId } = splitCellKey(key);
        if ((columns.find((c) => c.id === colId)?.computed ?? null) === null) return;
        const typed = textBefore(old, transaction);
        const now = cellText(table, rowId, colId);
        const meta = rowMetaMap(table).get(rowId);
        // Only a fill replacing something it never saw: the new value is what the reconciler
        // wrote, and the old one was not an earlier fill of the same cell.
        if (typed === '' || typed === now || meta?.get(computedFillKey(colId)) !== now) return;
        const earlier = byTarget.get(meta)?.changes.keys.get(computedFillKey(colId));
        if (earlier?.oldValue === typed) return;
        restores.push(() => {
          (cells as Y.Map<unknown>).set(cellKey(rowId, colId), textFragment(typed));
        });
      });
    }
    if (restores.length === 0) return;
    gd.doc.transact(() => {
      for (const restore of restores) restore();
    }, FILL_RESTORE_ORIGIN);
  });
}
