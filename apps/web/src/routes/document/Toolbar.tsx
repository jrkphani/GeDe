import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Button, Icon, Menu, Tooltip, type IconName, type MenuEntry } from '@gede/ui';

import { ARIA_KEYS, LABELS } from '../../doc/shortcuts.js';
import { useMessages } from '../../i18n/index.js';
import { formatZoom, ZOOM_PRESETS } from '../../doc/viewport.js';

export type InspectorMode = 'format' | 'organize';
/** The Organize tab a toolbar tool opens (INSP-01); mirrors `OrganizeTab` in `Inspector.tsx`. */
export type OrganizeTarget = 'categories' | 'sort' | 'filter';

export interface ToolbarProps {
  zoom: number;
  gridlines: boolean;
  /** A table is selected: row/column commands apply to it. */
  hasTable: boolean;
  /** SHARE-03: a view-only participant sees the commands disabled with the reason. */
  editable: boolean;
  inspector: InspectorMode | null;
  onAddTable: () => void;
  /** GRAPH-01: `+ Graph` enters pointing mode (GRAPH-03). */
  onAddGraph?: (() => void) | undefined;
  onAddRow: () => void;
  onAddColumn: () => void;
  onGridlines: (on: boolean) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomTo: (zoom: number) => void;
  onFit: () => void;
  onInspector: (mode: InspectorMode | null) => void;
  /** The Document menu (grid/DocumentMenu): open, print, undo, redo (KEYS-08). */
  documentMenu?: ReactNode | undefined;
  /** The Table menu (grid/TableMenu): the structure commands whose home is the menu. */
  tableMenu?: ReactNode | undefined;
  /** FIND-01: the magnifier opens the Find bar. */
  onFind: () => void;
  /** KEYS-01 / KEYS-08: the `?` sheet's other route. */
  onShortcuts: () => void;
  /**
   * SORT-01..06 / DOC-02: Filter opens Organize › Filter and Sort opens Organize › Sort —
   * two commands, so neither is the Organize toggle (ADR-041).
   */
  onOrganize: (tab: OrganizeTarget) => void;
  /** INSP-07 / DOC-02: the selected table's pinned state (null without a table) and its toggle. */
  pinned?: boolean | null | undefined;
  onPin?: ((pinned: boolean) => void) | undefined;
  /** INSP-07 / DOC-02: the sheet's DAG edges and their toggle. */
  edgesShown?: boolean | undefined;
  onEdges?: ((shown: boolean) => void) | undefined;
}

interface ToolProps {
  icon: IconName;
  label: string;
  /** Glyph label shown beside the command (KEYS-08), e.g. "⌘+". */
  shortcut?: string | undefined;
  /** ARIA key tokens for the same chord, e.g. "Meta+Equal" (L4). */
  ariaKeys?: string | undefined;
  onClick?: (() => void) | undefined;
  /** MENU-02 / INSP-11: unavailable commands render disabled with their reason, never hidden. */
  disabledReason?: string | undefined;
  pressed?: boolean | undefined;
  /** ONB-04: the guided tour measures this command by its `data-tour` anchor. */
  tourKey?: 'graph' | 'find' | undefined;
}

/** One toolbar command: icon button, tooltip with its shortcut (KEYS-08), disabled-with-reason. */
export function Tool({
  icon,
  label,
  shortcut,
  ariaKeys,
  onClick,
  disabledReason,
  pressed,
  tourKey,
}: ToolProps) {
  const disabled = disabledReason !== undefined;
  const tip = disabled
    ? `${label} — ${disabledReason}`
    : shortcut === undefined
      ? label
      : `${label} (${shortcut})`;
  return (
    <Tooltip
      content={
        <span className="gd-doc__tip">
          {disabled ? `${label} — ${disabledReason}` : label}
          {!disabled && shortcut !== undefined && <kbd className="gd-doc__tip-key">{shortcut}</kbd>}
        </span>
      }
    >
      <Button
        size="sm"
        variant="ghost"
        className={clsx('gd-tool', { 'gd-tool--pressed': pressed === true })}
        icon={<Icon name={icon} size={15} />}
        aria-label={label}
        aria-keyshortcuts={ariaKeys}
        aria-pressed={pressed}
        aria-disabled={disabled || undefined}
        title={tip}
        data-tour={tourKey}
        onClick={disabled ? undefined : onClick}
      />
    </Tooltip>
  );
}

