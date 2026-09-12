import clsx from 'clsx';
import { Icon } from '@gede/ui';

import type { CellDisplay } from './use-cell-display.js';

export interface FormulaCellContentProps {
  display: CellDisplay;
  /** Show the expression on a secondary line (FX-07). Off in the compact 1-unit row. */
  expression?: boolean | undefined;
  className?: string | undefined;
}

/**
 * The inside of a formula cell (FX-07, A11Y-04): value, reference badge and
 * the expression beneath. Errors carry the warning icon and their label; the
 * message is the tooltip. Pure presentation — the grid's Cell mounts it with
 * `useCellDisplay`, and `FormulaLayer` mounts it in the interim overlay.
 */
export function FormulaCellContent({
  display,
  expression = true,
  className,
}: FormulaCellContentProps) {
  const { value, formula, error, badge, pending, operands } = display;
  return (
    <span
      className={clsx('gd-formula', { 'gd-formula--error': error !== null }, className)}
      data-testid="formula-cell"
      title={error?.message ?? formula ?? undefined}
    >
      <span className="gd-formula__line">
        {error !== null ? (
          <span className="gd-formula__error" role="img" aria-label={error.message}>
            <Icon name="warning" size={13} />
            <span className="gd-formula__error-text">{error.label.replace(/^⚠\s*/u, '')}</span>
          </span>
        ) : (
          <span className={clsx('gd-formula__value', { 'gd-formula__value--pending': pending })}>
            {value}
          </span>
        )}
        {badge !== null && (
          <span
            className="gd-mono gd-formula__badge"
            aria-label={`Formula, ${String(operands.length)} ${operands.length === 1 ? 'reference' : 'references'}`}
          >
            {badge}
          </span>
        )}
      </span>
      {expression && formula !== null && (
        <span className="gd-mono gd-formula__expr" aria-label={`Expression ${formula}`}>
          {formula}
        </span>
      )}
    </span>
  );
}
