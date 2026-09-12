import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { cellAddress } from '../doc/geometry.js';
import { createSheet, createTable, setCellText } from '../doc/mutations.js';
import { cellText, openDocument, tableById, tableMap, type GedeDoc } from '../doc/schema.js';
import { commitCellText } from '../engine/commit.js';
import { setReferenceCell } from './reference.js';
import {
  boundTableIds,
  crossTableReferenceCount,
  crossTableReferenceKeys,
  isCrossTableFormula,
  newCrossTableReference,
} from './cross-table.js';

function twoTables(): {
  gd: GedeDoc;
  a: { id: string; rows: readonly string[]; cols: readonly string[] };
  b: { id: string; rows: readonly string[]; cols: readonly string[] };
} {
  const gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  const aId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 3, title: 'A' });
  const bId = createTable(gd, { sheetId, at: { col: 6, row: 1 }, columns: 2, rows: 3, title: 'B' });
  const a = tableById(gd, aId)!;
  const b = tableById(gd, bId)!;
  setCellText(gd, aId, a.rows[0]!, a.columns[0]!.id, 'One');
  setCellText(gd, aId, a.rows[0]!, a.columns[1]!.id, '10');
  setCellText(gd, aId, a.rows[1]!, a.columns[1]!.id, '20');
  setCellText(gd, bId, b.rows[0]!, b.columns[0]!.id, 'Other');
  setCellText(gd, bId, b.rows[0]!, b.columns[1]!.id, '5');
  return {
    gd,
    a: { id: aId, rows: a.rows, cols: a.columns.map((c) => c.id) },
    b: { id: bId, rows: b.rows, cols: b.columns.map((c) => c.id) },
  };
}

describe('cross-table reference detection (tour step 2)', () => {
  test('ONB-05 an empty document and plain text count zero', () => {
    const { gd, a } = twoTables();
    expect(crossTableReferenceCount(gd)).toBe(0);
    setCellText(gd, a.id, a.rows[2]!, a.cols[0]!, 'just text');
    expect(crossTableReferenceCount(gd)).toBe(0);
  });

  test('ONB-05 a formula whose references stay in its own table does not count', () => {
    const { gd, a } = twoTables();
    const map = tableMap(gd, a.id)!;
    const from = cellAddress(map, a.rows[0]!, a.cols[1]!)!;
    const to = cellAddress(map, a.rows[1]!, a.cols[1]!)!;
    commitCellText(gd, a.id, a.rows[2]!, a.cols[1]!, `=Sum(${from}:${to})`);
    expect(crossTableReferenceCount(gd)).toBe(0);
  });

  test('ONB-05 ONB-06 a typed =@ path into another table counts once it is committed', () => {
    const { gd, a } = twoTables();
    expect(commitCellText(gd, a.id, a.rows[2]!, a.cols[0]!, '=@B.Other')).toBe(true);
    expect(crossTableReferenceCount(gd)).toBe(1);
    // A second cell referencing the same table counts too; the count is per cell.
    commitCellText(gd, a.id, a.rows[1]!, a.cols[0]!, '=Sum(@B.Other, B5)');
    expect(crossTableReferenceCount(gd)).toBe(2);
  });

  test('ONB-05 the keys are a set: overwriting one reference with another, or moving it, is a new key; the count stays level', () => {
    const { gd, a, b } = twoTables();
    commitCellText(gd, a.id, a.rows[2]!, a.cols[0]!, '=@B.Other');
    const baseline = crossTableReferenceKeys(gd);
    expect(baseline).toEqual(new Set([`${a.id}/${a.rows[2]!}:${a.cols[0]!}`]));
    // Overwrite in place: same key, no new reference.
    commitCellText(gd, a.id, a.rows[2]!, a.cols[0]!, '=Sum(@B.Other, @B.Other)');
    expect(newCrossTableReference(baseline, crossTableReferenceKeys(gd))).toBeNull();
    // Clear it and write one elsewhere: the count is unchanged, the set is not.
    setCellText(gd, a.id, a.rows[2]!, a.cols[0]!, '');
    commitCellText(gd, b.id, b.rows[1]!, b.cols[1]!, '=@A.One');
    expect(crossTableReferenceCount(gd)).toBe(baseline.size);
    expect(newCrossTableReference(baseline, crossTableReferenceKeys(gd))).toBe(
      `${b.id}/${b.rows[1]!}:${b.cols[1]!}`,
    );
  });

  test('ONB-05 REF-01 a reference cell set without a formula counts', () => {
    const { gd, a, b } = twoTables();
    setReferenceCell(gd, b.id, b.rows[1]!, b.cols[0]!, {
      tableId: a.id,
      rowId: a.rows[0]!,
      colId: a.cols[0]!,
    });
    expect(crossTableReferenceCount(gd)).toBe(1);
  });

  test('ONB-05 boundTableIds reads every bound token; an unbound spelling has none', () => {
    const { gd, a, b } = twoTables();
    const map = tableMap(gd, a.id)!;
    const from = cellAddress(map, a.rows[0]!, a.cols[1]!)!;
    commitCellText(gd, a.id, a.rows[2]!, a.cols[1]!, `=Sum(${from}, @B.Other)`);
    const stored = cellText(map, a.rows[2]!, a.cols[1]!);
    expect([...boundTableIds(stored)].sort()).toEqual([a.id, b.id].sort());
    expect(isCrossTableFormula(stored, a.id)).toBe(true);
    expect(isCrossTableFormula(stored, b.id)).toBe(true);
    // An address that named empty canvas stays as typed: nothing to bind, nothing to count.
    expect(boundTableIds('=Sum(Z99:Z100)').size).toBe(0);
    expect(isCrossTableFormula('=1', a.id)).toBe(false);
  });
});
