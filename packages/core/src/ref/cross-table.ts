/**
 * Cross-table references as the guided tour counts them (ONB-05, step 2):
 * a committed formula cell at least one of whose id-bound references points
 * at a different table than the cell's own. Reference cells (`=@Team.Priya.Role`,
 * REF-01) count; so does `=Sum(@Team.Priya.Capacity, B5)`; a formula whose
 * references stay inside its table does not. The tour compares the count
 * against the one it took when the step began, so a reference the sample
 * shipped with never advances the step by itself.
 */
import { cellsMap, isFormula, type GedeDoc } from '../doc/schema.js';
import { references } from '../formula/ast.js';
import { parse } from '../formula/parser.js';
import type { Id } from '../ids.js';

/** Table ids the formula's bound references point at (unbound spellings have none). */
export function boundTableIds(source: string): Set<Id> {
  const out = new Set<Id>();
  if (!source.startsWith('=') || !source.includes('{')) return out;
  const parsed = parse(source);
  if (!parsed.ok) return out;
  for (const ref of references(parsed.value)) {
    if (ref.kind !== 'bound') continue;
    const bound = ref.ref;
    if (bound.kind === 'column') {
      for (const column of bound.columns) out.add(column.tableId);
    } else {
      out.add(bound.tableId);
    }
  }
  return out;
}

/** Whether a stored formula in `ownTableId` references any other table. */
export function isCrossTableFormula(source: string, ownTableId: Id): boolean {
  for (const tableId of boundTableIds(source)) {
    if (tableId !== ownTableId) return true;
  }
  return false;
}

/** Formula cells in the document that reference another table. */
export function crossTableReferenceCount(gd: GedeDoc): number {
  let count = 0;
  gd.tables.forEach((table, tableId) => {
    cellsMap(table).forEach((content) => {
      if (isFormula(content) && isCrossTableFormula(content, tableId)) count += 1;
    });
  });
  return count;
}
