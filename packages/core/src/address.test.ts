import { describe, expect, test } from 'vitest';

import {
  addressGrid,
  cellRefInTable,
  cellsInRange,
  columnIndex,
  columnLetter,
  formatAddress,
  formatColumn,
  formatRange,
  offsetsFromSizes,
  parseAddress,
  parseColumn,
  parseRange,
  rangeContains,
  rangeSize,
  type TableGeometry,
} from './address.js';

describe('column letters', () => {
  test('GRID-02 columnLetter counts A, Z, AA, AZ, BA, ZZ, AAA', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(51)).toBe('AZ');
    expect(columnLetter(52)).toBe('BA');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
    expect(columnLetter(18277)).toBe('ZZZ');
  });

  test('GRID-02 columnIndex is case-insensitive and rejects non-letters', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('aa')).toBe(26);
    expect(() => columnIndex('A1')).toThrow(RangeError);
    expect(() => columnIndex('')).toThrow(RangeError);
    expect(() => columnLetter(-1)).toThrow(RangeError);
    expect(() => columnLetter(1.5)).toThrow(RangeError);
  });

  test('GRID-02 columnIndex(columnLetter(n)) === n for every n in 0..20000', () => {
    for (let n = 0; n <= 20000; n += 1) {
      const letters = columnLetter(n);
      expect(letters).toMatch(/^[A-Z]{1,4}$/);
      expect(columnIndex(letters)).toBe(n);
    }
  });

  test('GRID-02 letters are strictly increasing in length then lexicographically', () => {
    let previous = columnLetter(0);
    for (let n = 1; n <= 5000; n += 1) {
      const current = columnLetter(n);
      const ahead =
        current.length > previous.length ||
        (current.length === previous.length && current > previous);
      expect(ahead).toBe(true);
      previous = current;
    }
  });
});

describe('addresses', () => {
  test('GRID-02 formatAddress and parseAddress round-trip', () => {
    expect(formatAddress({ col: 1, row: 13 })).toBe('B14');
    expect(parseAddress('B14')).toEqual({ ok: true, value: { col: 1, row: 13 } });
    expect(parseAddress(' b14 ')).toEqual({ ok: true, value: { col: 1, row: 13 } });
    for (let col = 0; col < 60; col += 7) {
      for (let row = 0; row < 500; row += 37) {
        const text = formatAddress({ col, row });
        expect(parseAddress(text)).toEqual({ ok: true, value: { col, row } });
      }
    }
  });

  test('GRID-02 parseAddress reports malformed input without throwing', () => {
    for (const bad of ['', 'B', '14', 'B0', 'B-1', 'ABCD1', 'B1:B2', '@B1']) {
      const result = parseAddress(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.input).toBe(bad);
    }
  });

  test('GRID-02 ranges normalise, enumerate row-major and format', () => {
    const range = parseRange('C3:B2');
    expect(range).toEqual({
      ok: true,
      value: { start: { col: 1, row: 1 }, end: { col: 2, row: 2 } },
    });
    if (!range.ok) return;
    expect(formatRange(range.value)).toBe('B2:C3');
    expect(rangeSize(range.value)).toBe(4);
    expect(cellsInRange(range.value).map(formatAddress)).toEqual(['B2', 'C2', 'B3', 'C3']);
    expect(rangeContains(range.value, { col: 2, row: 1 })).toBe(true);
    expect(rangeContains(range.value, { col: 3, row: 1 })).toBe(false);
    expect(parseRange('B2').ok).toBe(false);
    expect(parseRange('B2:X').ok).toBe(false);
  });

  test('FX-02 whole-column references parse and format', () => {
    expect(parseColumn('B:B')).toEqual({ ok: true, value: { col: 1 } });
    expect(parseColumn('B:C').ok).toBe(false);
    expect(parseColumn('B1:B2').ok).toBe(false);
    expect(formatColumn({ col: 27 })).toBe('AB:AB');
  });
});

describe('addresses derived from lattice geometry', () => {
  const table: TableGeometry = {
    origin: { col: 1, row: 1 }, // top-left cell is B2
    columnWidths: [1, 2, 1],
    rowHeights: [1, 1, 1],
  };

  test('GRID-02 a cell address is computed from the table origin and preceding sizes', () => {
    expect(offsetsFromSizes([1, 2, 1])).toEqual([0, 1, 3]);
    expect(formatAddress(cellRefInTable(table, 0, 0))).toBe('B2');
    expect(formatAddress(cellRefInTable(table, 1, 0))).toBe('C2');
    // The second column is two units wide, so the third column starts two letters on.
    expect(formatAddress(cellRefInTable(table, 2, 0))).toBe('E2');
    expect(formatAddress(cellRefInTable(table, 0, 2))).toBe('B4');
    expect(() => cellRefInTable(table, 3, 0)).toThrow(RangeError);
  });

  test('GRID-02 inserting a row above shifts every later address down; deleting shifts up', () => {
    const before = addressGrid(table).map((row) => row[0]);
    expect(before).toEqual(['B2', 'B3', 'B4']);

    const inserted: TableGeometry = { ...table, rowHeights: [1, 1, 1, 1] };
    // Rows are identified by ordinal, not address: the row that was B3 is now B4.
    const after = addressGrid(inserted).map((row) => row[0]);
    expect(after).toEqual(['B2', 'B3', 'B4', 'B5']);

    const deleted: TableGeometry = { ...table, rowHeights: [1, 1] };
    expect(addressGrid(deleted).map((row) => row[0])).toEqual(['B2', 'B3']);
  });

  test('GRID-02 a hidden row has height 0 and does not advance the addresses after it', () => {
    const hidden: TableGeometry = { ...table, rowHeights: [1, 0, 1] };
    expect(addressGrid(hidden).map((row) => row[0])).toEqual(['B2', 'B3', 'B3']);
  });

  test('GRID-09 a wrapped row occupies two lattice rows so the next row is two addresses down', () => {
    const wrapped: TableGeometry = { ...table, rowHeights: [1, 2, 1] };
    expect(addressGrid(wrapped).map((row) => row[0])).toEqual(['B2', 'B3', 'B5']);
    expect(formatAddress(cellRefInTable(wrapped, 2, 2))).toBe('E5');
  });

  test('GRID-01 moving the table origin re-addresses every cell but keeps relative layout', () => {
    const moved: TableGeometry = { ...table, origin: { col: 5, row: 9 } };
    expect(addressGrid(moved)[0]).toEqual(['F10', 'G10', 'I10']);
  });
});
