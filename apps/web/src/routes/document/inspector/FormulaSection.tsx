import { cellKey, type TableMap } from '@gede/core';
import { Icon } from '@gede/ui';

import {
  docOf,
  referenceColourVar,
  sheetOfTable,
  useCellDisplay,
  useOperandsOf,
} from '../formula/index.js';
import type { CellSelection } from '../selection.js';
import { Section } from './controls.js';

/**
 * The formula section of the Cell tab (FX-07, FX-08, A11Y-04): the projected
 * expression, the operands in outline colour with the "not anchored" marker
 * for a reference that follows an address rather than a cell (PRD §20), the
 * error label and message, and the ƒ badge with its reference count.
 * Text cells get the one-line note instead of an empty block.
 */
export function FormulaSection({ table, cell }: { table: TableMap; cell: CellSelection }) {
  const display = useCellDisplay(table, cellKey(cell.rowId, cell.colId));
  const operands = useOperandsOf(docOf(table), sheetOfTable(table), display.formula, true);
  if (!display.isFormula) {
    return (
      <Section label="formula">
        <p className="gd-insp__hint">Not a formula. Start the cell with = to write one.</p>
      </Section>
    );
  }
  return (
    <Section label="formula">
      <dl className="gd-insp__facts" data-testid="inspector-formula">
        <div>
          <dt>Expression</dt>
          <dd className="gd-mono">{display.formula}</dd>
        </div>
        <div>
          <dt>Value</dt>
          <dd className="gd-mono">
            {display.error !== null ? (
              <span className="gd-insp__formula-error">
                <Icon name="warning" size={13} /> {display.error.label.replace(/^⚠\s*/u, '')}
              </span>
            ) : display.pending ? (
              'Calculating…'
            ) : (
              display.value
            )}
          </dd>
        </div>
        {display.badge !== null && (
          <div>
            <dt>References</dt>
            <dd className="gd-mono">
              <span
                className="gd-insp__formula-badge"
                aria-label={`${String(display.operands.length)} ${display.operands.length === 1 ? 'reference' : 'references'}`}
              >
                {display.badge}
              </span>
              {display.positional > 0 && <span> · {display.positional} not anchored</span>}
            </dd>
          </div>
        )}
      </dl>
      {display.error !== null && <p className="gd-insp__reason">{display.error.message}</p>}
      {operands.length > 0 && (
        <ol className="gd-insp__operands" aria-label="Operands">
          {operands.map((op) => (
            <li key={op.index} className="gd-insp__operand">
              <span
                className="gd-mono gd-insp__operand-index"
                style={{ background: referenceColourVar(op.index) }}
                aria-hidden="true"
              >
                {op.index + 1}
              </span>
              <span className="gd-mono gd-insp__operand-label">{op.label}</span>
              <span className="gd-insp__operand-kind">{op.kind}</span>
              {!op.anchored && (
                <span className="gd-insp__operand-note" title="Follows the address, not a cell">
                  not anchored
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
