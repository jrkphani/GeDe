import { describe, expect, test } from 'vitest';

import { cellKey, isCellKey, isId, newId, splitCellKey } from './ids.js';

describe('ids', () => {
  test('GRID-02 ids are ULIDs, unique and position-independent', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const id = newId();
      expect(isId(id)).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(isId('not-a-ulid')).toBe(false);
    expect(isId(42)).toBe(false);
  });

  test('GRID-02 cellKey joins row and column ids and splitCellKey inverts it', () => {
    const rowId = newId();
    const colId = newId();
    const key = cellKey(rowId, colId);
    expect(key).toBe(`${rowId}:${colId}`);
    expect(isCellKey(key)).toBe(true);
    expect(splitCellKey(key)).toEqual({ rowId, colId });
  });

  test('GRID-02 malformed cell keys are rejected', () => {
    for (const bad of ['', ':', 'a:', ':b', 'a:b:c', 'abc']) {
      expect(isCellKey(bad)).toBe(false);
      expect(() => splitCellKey(bad)).toThrow(RangeError);
    }
  });

  test('ids minted in one millisecond sort in creation order', () => {
    const ids = Array.from({ length: 200 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });
});
