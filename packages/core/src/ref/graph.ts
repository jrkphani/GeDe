/**
 * REF-05 for graphs (PRD §19 "Derived, linked and pulled columns are not
 * offered — a context must be typeable back into its table"). The graph
 * inspector's dimension checklist filters its source table's columns
 * through this predicate; nothing else decides.
 */
import type { ColumnRecord } from '../doc/schema.js';

export function isGraphDimensionCandidate(column: Pick<ColumnRecord, 'source'>): boolean {
  return column.source === 'entered';
}
