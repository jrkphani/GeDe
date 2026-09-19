import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { cellAddress } from '../doc/geometry.js';
import {
  cellText,
  listSheets,
  openDocument,
  tableById,
  tableMap,
  tablesOnSheet,
  type GedeDoc,
} from '../doc/schema.js';
import { setCellText } from '../doc/mutations.js';
import { commitCellText } from '../engine/commit.js';
import { FormulaEngine, observeWorkbook, type CellResult } from '../engine/index.js';
import { cellKey } from '../ids.js';
import { defaultFormatValue } from '../formula/evaluate.js';
import { SAMPLE_DELIVERABLES, SAMPLE_TEAM, seedSampleWorkscape } from '../sample/seed.js';
import { parse } from '../formula/parser.js';
import {
  isSetOperatorCall,
  isSetOperatorFormula,
  SET_RESULT_FUNCTION_NAMES,
  setOperatorFormulaKeys,
} from './set-call.js';

/**
 * The worked examples the tour's step 3 cards show, evaluated against the
 * sample (ONB-01, ADR-055). 3a: everyone named as an owner or on the team,
 * once each. 3b: who else on the team could take Billing export — the team
 * less that row's owner.
 */
export const TOUR_UNION_EXAMPLE = '=Union(C5:C12, I5:I8)';
export const TOUR_UNION_RESULT = 'Priya, Marcus, Aditi, Sanjay';
export const TOUR_DIFF_EXAMPLE = '=Diff(I5:I8, C6)';
export const TOUR_DIFF_RESULT = 'Priya, Aditi, Sanjay';

function sample(): { doc: Y.Doc; gd: GedeDoc } {
  const doc = new Y.Doc();
  seedSampleWorkscape(doc);
  return { doc, gd: openDocument(doc) };
}

function evaluate(doc: Y.Doc): Map<string, CellResult> {
  const gd = openDocument(doc);
  const engine = new FormulaEngine();
  const results = new Map<string, CellResult>();
  const stop = observeWorkbook(gd, (changes) => {
    const out = engine.apply(changes);
    for (const r of out.results) results.set(r.cellId, r);
  });
  stop();
  return results;
}

/** An empty cell of Deliverables (row 2, Owner role) to type into. */
function target(gd: GedeDoc): { tableId: string; rowId: string; colId: string } {
  const [deliverables] = tablesOnSheet(gd, listSheets(gd)[0]!.id);
  const d = tableById(gd, deliverables!.id)!;
  return { tableId: d.id, rowId: d.rows[1]!, colId: d.columns[5]!.id };
}

function key(t: { tableId: string; rowId: string; colId: string }): string {
  return `${t.tableId}/${cellKey(t.rowId, t.colId)}`;
}

