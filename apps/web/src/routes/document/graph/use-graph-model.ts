/**
 * The live model behind one graph pair (GRAPH-06 "recompute live from the
 * table"): the source table's input, its derivation, the ring layout and the
 * per-column distinct counts. Re-derives when the table changes or when the
 * formula engine reports new values — a formula cell in a dimension column
 * contributes its evaluated value, never its source. The derivation is
 * `@gede/core`'s; this hook only feeds it.
 *
 * Derived once per pair: the store caches the model by (table, dimensions,
 * change counters, locale), so both halves and the Graph tab share one
 * derivation. When a change leaves the derivation structurally equal (a
 * keystroke in a column that is not a dimension), the previous derivation
 * and layout objects are kept, so the memoised SVG halves do not re-render.
 */
import { useMemo } from 'react';
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

import { peekEngine } from '../../../doc/engine.js';
import { useLocale, type Locale } from '../../../locale.js';
import { toFormatLocale } from '../cell/index.js';
import { formatCellValue } from '../formula/index.js';
import { graphStoreFor, useGraphVersions } from './store.js';

export interface GraphModel {
  readonly table: TableMap | null;
  readonly record: TableRecord | null;
  readonly input: GraphInput;
  /** Referentially stable while structurally unchanged. */
  readonly derivation: GraphDerivation;
  /** Referentially stable while the derivation is. */
  readonly ring: RingLayout;
  /** Distinct non-empty values per eligible column id (GRAPH-05 checklist). */
  readonly distinct: ReadonlyMap<Id, number>;
}

const EMPTY_INPUT: GraphInput = { columns: [], rows: [], dimensions: [] };

/** Structural equality of two derivations: plain data, so JSON is exact. */
export function sameDerivation(a: GraphDerivation, b: GraphDerivation): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useGraphModel(gd: GedeDoc, graph: GraphRecord): GraphModel {
  const versions = useGraphVersions(gd.doc, graph.tableId);
  const [activeLocale] = useLocale();
  const locale = toFormatLocale(activeLocale);
  const key = [
    graph.tableId ?? '',
    graph.dimensions.join(','),
    versions.table,
    versions.structure,
    versions.engine,
    locale,
  ].join('|');
  const store = graphStoreFor(gd.doc);
  const { pairId } = graph;
  return useMemo(
    () =>
      store.model<GraphModel>(pairId, key, (previous) => {
        const next = computeModel(gd, graph, locale);
        if (previous !== null && sameDerivation(previous.derivation, next.derivation)) {
          return { ...next, derivation: previous.derivation, ring: previous.ring };
        }
        return next;
      }),
    // `key` names every read the computation makes (table, dimensions, versions, locale);
    // the record itself is only read when the key changes.
    [store, pairId, key, gd],
  );
}

function computeModel(gd: GedeDoc, graph: GraphRecord, locale: Locale): GraphModel {
  const tableId = graph.tableId;
  const table = tableId === null ? null : tableMap(gd, tableId);
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
    const k = cellKey(rowId, colId);
    const content = cells.get(k);
    if (content === undefined) return '';
    if (!isFormula(content)) return cellText(table, rowId, colId);
    const value = engine?.result(workbookCellId(tableId, k))?.value ?? null;
    return value === null ? '' : formatCellValue(locale, value);
  };
  const input = graphInputOf(table, graph.dimensions, read, record);
  const derivation = deriveGraph(input);
  const distinct = new Map<Id, number>();
  for (const c of input.columns) {
    if (c.eligible) distinct.set(c.id, distinctValueCount(input.rows, c.id));
  }
  return { table, record, input, derivation, ring: ringLayout(derivation), distinct };
}
