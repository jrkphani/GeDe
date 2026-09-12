/**
 * Aggregation over formatted values (FMT-03, FMT-05, FX-02). The formula
 * engine's `Sum` has the same rules; this is the standalone form for footer
 * totals and for a Resolver that wants to pre-check a column.
 */
import type { CellValue, FormulaError } from '../formula/evaluate.js';
import { err, ok, type Result } from '../result.js';
import type { FormattedValue } from './value.js';

export interface SumOperand {
  readonly value: FormattedValue;
  /** A1 address or label for the error message; defaults to the operand's index. */
  readonly address?: string;
}

export interface CurrencySum {
  readonly kind: 'currency';
  readonly value: number;
  readonly code: string;
  /** Invalid cells skipped (FMT-05): they are excluded, never zero. */
  readonly excluded: number;
}

export interface NumberSum {
  readonly kind: 'number';
  readonly value: number;
  readonly excluded: number;
}

function addressOf(operand: SumOperand, index: number): string {
  return operand.address ?? `#${String(index + 1)}`;
}

function isOperand(item: SumOperand | FormattedValue): item is SumOperand {
  return !('kind' in item);
}

/**
 * Sum currency cells. Blanks count as zero, invalid cells are excluded and
 * counted, a plain number adopts the running code, text or a date is
 * `text-in-range`, and two codes are `mixed-currency` — an error, never a
 * conversion (FMT-03). With no currency operand at all the result is a
 * plain number sum.
 */
export function sumCurrency(
  operands: readonly (SumOperand | FormattedValue)[],
): Result<CurrencySum | NumberSum, FormulaError> {
  let total = 0;
  let code: string | null = null;
  let excluded = 0;
  for (const [index, item] of operands.entries()) {
    const operand: SumOperand = isOperand(item) ? item : { value: item };
    const value = operand.value;
    switch (value.kind) {
      case 'blank':
        break;
      case 'invalid':
        excluded += 1;
        break;
      case 'number':
        total += value.value;
        break;
      case 'currency':
        if (code !== null && code !== value.code) {
          return err({
            kind: 'mixed-currency',
            address: addressOf(operand, index),
            codes: [code, value.code],
          });
        }
        code = value.code;
        total += value.value;
        break;
      case 'text':
      case 'date':
        return err({ kind: 'text-in-range', address: addressOf(operand, index) });
    }
  }
  return ok(
    code === null
      ? { kind: 'number', value: total, excluded }
      : { kind: 'currency', value: total, code, excluded },
  );
}

/** A sum result as a `CellValue` for the formula engine or a footer cell. */
export function sumToCellValue(sum: CurrencySum | NumberSum): CellValue {
  return sum.kind === 'currency'
    ? { kind: 'currency', value: sum.value, code: sum.code }
    : { kind: 'number', value: sum.value };
}
