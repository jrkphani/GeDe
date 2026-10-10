/**
 * SET-02 / SET-05: a set table's facts, read the way every set formula reads its range
 * column (FX-09). A range cell holding a formula counts the elements of the value the
 * engine's Worker evaluated — nothing is evaluated here — so the footer's `|E| = n` and the
 * meta row's status agree with `Union(E)` over the same column. The engine is subscribed to
 * only while such a cell exists, so a set of typed elements re-renders on its own edits alone.
 */
import { useMemo } from 'react';
import {
  cellKey,
  cellsMap,
  isFormula,
  isSetKind,
  setRangeColumn,
  setTableFacts,
  workbookCellId,
  type SetTableFacts,
  type TableMap,
  type TableRecord,
} from '@gede/core';

import { peekEngine } from '../../../doc/engine.js';
import { useEngineVersion } from '../sort/useTableProjection.js';

export function useSetFacts(table: TableMap, record: TableRecord): SetTableFacts | null {
  const doc = table.doc;
  const formulaRange = useMemo(() => {
    const range = isSetKind(record.kind) ? setRangeColumn(record) : null;
    if (range === null) return false;
    const cells = cellsMap(table);
    return record.rows.some((rowId) => {
      const stored = cells.get(cellKey(rowId, range));
      return stored !== undefined && isFormula(stored);
    });
  }, [table, record]);
  const engineVersion = useEngineVersion(table, formulaRange);
  return useMemo(
    () =>
      setTableFacts(
        table,
        record,
        formulaRange && doc !== null
          ? (rowId, colId) =>
              peekEngine(doc)?.result(workbookCellId(record.id, cellKey(rowId, colId)))?.value
          : undefined,
      ),
    // `engineVersion` ticks when a result arrives: the facts are read again.
    [table, record, formulaRange, doc, engineVersion],
  );
}
