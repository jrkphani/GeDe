/**
 * A formula engine kept in step with a document the way the app's host keeps its Worker:
 * every transaction goes in, then the structure tables (SET-13..16) are recomputed from the
 * engine's own results until they stop moving. Not part of the published package.
 */
import type { Id } from '../../ids.js';
import { workbookCellId, type CellResult, type WorkbookChange } from '../types.js';
import { cellKey } from '../../ids.js';
import type { GedeDoc } from '../../doc/schema.js';
import { FormulaEngine } from '../engine.js';
import { observeWorkbook } from '../snapshot.js';
import { structureSync, SUMMARY_COLUMNS, type StructureLabels } from '../structure.js';

/** English words for the tables, as the catalogue spells them. */
export const STRUCTURE_LABELS: StructureLabels = {
  universe: 'U',
  superSet: 'super set array',
  sheetSummary: 'sheet summary',
  sectionTitle: (ordinal, name) => `${String(ordinal)}° ${name}`,
  summaryColumns: Object.fromEntries(
    SUMMARY_COLUMNS.map((c) => [c, c]),
  ) as StructureLabels['summaryColumns'],
  sheetColumns: { section: 'section', sets: 'sets', elements: 'elements' },
  superColumns: { member: 'member', kind: 'kind' },
  element: 'element',
  set: 'set',
  specialNull: 'null',
  specialSingleton: 'singleton',
  none: '—',
  bag: (n) => `bag ${String(n)}`,
};

export function liveEngine(gd: GedeDoc, labels: StructureLabels = STRUCTURE_LABELS) {
  const engine = new FormulaEngine();
  const results = new Map<string, CellResult>();
  const sync = structureSync(gd, () => labels);
  const feed = (changes: readonly WorkbookChange[]): void => {
    const out = engine.apply(changes);
    for (const id of out.removed) results.delete(id);
    for (const r of out.results) results.set(r.cellId, r);
  };
  const valueOf = (tableId: Id) => (rowId: Id, colId: Id) =>
    results.get(workbookCellId(tableId, cellKey(rowId, colId)))?.value;
  const settle = (): void => {
    for (let pass = 0; pass < 8; pass += 1) {
      const changes = sync.next(valueOf);
      if (changes.length === 0) return;
      feed(changes);
    }
    throw new Error('the structure tables did not settle');
  };
  const stop = observeWorkbook(gd, (changes) => {
    feed(changes);
    settle();
  });
  // Sections and locks live on the sheet map, which `observeWorkbook` does not watch.
  gd.sheets.observeDeep(settle);
  return { engine, results, sync, settle, stop };
}
