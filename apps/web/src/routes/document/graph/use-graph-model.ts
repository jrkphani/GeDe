/**
 * The live model behind one graph pair (GRAPH-06 "recompute live from the
 * table"): the source table's input, its derivation, the ring layout and the
 * per-column distinct counts. Re-derives when the table changes (its map is
 * watched deeply) or when the formula engine reports new values — a formula
 * cell in a dimension column contributes its evaluated value, never its
 * source. The derivation is `@gede/core`'s; this hook only feeds it.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  cellKey,
  cellsMap,
  cellText,
  deriveGraph,
  distinctValueCount,
  graphInputOf,
  isFormula,
  ringLayout,
  tableById,
  tableMap,
  workbookCellId,
  type GedeDoc,
  type GraphDerivation,
  type GraphInput,
  type GraphRecord,
  type Id,
  type RingLayout,
  type TableMap,
  type TableRecord,
} from '@gede/core';

import { engineFor, peekEngine } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import { useLocale } from '../../../locale.js';
import { toFormatLocale } from '../cell/index.js';
import { formatCellValue } from '../formula/index.js';

export interface GraphModel {
  readonly table: TableMap | null;
  readonly record: TableRecord | null;
  readonly input: GraphInput;
  readonly derivation: GraphDerivation;
  readonly ring: RingLayout;
  /** Distinct non-empty values per eligible column id (GRAPH-05 checklist). */
  readonly distinct: ReadonlyMap<Id, number>;
}

const EMPTY_INPUT: GraphInput = { columns: [], rows: [], dimensions: [] };

/** A counter that ticks whenever any engine result for the document changes. */
function useEngineVersion(gd: GedeDoc): number {
  useEffect(() => {
    engineFor(gd.doc);
  }, [gd]);
  const version = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) =>
      engineFor(gd.doc).subscribeAll(() => {
        version.current += 1;
        onChange();
      }),
    [gd],
  );
  return useSyncExternalStore(
    subscribe,
    () => version.current,
    () => 0,
  );
}

export function useGraphModel(gd: GedeDoc, graph: GraphRecord): GraphModel {
  const table = graph.tableId === null ? null : tableMap(gd, graph.tableId);
  const tableVersion = useYVersion(table);
  const engineVersion = useEngineVersion(gd);
  const [activeLocale] = useLocale();
  const locale = toFormatLocale(activeLocale);
  const dimensionsKey = graph.dimensions.join(',');
  return useMemo(() => {
    const tableId = graph.tableId;
    const record = table === null || tableId === null ? null : tableById(gd, tableId);
    if (table === null || record === null || tableId === null) {
      const derivation = deriveGraph(EMPTY_INPUT);
      return {
        table: null,
        record: null,
        input: EMPTY_INPUT,
        derivation,
        ring: ringLayout(derivation),
        distinct: new Map<Id, number>(),
      };
    }
    const cells = cellsMap(table);
    const engine = peekEngine(gd.doc);
    const read = (rowId: Id, colId: Id): string => {
      const key = cellKey(rowId, colId);
      const content = cells.get(key);
      if (content === undefined) return '';
      if (!isFormula(content)) return cellText(table, rowId, colId);
      const value = engine?.result(workbookCellId(tableId, key))?.value ?? null;
      return value === null ? '' : formatCellValue(locale, value);
    };
    const input = graphInputOf(table, graph.dimensions, read, record);
    const derivation = deriveGraph(input);
    const distinct = new Map<Id, number>();
    for (const c of input.columns) {
      if (c.eligible) distinct.set(c.id, distinctValueCount(input.rows, c.id));
    }
    return { table, record, input, derivation, ring: ringLayout(derivation), distinct };
    // tableVersion and engineVersion are the change signals for the reads above;
    // dimensionsKey stands for graph.dimensions (a fresh array each record read).
  }, [gd, table, graph.tableId, dimensionsKey, tableVersion, engineVersion, locale]);
}
