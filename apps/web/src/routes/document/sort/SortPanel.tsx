import { useId, useState } from 'react';
import {
  isEmptyFilter,
  isSortMode,
  isViewActive,
  SORT_MODE_LABELS,
  SORT_MODES,
  tableById,
  type GedeDoc,
  type Id,
  type SortMode,
} from '@gede/core';
import { Button, Select, type SelectOption } from '@gede/ui';

import { useYVersion } from '../../../doc/use-y.js';
import { useTableView } from '../../../doc/view-state.js';
import type { SortCommands } from './commands.js';
import { FilterForm } from './HeaderMenu.js';

export interface SortPanelProps {
  gd: GedeDoc;
  /** The selected table; the panel says so when there is none. */
  tableId: Id | null;
  commands: SortCommands;
}

/** The "none" choice of a column select (a Radix Select value may not be ''). */
const NONE = '__none__';

/**
 * The Organize inspector's Categories · Sort · Filter controls for one table
 * (PRD §18, SORT-01..06). Exported for the inspector integrator; not mounted
 * here. Every control has a keyboard route; the header ▼ menu is the other
 * home of the same commands (KEYS-08 applies to shortcuts, not to these).
 * The view is the viewer's own (ADR-026), so no permission gates it — only a
 * missing table does (MENU-02: disabled with the reason, never hidden).
 */
export function SortPanel({ gd, tableId, commands }: SortPanelProps) {
  useYVersion(gd.tables);
  useTableView(tableId ?? '');
  const record = tableId === null ? null : tableById(gd, tableId);
  const view = tableId === null ? null : commands.view(tableId);
  const sortHeadingId = useId();
  const groupHeadingId = useId();
  const filterHeadingId = useId();
  const [scope, setScope] = useState<Id | null>(null);
  const columns = record?.columns.filter((c) => !c.hidden) ?? [];
  const disabledReason = record === null ? 'select a table first' : null;
  const disabled = disabledReason !== null;
  const filter = view?.filter ?? null;
  const filterScope = isEmptyFilter(filter) ? scope : filter.colId;
  const scopeLabel =
    filterScope === null ? null : (columns.find((c) => c.id === filterScope)?.label ?? null);
  const columnOptions = (none: string): SelectOption<string>[] => [
    { value: NONE, label: none },
    ...columns.map((c) => ({ value: c.id, label: c.label })),
  ];
  const modeOptions: SelectOption<SortMode>[] = SORT_MODES.map((m) => ({
    value: m,
    label: SORT_MODE_LABELS[m],
  }));
  const sortBy = view?.sortBy ?? null;

  return (
    <div className="gd-sort-panel" data-testid="sort-panel">
      {disabledReason !== null && (
        <p className="gd-inspector__note" data-testid="sort-panel-reason">
          Sort, filter and grouping: {disabledReason}.
        </p>
      )}
      <section className="gd-sort-panel__section" aria-labelledby={sortHeadingId}>
        <h3 id={sortHeadingId} className="gd-mono gd-sort-panel__heading">
          sort
        </h3>
        <Select
          label="Column"
          size="sm"
          value={sortBy?.colId ?? NONE}
          disabled={disabled}
          options={columnOptions('None')}
          onValueChange={(colId) => {
            if (tableId === null) return;
            if (colId === NONE) {
              if (sortBy !== null) commands.setSort(tableId, sortBy.colId, null);
              return;
            }
            commands.setSort(tableId, colId, sortBy?.mode ?? 'az');
          }}
        />
        <Select
          label="Order"
          size="sm"
          value={sortBy?.mode ?? 'az'}
          disabled={disabled || sortBy === null}
          options={modeOptions}
          onValueChange={(mode) => {
            if (tableId === null || sortBy === null || !isSortMode(mode)) return;
            commands.setSort(tableId, sortBy.colId, mode);
          }}
        />
      </section>

      <section className="gd-sort-panel__section" aria-labelledby={groupHeadingId}>
        <h3 id={groupHeadingId} className="gd-mono gd-sort-panel__heading">
          categories
        </h3>
        <Select
          label="Group rows by"
          size="sm"
          value={view?.groupBy ?? NONE}
          disabled={disabled}
          options={columnOptions('None')}
          onValueChange={(colId) => {
            if (tableId === null) return;
            commands.setGroupBy(tableId, colId === NONE ? null : colId);
          }}
        />
      </section>

      <section className="gd-sort-panel__section" aria-labelledby={filterHeadingId}>
        <h3 id={filterHeadingId} className="gd-mono gd-sort-panel__heading">
          filter
        </h3>
        <Select
          label="Look in"
          size="sm"
          value={filterScope ?? NONE}
          disabled={disabled}
          options={columnOptions('Any column')}
          onValueChange={(colId) => {
            const next = colId === NONE ? null : colId;
            setScope(next);
            if (tableId !== null && !isEmptyFilter(filter)) {
              commands.setFilter(tableId, { ...filter, colId: next });
            }
          }}
        />
        {tableId !== null && !disabled && (
          <FilterForm
            key={`${tableId}:${JSON.stringify(filter)}`}
            columnLabel={scopeLabel}
            initial={filter ?? { colId: filterScope, text: '', fuzzy: true, facet: null }}
            onApply={(next) => {
              commands.setFilter(tableId, { ...next, colId: filterScope });
            }}
            onClear={() => {
              commands.setFilter(tableId, null);
            }}
          />
        )}
      </section>

      <Button
        size="sm"
        variant="secondary"
        className="gd-sort-panel__clear"
        disabled={disabled || view === null || !isViewActive(view)}
        title={
          disabledReason ??
          (view === null || !isViewActive(view)
            ? 'nothing is sorted, filtered or grouped'
            : undefined)
        }
        onClick={() => {
          if (tableId !== null) commands.clear(tableId);
        }}
      >
        Clear sort, filter and grouping
      </Button>
    </div>
  );
}
