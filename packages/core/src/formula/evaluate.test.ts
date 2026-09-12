import { describe, expect, test } from 'vitest';

import { formatAddress, parseAddress, type CellRef } from '../address.js';
import {
  errorLabel,
  evaluate,
  type CellValue,
  type EvaluateResult,
  type Resolver,
} from './evaluate.js';
import { parse } from './parser.js';

/** A labelled fake resolver over a Map of A1 → value plus an entity map. Not a workbook. */
function fakeResolver(
  cells: Record<string, CellValue>,
  entities: Record<string, CellValue> = {},
  formulas: Record<string, string> = {},
): Resolver {
  const resolver: Resolver = {
    valueAt(ref, depth) {
      const address = formatAddress(ref);
      const formula = formulas[address];
      if (formula !== undefined) {
        const ast = parse(formula);
        if (!ast.ok) throw new Error(ast.error.message);
        const result = evaluate(ast.value, resolver, { depth: depth + 1 });
        return result.ok ? result.value : { kind: 'error', error: result.error };
      }
      return cells[address];
    },
    entity(path) {
      return entities[path.join('.')];
    },
    columnValues(col, depth) {
      const out: { row: number; value: CellValue }[] = [];
      for (const address of Object.keys(cells)) {
        const parsed = parseAddress(address);
        if (parsed.ok && parsed.value.col === col) {
          const ref: CellRef = parsed.value;
          const value = resolver.valueAt(ref, depth);
          if (value) out.push({ row: ref.row, value });
        }
      }
      return out.sort((a, b) => a.row - b.row);
    },
  };
  return resolver;
}

function run(text: string, resolver: Resolver): EvaluateResult {
  const ast = parse(text);
  if (!ast.ok) throw new Error(ast.error.message);
  return evaluate(ast.value, resolver);
}

const num = (value: number): CellValue => ({ kind: 'number', value });
const sgd = (value: number): CellValue => ({ kind: 'currency', value, code: 'SGD' });
const txt = (text: string): CellValue => ({ kind: 'text', text });

describe('Concat (FX-01)', () => {
  test('FX-01 joins addresses, entity paths and literals end to end', () => {
    const r = fakeResolver(
      { A1: txt('Ada'), B1: txt('Lovelace') },
      { 'Team.Lead': txt('Babbage') },
    );
    expect(run('=Concat(A1, " ", B1, " · ", @Team.Lead)', r)).toEqual({
      ok: true,
      value: txt('Ada Lovelace · Babbage'),
    });
  });

  test('FX-01 blanks contribute nothing; numbers and currency render locale-neutrally by default', () => {
    const r = fakeResolver({ A1: num(3), B1: sgd(12.5) });
    expect(run('=Concat(A1, "/", B1, C1, 7)', r)).toEqual({ ok: true, value: txt('3/SGD 12.57') });
  });

  test('FX-01 a formatValue hook owns display formatting', () => {
    const ast = parse('=Concat(A1)');
    if (!ast.ok) throw new Error('parse');
    const result = evaluate(ast.value, fakeResolver({ A1: num(1234.5) }), {
      formatValue: (v) =>
        v.kind === 'number' ? new Intl.NumberFormat('en-IN').format(v.value) : '',
    });
    expect(result).toEqual({ ok: true, value: txt('1,234.5') });
  });

  test('FX-01 a range operand lists its cells comma-separated', () => {
    const r = fakeResolver({ A1: txt('x'), A2: txt('y') });
    expect(run('=Concat(A1:A2)', r)).toEqual({ ok: true, value: txt('x, y') });
  });

  test('FX-01 an unknown @ path is an error, not empty text', () => {
    expect(run('=Concat(@Nobody.Here)', fakeResolver({}))).toEqual({
      ok: false,
      error: { kind: 'unknown-entity', path: '@Nobody.Here' },
    });
  });
});

