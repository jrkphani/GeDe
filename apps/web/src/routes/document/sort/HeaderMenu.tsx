import clsx from 'clsx';
import { useRef, useState, type SyntheticEvent } from 'react';
import {
  FACET_KINDS,
  FACET_LABELS,
  isEmptyFilter,
  isFacetKind,
  isViewActive,
  SORT_MODE_LABELS,
  SORT_MODES,
  type ColumnRecord,
  type Id,
  type SortMode,
  type TableFilter,
  type TableViewState,
} from '@gede/core';
import { Button, Icon, Menu, Popover, Select, Switch, TextField, type MenuEntry } from '@gede/ui';

import { describeFilter, type SortCommands } from './commands.js';

export interface HeaderMenuProps {
  tableId: Id;
  column: ColumnRecord;
  view: TableViewState;
  commands: SortCommands;
  /** Roving tab stop: Tab reaches the ▼ of the selected column only, like the column divider. */
  tabStop: boolean;
  /**
   * HIER-04 / ADR-051: "Use as outline column" — the table's default outline
   * column, a document write beside the viewer's own sort, filter and group.
   * Absent for a viewer who cannot write the document (the item is not shown).
   */
  outline?:
    | {
        readonly checked: boolean;
        readonly disabledReason?: string | undefined;
        readonly onCheckedChange: (on: boolean) => void;
      }
    | undefined;
}

/** The sort mode the menu shows for this column: its own, or None. */
export function sortModeOf(view: TableViewState, colId: Id): SortMode | 'none' {
  return view.sortBy !== null && view.sortBy.colId === colId ? view.sortBy.mode : 'none';
}

export interface HeaderGlyph {
  readonly icon: 'arrow-up' | 'arrow-down' | 'sort' | 'search';
  readonly label: string;
}

/**
 * SORT-01: the header's state glyphs — ↑ for A–Z, ↓ for Z–A, ⇅ for the volume
 * and frequency modes, and ⌕ when the filter reads this column (a filter over
 * every column marks every header). A column both sorted and filtered shows
 * both, sort first.
 */
export function headerGlyphs(view: TableViewState, colId: Id): readonly HeaderGlyph[] {
  const out: HeaderGlyph[] = [];
  const mode = sortModeOf(view, colId);
  if (mode === 'az') out.push({ icon: 'arrow-up', label: 'sorted A–Z' });
  else if (mode === 'za') out.push({ icon: 'arrow-down', label: 'sorted Z–A' });
  else if (mode !== 'none')
    out.push({ icon: 'sort', label: `sorted by ${SORT_MODE_LABELS[mode]}` });
  if (!isEmptyFilter(view.filter) && (view.filter.colId === null || view.filter.colId === colId)) {
    out.push({
      icon: 'search',
      label: view.filter.colId === null ? 'filtered (any column)' : 'filtered',
    });
  }
  return out;
}

/** `aria-sort` for the column header (WAI-ARIA grid): only the sorted column carries one. */
export function ariaSortOf(
  view: TableViewState,
  colId: Id,
): 'ascending' | 'descending' | 'other' | undefined {
  const mode = sortModeOf(view, colId);
  if (mode === 'none') return undefined;
  if (mode === 'az') return 'ascending';
  if (mode === 'za') return 'descending';
  return 'other';
}

/**
 * The column header's ▼ (SORT-01, MENU-03): a Radix menu with the six sort
 * modes, the group toggle and Clear, plus "Filter this column…" which opens
 * the filter panel — a popover, because a text field is not a menu item (it
 * would be neither Tab-reachable nor axe-clean inside one).
 */
