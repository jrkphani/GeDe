import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  normaliseTableView,
  tableMap,
  tableRecord,
  type GedeDoc,
  type ToggleMark,
} from '@gede/core';
import { below } from '@gede/tokens';
import { Button, Icon, Tabs, type TabItem } from '@gede/ui';

import { ARIA_KEYS, LABELS } from '../../doc/shortcuts.js';
import { useYVersion } from '../../doc/use-y.js';
import { useTableView } from '../../doc/view-state.js';
import { useMediaQuery } from '../../use-media-query.js';
import { ResultList } from './find/FindBar.js';
import type { Find } from './find/useFind.js';
import type { GridCommands } from './grid/commands.js';
import { ArrangeTab } from './inspector/ArrangeTab.js';
import { CellTab } from './inspector/CellTab.js';
import { HierarchyPanel } from './hier/HierarchyPanel.js';
import { InspectorHead, type HeadObject } from './inspector/InspectorHead.js';
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
  /**
   * INSP-01 / DOC-02: the Organize tab, owned by the shell so the toolbar's
   * Filter and Sort tools can open their own tab (ADR-037). Defaults to
   * Categories when absent.
   */
  organizeTab?: OrganizeTab | undefined;
  onOrganizeTabChange?: ((tab: OrganizeTab) => void) | undefined;
  /** INSP-03: what the head says when the selection is not a table (a graph). */
  object?: HeadObject | undefined;
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
  organizeTab: organizeTabProp,
  onOrganizeTabChange,
  object,
  selection,
  editing,
  editable,
  commands,
  find,
  onToggleMark,
  slots,
}: InspectorProps) {
  useYVersion(gd.tables);
  // RESP-03: below lg the open rail is an overlay over the canvas, and an overlay
  // dismisses like every layered surface — Escape, or a press outside it. Escape is
  // taken in the capture phase and prevented, so the shell's Escape (clear the
  // selection) does not fire for the same key (D7).
  const overlay = useMediaQuery(below('lg'));
  const asideRef = useRef<HTMLElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const dismissible = overlay && open;
  useEffect(() => {
    if (!dismissible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Escape' || event.defaultPrevented) return;
      // A menu, select or dialog above the rail takes its own Escape first.
      if (document.querySelector('[role="menu"], [role="listbox"], [role="dialog"]') !== null)
        return;
      event.preventDefault();
      onOpenChangeRef.current(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const aside = asideRef.current;
      if (aside === null || !(event.target instanceof Node) || aside.contains(event.target)) return;
      // Portaled surfaces (a select's list) belong to the rail; the toolbar's own
      // toggles decide the rail's state themselves (a press on Format is not "outside").
      if (
        event.target instanceof Element &&
        event.target.closest('[data-radix-popper-content-wrapper], .gd-doc__toolbar') !== null
      )
        return;
      onOpenChangeRef.current(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [dismissible]);
  const table = selection === null ? null : tableMap(gd, selection.tableId);
  const cell: CellSelection | null =
    selection?.cell && table !== null ? { tableId: selection.tableId, ...selection.cell } : null;
  const [formatTab, setFormatTab] = useState<FormatTab>('table');
  const [ownOrganizeTab, setOwnOrganizeTab] = useState<OrganizeTab>('categories');
  const organizeTab = organizeTabProp ?? ownOrganizeTab;
  const setOrganizeTab = (tab: OrganizeTab) => {
    setOwnOrganizeTab(tab);
    onOrganizeTabChange?.(tab);
  };
  // INSP-03: the grouping in force is the viewer's own view (ADR-026), read from the store.
  const storedView = useTableView(selection?.tableId ?? '');
  const groupedBy =
    table === null
      ? null
      : (() => {
          const record = tableRecord(table);
          const view = normaliseTableView(storedView, new Set(record.columns.map((c) => c.id)));
          return record.columns.find((c) => c.id === view.groupBy)?.label ?? null;
        })();
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
      content: withTable((t) => (
        <CellTab gd={gd} table={t} cell={cell} editable={editable} commands={commands} />
      )),
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
      content: withTable((t) => (
        <ArrangeTab gd={gd} table={t} editable={editable} commands={commands} />
      )),
    },
    // INSP-08: only when a graph is selected — the graph release sets the slot.
    ...(slots?.graph === undefined
      ? []
      : [{ value: 'graph' as const, label: 'Graph', content: slots.graph }]),
    {
      value: 'derive',
      label: 'Derive',
      content: (
        <DeriveTab
          slot={slots?.derive}
          hierarchy={
            <HierarchyPanel gd={gd} selection={selection} commands={commands} editable={editable} />
          }
        />
      ),
    },
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
      ref={asideRef}
      className={clsx('gd-inspector', 'gd-inspector--open', { 'gd-inspector--overlay': overlay })}
      aria-label={name}
      data-testid="inspector"
      data-state="open"
      data-overlay={overlay || undefined}
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
      <InspectorHead
        table={table}
        selection={selection}
        object={object ?? (slots?.graph === undefined ? undefined : { label: 'Graph' })}
        groupedBy={groupedBy}
      />
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