describe('Sum (FX-02)', () => {
  test('FX-02 adds a range; blanks count as zero', () => {
    const r = fakeResolver({ B2: num(1), B3: num(2), B5: num(4) });
    expect(run('=Sum(B2:B5)', r)).toEqual({ ok: true, value: num(7) });
  });

  test('FX-02 adds an address list, @ paths and literals', () => {
    const r = fakeResolver({ A1: num(1), A2: num(2) }, { 'Q1.Total': num(10) });
    expect(run('=Sum(A1, A2, @Q1.Total, 0.5)', r)).toEqual({ ok: true, value: num(13.5) });
  });

  test('FX-02 adds a whole column', () => {
    const r = fakeResolver({ B1: num(1), B9: num(9), C1: num(100) });
    expect(run('=Sum(B:B)', r)).toEqual({ ok: true, value: num(10) });
  });

  test('FX-02 a text cell in range yields ⚠ text in range naming the offender', () => {
    const r = fakeResolver({ B2: num(1), B3: txt('n/a'), B4: num(2) });
    const result = run('=Sum(B2:B4)', r);
    expect(result).toEqual({ ok: false, error: { kind: 'text-in-range', address: 'B3' } });
    if (!result.ok) expect(errorLabel(result.error)).toBe('⚠ text in range');
  });

  test('FX-02 a text cell in a whole column names its lattice address', () => {
    const r = fakeResolver({ B1: num(1), B7: txt('seven') });
    expect(run('=Sum(B:B)', r)).toEqual({
      ok: false,
      error: { kind: 'text-in-range', address: 'B7' },
    });
  });

  test('FX-02 a date is not numeric either', () => {
    const r = fakeResolver({ B2: { kind: 'date', iso: '2026-09-12' } });
    expect(run('=Sum(B2)', r)).toEqual({
      ok: false,
      error: { kind: 'text-in-range', address: 'B2' },
    });
  });

  test('FX-02 the result takes the operands’ currency', () => {
    const r = fakeResolver({ B2: sgd(10), B3: sgd(2.25), B4: { kind: 'blank' } });
    expect(run('=Sum(B2:B4)', r)).toEqual({ ok: true, value: sgd(12.25) });
  });

  test('FX-02 mixed currencies are an error, never a conversion', () => {
    const r = fakeResolver({ B2: sgd(10), B3: { kind: 'currency', value: 5, code: 'MYR' } });
    expect(run('=Sum(B2, B3)', r)).toEqual({
      ok: false,
      error: { kind: 'mixed-currency', address: 'B3', codes: ['SGD', 'MYR'] },
    });
  });

  test('FX-02 a quoted string is not a Sum operand', () => {
    const result = run('=Sum("12")', fakeResolver({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('invalid-argument');
  });

  test('FX-02 nested Sum feeds the outer Sum', () => {
    const r = fakeResolver({ A1: num(1), A2: num(2) });
    expect(run('=Sum(Sum(A1, A2), 3)', r)).toEqual({ ok: true, value: num(6) });
  });
});

describe('lists (FX-03)', () => {
  test('FX-03 =A2, D5 lists the values with the typed separator', () => {
    const r = fakeResolver({ A2: txt('left'), D5: num(5) });
    expect(run('=A2, D5', r)).toEqual({ ok: true, value: txt('left, 5') });
  });

  test('FX-03 =@Path — @Path echoes any separator text between entities', () => {
    const r = fakeResolver({}, { 'Sales.North': num(1), 'Sales.South': num(2) });
    expect(run('=@Sales.North — @Sales.South', r)).toEqual({ ok: true, value: txt('1 — 2') });
  });

  test('FX-03 a blank address renders as empty text', () => {
    expect(run('=Z99', fakeResolver({}))).toEqual({ ok: true, value: txt('') });
  });
});

describe('evaluation chains (FX-06)', () => {
  test('FX-06 formulas may reference formulas', () => {
    const r = fakeResolver(
      { A1: num(2), A2: num(3) },
      {},
      { B1: '=Sum(A1, A2)', C1: '=Sum(B1, B1)' },
    );
    expect(run('=C1', r)).toEqual({ ok: true, value: txt('10') });
    expect(run('=Sum(C1)', r)).toEqual({ ok: true, value: num(10) });
  });

  test('FX-06 an error in a referenced formula propagates', () => {
    const r = fakeResolver({ A1: txt('x') }, {}, { B1: '=Sum(A1)' });
    expect(run('=Sum(B1, 1)', r)).toEqual({
      ok: false,
      error: { kind: 'text-in-range', address: 'A1' },
    });
    expect(run('=Concat(B1)', r)).toEqual({
      ok: false,
      error: { kind: 'text-in-range', address: 'A1' },
    });
  });

  test('FX-06 the depth guard reports ⚠ circular for a reference loop', () => {
    const r = fakeResolver({}, {}, { A1: '=Sum(B1)', B1: '=Sum(A1)' });
    const result = run('=Sum(A1)', r);
    expect(result).toEqual({ ok: false, error: { kind: 'circular' } });
    if (!result.ok) expect(errorLabel(result.error)).toBe('⚠ circular');
  });

  test('FX-06 a self-referencing formula is circular', () => {
    const r = fakeResolver({}, {}, { A1: '=Concat(A1)' });
    expect(run('=A1', r)).toEqual({ ok: false, error: { kind: 'circular' } });
  });

  test('FX-06 evaluate beyond maxDepth is circular without touching the resolver', () => {
    const ast = parse('=Sum(A1)');
    if (!ast.ok) throw new Error('parse');
    const resolver: Resolver = {
      valueAt: () => {
        throw new Error('must not be called');
      },
      entity: () => undefined,
      columnValues: () => [],
    };
    expect(evaluate(ast.value, resolver, { depth: 5, maxDepth: 4 })).toEqual({
      ok: false,
      error: { kind: 'circular' },
    });
  });
});
