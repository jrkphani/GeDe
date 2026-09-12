import {
  cellKey,
  derivedCellSource,
  readString,
  workbookCellId,
  type DeriveSpec,
  type TableMap,
} from '@gede/core';

import { useCellResult } from '../../../doc/engine.js';
import { useWorkbookIndexVersion } from '../../../doc/workbook-index.js';
import { useLocale } from '../../../locale.js';
import type { CellSelection } from '../selection.js';
import { displayOf, docOf, FormulaCellContent, projectSource } from '../formula/index.js';

export interface DerivedCellProps {
  table: TableMap;
  cell: CellSelection;
  spec: DeriveSpec;
  /** The expression's secondary line needs a wrapped (two-unit) row (GRID-09, ADR-024). */
  expression: boolean;
}

/**
 * A derived column's cell (REF-04). Nothing is stored for it: the engine
 * synthesises `={c:…}.Method(args)` for the row and evaluates it in the
 * Worker; this subscribes to that result and renders it like a formula cell
 * (value, badge, expression in a wrapped row) in accent mono.
 */
export function DerivedCell({ table, cell, spec, expression }: DerivedCellProps) {
  const doc = docOf(table);
  useWorkbookIndexVersion(doc);
  const [locale] = useLocale();
  const tableId = readString(table, 'id');
  const source = derivedCellSource(tableId, cell.rowId, spec);
  const result = useCellResult(doc, workbookCellId(tableId, cellKey(cell.rowId, cell.colId)));
  const display = displayOf(locale, source, projectSource(doc, source), result);
  return (
    <FormulaCellContent
      display={display}
      expression={expression}
      className="gd-ref gd-ref--derived"
    />
  );
}
