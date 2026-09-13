import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

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
import { seedSampleWorkscape } from '../sample/seed.js';
import { concatFormulaKeys, isConcatFormula } from './concat.js';

/** The worked example the tour's step 2b card shows, evaluated against the sample (ONB-01). */
export const TOUR_CONCAT_EXAMPLE = '=Concat(C5, " — ", @Team.Priya.Role)';

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

/** An empty cell of Deliverables (row 2, Days) to type into. */
function target(gd: GedeDoc): { tableId: string; rowId: string; colId: string } {
  const [deliverables] = tablesOnSheet(gd, listSheets(gd)[0]!.id);
  const d = tableById(gd, deliverables!.id)!;
  return { tableId: d.id, rowId: d.rows[1]!, colId: d.columns[5]!.id };
}

describe('Concat detection (tour step 2b, FX-01)', () => {
  test('ONB-05 FX-01 a committed Concat over two or more operands with a bound reference counts; one operand, literals only, or another function do not', () => {
    const { gd } = sample();
    const t = target(gd);
    const stored = (text: string): string => {
      commitCellText(gd, t.tableId, t.rowId, t.colId, text);
      return cellText(tableMap(gd, t.tableId)!, t.rowId, t.colId);
    };
    expect(isConcatFormula(stored('=Concat(C5, " · ", @Team.Priya.Role)'))).toBe(true);
    expect(isConcatFormula(stored('=Concat(@Team.Priya.Name, ": ", @Team.Priya.Role)'))).toBe(true);
    expect(isConcatFormula(stored('=Concat(B5, C5)'))).toBe(true);
    // The parser normalises the function name (`concat` is `Concat`).
    expect(isConcatFormula(stored('=concat(C5, " · ", @Team.Priya.Role)'))).toBe(true);
    // A method over a bound reference is still a bound operand.
    expect(isConcatFormula(stored('=Concat(@Team.Priya.Role.Extract("Product"), "!")'))).toBe(true);
    expect(isConcatFormula(stored('=Concat(C5)'))).toBe(false);
    expect(isConcatFormula(stored('=Concat("a", "b")'))).toBe(false);
    expect(isConcatFormula(stored('=Sum(@Team.Priya.Capacity, @Team.Marcus.Capacity)'))).toBe(
      false,
    );
    expect(isConcatFormula(stored('=@Team.Priya.Role'))).toBe(false);
    expect(isConcatFormula('plain text')).toBe(false);
    expect(isConcatFormula('=Concat(')).toBe(false);
  });

  test('ONB-05 the sample ships with no Concat formula; the set gains the cell that commits one and loses it when the cell is cleared', () => {
    const { gd } = sample();
    expect(concatFormulaKeys(gd).size).toBe(0);
    const t = target(gd);
    commitCellText(gd, t.tableId, t.rowId, t.colId, TOUR_CONCAT_EXAMPLE);
    expect(concatFormulaKeys(gd)).toEqual(new Set([`${t.tableId}/${cellKey(t.rowId, t.colId)}`]));
    setCellText(gd, t.tableId, t.rowId, t.colId, '');
    expect(concatFormulaKeys(gd).size).toBe(0);
  });

  test("ONB-01 ONB-10 the card's example evaluates against the sample to the result it shows: Priya — Product engineer (a row's key column is no entity path, so @Team.Priya.Name is not it)", () => {
    const { doc, gd } = sample();
    const t = target(gd);
    commitCellText(gd, t.tableId, t.rowId, t.colId, TOUR_CONCAT_EXAMPLE);
    const result = evaluate(doc).get(`${t.tableId}/${cellKey(t.rowId, t.colId)}`);
    expect(result?.value).toEqual(
      expect.objectContaining({ kind: 'text', text: 'Priya — Product engineer' }),
    );
    // #159 item 11e suggested `@Team.Priya.Name`: the key column is what names the entity, not
    // a path under it, so that spelling stays unbound and evaluates to an error.
    commitCellText(
      gd,
      t.tableId,
      t.rowId,
      t.colId,
      '=Concat(@Team.Priya.Name, " — ", @Team.Priya.Role)',
    );
    expect(evaluate(doc).get(`${t.tableId}/${cellKey(t.rowId, t.colId)}`)?.error).toMatchObject({
      kind: 'unknown-entity',
    });
  });
});
