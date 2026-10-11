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
  cross,
  crossCardinality,
  crossTuples,
  dedupe,
  difference,
  intersection,
  MAX_CROSS_TUPLES,
  power,
  powerCardinality,
  spreadMemberLabel,
  tableMap,
  union,
  setTableFacts,
  unenclosableElement,
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

/**
 * A set table's elements as the formulas read them: split on FX-09's separators, NFC, a typed
 * number, date or currency in its canonical spelling, a lost row left out (`setTableFacts`).
 */
function elementsOf(gd: GedeDoc, tableId: Id): string[] {
  const table = tableMap(gd, tableId);
  const facts = table === null ? null : setTableFacts(table);
  if (facts === null) return [];
  return dedupe(
    [...facts.rows.values()].flatMap((row) => (row.kind === 'element' ? row.elements : [])),
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
      // The evaluator refuses an element that would read as two once braced (Add reports it).
      return unenclosableElement(sets[0] ?? []) !== undefined ||
        powerCardinality(sets[0] ?? []) > MAX_CROSS_TUPLES
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
