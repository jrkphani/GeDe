/**
 * SET-09, SPEC §2.4: a computed table whose formula is refused or in error says so —
 * `⚠ too many tuples`, `⚠ circular`, `⚠ reference removed` — with the message naming why:
 * in words in the title bar (a 160 px heading cannot hold them beside its name), and as the
 * ⚠ glyph on the first computed column's heading, whose name and tooltip carry the words. Its rows stay as they were (a refused result reconciles nothing),
 * so without this the last rows would read as current. Icon and words, never hue alone
 * (A11Y-04); the message is in the accessible name and the tooltip.
 */
import type * as Y from 'yjs';
import {
  cellErrorLabel,
  cellErrorMessage,
  computedFormulaKey,
  workbookCellId,
  type CellError,
  type CellResult,
  type Id,
} from '@gede/core';
import { Icon } from '@gede/ui';

import { useCellResult } from '../../../doc/engine.js';
import { useLocale } from '../../../locale.js';

/** The error the table's formula evaluated to for `formula`, or null (none, or not yet answered). */
export function computedFormulaError(
  result: CellResult | undefined,
  formula: string,
): CellError | null {
  if (result?.source !== formula) return null;
  if (result.error !== null) return result.error;
  return result.value?.kind === 'error' ? result.value.error : null;
}

export interface ComputedFormulaErrorProps {
  readonly doc: Y.Doc;
  readonly tableId: Id;
  /** The table's first computed column: the engine keeps the formula there. */
  readonly driverColId: Id;
  readonly formula: string;
  /** In a column heading: the glyph alone, its words in its accessible name and tooltip. */
  readonly compact?: boolean;
}

export function ComputedFormulaError({
  doc,
  tableId,
  driverColId,
  formula,
  compact = false,
}: ComputedFormulaErrorProps) {
  const [locale] = useLocale();
  const result = useCellResult(doc, workbookCellId(tableId, computedFormulaKey(driverColId)));
  const error = computedFormulaError(result, formula);
  if (error === null) return null;
  const label = cellErrorLabel(error).replace(/^⚠\s*/u, '');
  const message = cellErrorMessage(error, locale);
  if (compact) {
    return (
      <span
        className="gd-set-error gd-set-error--compact"
        data-testid="computed-error-glyph"
        role="img"
        aria-label={`${label}: ${message}`}
        title={`${label}: ${message}`}
      >
        <Icon name="warning" size={13} />
      </span>
    );
  }
  return (
    <span className="gd-set-error" title={message} data-testid="computed-error">
      <Icon name="warning" size={13} />
      <span className="gd-set-error__text">{label}</span>
      <span className="gd-visually-hidden">{`: ${message}`}</span>
    </span>
  );
}
