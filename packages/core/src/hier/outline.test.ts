/**
 * The outline as pure functions (HIER-02, HIER-03, HIER-05, HIER-06):
 * property tests over arbitrary depth sequences, valid and not.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  canNest,
  canPromote,
  effectiveDepths,
  hasDescendants,
  hiddenRows,
  isValidDepths,
  parentIndex,
  subtreeEnd,
} from './outline.js';

/** Any sequence of stored depths, including ones a merge could leave invalid. */
const anyDepths = fc.array(fc.nat(6), { maxLength: 40 });

/** Depths that already obey HIER-02: each at most one deeper than the one before. */
const validDepths = fc.array(fc.integer({ min: -6, max: 1 }), { maxLength: 40 }).map((deltas) => {
  const out: number[] = [];
  let previous = -1;
  for (const delta of deltas) {
    const next = Math.max(0, Math.min(previous + 1, previous + delta));
    out.push(next);
    previous = next;
  }
  return out;
});

const outline = (depths: readonly number[]) =>
  fc.tuple(
    fc.constant(depths),
    fc.array(fc.boolean(), { minLength: depths.length, maxLength: depths.length }),
  );

describe('effectiveDepths (HIER-02 as an invariant)', () => {
  test('HIER-02 the result always starts at 0 and never steps down more than one level up from the row above', () => {
    fc.assert(
      fc.property(anyDepths, (depths) => {
        const effective = effectiveDepths(depths);
        expect(effective.length).toBe(depths.length);
        effective.forEach((d, i) => {
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(i === 0 ? 0 : (effective[i - 1] ?? 0) + 1);
          expect(d).toBeLessThanOrEqual(depths[i] ?? 0); // never deeper than stored
        });
      }),
    );
  });

  test('HIER-02 valid input is returned unchanged, and the function is idempotent', () => {
    fc.assert(
      fc.property(validDepths, (depths) => {
        expect(isValidDepths(depths)).toBe(true);
        expect(effectiveDepths(depths)).toEqual(depths);
      }),
    );
    fc.assert(
      fc.property(anyDepths, (depths) => {
        const once = effectiveDepths(depths);
        expect(effectiveDepths(once)).toEqual(once);
        expect(isValidDepths(once)).toBe(true);
      }),
    );
  });

  test('HIER-02 a merge that left a row two deeper than the row above clamps it to one deeper; NaN and negatives read as 0', () => {
    expect(effectiveDepths([0, 2, 3])).toEqual([0, 1, 2]);
    expect(effectiveDepths([1])).toEqual([0]);
    expect(effectiveDepths([0, 1, -3, Number.NaN, 1.6])).toEqual([0, 1, 0, 0, 1]);
  });
});

describe('parentIndex (HIER-03)', () => {
  test('HIER-03 the parent is the nearest row above at a shallower depth; depth 0 has none; every row between is at least as deep as the child', () => {
    fc.assert(
      fc.property(validDepths, (depths) => {
        depths.forEach((depth, i) => {
          const parent = parentIndex(depths, i);
          if (depth === 0) {
            expect(parent).toBeNull();
            return;
          }
          expect(parent).not.toBeNull();
          const p = parent ?? -1;
          expect(p).toBeLessThan(i);
          expect(depths[p]).toBeLessThan(depth);
          for (let k = p + 1; k < i; k += 1) expect(depths[k]).toBeGreaterThanOrEqual(depth);
        });
      }),
    );
  });

  test('HIER-03 in a valid outline the parent is exactly one level shallower', () => {
    fc.assert(
      fc.property(validDepths, (depths) => {
        depths.forEach((depth, i) => {
          const parent = parentIndex(depths, i);
          if (parent !== null) expect(depths[parent]).toBe(depth - 1);
        });
      }),
    );
  });
});

describe('subtreeEnd and hasDescendants (HIER-05)', () => {
  test('HIER-05 the subtree is the maximal run of deeper rows after the row; a row has descendants iff its subtree is not empty', () => {
    fc.assert(
      fc.property(validDepths, (depths) => {
        depths.forEach((depth, i) => {
          const end = subtreeEnd(depths, i);
          expect(end).toBeGreaterThan(i);
          for (let k = i + 1; k < end; k += 1) expect(depths[k]).toBeGreaterThan(depth);
          if (end < depths.length) expect(depths[end]).toBeLessThanOrEqual(depth);
          expect(hasDescendants(depths, i)).toBe(end > i + 1);
        });
      }),
    );
  });
});

describe('canNest and canPromote (HIER-02)', () => {
  test('HIER-02 nesting is allowed exactly when the row is not already one deeper than the row above; the first row never nests; promote needs depth above 0', () => {
    fc.assert(
      fc.property(validDepths, (depths) => {
        depths.forEach((depth, i) => {
          const above = i === 0 ? null : (depths[i - 1] ?? 0);
          expect(canNest(depths, i)).toBe(above !== null && depth < above + 1);
          expect(canPromote(depths, i)).toBe(depth > 0);
        });
      }),
    );
  });

  test('HIER-02 nesting a row that may nest, with its subtree, leaves the outline valid; so does promoting one that may promote', () => {
    fc.assert(
      fc.property(validDepths, fc.nat(39), (depths, pick) => {
        if (depths.length === 0) return;
        const i = pick % depths.length;
        for (const delta of [1, -1] as const) {
          const allowed = delta === 1 ? canNest(depths, i) : canPromote(depths, i);
          if (!allowed) continue;
          const end = subtreeEnd(depths, i);
          const next = depths.map((d, k) => (k >= i && k < end ? d + delta : d));
          expect(isValidDepths(next)).toBe(true);
        }
      }),
    );
  });
});

describe('hiddenRows (HIER-06)', () => {
  test('HIER-06 a row is hidden iff some ancestor is collapsed — the whole subtree, not only the children', () => {
    fc.assert(
      fc.property(validDepths.chain(outline), ([depths, collapsed]) => {
        const rows = depths.map((depth, i) => ({ depth, collapsed: collapsed[i] ?? false }));
        const hidden = hiddenRows(rows);
        rows.forEach((_row, i) => {
          let ancestorCollapsed = false;
          let cursor: number | null = i;
          for (;;) {
            cursor = parentIndex(depths, cursor);
            if (cursor === null) break;
            if (collapsed[cursor] === true) ancestorCollapsed = true;
          }
          expect(hidden[i]).toBe(ancestorCollapsed);
        });
      }),
    );
  });

  test('HIER-06 collapsing a childless row hides nothing, and a collapsed row is itself still shown', () => {
    expect(
      hiddenRows([
        { depth: 0, collapsed: true },
        { depth: 0, collapsed: false },
      ]),
    ).toEqual([false, false]);
    expect(
      hiddenRows([
        { depth: 0, collapsed: true },
        { depth: 1, collapsed: false },
        { depth: 2, collapsed: false },
        { depth: 1, collapsed: true },
        { depth: 2, collapsed: false },
        { depth: 0, collapsed: false },
      ]),
    ).toEqual([false, true, true, true, true, false]);
  });

  test('HIER-06 stored depths that break HIER-02 are normalised before visibility is decided', () => {
    // The third row claims depth 3 under a depth-1 parent: it is a grandchild at 2, hidden with the rest.
    expect(
      hiddenRows([
        { depth: 0, collapsed: true },
        { depth: 1, collapsed: false },
        { depth: 3, collapsed: false },
      ]),
    ).toEqual([false, true, true]);
  });
});
