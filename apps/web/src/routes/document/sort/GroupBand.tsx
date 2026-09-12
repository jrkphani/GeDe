import clsx from 'clsx';
import { LATTICE } from '@gede/core';
import { Icon } from '@gede/ui';

export interface GroupBandProps {
  /** The grouped value; '' renders as "Blank". */
  value: string;
  count: number;
  collapsed: boolean;
  /** Canvas-pixel offset of the grouped column inside the table: the label sits on that column (PRD §15). */
  columnLeft: number;
  columnWidth: number;
  /** Visible column count, for `aria-colspan`. */
  columns: number;
  /** ARIA row index of the band in the grid. */
  rowIndex: number;
  /** DOM id of the label, so the rowgroup can be named by it. */
  labelId: string;
  /** Localised count sentence, e.g. "3 rows". */
  countText: string;
  onToggle: () => void;
}

/**
 * A category band (SORT-05, HIER-08): one lattice row stating the value and
 * its row count on the grouped column, collapsible. It takes over the
 * outline column, so no chevron of the row hierarchy renders while grouped.
 * Not a data row: it has no cells, no address and nothing to type into
 * (GRID-04). The band's rows follow it inside the same `rowgroup`.
 */
export function GroupBand({
  value,
  count,
  collapsed,
  columnLeft,
  columnWidth,
  columns,
  rowIndex,
  labelId,
  countText,
  onToggle,
}: GroupBandProps) {
  const label = value === '' ? 'Blank' : value;
  return (
    <div
      className={clsx('gd-table__row gd-band', { 'gd-band--collapsed': collapsed })}
      role="row"
      aria-rowindex={rowIndex}
      style={{ height: `${String(LATTICE.row)}px` }}
      data-testid="group-band"
    >
      <div className="gd-band__cell" role="rowheader" aria-colspan={columns}>
        <button
          type="button"
          className="gd-band__toggle"
          style={{
            left: `${String(columnLeft)}px`,
            maxWidth: `${String(Math.max(columnWidth, LATTICE.col))}px`,
          }}
          aria-expanded={!collapsed}
          onClick={onToggle}
          onPointerDown={(e) => {
            e.stopPropagation();
          }}
          title={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        >
          <Icon
            name="chevron-right"
            size={13}
            className={clsx('gd-band__chevron', { 'gd-band__chevron--open': !collapsed })}
          />
          <span
            id={labelId}
            className={clsx('gd-band__value', { 'gd-band__value--blank': value === '' })}
          >
            {label}
          </span>
          <span className="gd-mono gd-band__count" data-count={count}>
            {countText}
          </span>
        </button>
      </div>
    </div>
  );
}
