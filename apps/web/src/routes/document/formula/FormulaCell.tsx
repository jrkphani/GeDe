import { cellKey, type TableMap } from '@gede/core';

import type { CellSelection } from '../selection.js';
import { FormulaCellContent } from './FormulaCellContent.js';
import { useCellDisplay } from './use-cell-display.js';

export interface FormulaCellProps {
  table: TableMap;
  cell: CellSelection;
  /** The expression's secondary line needs a wrapped (two-unit) row (GRID-09). */
  expression: boolean;
}

/**
 * The body of a formula cell inside the grid (FX-07). A separate component
 * so only formula cells subscribe to the engine; text cells stay as cheap as
 * they were.
 */
export function FormulaCell({ table, cell, expression }: FormulaCellProps) {
  const display = useCellDisplay(table, cellKey(cell.rowId, cell.colId));
  return <FormulaCellContent display={display} expression={expression} />;
}
