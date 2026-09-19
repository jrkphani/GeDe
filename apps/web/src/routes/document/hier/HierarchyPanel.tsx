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
  normaliseTableView,
  projectCellText,
  rowOutline,
  tableMap,
  tableOutline,
  tableRecord,
  type GedeDoc,
  type Id,
  type OutlineRow,
  type TableMap,
  type TableOutline,
  type TableRecord,
} from '@gede/core';

import { useYVersion } from '../../../doc/use-y.js';
import { useTableView } from '../../../doc/view-state.js';
import { workbookIndexFor } from '../../../doc/workbook-index.js';
import { columnDisplayName } from '../grid/column-name.js';
import type { GridCommands } from '../grid/commands.js';
import { HIER_ARIA_KEYS, HIER_LABELS } from '../grid/hier-keys.js';
import { ReasonedButton } from '../inspector/controls.js';
import type { Selection } from '../selection.js';

export interface HierarchyPanelProps {
  gd: GedeDoc;
  selection: Selection | null;
  commands: GridCommands;
  /** RESP-02 / SHARE-03: the controls render disabled, with the reason, when false. */
  editable: boolean;
  /**
   * Force the "view is sorted" treatment (HIER-08, ADR-026): the outline is not
   * drawn and nest/promote are disabled, as under grouping. The panel reads the
   * viewer's own sort, filter and grouping from the view store and applies this
   * itself; the prop is for a host that knows better.
   */
  viewSorted?: boolean | undefined;
}

/**
 * How a row is named in the panel: the text of its outline column — the
 * row's own (ADR-052), else the table's — else its address, else "(blank
 * row)". A formula or reference cell names the row by its projected
 * expression (`=Sum(B5:B6)`, `@Offices.City`), never by the stored id tokens
 * (PRD §20, #142).
 */
export function rowLabel(table: TableMap, outline: TableOutline, rowId: Id, gd?: GedeDoc): string {
  const column = outline.rows.find((r) => r.id === rowId)?.column ?? outline.column;
  const stored = column === null ? '' : cellText(table, rowId, column);
  const projected =
    gd === undefined ? stored : projectCellText(gd, stored, workbookIndexFor(gd.doc));
  const text = projected.split('\n')[0]?.trim();
  if (text !== undefined && text !== '') return text;
  const address = column === null ? null : cellAddress(table, rowId, column);
  return address ?? '(blank row)';
}

/**
 * ADR-052: the name of the column a nested row's outline is drawn in — the
 * column's label, else its grid letter — or null for a top-level row, which
 * has no indent to place.
 */
function outlineColumnName(record: TableRecord, row: OutlineRow): string | null {
  if (row.depth === 0 || row.column === null) return null;
  return columnDisplayName(record, row.column);
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
  // ADR-052: a nest draws the outline in the selected cell's column.
  const colId = selection?.cell?.colId;
  const record = table === null ? null : tableRecord(table);
  // ADR-026: the viewer's own grouping, sort and filter, from the view store.
  const storedView = useTableView(record?.id ?? '');
  const view = normaliseTableView(storedView, new Set(record?.columns.map((c) => c.id) ?? []));
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
    view.groupBy === null ? null : record.columns.find((c) => c.id === view.groupBy);
  const sorted = viewSorted || view.sortBy !== null || view.filter !== null;
  const anyCollapsible = outline.rows.some((r) => r.hasChildren && !r.collapsed);
  const anyCollapsed = outline.rows.some((r) => r.collapsed);
  const parentLabel =
    row?.parent === null || row?.parent === undefined
      ? null
      : rowLabel(table, outline, row.parent, gd);
  // Depth is edited only when the drawn order is document order (HIER-08).
  const depthLocked = groupedBy
    ? 'Unavailable while the table is grouped'
    : sorted
      ? 'Unavailable while the view is sorted or filtered'
      : null;
  const disabledReason = viewOnly ? 'View only' : depthLocked;
  const outlineIn = row === null ? null : outlineColumnName(record, row);

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
      {!groupedBy && sorted && (
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
            {rowLabel(table, outline, rowId, gd)}
          </p>
          <p className="gd-hier__parent" data-testid="hierarchy-parent">
            {parentLabel === null ? 'top level — no parent' : `↳ under ${parentLabel}`}
          </p>
          <p className="gd-inspector__counts" data-testid="hierarchy-depth">
            depth {row.depth}
          </p>
          {outlineIn !== null && (
            // ADR-052: where the indent lands — the column the row was nested from.
            <p className="gd-inspector__counts" data-testid="hierarchy-outline">
              Outline in {outlineIn}
            </p>
          )}
          {/* KEYS-08: the chord stays beside each command whether or not it can run now (#136). */}
          <div className="gd-hier__actions" role="group" aria-label="Row depth">
            <ReasonedButton
              label={`Promote (${HIER_LABELS.promote})`}
              available={`Promote one level (${HIER_LABELS.promote})`}
              reason={disabledReason ?? (row.canPromote ? undefined : 'already at the top level')}
              aria-keyshortcuts={HIER_ARIA_KEYS.promote}
              onClick={() => {
                commands.promoteRow(tableId, rowId, colId);
              }}
            >
              ⇤ Promote
            </ReasonedButton>
            <ReasonedButton
              label={`Nest (${HIER_LABELS.nest})`}
              available={`Nest under the row above (${HIER_LABELS.nest})`}
              reason={
                disabledReason ??
                (row.canNest
                  ? undefined
                  : 'a row nests at most one level deeper than the row above it')
              }
              aria-keyshortcuts={HIER_ARIA_KEYS.nest}
              onClick={() => {
                commands.nestRow(tableId, rowId, colId);
              }}
            >
              Nest ⇥
            </ReasonedButton>
          </div>
          {row.hasChildren && (
            <div className="gd-hier__actions">
              <ReasonedButton
                variant="ghost"
                label={
                  row.collapsed
                    ? `Expand row (${HIER_LABELS.expand})`
                    : `Collapse row (${HIER_LABELS.collapse})`
                }
                reason={disabledReason ?? undefined}
                aria-expanded={!row.collapsed}
                aria-keyshortcuts={row.collapsed ? HIER_ARIA_KEYS.expand : HIER_ARIA_KEYS.collapse}
                onClick={() => {
                  commands.toggleCollapse(tableId, rowId);
                }}
              >
                {row.collapsed ? 'Expand row' : 'Collapse row'}
              </ReasonedButton>
            </div>
          )}
        </>
      )}
      <div className="gd-hier__actions" role="group" aria-label="Whole table">
        <ReasonedButton
          variant="ghost"
          label="Collapse all"
          available="Collapse every row that has children"
          reason={disabledReason ?? (anyCollapsible ? undefined : 'no row has children to hide')}
          onClick={() => {
            commands.collapseAll(tableId);
          }}
        />
        <ReasonedButton
          variant="ghost"
          label="Expand all"
          available="Expand every collapsed row"
          reason={disabledReason ?? (anyCollapsed ? undefined : 'no row is collapsed')}
          onClick={() => {
            commands.expandAll(tableId);
          }}
        />
      </div>
      <p className="gd-inspector__note gd-hier__hint">
        Nesting sets the parent to the nearest row above at a shallower level. Parents get a
        chevron; collapsing one hides its whole subtree.
      </p>
    </section>
  );
}
