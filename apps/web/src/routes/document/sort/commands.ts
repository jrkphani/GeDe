/**
 * Sort, filter and group commands (SORT-01, SORT-05, SORT-06) — the contract
 * the header menu, the filter popover and `SortPanel` call. They write the
 * viewer's own view store (ADR-026), never the document: no permission is
 * needed (a view-only participant sorts their own screen), nothing syncs,
 * and nothing is an undo step (KEYS-03 undoes document edits). Each command
 * announces its outcome (A11Y-05). Nothing here touches the DOM.
 */
import { useMemo } from 'react';
import {
  FACET_LABELS,
  isEmptyFilter,
  normaliseTableView,
  SORT_MODE_LABELS,
  tableById,
  type GedeDoc,
  type Id,
  type SortBy,
  type SortMode,
  type TableFilter,
  type TableViewState,
} from '@gede/core';

import { announce } from '../../../announce.js';
import type { ViewStore } from '../../../doc/view-state.js';

export interface SortCommands {
  /** SORT-01: sort by a column in a mode; `null` mode is None. Returns what was stored. */
  setSort(tableId: Id, colId: Id, mode: SortMode | null): SortBy | null;
  /**
   * SORT-01, SORT-03, SORT-04: the table's filter, or `null` to clear it.
   * `announce: false` writes quietly — a live form calls this per keystroke
   * (INSP-12) and announces once the field settles.
   */
  setFilter(
    tableId: Id,
    filter: TableFilter | null,
    options?: { announce?: boolean | undefined },
  ): TableFilter | null;
  /** SORT-05, HIER-08: group by a column, or `null` to remove the grouping. */
  setGroupBy(tableId: Id, colId: Id | null): Id | null;
  /** SORT-06: reset sort, filter and grouping for the table in one action. */
  clear(tableId: Id): boolean;
  /** The view in force for a table, validated against its columns; null for an unknown table. */
  view(tableId: Id): TableViewState | null;
}

export interface SortCommandDeps {
  gd: GedeDoc;
  store: ViewStore;
  announce: (text: string) => void;
}

/** The sentence the filter reads as, for announcements and the header's title. */
export function describeFilter(filter: TableFilter, columnLabel: string | null): string {
  const parts: string[] = [];
  if (filter.text.trim() !== '') {
    parts.push(`${filter.fuzzy ? 'roughly contains' : 'contains'} “${filter.text.trim()}”`);
  }
  if (filter.facet !== null) parts.push(`has a ${FACET_LABELS[filter.facet]}`);
  const where = columnLabel ?? 'any column';
  return `${where} ${parts.join(' and ')}`;
}

export function createSortCommands(deps: SortCommandDeps): SortCommands {
  const { gd, store } = deps;
  const columnIds = (tableId: Id): ReadonlySet<Id> | null => {
    const record = tableById(gd, tableId);
    return record === null ? null : new Set(record.columns.map((c) => c.id));
  };
  const labelOf = (tableId: Id, colId: Id | null): string | null =>
    colId === null
      ? null
      : (tableById(gd, tableId)?.columns.find((c) => c.id === colId)?.label ?? null);
  const view = (tableId: Id): TableViewState | null => {
    const ids = columnIds(tableId);
    return ids === null ? null : normaliseTableView(store.get(tableId), ids);
  };

  return {
    setSort(tableId, colId, mode) {
      const ids = columnIds(tableId);
      const current = view(tableId);
      if (ids === null || current === null) return null;
      const sortBy = mode !== null && ids.has(colId) ? { colId, mode } : null;
      store.set(tableId, { ...current, sortBy });
      deps.announce(
        sortBy === null
          ? 'Sort cleared'
          : `Sorted ${labelOf(tableId, sortBy.colId) ?? 'column'} ${SORT_MODE_LABELS[sortBy.mode]}`,
      );
      return sortBy;
    },
    setFilter(tableId, filter, options) {
      const ids = columnIds(tableId);
      const current = view(tableId);
      if (ids === null || current === null) return null;
      let next: TableFilter | null = isEmptyFilter(filter) ? null : filter;
      if (next?.colId != null && !ids.has(next.colId)) next = { ...next, colId: null };
      store.set(tableId, { ...current, filter: next });
      if (options?.announce === false) return next;
      deps.announce(
        next === null
          ? 'Filter cleared'
          : `Filtered: ${describeFilter(next, labelOf(tableId, next.colId))}`,
      );
      return next;
    },
    setGroupBy(tableId, colId) {
      const ids = columnIds(tableId);
      const current = view(tableId);
      if (ids === null || current === null) return null;
      const groupBy = colId !== null && ids.has(colId) ? colId : null;
      store.set(tableId, { ...current, groupBy });
      deps.announce(
        groupBy === null
          ? 'Grouping removed'
          : `Grouped by ${labelOf(tableId, groupBy) ?? 'column'}`,
      );
      return groupBy;
    },
    clear(tableId) {
      if (columnIds(tableId) === null) return false;
      store.clear(tableId);
      deps.announce('Sort, filter and grouping cleared');
      return true;
    },
    view,
  };
}

/** One instance per open document, stable across renders so `TableView` stays memoised. */
export function useSortCommands(gd: GedeDoc, store: ViewStore): SortCommands {
  return useMemo(() => createSortCommands({ gd, store, announce }), [gd, store]);
}
