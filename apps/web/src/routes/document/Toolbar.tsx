import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Button, Icon, Menu, Tooltip, type IconName, type MenuEntry } from '@gede/ui';

import { ARIA_KEYS, LABELS } from '../../doc/shortcuts.js';
import { formatZoom, ZOOM_PRESETS } from '../../doc/viewport.js';

export type InspectorMode = 'format' | 'organize';

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
  /** The Table menu (grid/TableMenu): row, column, freeze, header and footer commands. */
  tableMenu?: ReactNode | undefined;
  /** FIND-01: the magnifier opens the Find bar. */
  onFind: () => void;
  /** KEYS-01 / KEYS-08: the `?` sheet's other route. */
  onShortcuts: () => void;
  /** SORT-01..06: Sort and Filter open the Organize inspector, where the viewer's options live. */
  onOrganize: () => void;
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
  const pressed = active === mode;
  return (
    <Tooltip
      content={
        <span className="gd-doc__tip">
          {label} inspector
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
        aria-label={`${label} inspector`}
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
 * DOC-02: grouped tool clusters with tooltips. A command appears in exactly
 * one place; commands not yet implemented are present but disabled with a
 * reason (MENU-02), never hidden.
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
  tableMenu,
  onFind,
  onShortcuts,
  onOrganize,
}: ToolbarProps) {
  const viewOnly = editable ? undefined : 'you have view-only access';
  const needsTable = viewOnly ?? (hasTable ? undefined : 'select a table first');
  const graphSoon = 'arrives with the context graph release';
  const arrangeSoon = 'arrives with a later release (pin and DAG edges)';
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
    <div className="gd-doc__toolbar" role="toolbar" aria-label="Document tools">
      <Cluster label="Insert">
        <Tool icon="table" label="Add table" onClick={onAddTable} disabledReason={viewOnly} />
        <Tool
          icon="add-row"
          label="Add row"
          shortcut={LABELS.addRow}
          ariaKeys={ARIA_KEYS.addRow}
          onClick={onAddRow}
          disabledReason={needsTable}
        />
        <Tool
          icon="add-column"
          label="Add column"
          shortcut={LABELS.addColumn}
          ariaKeys={ARIA_KEYS.addColumn}
          onClick={onAddColumn}
          disabledReason={needsTable}
        />
        <Tool
          icon="graph"
          label="Add graph"
          onClick={onAddGraph}
          disabledReason={viewOnly ?? (onAddGraph === undefined ? graphSoon : undefined)}
        />
      </Cluster>
      {tableMenu !== undefined && <Cluster label="Table">{tableMenu}</Cluster>}
      <Cluster label="Arrange">
        <Tool icon="pin" label="Pin to viewport" disabledReason={arrangeSoon} />
        <Tool icon="edges" label="DAG edges" disabledReason={arrangeSoon} />
      </Cluster>
      <Cluster label="Data">
        <Tool
          icon="gridlines"
          label="Gridlines"
          pressed={gridlines}
          onClick={() => {
            onGridlines(!gridlines);
          }}
        />
        <Tool
          icon="filter"
          label="Filter"
          shortcut={LABELS.organizeInspector}
          ariaKeys={ARIA_KEYS.organizeInspector}
          onClick={onOrganize}
          disabledReason={hasTable ? undefined : 'select a table first'}
        />
        <Tool
          icon="sort"
          label="Sort"
          shortcut={LABELS.organizeInspector}
          ariaKeys={ARIA_KEYS.organizeInspector}
          onClick={onOrganize}
          disabledReason={hasTable ? undefined : 'select a table first'}
        />
      </Cluster>
      <span className="gd-doc__toolgap" />
      <Cluster label="Find">
        <Tool
          icon="search"
          label="Find"
          shortcut={LABELS.find}
          ariaKeys={ARIA_KEYS.find}
          onClick={onFind}
        />
      </Cluster>
      <Cluster label="View">
        <Tool
          icon="zoom-out"
          label="Zoom out"
          shortcut={LABELS.zoomOut}
          ariaKeys={ARIA_KEYS.zoomOut}
          onClick={onZoomOut}
        />
        <Menu
          label="Zoom"
          align="center"
          entries={zoomEntries}
          trigger={
            <button
              type="button"
              className="gd-mono gd-doc__zoom"
              aria-label={`Zoom ${formatZoom(zoom)}`}
              title="Zoom"
            >
              {formatZoom(zoom)}
            </button>
          }
        />
        <Tool
          icon="zoom-in"
          label="Zoom in"
          shortcut={LABELS.zoomIn}
          ariaKeys={ARIA_KEYS.zoomIn}
          onClick={onZoomIn}
        />
        <Tool
          icon="fit"
          label="Fit to canvas"
          shortcut={LABELS.fit}
          ariaKeys={ARIA_KEYS.fit}
          onClick={onFit}
        />
      </Cluster>
      <Cluster label="Help">
        <Tool
          icon="keyboard"
          label="Keyboard shortcuts"
          shortcut={LABELS.shortcutSheet}
          ariaKeys={ARIA_KEYS.shortcutSheet}
          onClick={onShortcuts}
        />
      </Cluster>
      <Cluster label="Inspectors">
        <InspectorToggle
          mode="format"
          label="Format"
          shortcut={LABELS.formatInspector}
          ariaKeys={ARIA_KEYS.formatInspector}
          active={inspector}
          onInspector={onInspector}
        />
        <InspectorToggle
          mode="organize"
          label="Organize"
          shortcut={LABELS.organizeInspector}
          ariaKeys={ARIA_KEYS.organizeInspector}
          active={inspector}
          onInspector={onInspector}
        />
      </Cluster>
    </div>
  );
}
