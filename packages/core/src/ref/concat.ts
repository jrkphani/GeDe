/**
 * `=Concat()` formulas as the guided tour counts them (ONB-05, step 2b;
 * FX-01): a committed formula whose top-level call is `Concat` with at least
 * two operands, at least one of them a reference bound to a cell — an
 * address (`B5`), an `@` entity path, or a method over either. `=Concat(B5)`
 * joins nothing; `=Concat("a", "b")` references nothing; neither counts. The
 * function name is matched as the parser does (`concat` is `Concat`).
 *
 * The tour baselines the set of cells holding one when the sub-step begins
 * and advances on a key outside it (the same shape as `cross-table.ts`), so
 * nothing the sample ships with advances the step on its own.
 */
import { cellsMap, isFormula, type GedeDoc } from '../doc/schema.js';
import type { Expr } from '../formula/ast.js';
import { parse } from '../formula/parser.js';

function isBoundOperand(arg: Expr): boolean {
  if (arg.kind === 'bound') return true;
  return arg.kind === 'method' && arg.target.kind === 'bound';
}

/** Whether a stored formula joins at least two operands with Concat, one of them a bound reference. */
export function isConcatFormula(source: string): boolean {
  if (!source.startsWith('=')) return false;
  const parsed = parse(source);
  if (!parsed.ok) return false;
  const ast = parsed.value;
  if (ast.kind !== 'call' || ast.name !== 'Concat' || ast.args.length < 2) return false;
  return ast.args.some(isBoundOperand);
}

/** The cells holding a Concat formula, keyed `${tableId}/${rowId}:${colId}` (the workbook cell id). */
export function concatFormulaKeys(gd: GedeDoc): Set<string> {
  const keys = new Set<string>();
  gd.tables.forEach((table, tableId) => {
    cellsMap(table).forEach((content, key) => {
      if (isFormula(content) && isConcatFormula(content)) keys.add(`${tableId}/${key}`);
    });
  });
  return keys;
}