export function HeaderMenu({ tableId, column, view, commands, tabStop, outline }: HeaderMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  // The popover anchors to the ▼'s wrapper; an element, so Radix can measure it.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  // The scope the open panel edits, fixed when it opens: a filter that read every column keeps
  // that scope for the whole edit, even through a keystroke that empties the field (live writes
  // clear the stored filter, which would otherwise re-scope the next one to this column).
  const [panelScope, setPanelScope] = useState<Id | null>(null);
  // Set when "Filter this column…" was chosen: the menu's close hands focus to the panel.
  const openFilterOnClose = useRef(false);
  const mode = sortModeOf(view, column.id);
  const grouped = view.groupBy === column.id;
  const filter = view.filter;
  // The filter this menu edits: one scoped to this column, or the any-column one.
  const filteredHere =
    !isEmptyFilter(filter) && (filter.colId === column.id || filter.colId === null);
  const active = isViewActive(view);

  const entries: MenuEntry[] = [
    {
      kind: 'radio',
      id: 'sort',
      label: 'Sort',
      value: mode,
      onValueChange: (value) => {
        commands.setSort(tableId, column.id, value === 'none' ? null : (value as SortMode));
      },
      options: [
        { value: 'none', label: 'None' },
        ...SORT_MODES.map((m) => ({ value: m, label: SORT_MODE_LABELS[m] })),
      ],
    },
    { kind: 'separator', id: 's1' },
    {
      kind: 'check',
      id: 'group',
      label: 'Group rows by this column',
      checked: grouped,
      onCheckedChange: (checked) => {
        commands.setGroupBy(tableId, checked ? column.id : null);
      },
    },
    { kind: 'separator', id: 's2' },
    {
      kind: 'item',
      id: 'filter',
      label: filteredHere
        ? `Filter: ${describeFilter(filter, filter.colId === null ? null : column.label)}…`
        : 'Filter this column…',
      onSelect: () => {
        openFilterOnClose.current = true;
      },
    },
    {
      kind: 'item',
      id: 'clear',
      label: 'Clear sort, filter and grouping',
      disabledReason: active ? undefined : 'nothing is sorted, filtered or grouped',
      onSelect: () => {
        commands.clear(tableId);
      },
    },
    ...(outline === undefined
      ? []
      : ([
          { kind: 'separator', id: 's3' },
          {
            kind: 'check',
            id: 'outline-column',
            label: 'Use as outline column',
            checked: outline.checked,
            disabledReason: outline.disabledReason,
            onCheckedChange: outline.onCheckedChange,
          },
        ] satisfies MenuEntry[])),
  ];

  return (
    <>
      <span className="gd-hmenu" ref={setAnchor}>
        <Menu
          label={`${column.label} column`}
          align="end"
          modal={false}
          entries={entries}
          onCloseAutoFocus={(event) => {
            if (!openFilterOnClose.current) return;
            openFilterOnClose.current = false;
            event.preventDefault();
            setPanelScope(filteredHere && filter.colId === null ? null : column.id);
            setFilterOpen(true);
          }}
          trigger={
            <Button
              ref={trigger}
              size="sm"
              variant="ghost"
              className={clsx('gd-hmenu__trigger', { 'gd-hmenu__trigger--active': active })}
              icon={<Icon name="chevron-down" size={13} />}
              aria-label={`Sort, filter or group ${column.label}`}
              title="Sort, filter or group this column"
              tabIndex={tabStop ? 0 : -1}
              onPointerDown={(e) => {
                e.stopPropagation();
              }}
            />
          }
        />
      </span>
      <Popover
        open={filterOpen}
        onOpenChange={setFilterOpen}
        label={`Filter ${column.label}`}
        anchor={anchor}
        align="end"
        keepFocus={false}
        returnFocusTo={trigger.current}
        className="gd-filter-popover"
      >
        {filterOpen && (
          <FilterForm
            columnLabel={filteredHere && filter.colId === null ? null : column.label}
            initial={
              filteredHere ? filter : { colId: column.id, text: '', fuzzy: true, facet: null }
            }
            onChange={(next, settled) => {
              // INSP-12: live. A filter that read every column keeps that scope; a new one
              // reads this column. Escape closes the panel; focus returns to the ▼ (MENU-05).
              commands.setFilter(tableId, { ...next, colId: panelScope }, { announce: settled });
            }}
            onClear={() => {
              commands.setFilter(tableId, null);
              setFilterOpen(false);
            }}
          />
        )}
      </Popover>
    </>
  );
}

export interface FilterFormProps {
  /** Names the scope in the field label; null when the filter reads every column. */
  columnLabel: string | null;
  initial: TableFilter;
  /**
   * INSP-12: called on every change, live. `settled` is true when the change is
   * a whole step (a switch, a facet, Enter, or the field losing focus) and
   * false per keystroke, so the caller can announce once rather than per key.
   */
  onChange: (filter: TableFilter, settled: boolean) => void;
  onClear: () => void;
}

/**
 * The contains / fuzzy / facet form (SORT-01, SORT-03, SORT-04). Live: every
 * change reaches the viewer's own view at once (INSP-12 — no Apply step); a
 * view is per user (ADR-026), so nothing here ever waits on sync.
 */
export function FilterForm({ columnLabel, initial, onChange, onClear }: FilterFormProps) {
  const [text, setText] = useState(initial.text);
  const [fuzzy, setFuzzy] = useState(initial.fuzzy);
  const [facet, setFacet] = useState(initial.facet);
  // Keystrokes since the last settle: a blur announces only what typing changed, so tabbing
  // through an untouched field (empty or not) never announces "Filter cleared" for nothing.
  const typed = useRef(false);
  const emit = (
    next: { text?: string; fuzzy?: boolean; facet?: TableFilter['facet'] },
    settled: boolean,
  ) => {
    onChange(
      {
        colId: initial.colId,
        text: (next.text ?? text).trim(),
        fuzzy: next.fuzzy ?? fuzzy,
        facet: next.facet === undefined ? facet : next.facet,
      },
      settled,
    );
  };
  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    typed.current = false;
    emit({}, true);
  };
  return (
    <form className="gd-filter" onSubmit={submit}>
      <TextField
        label={columnLabel === null ? 'Any column contains' : `${columnLabel} contains`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          typed.current = true;
          emit({ text: e.target.value }, false);
        }}
        onBlur={() => {
          if (!typed.current) return;
          typed.current = false;
          emit({}, true);
        }}
        autoComplete="off"
        spellCheck={false}
      />
      <Switch
        label="Fuzzy match — tolerates typos"
        checked={fuzzy}
        onCheckedChange={(on) => {
          setFuzzy(on);
          emit({ fuzzy: on }, true);
        }}
      />
      <Select
        label="Has an entity"
        size="sm"
        value={facet ?? 'none'}
        onValueChange={(v) => {
          const next = isFacetKind(v) ? v : null;
          setFacet(next);
          emit({ facet: next }, true);
        }}
        options={[
          { value: 'none', label: 'Any text' },
          ...FACET_KINDS.map((k) => ({ value: k, label: FACET_LABELS[k] })),
        ]}
      />
      <div className="gd-filter__actions">
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear filter
        </Button>
      </div>
    </form>
  );
}