describe('set-operator detection (tour step 3, FX-09)', () => {
  test('ONB-05 FX-09 a committed set operator over two or more operands with a bound reference counts; one operand, literals only, Concat, Sum or a bare reference do not; the parser’s name map applies', () => {
    const { gd } = sample();
    const t = target(gd);
    const stored = (text: string): string => {
      commitCellText(gd, t.tableId, t.rowId, t.colId, text);
      return cellText(tableMap(gd, t.tableId)!, t.rowId, t.colId);
    };
    expect(isSetOperatorFormula(stored(TOUR_UNION_EXAMPLE))).toBe(true);
    expect(isSetOperatorFormula(stored(TOUR_DIFF_EXAMPLE))).toBe(true);
    expect(isSetOperatorFormula(stored('=Inter(C5:C12, "Priya, Sanjay")'))).toBe(true);
    expect(isSetOperatorFormula(stored('=Comp(C6, I5:I8)'))).toBe(true);
    expect(isSetOperatorFormula(stored('=Cross(@Team.Priya.Role, C6)'))).toBe(true);
    // Aliases and case: `UNION`, `minus`, `intersect` are the canonical five.
    expect(isSetOperatorFormula(stored('=UNION(C5, C6)'))).toBe(true);
    expect(isSetOperatorFormula(stored('=minus(I5:I8, C6)'))).toBe(true);
    // A method over a bound reference is a bound operand; a whole column too.
    expect(isSetOperatorFormula(stored('=Union(C6.Split(", "), "x")'))).toBe(true);
    expect(isSetOperatorFormula(stored('=Union(C:C, I:I)'))).toBe(true);
    // One operand is an arity error; literals reference nothing; Concat and Sum are other steps.
    expect(isSetOperatorFormula(stored('=Union(C5:C12)'))).toBe(false);
    expect(isSetOperatorFormula(stored('=Diff("a, b", "b")'))).toBe(false);
    expect(isSetOperatorFormula(stored('=Concat(C5, " — ", @Team.Priya.Role)'))).toBe(false);
    expect(isSetOperatorFormula(stored('=Sum(F5, F6)'))).toBe(false);
    expect(isSetOperatorFormula(stored('=@Team.Priya.Role'))).toBe(false);
    expect(isSetOperatorFormula('plain text')).toBe(false);
    expect(isSetOperatorFormula('=Union(')).toBe(false);
  });

  test('ONB-05 FX-09 step 3b counts every set operator but Union; the AST predicate takes the same list', () => {
    const { gd } = sample();
    const t = target(gd);
    const stored = (text: string): string => {
      commitCellText(gd, t.tableId, t.rowId, t.colId, text);
      return cellText(tableMap(gd, t.tableId)!, t.rowId, t.colId);
    };
    expect(SET_RESULT_FUNCTION_NAMES).toEqual(['Inter', 'Diff', 'Comp', 'Cross']);
    expect(isSetOperatorFormula(stored(TOUR_UNION_EXAMPLE), SET_RESULT_FUNCTION_NAMES)).toBe(false);
    expect(isSetOperatorFormula(stored(TOUR_DIFF_EXAMPLE), SET_RESULT_FUNCTION_NAMES)).toBe(true);
    expect(isSetOperatorFormula(stored('=Inter(C5:C12, I5:I8)'), SET_RESULT_FUNCTION_NAMES)).toBe(
      true,
    );
    expect(isSetOperatorFormula(stored('=Comp(C6, I5:I8)'), SET_RESULT_FUNCTION_NAMES)).toBe(true);
    expect(isSetOperatorFormula(stored('=Cross(C5, I5)'), SET_RESULT_FUNCTION_NAMES)).toBe(true);
    // A nested set call under a Union is still a Union at the top level.
    expect(
      isSetOperatorFormula(stored('=Union(Diff(I5:I8, C6), C5)'), SET_RESULT_FUNCTION_NAMES),
    ).toBe(false);
    const parsed = parse(stored(TOUR_DIFF_EXAMPLE));
    expect(parsed.ok && isSetOperatorCall(parsed.value)).toBe(true);
    expect(parsed.ok && isSetOperatorCall(parsed.value, ['Union'])).toBe(false);
  });

  test('ONB-05 the sample ships with no set-operator formula; the set gains the cell that commits one and loses it when the cell is cleared', () => {
    const { gd } = sample();
    expect(setOperatorFormulaKeys(gd).size).toBe(0);
    const t = target(gd);
    commitCellText(gd, t.tableId, t.rowId, t.colId, TOUR_UNION_EXAMPLE);
    expect(setOperatorFormulaKeys(gd)).toEqual(new Set([key(t)]));
    expect(setOperatorFormulaKeys(gd, SET_RESULT_FUNCTION_NAMES).size).toBe(0);
    commitCellText(gd, t.tableId, t.rowId, t.colId, TOUR_DIFF_EXAMPLE);
    expect(setOperatorFormulaKeys(gd, SET_RESULT_FUNCTION_NAMES)).toEqual(new Set([key(t)]));
    setCellText(gd, t.tableId, t.rowId, t.colId, '');
    expect(setOperatorFormulaKeys(gd).size).toBe(0);
  });

  test('ONB-01 ONB-10 FX-09 the cards’ examples name the sample’s real addresses — Owner is C5:C12, Team names are I5:I8, Billing export’s owner is C6 — and evaluate to the results the cards show', () => {
    const { doc, gd } = sample();
    const [deliverables, team] = tablesOnSheet(gd, listSheets(gd)[0]!.id);
    const d = tableById(gd, deliverables!.id)!;
    const tm = tableById(gd, team!.id)!;
    const dMap = tableMap(gd, d.id)!;
    const tMap = tableMap(gd, tm.id)!;
    const owner = d.columns[1]!.id;
    const name = tm.columns[0]!.id;
    // The addresses the examples are written against (ADR-055).
    expect(cellAddress(dMap, d.rows[0]!, owner)).toBe('C5');
    expect(cellAddress(dMap, d.rows[SAMPLE_DELIVERABLES.length - 1]!, owner)).toBe('C12');
    expect(cellAddress(tMap, tm.rows[0]!, name)).toBe('I5');
    expect(cellAddress(tMap, tm.rows[SAMPLE_TEAM.length - 1]!, name)).toBe('I8');
    // I9 is the Total row, outside the range; C6 is the Billing export row's owner.
    expect(cellText(tMap, tm.rows[SAMPLE_TEAM.length]!, name)).toBe('Total');
    expect(cellAddress(dMap, d.rows[1]!, owner)).toBe('C6');
    expect(cellText(dMap, d.rows[1]!, d.columns[0]!.id)).toBe('Billing export');
    expect(cellText(dMap, d.rows[1]!, owner)).toBe('Marcus');

    const t = target(gd);
    commitCellText(gd, t.tableId, t.rowId, t.colId, TOUR_UNION_EXAMPLE);
    let result = evaluate(doc).get(key(t));
    expect(result?.error).toBeNull();
    expect(result?.value && defaultFormatValue(result.value)).toBe(TOUR_UNION_RESULT);
    commitCellText(gd, t.tableId, t.rowId, t.colId, TOUR_DIFF_EXAMPLE);
    result = evaluate(doc).get(key(t));
    expect(result?.error).toBeNull();
    expect(result?.value && defaultFormatValue(result.value)).toBe(TOUR_DIFF_RESULT);
  });
});
