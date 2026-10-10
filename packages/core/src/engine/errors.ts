/**
 * User-facing wording for a formula cell in error (A11Y-04: icon + text,
 * never hue alone). The short label sits in the cell; the message is the
 * tooltip and the live-region announcement.
 */
import { arityText, errorLabel } from '../formula/evaluate.js';
import { MAX_CROSS_TUPLES } from '../formula/sets.js';
import type { CellError } from './types.js';

export function cellErrorLabel(error: CellError): string {
  if (error.kind === 'parse') return '⚠ invalid formula';
  return errorLabel(error);
}

/** `locale` is the active BCP 47 tag; counts go through Intl for it. */
export function cellErrorMessage(error: CellError, locale?: string): string {
  const count = (n: number): string => new Intl.NumberFormat(locale).format(n);
  switch (error.kind) {
    case 'parse':
      return error.error.message;
    case 'text-in-range':
      return `${error.address} holds text, so it cannot be summed`;
    case 'mixed-currency':
      return `${error.address} is in ${error.codes[1]}; the sum so far is in ${error.codes[0]}`;
    case 'circular':
      return 'This formula depends on its own result';
    case 'unknown-entity':
      return `${error.path} does not name anything in this workscape`;
    case 'reference-removed':
      return `This formula reads ${error.label} that was deleted; undo the delete or re-enter the formula`;
    case 'invalid-argument':
      return error.message;
    case 'arity':
      return error.name === 'Comp'
        ? 'Comp takes exactly 2 arguments: the set, then its universe'
        : `${error.name} takes ${arityText(error.arity)}`;
    case 'too-many-tuples':
      return `Cross would make ${count(error.count)} tuples, past the limit of ${count(MAX_CROSS_TUPLES)}; narrow the sets`;
    case 'too-many-subsets':
      return `Power over ${count(error.elements)} elements would make more than ${count(MAX_CROSS_TUPLES)} subsets; a set of at most 13 elements fits`;
  }
}
