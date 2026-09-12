/**
 * The projected rows of one table (SORT-01..05): what `TableView` renders in
 * place of `record.rows` when the viewer has a sort, filter or grouping on
 * it. The view comes from the viewer's store (ADR-026), the texts from the
 * document, a formula's text from the engine's result for that cell (FX-07,
 * so a derived column sorts and facets by value), and the projection is
 * computed in the sort Worker; this hook only holds the last answer.
 *
 * Which bands are collapsed is viewer state here too: a phone or view-only
 * participant must still be able to expand groups (PRD §23, RESP-02).
 *
 * While a cell in the table is being edited the projection is held: the row
 * under the caret must not jump to its sorted place mid-keystroke. The held
 * projection is refreshed as soon as the edit ends.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  buildProjectionInput,
  isViewActive,
  normaliseTableView,
  workbookCellId,
  type Band,
  type CellKey,
  type Id,
  type TableMap,
  type TableRecord,
  type TableViewState,
  type ViewProjection,
} from '@gede/core';

import { engineFor, peekEngine } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import { useTableView } from '../../../doc/view-state.js';
import { createViewProjector, type ViewProjector } from './view-client.js';

export interface TableProjection {
  /** The viewer's view, validated against the table's columns. */
  readonly view: TableViewState;
  /** True when a sort, filter or grouping is in force. */
  readonly active: boolean;
  /** Rows to render, in view order — `record.rows` when nothing is in force. */
  readonly rowIds: readonly Id[];
  /** Bands in view order when grouped, else null (SORT-05). */
  readonly bands: readonly Band[] | null;
  /** Under grouping, entirely empty rows after the bands. */
  readonly loose: readonly Id[];
  /** Rows the filter removed. */
  readonly hidden: number;
  readonly collapsed: ReadonlySet<string>;
  readonly toggleBand: (key: string) => void;
}

let shared: ViewProjector | null = null;

/** One Worker for every table of every open document. */
export function sharedProjector(): ViewProjector {
  shared ??= createViewProjector();
  return shared;
}

/** Test seam: replace the shared projector (e.g. with a main-thread one). */
export function setSharedProjectorForTests(projector: ViewProjector | null): void {
  shared?.dispose();
  shared = projector;
}

const EMPTY: readonly Id[] = [];
const NO_SET: ReadonlySet<string> = new Set();

/**
 * Reconcile a projection with the rows the table has *now*: rows deleted since
 * drop out, rows added since (a collaborator's, or one appended past the last
 * row — GRID-05) render at once, at the end, until the next projection places
 * them. Bands keep only rows that still exist.
 */
function reconcile(
  projection: ViewProjection,
  rows: readonly Id[],
): Pick<ViewProjection, 'rowIds' | 'bands' | 'loose'> & { hidden: number } {
  const present = new Set(rows);
  const seen = new Set<Id>();
  const rowIds: Id[] = [];
  for (const id of projection.rowIds) {
    if (present.has(id)) {
      rowIds.push(id);
      seen.add(id);
    }
  }
  let hidden = 0;
  for (const id of projection.hiddenRowIds) {
    if (present.has(id)) {
      seen.add(id);
      hidden += 1;
    }
  }
  const added = rows.filter((id) => !seen.has(id));
  rowIds.push(...added);
  const bands =
    projection.bands === null
      ? null
      : projection.bands
          .map((b) => ({ ...b, rowIds: b.rowIds.filter((id) => present.has(id)) }))
          .filter((b) => b.rowIds.length > 0);
  const loose = [...projection.loose.filter((id) => present.has(id)), ...added];
  return { rowIds, bands, loose, hidden };
}

/** The formula engine's result version for a document: ticks when any cell's value changes. */
function useEngineVersion(table: TableMap, wanted: boolean): number {
  const doc = table.doc;
  useEffect(() => {
    if (wanted && doc !== null) engineFor(doc);
  }, [doc, wanted]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!wanted || doc === null) return () => undefined;
      return engineFor(doc).subscribeAll(onChange);
    },
    [doc, wanted],
  );
  return useSyncExternalStore(
    subscribe,
    () => (doc === null ? 0 : (peekEngine(doc)?.version ?? 0)),
    () => 0,
  );
}

export function useTableProjection(
  table: TableMap,
  record: TableRecord,
  locale: string,
  hold: boolean,
): TableProjection {
  const version = useYVersion(table);
  const stored = useTableView(record.id);
  const columnKey = record.columns.map((c) => c.id).join(',');
  const view = useMemo(
    () => normaliseTableView(stored, new Set(columnKey.split(','))),
    [stored, columnKey],
  );
  const active = isViewActive(view);
  const engineVersion = useEngineVersion(table, active);
  const [result, setResult] = useState<{ tableId: Id; projection: ViewProjection } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    // A held projection is not re-requested; `hold` is a dependency, so lifting it
    // re-projects with whatever changed meanwhile.
    if (!active || hold) return;
    let cancelled = false;
    const doc = table.doc;
    const engine = doc === null ? undefined : peekEngine(doc);
    const tableId = record.id;
    const input = buildProjectionInput(table, view, locale, {
      cellValue: (key: CellKey) => engine?.result(workbookCellId(tableId, key))?.value,
    });
    void sharedProjector()
      .project(tableId, input)
      .then((r) => {
        if (cancelled || !r.ok) return;
        setResult({ tableId, projection: r.projection });
      });
    return () => {
      cancelled = true;
    };
    // `version` (the table) and `engineVersion` (formula results) tick on every change.
  }, [table, record.id, view, locale, version, engineVersion, active, hold]);

  const toggleBand = useCallback((bandKey: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(bandKey)) next.delete(bandKey);
      else next.add(bandKey);
      return next;
    });
  }, []);

  return useMemo<TableProjection>(() => {
    if (!active) {
      return {
        view,
        active,
        rowIds: record.rows,
        bands: null,
        loose: EMPTY,
        hidden: 0,
        collapsed: NO_SET,
        toggleBand,
      };
    }
    // Before the first answer (or after the table changed identity) the rows render as
    // stored; the projection lands a frame later — never a blank table.
    if (result?.tableId !== record.id) {
      return {
        view,
        active,
        rowIds: record.rows,
        bands: null,
        loose: EMPTY,
        hidden: 0,
        collapsed,
        toggleBand,
      };
    }
    const { rowIds, bands, loose, hidden } = reconcile(result.projection, record.rows);
    return {
      view,
      active,
      rowIds,
      bands: view.groupBy === null ? null : bands,
      loose,
      hidden,
      collapsed,
      toggleBand,
    };
  }, [active, view, record.id, record.rows, result, collapsed, toggleBand]);
}
