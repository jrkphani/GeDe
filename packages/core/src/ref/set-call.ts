/**
 * Set-operator formulas as the guided tour counts them (ONB-05, step 3;
 * FX-09, ADR-055): a committed formula whose top-level call is one of
 * `Union`, `Inter`, `Diff`, `Comp` or `Cross` with at least two operands, at
 * least one of them a reference bound to a cell — an address, a range, a
 * column, an `@` entity path, or a method over one. `=Union(C5:C12)` is an
 * arity error, `=Diff("a, b", "b")` references nothing; neither counts. The
 * function name is matched as the parser does (`union` and `UNION` are
 * `Union`; `Minus` is `Diff`).
 *
 * Step 3 is two cards. 3a (`pick-form`) waits for any set operator; 3b
 * (`set-result`) waits for one of the four that compare two sets —
 * `SET_RESULT_FUNCTION_NAMES` — so a person who typed a Union for 3a is asked
 * for a Diff, Inter, Comp or Cross next. Each card baselines the set of cells
 * holding a matching formula when it first shows and advances on a key
 * outside it (the same shape as `concat.ts`), so nothing the sample ships
 * with, and nothing the previous card was satisfied by, advances the next.
 */
import { cellsMap, isFormula, type GedeDoc } from '../doc/schema.js';
import {
  isSetFunctionName,
  SET_FUNCTION_NAMES,
  type Ast,
  type Expr,
  type SetFunctionName,
} from '../formula/ast.js';
import { parse } from '../formula/parser.js';

/** The set operators that compare two sets — what step 3b asks for (every set operator but Union). */
export const SET_RESULT_FUNCTION_NAMES: readonly SetFunctionName[] = [
  'Inter',
  'Diff',
  'Comp',
  'Cross',
];

function isBoundOperand(arg: Expr): boolean {
  if (arg.kind === 'bound') return true;
  return arg.kind === 'method' && arg.target.kind === 'bound';
}

/**
 * Whether the formula's top-level call is one of `names` over at least two
 * operands, at least one of them bound to a cell.
 */
export function isSetOperatorCall(
  ast: Ast,
  names: readonly SetFunctionName[] = SET_FUNCTION_NAMES,
): boolean {
  if (ast.kind !== 'call' || !isSetFunctionName(ast.name) || !names.includes(ast.name)) {
    return false;
  }
  if (ast.args.length < 2) return false;
  return ast.args.some(isBoundOperand);
}

/** Whether a stored formula is a set-operator call the tour counts (see `isSetOperatorCall`). */
export function isSetOperatorFormula(
  source: string,
  names: readonly SetFunctionName[] = SET_FUNCTION_NAMES,
): boolean {
  if (!source.startsWith('=')) return false;
  const parsed = parse(source);
  return parsed.ok && isSetOperatorCall(parsed.value, names);
}

/**
 * The cells holding a set-operator formula over `names`, keyed
 * `${tableId}/${rowId}:${colId}` (the workbook cell id).
 */
export function setOperatorFormulaKeys(
  gd: GedeDoc,
  names: readonly SetFunctionName[] = SET_FUNCTION_NAMES,
): Set<string> {
  const keys = new Set<string>();
  gd.tables.forEach((table, tableId) => {
    cellsMap(table).forEach((content, key) => {
      if (isFormula(content) && isSetOperatorFormula(content, names)) keys.add(`${tableId}/${key}`);
    });
  });
  return keys;
}
