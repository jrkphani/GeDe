import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import { tableMap, type GedeDoc, type ToggleMark } from '@gede/core';
import { Button, Icon, Tabs, type TabItem } from '@gede/ui';

import { ARIA_KEYS, LABELS } from '../../doc/shortcuts.js';
import { useYVersion } from '../../doc/use-y.js';
import { ResultList } from './find/FindBar.js';
import type { Find } from './find/useFind.js';
import type { GridCommands } from './grid/commands.js';
import { ArrangeTab } from './inspector/ArrangeTab.js';
import { CellTab } from './inspector/CellTab.js';
import { InspectorHead } from './inspector/InspectorHead.js';
import { Section } from './inspector/controls.js';
import {
  CategoriesTab,
  DeriveTab,
  FilterTab,
  SortTab,
  type InspectorSlots,
} from './inspector/slots.js';
import { TableTab } from './inspector/TableTab.js';
import { TextTab } from './inspector/TextTab.js';
import type { CellSelection, Selection } from './selection.js';
import type { InspectorMode } from './Toolbar.js';

export type FormatTab = 'table' | 'cell' | 'text' | 'arrange' | 'graph' | 'derive';
export type OrganizeTab = 'categories' | 'sort' | 'filter';

export interface InspectorProps {
  gd: GedeDoc;
  mode: InspectorMode;
  /** Expanded (322 px) or the 38 px strip (INSP-02, RESP-04). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selection: Selection | null;
  editing: boolean;
  editable: boolean;
  commands: GridCommands;
  find: Find;
  /** KEYS-05: toggle a mark over the whole selected cell. */
  onToggleMark: (mark: ToggleMark) => void;
  /** Panes other Wave 2 work mounts; each tab shows its slot marker until then. */
  slots?: InspectorSlots | undefined;
}

/**
 * The inspector rail (INSP-01..12). Two modes — Format (Table, Cell, Text,
 * Arrange, Graph when a graph is selected, Derive) and Organize (Categories,
 * Sort, Filter) — as Radix Tabs; the head always states the selected object
 * (INSP-03); collapsed it is a 38 px strip with the expand control and the
 * mode's name (INSP-02). Every control writes through `GridCommands` or a
 * core mutation at once (INSP-12); what is not implemented is disabled with
 * its reason (INSP-11). The Find result list lives here while the rail is
 * open (FIND-06).
 */
export function Inspector({
  gd,
  mode,
  open,
  onOpenChange,
  selection,
  editing,
  editable,
  commands,
  find,
  onToggleMark,
  slots,
}: InspectorProps) {
  useYVersion(gd.tables);
  const table = selection === null ? null : tableMap(gd, selection.tableId);
  const cell: CellSelection | null =
    selection?.cell && table !== null ? { tableId: selection.tableId, ...selection.cell } : null;
  const [formatTab, setFormatTab] = useState<FormatTab>('table');
  const [organizeTab, setOrganizeTab] = useState<OrganizeTab>('categories');
  const modeLabel = mode === 'format' ? 'Format' : 'Organize';
  const name = `${modeLabel} inspector`;

  if (!open) {
    return (
      <aside
        className="gd-inspector gd-inspector--collapsed"
        aria-label={name}
        data-testid="inspector"
        data-state="collapsed"
      >
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="chevron-left" size={13} />}
          aria-label="Expand inspector"
          aria-keyshortcuts={ARIA_KEYS.inspector}
          title={`Expand inspector (${LABELS.inspector})`}
          onClick={() => {
            onOpenChange(true);
          }}
        />
        <span className="gd-mono gd-inspector__strip-label" aria-hidden="true">
          {modeLabel}
        </span>
      </aside>
    );
  }

  const noTable = (
    <Section label="selection">
      <p className="gd-insp__hint">Select a table on the canvas to see its options.</p>
    </Section>
  );
  const withTable = (pane: (t: NonNullable<typeof table>) => ReactNode) =>
    table === null ? noTable : pane(table);

  const formatItems: TabItem<FormatTab>[] = [
    {
      value: 'table',
      label: 'Table',
      content: withTable((t) => (
        <TableTab gd={gd} table={t} selection={selection} editable={editable} commands={commands} />
      )),
    },
    {
      value: 'cell',
      label: 'Cell',
      content: withTable((t) => <CellTab gd={gd} table={t} cell={cell} editable={editable} />),
    },
    {
      value: 'text',
      label: 'Text',
      content: withTable((t) => (
        <TextTab
          table={t}
          cell={cell}
          editing={editing}
          editable={editable}
          commands={commands}
          onToggleMark={onToggleMark}
        />
      )),
    },
    {
      value: 'arrange',
      label: 'Arrange',
      content: withTable((t) => <ArrangeTab gd={gd} table={t} editable={editable} />),
    },
    // INSP-08: only when a graph is selected — the graph release sets the slot.
    ...(slots?.graph === undefined
      ? []
      : [{ value: 'graph' as const, label: 'Graph', content: slots.graph }]),
    { value: 'derive', label: 'Derive', content: <DeriveTab slot={slots?.derive} /> },
  ];
  const organizeItems: TabItem<OrganizeTab>[] = [
    {
      value: 'categories',
      label: 'Categories',
      content: <CategoriesTab slot={slots?.hierarchy} />,
    },
    { value: 'sort', label: 'Sort', content: <SortTab slot={slots?.sort} /> },
    { value: 'filter', label: 'Filter', content: <FilterTab slot={slots?.filter} /> },
  ];
  const activeFormat = formatTab === 'graph' && slots?.graph === undefined ? 'table' : formatTab;

  const results = find.state.open && find.state.listOpen && find.state.matches.length > 0;

  return (
    <aside
      className={clsx('gd-inspector', 'gd-inspector--open')}
      aria-label={name}
      data-testid="inspector"
      data-state="open"
    >
      <div className="gd-inspector__head">
        <span className="gd-mono gd-inspector__label">{modeLabel}</span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="collapse-rail" size={13} />}
          aria-label="Collapse inspector"
          aria-keyshortcuts={ARIA_KEYS.inspector}
          title={`Collapse inspector (${LABELS.inspector})`}
          onClick={() => {
            onOpenChange(false);
          }}
        />
      </div>
      <InspectorHead table={table} selection={selection} />
      <div className="gd-inspector__body">
        {mode === 'format' ? (
          <Tabs
            label="Format"
            className="gd-inspector__tabs"
            items={formatItems}
            value={activeFormat}
            onChange={setFormatTab}
          />
        ) : (
          <Tabs
            label="Organize"
            className="gd-inspector__tabs"
            items={organizeItems}
            value={organizeTab}
            onChange={setOrganizeTab}
          />
        )}
        {results && (
          <Section label="find results">
            <ResultList
              gd={gd}
              matches={find.state.matches}
              current={find.state.current}
              onPick={find.actions.goTo}
            />
          </Section>
        )}
      </div>
    </aside>
  );
}
