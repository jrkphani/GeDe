import { describe, expect, test } from 'vitest';

import { formatAddress, parseAddress, type CellRef } from '../address.js';
import {
  defaultFormatValue,
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
    bound: () => undefined,
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

const num = (value: number, text?: string): CellValue =>
  text === undefined ? { kind: 'number', value } : { kind: 'number', value, text };
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

describe('set operators (FX-09)', () => {
  /** A = {1, 2}, B = {2, 3}, U = {1, 2, 3, 4}: the owner's worked example. */
  const sets = () => fakeResolver({ A1: txt('1, 2'), B1: txt('2, 3'), U1: txt('1, 2, 3, 4') });
  const set = (...items: string[]): CellValue => ({ kind: 'list', items: items.map(txt) });
  const ELEMENTS = (result: EvaluateResult): string[] => {
    if (!result.ok) throw new Error(errorLabel(result.error));
    if (result.value.kind !== 'list') throw new Error(`not a list: ${result.value.kind}`);
    return result.value.items.map((i) => (i.kind === 'text' ? i.text : '?'));
  };

  test('FX-09 Union: A ∪ B = {1, 2, 3}', () => {
    expect(run('=UNION(A1, B1)', sets())).toEqual({ ok: true, value: set('1', '2', '3') });
  });

  test('FX-09 Inter: A ∩ B = {2}', () => {
    expect(run('=Inter(A1, B1)', sets())).toEqual({ ok: true, value: set('2') });
  });

  test('FX-09 Diff: A \\ B = {1}', () => {
    expect(run('=Diff(A1, B1)', sets())).toEqual({ ok: true, value: set('1') });
  });

  test('FX-09 Comp: Aᶜ within U = {1, 2, 3, 4} is {3, 4}; the universe is the second argument', () => {
    expect(run('=Comp(A1, U1)', sets())).toEqual({ ok: true, value: set('3', '4') });
  });

  test('FX-09 Cross: A × B = {(1, 2), (1, 3), (2, 2), (2, 3)} in a-major order', () => {
    expect(run('=Cross(A1, B1)', sets())).toEqual({
      ok: true,
      value: set('(1, 2)', '(1, 3)', '(2, 2)', '(2, 3)'),
    });
  });

  test('FX-09 the result renders comma-separated as text and an empty result renders as an empty cell', () => {
    const union = run('=Union(A1, B1)', sets());
    if (!union.ok) throw new Error('union');
    expect(defaultFormatValue(union.value)).toBe('1, 2, 3');
    const empty = run('=Inter(A1, "9")', sets());
    expect(empty).toEqual({ ok: true, value: { kind: 'list', items: [] } });
    if (empty.ok) expect(defaultFormatValue(empty.value)).toBe('');
  });

  test('FX-09 Union, Inter, Diff and Cross are n-ary; Diff removes the union of the rest', () => {
    const r = fakeResolver({
      A1: txt('a, b, c, d'),
      B1: txt('b'),
      C1: txt('c, x'),
      D1: txt('a, b'),
    });
    expect(ELEMENTS(run('=Union(A1, B1, C1)', r))).toEqual(['a', 'b', 'c', 'd', 'x']);
    expect(ELEMENTS(run('=Inter(A1, D1, "a, b, q")', r))).toEqual(['a', 'b']);
    expect(ELEMENTS(run('=Diff(A1, B1, C1)', r))).toEqual(['a', 'd']);
    expect(ELEMENTS(run('=Cross(B1, "1, 2", "x")', r))).toEqual(['(b, 1, x)', '(b, 2, x)']);
  });

  test.each([
    ['=Union(A1)', 'Union', { atLeast: 2 }, '⚠ Union takes at least 2 arguments'],
    ['=Inter(A1)', 'Inter', { atLeast: 2 }, '⚠ Inter takes at least 2 arguments'],
    ['=Diff(A1)', 'Diff', { atLeast: 2 }, '⚠ Diff takes at least 2 arguments'],
    ['=Cross()', 'Cross', { atLeast: 2 }, '⚠ Cross takes at least 2 arguments'],
    ['=Comp(A1)', 'Comp', { exactly: 2 }, '⚠ Comp takes 2 arguments'],
    ['=Comp(A1, B1, U1)', 'Comp', { exactly: 2 }, '⚠ Comp takes 2 arguments'],
  ])('FX-09 wrong arity is a formula error: %s', (text, name, arity, label) => {
    const result = run(text, sets());
    expect(result).toEqual({ ok: false, error: { kind: 'arity', name, arity } });
    if (!result.ok) expect(errorLabel(result.error)).toBe(label);
  });

  test('FX-09 elements split on commas, semicolons and newlines; each is trimmed and NFC-normalised; empties drop; equality is case-sensitive', () => {
    const r = fakeResolver({
      A1: txt(' apple ;banana\n\ncherry,, Apple '),
      // "é" as e + combining acute, against the precomposed é in B1.
      B1: txt('café, apple'),
      C1: txt('café'),
    });
    expect(ELEMENTS(run('=Union(A1, "")', r))).toEqual(['apple', 'banana', 'cherry', 'Apple']);
    expect(ELEMENTS(run('=Inter(B1, C1)', r))).toEqual(['café']);
    expect(ELEMENTS(run('=Inter(A1, "APPLE")', r))).toEqual([]);
  });

  test('FX-09 a blank cell is the empty set, a range contributes every cell and skips blanks; an Automatic number splits its stored spelling as typed', () => {
    const r = fakeResolver({ A1: txt('1, 2'), A3: txt('3'), B1: num(1200, '1,200') });
    expect(ELEMENTS(run('=Union(A1:A4, Z9)', r))).toEqual(['1', '2', '3']);
    expect(ELEMENTS(run('=Diff(Z9, A1)', r))).toEqual([]);
    expect(ELEMENTS(run('=Union(B1, 7)', r))).toEqual(['1', '200', '7']);
  });

  test('FX-09 a number, amount or date under an explicit format is one element spelled locale-independently, never its locale rendering', () => {
    // As the engine builds them for an en-IN replica (`cellValueOf`): the text is a rendering.
    const r = fakeResolver({
      A1: { kind: 'number', value: 1234567, text: '12,34,567', rendered: true },
      B1: { kind: 'currency', value: 1200.5, code: 'SGD', text: 'S$1,200.50', rendered: true },
      C1: { kind: 'date', iso: '2026-09-12', text: '12/9/2026', rendered: true },
      D1: { kind: 'number', value: 3.5 },
    });
    const formatValue = (v: CellValue): string =>
      v.kind === 'number' ? new Intl.NumberFormat('en-IN').format(v.value) : '';
    const ast = parse('=Union(A1, B1, C1, D1, Sum(D1, D1), "1234567")');
    if (!ast.ok) throw new Error('parse');
    expect(ELEMENTS(evaluate(ast.value, r, { formatValue, locale: 'en-IN' }))).toEqual([
      '1234567',
      'SGD 1200.5',
      '2026-09-12',
      '3.5',
      '7',
    ]);
    expect(ELEMENTS(run('=Inter(A1, "1234567")', r))).toEqual(['1234567']);
  });

  test('FX-09 FMT-05 a cell its format could not parse is blank to Sum but contributes its stored text as a set', () => {
    const r = fakeResolver({ A1: { kind: 'blank', text: 'north, south' }, B1: num(1) });
    expect(run('=Sum(A1, B1)', r)).toEqual({ ok: true, value: num(1) });
    expect(ELEMENTS(run('=Union(A1, "east")', r))).toEqual(['north', 'south', 'east']);
    expect(run('=Concat(A1, B1)', r)).toEqual({ ok: true, value: txt('1') });
  });

  test('FX-09 Cross is refused from the operand sizes past MAX_CROSS_TUPLES, before any tuple is built', () => {
    const big = (n: number, prefix: string): CellValue =>
      txt(Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`).join(', '));
    const r = fakeResolver({ A1: big(100, 'a'), B1: big(100, 'b'), C1: big(101, 'c') });
    const ok = run('=Cross(A1, B1)', r);
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.value.kind === 'list') expect(ok.value.items).toHaveLength(10_000);
    const refused = run('=Cross(A1, C1)', r);
    expect(refused).toEqual({ ok: false, error: { kind: 'too-many-tuples', count: 10_100 } });
    if (!refused.ok) expect(errorLabel(refused.error)).toBe('⚠ too many tuples');
    // Three operands multiply; duplicates do not count.
    expect(run('=Cross(A1, B1, "x, x, y")', r)).toEqual({
      ok: false,
      error: { kind: 'too-many-tuples', count: 20_000 },
    });
  });

  test('FX-09 ; separates arguments like , inside a call', () => {
    expect(run('=Union(A1; B1)', sets())).toEqual({ ok: true, value: set('1', '2', '3') });
    expect(run('=Comp(A1;U1)', sets())).toEqual({ ok: true, value: set('3', '4') });
  });

  test('FX-09 a set result round-trips as the operand of another set function, pairs from Cross included', () => {
    const r = fakeResolver(
      { A1: txt('1, 2'), B1: txt('2, 3'), C1: txt('4') },
      {},
      { D1: '=Cross(A1, B1)', E1: '=Cross(A1, C1)' },
    );
    expect(ELEMENTS(run('=Union(D1, E1)', r))).toEqual([
      '(1, 2)',
      '(1, 3)',
      '(2, 2)',
      '(2, 3)',
      '(1, 4)',
      '(2, 4)',
    ]);
    expect(ELEMENTS(run('=Union(Cross(A1, B1), Cross(A1, C1))', r))).toEqual(
      ELEMENTS(run('=Union(D1, E1)', r)),
    );
    expect(ELEMENTS(run('=Inter(Cross(A1, B1), "(2, 3), (9, 9)")', r))).toEqual(['(2, 3)']);
    expect(ELEMENTS(run('=Diff(D1, Cross(A1, "2"))', r))).toEqual(['(1, 3)', '(2, 3)']);
    // Nested inside Concat, a set reads as its comma-separated text.
    expect(run('=Concat("[", Union(A1, B1), "]")', r)).toEqual({
      ok: true,
      value: txt('[1, 2, 3]'),
    });
  });

  test('FX-09 quoted literals, @ paths and a Split list are operands; a list’s items are the elements — the Split boundary wins over a comma inside a piece', () => {
    const r = fakeResolver(
      { A1: txt('x / y / z'), B1: txt('x, y / z') },
      { 'Team.Tags': txt('y; q') },
    );
    expect(ELEMENTS(run('=Union("a, b", @Team.Tags)', r))).toEqual(['a', 'b', 'y', 'q']);
    expect(ELEMENTS(run('=Inter(A1.Split(" / "), @Team.Tags)', r))).toEqual(['y']);
    expect(ELEMENTS(run('=Union(B1.Split(" / "), "x")', r))).toEqual(['x, y', 'z', 'x']);
  });

  test('FX-09 a lone ( swallows the rest of the text into one element; quotes are not delimiters', () => {
    const r = fakeResolver({ A1: txt('a, (b, c'), B1: txt('"a, b", c') });
    expect(ELEMENTS(run('=Union(A1, "")', r))).toEqual(['a', '(b, c']);
    expect(ELEMENTS(run('=Union(B1, "")', r))).toEqual(['"a', 'b"', 'c']);
  });

  test('FX-09 FX-06 an error in an operand propagates as it does for Sum', () => {
    const r = fakeResolver({ A1: txt('x') }, {}, { B1: '=Sum(A1)' });
    expect(run('=Union(B1, A1)', r)).toEqual({
      ok: false,
      error: { kind: 'text-in-range', address: 'A1' },
    });
    expect(run('=Union(@Nobody.Here, A1)', r)).toEqual({
      ok: false,
      error: { kind: 'unknown-entity', path: '@Nobody.Here' },
    });
  });

  test('FX-09 a set result is text to Sum', () => {
    const r = fakeResolver({ A1: txt('1, 2') }, {}, { B1: '=Union(A1, A1)' });
    expect(run('=Sum(B1)', r)).toEqual({
      ok: false,
      error: { kind: 'text-in-range', address: 'B1' },
    });
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
      bound: () => undefined,
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
