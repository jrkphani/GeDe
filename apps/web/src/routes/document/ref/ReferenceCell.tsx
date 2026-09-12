import clsx from 'clsx';
import { cellKey, openDocument, pullOf, readString, tableById, type TableMap } from '@gede/core';
import { Icon } from '@gede/ui';

import type { CellSelection } from '../selection.js';
import { docOf, useCellDisplay } from '../formula/index.js';

export interface ReferenceCellProps {
  table: TableMap;
  cell: CellSelection;
  /** `reference`: an `@` pick (REF-01). `pulled`: a mirrored row's cell (REF-02). */
  kind: 'reference' | 'pulled';
  /** The path's secondary line needs a wrapped (two-unit) row (GRID-09, ADR-024). */
  expression: boolean;
}

/**
 * A live reference cell (REF-01) and a pulled cell (REF-02): the value in
 * accent mono, a badge naming the kind (`@` or `↰`, text — A11Y-04), and the
 * path beneath in a wrapped row; in a compact row the path is the tooltip.
 * The value is the engine's, so it follows the source (values stay live).
 */
export function ReferenceCell({ table, cell, kind, expression }: ReferenceCellProps) {
  const display = useCellDisplay(table, cellKey(cell.rowId, cell.colId));
  const path =
    kind === 'reference' ? (display.formula ?? '').slice(1) : pulledPath(table, display.formula);
  const badge = kind === 'reference' ? '@' : '↰';
  const badgeLabel = kind === 'reference' ? 'Reference' : 'Pulled';
  const { error, value, pending } = display;
  return (
    <span
      className={clsx('gd-ref', `gd-ref--${kind}`, { 'gd-ref--error': error !== null })}
      data-testid={`${kind}-cell`}
      title={error?.message ?? path}
    >
      <span className="gd-ref__line">
        {error !== null ? (
          <span className="gd-ref__error" role="img" aria-label={error.message}>
            <Icon name="warning" size={13} />
            <span className="gd-ref__error-text">{error.label.replace(/^⚠\s*/u, '')}</span>
          </span>
        ) : (
          <span className={clsx('gd-ref__value', { 'gd-ref__value--pending': pending })}>
            {value}
          </span>
        )}
        <span className="gd-ref__badge" aria-label={`${badgeLabel}, ${path}`}>
          {badge}
        </span>
      </span>
      {expression && path !== '' && (
        <span className="gd-ref__path" aria-hidden="true">
          {path}
        </span>
      )}
    </span>
  );
}

/** `Peaks · B5`: the source table and the address the pulled cell reads today. */
function pulledPath(table: TableMap, projected: string | null): string {
  const pull = pullOf(table);
  const address = projected === null ? '' : projected.slice(1);
  if (pull === null) return address;
  const source = tableById(openDocument(docOf(table)), pull.spec.tableId);
  const title = source?.title ?? readString(table, 'title');
  return address === '' ? title : `${title} · ${address}`;
}