function InspectorToggle({
  mode,
  label,
  shortcut,
  ariaKeys,
  active,
  onInspector,
}: {
  mode: InspectorMode;
  label: string;
  shortcut: string;
  ariaKeys: string;
  active: InspectorMode | null;
  onInspector: (mode: InspectorMode | null) => void;
}) {
  const t = useMessages();
  const pressed = active === mode;
  return (
    <Tooltip
      content={
        <span className="gd-doc__tip">
          {t('menu.labelInspector', { label })}
          <kbd className="gd-doc__tip-key">{shortcut}</kbd>
        </span>
      }
    >
      <Button
        size="sm"
        variant="ghost"
        className={clsx('gd-tool', 'gd-tool--text', { 'gd-tool--pressed': pressed })}
        aria-pressed={pressed}
        aria-keyshortcuts={ariaKeys}
        aria-label={t('menu.labelInspector', { label })}
        onClick={() => {
          onInspector(pressed ? null : mode);
        }}
      >
        {label}
      </Button>
    </Tooltip>
  );
}

function Cluster({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gd-doc__cluster" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * DOC-02: grouped tool clusters with tooltips. A command has exactly one home
 * — here, in a toolbar menu, or in an inspector tab (ADR-041); context menus
 * and chords are routes to it. Commands not yet implemented are present but
 * disabled with a reason (MENU-02), never hidden.
 */
export function Toolbar({
  zoom,
  gridlines,
  hasTable,
  editable,
  inspector,
  onAddTable,
  onAddGraph,
  onAddRow,
  onAddColumn,
  onGridlines,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  onFit,
  onInspector,
  documentMenu,
  tableMenu,
  onFind,
  onShortcuts,
  onOrganize,
  pinned = null,
  onPin,
  edgesShown = false,
  onEdges,
}: ToolbarProps) {
  const t = useMessages();
  const viewOnly = editable ? undefined : 'you have view-only access';
  const needsTable = viewOnly ?? (hasTable ? undefined : 'select a table first');
  const graphSoon = 'arrives with the context graph release';
  const zoomEntries: MenuEntry[] = [
    ...ZOOM_PRESETS.map<MenuEntry>((z) => ({
      kind: 'item',
      id: `zoom-${String(z)}`,
      label: formatZoom(z),
      onSelect: () => {
        onZoomTo(z);
      },
      // Actual size (⌘0) has one home: the 100 % entry here.
      shortcut: z === 1 ? LABELS.actualSize : undefined,
    })),
  ];

  return (
    <div className="gd-doc__toolbar" role="toolbar" aria-label={t('menu.documentTools')}>
      <Cluster label={t('menu.add')}>
        <Tool
          icon="table"
          label={t('addTable.add')}
          onClick={onAddTable}
          disabledReason={viewOnly}
        />
        <Tool
          icon="add-row"
          label={t('menu.addRow')}
          shortcut={LABELS.addRow}
          ariaKeys={ARIA_KEYS.addRow}
          onClick={onAddRow}
          disabledReason={needsTable}
        />
        <Tool
          icon="add-column"
          label={t('menu.addColumn')}
          shortcut={LABELS.addColumn}
          ariaKeys={ARIA_KEYS.addColumn}
          onClick={onAddColumn}
          disabledReason={needsTable}
        />
        <Tool
          icon="graph"
          label={t('menu.addGraph')}
          onClick={onAddGraph}
          disabledReason={viewOnly ?? (onAddGraph === undefined ? graphSoon : undefined)}
          tourKey="graph"
        />
      </Cluster>
      {(documentMenu !== undefined || tableMenu !== undefined) && (
        <Cluster label={t('menu.menus')}>
          {documentMenu}
          {tableMenu}
        </Cluster>
      )}
      <Cluster label={t('menu.arrange')}>
        <Tool
          icon="pin"
          label={t('menu.pinToViewport')}
          pressed={pinned === true}
          disabledReason={viewOnly ?? (pinned === null ? needsTable : undefined)}
          onClick={() => {
            onPin?.(pinned !== true);
          }}
        />
        <Tool
          icon="edges"
          label={t('menu.dagEdges')}
          pressed={edgesShown}
          disabledReason={viewOnly}
          onClick={() => {
            onEdges?.(!edgesShown);
          }}
        />
      </Cluster>
      <Cluster label={t('menu.data')}>
        <Tool
          icon="gridlines"
          label={t('menu.gridlines')}
          pressed={gridlines}
          onClick={() => {
            onGridlines(!gridlines);
          }}
        />
        <Tool
          icon="filter"
          label={t('menu.filter')}
          onClick={() => {
            onOrganize('filter');
          }}
          disabledReason={hasTable ? undefined : 'select a table first'}
        />
        <Tool
          icon="sort"
          label={t('menu.sort')}
          onClick={() => {
            onOrganize('sort');
          }}
          disabledReason={hasTable ? undefined : 'select a table first'}
        />
      </Cluster>
      <span className="gd-doc__toolgap" />
      <Cluster label={t('menu.find')}>
        <Tool
          icon="search"
          label={t('menu.find')}
          tourKey="find"
          shortcut={LABELS.find}
          ariaKeys={ARIA_KEYS.find}
          onClick={onFind}
        />
      </Cluster>
      <Cluster label={t('menu.view')}>
        <Tool
          icon="zoom-out"
          label={t('menu.zoomOut')}
          shortcut={LABELS.zoomOut}
          ariaKeys={ARIA_KEYS.zoomOut}
          onClick={onZoomOut}
        />
        <Menu
          label={t('menu.zoom')}
          align="center"
          entries={zoomEntries}
          trigger={
            <button
              type="button"
              className="gd-mono gd-doc__zoom"
              aria-label={t('menu.zoomZoom', { zoom: formatZoom(zoom) })}
              title={t('menu.zoom')}
            >
              {formatZoom(zoom)}
            </button>
          }
        />
        <Tool
          icon="zoom-in"
          label={t('menu.zoomIn')}
          shortcut={LABELS.zoomIn}
          ariaKeys={ARIA_KEYS.zoomIn}
          onClick={onZoomIn}
        />
        <Tool
          icon="fit"
          label={t('menu.fitToCanvas')}
          shortcut={LABELS.fit}
          ariaKeys={ARIA_KEYS.fit}
          onClick={onFit}
        />
      </Cluster>
      <Cluster label={t('menu.help')}>
        <Tool
          icon="keyboard"
          label={t('menu.keyboardShortcuts')}
          shortcut={LABELS.shortcutSheet}
          ariaKeys={ARIA_KEYS.shortcutSheet}
          onClick={onShortcuts}
        />
      </Cluster>
      <Cluster label={t('menu.inspectors')}>
        <InspectorToggle
          mode="format"
          label={t('menu.format')}
          shortcut={LABELS.formatInspector}
          ariaKeys={ARIA_KEYS.formatInspector}
          active={inspector}
          onInspector={onInspector}
        />
        <InspectorToggle
          mode="organize"
          label={t('menu.organize')}
          shortcut={LABELS.organizeInspector}
          ariaKeys={ARIA_KEYS.organizeInspector}
          active={inspector}
          onInspector={onInspector}
        />
      </Cluster>
    </div>
  );
}
