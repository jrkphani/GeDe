import { cellKey, type CellFormat, type TableMap } from '@gede/core';

import type { CellSelection } from '../selection.js';
import { FormulaCellContent } from './FormulaCellContent.js';
import { useCellDisplay } from './use-cell-display.js';

export interface FormulaCellProps {
  table: TableMap;
  cell: CellSelection;
  /** The expression's secondary line needs a wrapped (two-unit) row (GRID-09). */
  expression: boolean;
  /**
   * The cell's effective format (column, or its own override), as the grid
   * resolved it for this render: the result renders under it (PRD §22).
   * Read from the table when absent.
   */
  format?: CellFormat | undefined;
}

/**
 * The body of a formula cell inside the grid (FX-07). A separate component
 * so only formula cells subscribe to the engine; text cells stay as cheap as
 * they were.
 */
export function FormulaCell({ table, cell, expression, format }: FormulaCellProps) {
  const display = useCellDisplay(table, cellKey(cell.rowId, cell.colId), format);
  return <FormulaCellContent display={display} expression={expression} />;
}
