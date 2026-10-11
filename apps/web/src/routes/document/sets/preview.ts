/**
 * SET-01 (Derive design): what Add table would put in a computed table, shown before it is
 * added. The operands are the typed texts of the picked sets' range columns, combined with
 * core's set functions; the real table is still filled by the Worker after Add.
 *
 * shortcut: this is the operand-level set algebra on the main thread, not a formula
 * evaluation (no parse, no engine); bounded by MAX_CROSS_TUPLES. Move it behind an engine
 * request if a preview ever needs a formula the picker cannot write.
 */
import {
  cellText,
  cross,
  crossCardinality,
  crossTuples,
  dedupe,
  difference,
  intersection,
  MAX_CROSS_TUPLES,
  power,
  powerCardinality,
  rowsArray,
  spreadMemberLabel,
  tableMap,
  union,
  setRangeColumn,
  tableById,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { pickFormula, type SetPick } from './set-tables.js';

/** Rows the preview draws; the count states the rest. */
export const PREVIEW_ROWS = 6;

export interface ResultPreview {
  /** Header cells: one per column the table would fill. */
  readonly heads: readonly string[];
  /** The first `PREVIEW_ROWS` result rows, a cell per head. */
  readonly rows: readonly (readonly string[])[];
  /** Every result row. */
  readonly total: number;
}

function elementsOf(gd: GedeDoc, tableId: Id): string[] {
  const record = tableById(gd, tableId);
  const table = tableMap(gd, tableId);
  const colId = record === null ? null : setRangeColumn(record);
  if (table === null || colId === null) return [];
  return dedupe(
    rowsArray(table)
      .toArray()
      .map((rowId) => cellText(table, rowId, colId).trim())
      .filter((text) => text !== ''),
  );
}

/** The result of a pick, or null when it is too large to show (Add itself then reports it). */
export function previewPick(gd: GedeDoc, pick: SetPick, rangeHead: string): ResultPreview | null {
  const sets = pick.sets.map((id) => elementsOf(gd, id));
  const single = (items: readonly string[]): ResultPreview => ({
    heads: [rangeHead],
    rows: items.slice(0, PREVIEW_ROWS).map((e) => [e]),
    total: items.length,
  });
  switch (pick.op) {
    case 'Union':
      return single(union(sets));
    case 'Inter':
      return single(intersection(sets));
    case 'Diff':
      return single(difference(sets));
    case 'Power':
      return powerCardinality(sets[0] ?? []) > MAX_CROSS_TUPLES
        ? null
        : single(power(sets[0] ?? []));
    case 'Cross': {
      const total = crossCardinality(sets);
      if (total > MAX_CROSS_TUPLES) return null;
      if (pick.shape === 'column') return single(cross(sets));
      const formula = pickFormula(gd, pick);
      return {
        heads: sets.map((_, i) => spreadMemberLabel(gd, formula, i)),
        rows: crossTuples(sets).slice(0, PREVIEW_ROWS),
        total,
      };
    }
  }
}
