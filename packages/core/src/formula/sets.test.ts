import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  complement,
  cross,
  crossCardinality,
  difference,
  intersection,
  MAX_CROSS_TUPLES,
  splitSetElements,
  union,
} from './sets.js';

describe('set elements (FX-09)', () => {
  test('FX-09 a cell splits on commas, semicolons and newlines; pieces are trimmed, empties dropped, duplicates collapsed first-seen', () => {
    expect(splitSetElements('1, 2')).toEqual(['1', '2']);
    expect(splitSetElements(' b ;a\n\nc,,b\r\na ')).toEqual(['b', 'a', 'c']);
    expect(splitSetElements('')).toEqual([]);
    expect(splitSetElements(' , ; ')).toEqual([]);
  });

  test('FX-09 a separator inside parentheses does not split, so Cross pairs survive the round trip', () => {
    expect(splitSetElements('(1, 2), (1, 3)')).toEqual(['(1, 2)', '(1, 3)']);
    expect(splitSetElements('(a, (b, c)), d')).toEqual(['(a, (b, c))', 'd']);
    // An unbalanced close does not swallow the rest of the text.
    expect(splitSetElements('a), b')).toEqual(['a)', 'b']);
  });

  test('FX-09 a lone ( swallows the rest of the text into one element', () => {
    expect(splitSetElements('a, (b, c')).toEqual(['a', '(b, c']);
    expect(splitSetElements('(a, b')).toEqual(['(a, b']);
  });

  test('FX-09 quotes are not delimiters: "a, b", c is three elements', () => {
    expect(splitSetElements('"a, b", c')).toEqual(['"a', 'b"', 'c']);
  });

  test('FX-09 crossCardinality is the product of the deduplicated operand sizes, computed without building a tuple', () => {
    expect(
      crossCardinality([
        ['a', 'b'],
        ['c', 'd', 'e'],
      ]),
    ).toBe(6);
    expect(crossCardinality([['a', 'a'], ['c']])).toBe(1);
    expect(crossCardinality([['a'], []])).toBe(0);
    expect(crossCardinality([])).toBe(0);
    const big = Array.from({ length: 3000 }, (_, i) => String(i));
    expect(crossCardinality([big, big])).toBe(9_000_000);
    expect(MAX_CROSS_TUPLES).toBe(10_000);
  });

  test('FX-09 equality is exact after trim and NFC: case-sensitive, composed and decomposed forms equal', () => {
    expect(splitSetElements('Apple, apple')).toEqual(['Apple', 'apple']);
    expect(splitSetElements('café, café')).toEqual(['café']);
  });

  test('FX-09 Union keeps the first operand’s order, then each later operand’s new elements', () => {
    expect(union([['b', 'a'], ['c', 'a'], ['d']])).toEqual(['b', 'a', 'c', 'd']);
  });

  test('FX-09 Inter keeps the first operand’s order; Diff subtracts the union of the rest; Comp reads the universe’s order', () => {
    expect(
      intersection([
        ['c', 'a', 'b'],
        ['b', 'c', 'z'],
        ['c', 'b'],
      ]),
    ).toEqual(['c', 'b']);
    expect(difference([['a', 'b', 'c', 'd'], ['b'], ['d', 'x']])).toEqual(['a', 'c']);
    expect(complement(['1', '2'], ['4', '3', '2', '1'])).toEqual(['4', '3']);
  });

  test('FX-09 Cross renders ordered tuples first-operand-major; an empty operand empties the product', () => {
    expect(
      cross([
        ['1', '2'],
        ['2', '3'],
      ]),
    ).toEqual(['(1, 2)', '(1, 3)', '(2, 2)', '(2, 3)']);
    expect(cross([['a'], ['b'], ['c', 'd']])).toEqual(['(a, b, c)', '(a, b, d)']);
    expect(cross([['a'], []])).toEqual([]);
  });

  const element = fc.stringMatching(/^[a-z0-9]{1,3}$/);
  const set = fc.uniqueArray(element, { maxLength: 6 });

  test('FX-09 Union is commutative (as a set) and idempotent; Inter is within each operand; Diff and its subtrahend are disjoint; |Cross| = |A|·|B|', () => {
    fc.assert(
      fc.property(set, set, (a, b) => {
        const ab = union([a, b]);
        const ba = union([b, a]);
        expect(new Set(ab)).toEqual(new Set(ba));
        expect(union([a, a])).toEqual(a);
        expect(union([ab, a, b])).toEqual(ab);
        const inter = intersection([a, b]);
        for (const e of inter) expect(a).toContain(e);
        for (const e of inter) expect(b).toContain(e);
        const diff = difference([a, b]);
        expect(intersection([diff, b])).toEqual([]);
        expect(union([diff, inter]).length).toBe(a.length);
        expect(cross([a, b])).toHaveLength(a.length * b.length);
        expect(complement(a, ab)).toEqual(difference([b, a]));
      }),
      { numRuns: 200 },
    );
  });

  test('FX-09 any result re-splits to itself (the algebra is closed under the cell text)', () => {
    fc.assert(
      fc.property(set, set, (a, b) => {
        for (const result of [
          union([a, b]),
          intersection([a, b]),
          difference([a, b]),
          cross([a, b]),
        ]) {
          expect(splitSetElements(result.join(', '))).toEqual(result);
        }
      }),
      { numRuns: 200 },
    );
  });
});
