/**
 * The hierarchy controls for the inspector (HIER-01, HIER-02, HIER-03,
 * HIER-06, HIER-08): with a cell selected, the row, its parent and depth, with
 * Promote (⇤) and Nest (⇥), plus collapse for the row and the whole table.
 * Reads the document directly (`useYVersion`) and acts through `GridCommands`,
 * so it agrees with the grid about what is allowed: a control is disabled
 * exactly when the command would refuse.
 *
 * Exported for the inspector to mount; it is not a route and owns no state.
 */
import { useId } from 'react';
import {
  cellAddress,
  cellText,
  rowOutline,
  tableMap,
  tableOutline,
  tableRecord,
  type GedeDoc,
  type Id,
  type TableMap,
  type TableOutline,
} from '@gede/core';
import { Button } from '@gede/ui';

import { useYVersion } from '../../../doc/use-y.js';
import type { GridCommands } from '../grid/commands.js';
import { HIER_ARIA_KEYS, HIER_LABELS } from '../grid/hier-keys.js';
import type { Selection } from '../selection.js';

export interface HierarchyPanelProps {
  gd: GedeDoc;
  selection: Selection | null;
  commands: GridCommands;
  /** RESP-02 / SHARE-03: the controls render disabled, with the reason, when false. */
  editable: boolean;
  /**
   * True while this viewer's sort or filter reorders or drops rows (per-user
   * view state): the outline is not drawn and nest/promote are disabled, as
   * under grouping (HIER-08). The sort feature wires it; default false.
   */
  viewSorted?: boolean | undefined;
}

/** How a row is named in the panel: its outline-column text, else its address, else "(blank row)". */
export function rowLabel(table: TableMap, outline: TableOutline, rowId: Id): string {
  const column = outline.column;
  const text = column === null ? '' : cellText(table, rowId, column).split('\n')[0]?.trim();
  if (text !== undefined && text !== '') return text;
  const address = column === null ? null : cellAddress(table, rowId, column);
  return address ?? '(blank row)';
}

export function HierarchyPanel({
  gd,
  selection,
  commands,
  editable,
  viewSorted = false,
}: HierarchyPanelProps) {
  useYVersion(gd.tables);
  const headingId = useId();
  const table = selection === null ? null : tableMap(gd, selection.tableId);
  const rowId = selection?.cell?.rowId ?? null;
  const record = table === null ? null : tableRecord(table);
  const outline = table === null || record === null ? null : tableOutline(table, record);
  const row = table === null || rowId === null ? null : rowOutline(table, rowId);
  const viewOnly = !editable;

  if (table === null || record === null || outline === null) {
    return (
      <section className="gd-hier" aria-labelledby={headingId}>
        <h3 id={headingId} className="gd-mono gd-inspector__label gd-hier__heading">
          hierarchy
        </h3>
        <p className="gd-inspector__note">Select a cell to see its row.</p>
      </section>
    );
  }

  const tableId = record.id;
  const groupedBy =
    record.groupBy === null ? null : record.columns.find((c) => c.id === record.groupBy);
  const anyCollapsible = outline.rows.some((r) => r.hasChildren && !r.collapsed);
  const anyCollapsed = outline.rows.some((r) => r.collapsed);
  const parentLabel =
    row?.parent === null || row?.parent === undefined ? null : rowLabel(table, outline, row.parent);
  // Depth is edited only when the drawn order is document order (HIER-08).
  const depthLocked = groupedBy
    ? 'Unavailable while the table is grouped'
    : viewSorted
      ? 'Unavailable while the view is sorted or filtered'
      : null;
  const disabledReason = viewOnly ? 'View only' : depthLocked;

  return (
    <section className="gd-hier" aria-labelledby={headingId} data-testid="hierarchy-panel">
      <h3 id={headingId} className="gd-mono gd-inspector__label gd-hier__heading">
        hierarchy
      </h3>
      {groupedBy !== undefined && groupedBy !== null && (
        // HIER-08: bands own the outline column; depth is kept but not shown.
        <p className="gd-inspector__note gd-hier__grouped" data-testid="hierarchy-grouped">
          Grouped by {groupedBy.label}. The outline is hidden while the table is grouped; depth is
          kept and returns when grouping is removed.
        </p>
      )}
      {!groupedBy && viewSorted && (
        <p className="gd-inspector__note gd-hier__grouped" data-testid="hierarchy-sorted">
          The outline is hidden while your view is sorted or filtered; depth is kept and returns
          when the sort or filter is cleared.
        </p>
      )}
      {row === null || rowId === null ? (
        <p className="gd-inspector__note">Select a cell to see its row.</p>
      ) : (
        <>
          <p className="gd-hier__row" data-testid="hierarchy-row">
            {rowLabel(table, outline, rowId)}
          </p>
          <p className="gd-hier__parent" data-testid="hierarchy-parent">
            {parentLabel === null ? 'top level — no parent' : `↳ under ${parentLabel}`}
          </p>
          <p className="gd-inspector__counts" data-testid="hierarchy-depth">
            depth {row.depth}
          </p>
          <div className="gd-hier__actions" role="group" aria-label="Row depth">
            <Button
              size="sm"
              disabled={disabledReason !== null || !row.canPromote}
              title={
                disabledReason ??
                (row.canPromote
                  ? `Promote one level (${HIER_LABELS.promote})`
                  : 'Already at the top level')
              }
              aria-keyshortcuts={HIER_ARIA_KEYS.promote}
              onClick={() => {
                commands.promoteRow(tableId, rowId);
              }}
            >
              ⇤ Promote
            </Button>
            <Button
              size="sm"
              disabled={disabledReason !== null || !row.canNest}
              title={
                disabledReason ??
                (row.canNest
                  ? `Nest under the row above (${HIER_LABELS.nest})`
                  : 'A row nests at most one level deeper than the row above it')
              }
              aria-keyshortcuts={HIER_ARIA_KEYS.nest}
              onClick={() => {
                commands.nestRow(tableId, rowId);
              }}
            >
              Nest ⇥
            </Button>
          </div>
          {row.hasChildren && (
            <div className="gd-hier__actions">
              <Button
                size="sm"
                variant="ghost"
                disabled={disabledReason !== null}
                title={
                  disabledReason ?? (row.collapsed ? HIER_LABELS.expand : HIER_LABELS.collapse)
                }
                aria-expanded={!row.collapsed}
                aria-keyshortcuts={row.collapsed ? HIER_ARIA_KEYS.expand : HIER_ARIA_KEYS.collapse}
                onClick={() => {
                  commands.toggleCollapse(tableId, rowId);
                }}
              >
                {row.collapsed ? 'Expand row' : 'Collapse row'}
              </Button>
            </div>
          )}
        </>
      )}
      <div className="gd-hier__actions" role="group" aria-label="Whole table">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabledReason !== null || !anyCollapsible}
          title={disabledReason ?? 'Collapse every row that has children'}
          onClick={() => {
            commands.collapseAll(tableId);
          }}
        >
          Collapse all
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabledReason !== null || !anyCollapsed}
          title={disabledReason ?? 'Expand every collapsed row'}
          onClick={() => {
            commands.expandAll(tableId);
          }}
        >
          Expand all
        </Button>
      </div>
      <p className="gd-inspector__note gd-hier__hint">
        Nesting sets the parent to the nearest row above at a shallower level. Parents get a
        chevron; collapsing one hides its whole subtree.
      </p>
    </section>
  );
}
