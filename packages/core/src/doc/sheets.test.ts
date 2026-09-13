/**
 * Sheet mutations beyond the strip's + (ADR-048): rename, delete with its
 * cascade, insert after. Undo, convergence and the last-sheet refusal.
 */
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { cellKey } from '../ids.js';
import { commitCellText } from '../engine/commit.js';
import { FormulaEngine } from '../engine/engine.js';
import { cellErrorLabel } from '../engine/errors.js';
import { observeWorkbook } from '../engine/snapshot.js';
import { workbookCellId, type CellResult, type WorkbookChange } from '../engine/types.js';
import { createChildSheet, createGraphPair, removeGraphPair } from '../graph/mutations.js';
import { setPull } from '../ref/pull.js';
import {
  createSheet,
  createTable,
  createUndoManager,
  deleteSheet,
  graphById,
  graphsOnSheet,
  isLastSheet,
  listSheets,
  objectCount,
  openDocument,
  renameSheet,
  setCellText,
  sheetById,
  tableById,
  tablesOnSheet,
  type GedeDoc,
} from './index.js';

function fresh(): GedeDoc {
  return openDocument(new Y.Doc());
}

/** Two replicas that exchange every update, as the sync service would relay them. */
function pair(): { a: GedeDoc; b: GedeDoc } {
  const a = fresh();
  const b = fresh();
  a.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(b.doc, update, 'relay');
  });
  b.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(a.doc, update, 'relay');
  });
  return { a, b };
}

/**
 * Three sheets. Sheet 2 holds two tables and a graph pair bound to the first;
 * Sheet 3 holds a table with a formula reading a Sheet 2 cell, a formula that
 * stays local, and a pulled column mirroring a Sheet 2 table.
 */
function workbook(gd: GedeDoc = fresh()) {
  const s1 = createSheet(gd);
  const s2 = createSheet(gd);
  const s3 = createSheet(gd);
  const t2a = createTable(gd, {
    sheetId: s2,
    at: { col: 1, row: 1 },
    columns: 2,
    rows: 3,
    title: 'A',
  });
  const t2b = createTable(gd, {
    sheetId: s2,
    at: { col: 8, row: 1 },
    columns: 2,
    rows: 2,
    title: 'B',
  });
  const a = tableById(gd, t2a)!;
  setCellText(gd, t2a, a.rows[0]!, a.columns[0]!.id, 'One');
  setCellText(gd, t2a, a.rows[0]!, a.columns[1]!.id, '10');
  setCellText(gd, t2a, a.rows[1]!, a.columns[0]!.id, 'Two');
  setCellText(gd, t2a, a.rows[1]!, a.columns[1]!.id, '20');
  const graph = createGraphPair(gd, { sheetId: s2, tableId: t2a });
  const t3 = createTable(gd, {
    sheetId: s3,
    at: { col: 1, row: 1 },
    columns: 3,
    rows: 3,
    title: 'C',
  });
  const c = tableById(gd, t3)!;
  setCellText(gd, t3, c.rows[0]!, c.columns[0]!.id, '7');
  // Two cells on Sheet 3 read Sheet 2's table A; one reads its own table.
  expect(commitCellText(gd, t3, c.rows[1]!, c.columns[0]!.id, '=@A.One')).toBe(true);
  expect(commitCellText(gd, t3, c.rows[2]!, c.columns[0]!.id, '=@A.Two')).toBe(true);
  expect(commitCellText(gd, t3, c.rows[1]!, c.columns[1]!.id, '=Sum(A4)')).toBe(true);
  // A pulled column mirrors table A's rows: they are reconciled away, never counted.
  expect(
    setPull(gd, t3, c.columns[2]!.id, { tableId: t2a, colId: a.columns[0]!.id, filter: '' }),
  ).toBe(true);
  return { gd, s1, s2, s3, t2a, t2b, t3, graph };
}

describe('sheet rename (ADR-048)', () => {
  test('DOC-03 renameSheet trims, refuses an empty name, and writes nothing for an unchanged one', () => {
    const gd = fresh();
    const id = createSheet(gd);
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    expect(renameSheet(gd, id, '  Trek plan  ')).toBe(true);
    expect(sheetById(gd, id)?.label).toBe('Trek plan');
    expect(undo.undoStack).toHaveLength(1);
    expect(renameSheet(gd, id, '   ')).toBe(false);
    expect(renameSheet(gd, id, 'Trek plan')).toBe(false);
    expect(sheetById(gd, id)?.label).toBe('Trek plan');
    expect(undo.undoStack).toHaveLength(1);
    expect(renameSheet(gd, 'not-a-sheet', 'x')).toBe(false);
    undo.undo();
    expect(sheetById(gd, id)?.label).toBe('Sheet 1');
  });

  test('DOC-03 a rename reaches the other replica', () => {
    const { a, b } = pair();
    const id = createSheet(a);
    renameSheet(a, id, 'Budget');
    expect(sheetById(b, id)?.label).toBe('Budget');
  });
});

describe('sheet names (ADR-048)', () => {
  test('DOC-03 a new sheet never repeats a "Sheet N" the strip still shows', () => {
    const gd = fresh();
    const s1 = createSheet(gd);
    const s2 = createSheet(gd);
    createSheet(gd);
    deleteSheet(gd, s2);
    // Two sheets remain, one of them named "Sheet 3": the count alone would repeat it.
    expect(listSheets(gd).map((s) => s.label)).toEqual(['Sheet 1', 'Sheet 3']);
    const s4 = createSheet(gd);
    expect(sheetById(gd, s4)?.label).toBe('Sheet 4');
    expect(listSheets(gd).map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(s1).toBe(listSheets(gd)[0]?.id);
  });

  test('GRAPH-10 renaming a child sheet changes its label only; parentContext is untouched', () => {
    const gd = fresh();
    createSheet(gd);
    const { sheetId } = createChildSheet(gd, { symbol: 'α', tupleKey: 'Nepal · Spring' });
    expect(sheetById(gd, sheetId)).toMatchObject({
      label: 'α',
      parentContext: 'α — Nepal · Spring',
    });
    expect(renameSheet(gd, sheetId, 'Alpha children')).toBe(true);
    expect(sheetById(gd, sheetId)).toMatchObject({
      label: 'Alpha children',
      parentContext: 'α — Nepal · Spring',
    });
  });
});

describe('delete sheet (ADR-048)', () => {
  test('DOC-03 GRAPH-02 deleteSheet removes the sheet with its tables, its graph halves and the halves elsewhere bound to its tables, in one transaction, and names the neighbour', () => {
    const { gd, s1, s2, s3, t2a, t2b, t3, graph } = workbook();
    // A pair on Sheet 3 bound to a Sheet 2 table goes too (#163's cascade); one bound to
    // Sheet 3's own table stays.
    const remote = createGraphPair(gd, { sheetId: s3, tableId: t2a });
    const local = createGraphPair(gd, { sheetId: s3, tableId: t3 });
    let transactions = 0;
    gd.doc.on('afterTransaction', () => {
      transactions += 1;
    });
    const result = deleteSheet(gd, s2);
    expect(transactions).toBe(1);
    expect(result).toEqual({
      label: 'Sheet 2',
      tables: 2,
      graphs: 2,
      referencesRemoved: 2,
      neighbourId: s3,
    });
    expect(graphById(gd, remote.ringId)).toBeNull();
    expect(graphById(gd, remote.coverageId)).toBeNull();
    expect(graphById(gd, local.ringId)?.tableId).toBe(t3);
    expect(objectCount(gd, s3)).toBe(3);
    expect(listSheets(gd).map((s) => s.id)).toEqual([s1, s3]);
    expect(listSheets(gd).map((s) => s.ordinal)).toEqual([1, 2]);
    expect(tableById(gd, t2a)).toBeNull();
    expect(tableById(gd, t2b)).toBeNull();
    expect(graphById(gd, graph.ringId)).toBeNull();
    expect(graphById(gd, graph.coverageId)).toBeNull();
    expect(gd.tables.size).toBe(1);
    expect(gd.graphs.size).toBe(2);
    expect(tableById(gd, t3)).not.toBeNull();
  });

  test('DOC-03 the last sheet cannot be deleted and an unknown id is refused: RangeError, nothing written, no undo step', () => {
    const gd = fresh();
    const only = createSheet(gd);
    createTable(gd, { sheetId: only, at: { col: 0, row: 0 } });
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    expect(isLastSheet(gd)).toBe(true);
    expect(() => deleteSheet(gd, only)).toThrow(RangeError);
    expect(listSheets(gd)).toHaveLength(1);
    expect(gd.tables.size).toBe(1);
    expect(undo.canUndo()).toBe(false);
    const second = createSheet(gd);
    expect(isLastSheet(gd)).toBe(false);
    expect(() => deleteSheet(gd, 'never-a-sheet')).toThrow(RangeError);
    expect(listSheets(gd)).toHaveLength(2);
    expect(deleteSheet(gd, second)).toMatchObject({ neighbourId: only, tables: 0, graphs: 0 });
    expect(isLastSheet(gd)).toBe(true);
  });

  test('DOC-03 the neighbour is the next sheet, else the previous', () => {
    const gd = fresh();
    const s1 = createSheet(gd);
    const s2 = createSheet(gd);
    const s3 = createSheet(gd);
    expect(deleteSheet(gd, s3).neighbourId).toBe(s2);
    expect(deleteSheet(gd, s1).neighbourId).toBe(s2);
  });

  test('DOC-03 KEYS-03 one undo step restores the sheet at its position with every table, cell, row meta and graph half', () => {
    const { gd, s1, s2, s3, t2a, t2b, graph } = workbook();
    const before = {
      tables: gd.tables.toJSON() as unknown,
      graphs: gd.graphs.toJSON() as unknown,
      sheets: gd.sheets.toJSON() as unknown,
    };
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    deleteSheet(gd, s2);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(listSheets(gd).map((s) => s.id)).toEqual([s1, s2, s3]);
    expect(gd.sheets.toJSON()).toEqual(before.sheets);
    expect(gd.tables.toJSON()).toEqual(before.tables);
    expect(gd.graphs.toJSON()).toEqual(before.graphs);
    expect(
      tablesOnSheet(gd, s2)
        .map((t) => t.id)
        .sort(),
    ).toEqual([t2a, t2b].sort());
    expect(
      graphsOnSheet(gd, s2)
        .map((g) => g.id)
        .sort(),
    ).toEqual([graph.ringId, graph.coverageId].sort());
    expect(objectCount(gd, s2)).toBe(4);
    // The restored graph is still bound to the restored table.
    expect(graphById(gd, graph.ringId)?.tableId).toBe(t2a);
    undo.redo();
    expect(sheetById(gd, s2)).toBeNull();
    expect(gd.tables.size).toBe(1);
  });

  test('DOC-03 referencesRemoved counts formula cells on other sheets that bound into the deleted tables, once per cell', () => {
    const { gd, s2, s3, t2a } = workbook();
    // A graph pair removed earlier changes nothing about references.
    const extra = createGraphPair(gd, { sheetId: s2, tableId: t2a });
    removeGraphPair(gd, extra.pairId);
    // Deleting Sheet 3 removes the readers, not the read: nothing elsewhere breaks.
    expect(deleteSheet(gd, s3).referencesRemoved).toBe(0);
  });

  test('REF-01 FX-06 a cross-sheet formula reads ⚠ reference removed once its sheet is deleted, and one undo brings its value back', () => {
    const gd = fresh();
    const engine = new FormulaEngine();
    const results = new Map<string, CellResult>();
    observeWorkbook(gd, (changes: WorkbookChange[]) => {
      const out = engine.apply(changes);
      for (const id of out.removed) results.delete(id);
      for (const r of out.results) results.set(r.cellId, r);
    });
    const { s2, t3 } = workbook(gd);
    const c = tableById(gd, t3)!;
    const readerId = workbookCellId(t3, cellKey(c.rows[1]!, c.columns[0]!.id));
    expect(results.get(readerId)?.value).toMatchObject({ kind: 'text' });
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    deleteSheet(gd, s2);
    const broken = results.get(readerId);
    expect(broken?.error?.kind).toBe('reference-removed');
    expect(cellErrorLabel(broken!.error!)).toBe('⚠ reference removed');
    undo.undo();
    expect(results.get(readerId)?.error ?? null).toBeNull();
    expect(results.get(readerId)?.value).toMatchObject({ kind: 'text' });
  });

  test('SHARE-04 two replicas converge when one deletes the sheet the other is viewing, and the viewer still has a sheet to show', () => {
    const { a, b } = pair();
    const { s1, s2, s3, t3 } = workbook(a);
    expect(listSheets(b)).toHaveLength(3);
    const result = deleteSheet(a, s2);
    expect(result.neighbourId).toBe(s3);
    expect(listSheets(b).map((s) => s.id)).toEqual([s1, s3]);
    expect(sheetById(b, s2)).toBeNull();
    expect(tablesOnSheet(b, s2)).toEqual([]);
    expect(graphsOnSheet(b, s2)).toEqual([]);
    expect(tableById(b, t3)).not.toBeNull();
    expect(a.tables.toJSON()).toEqual(b.tables.toJSON());
    expect(a.graphs.toJSON()).toEqual(b.graphs.toJSON());
    expect(a.sheets.toJSON()).toEqual(b.sheets.toJSON());
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
  });

  test('SHARE-04 a delete on one replica and an edit to a cell on that sheet on the other converge without a dangling table', () => {
    const { a, b } = pair();
    const { s2, t2a } = workbook(a);
    const record = tableById(b, t2a)!;
    // b edits a Sheet 2 cell in the same tick a deletes the sheet: the delete wins (Yjs map semantics).
    setCellText(b, t2a, record.rows[2]!, record.columns[0]!.id, 'late');
    deleteSheet(a, s2);
    expect(tableById(a, t2a)).toBeNull();
    expect(tableById(b, t2a)).toBeNull();
    expect(a.tables.toJSON()).toEqual(b.tables.toJSON());
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
  });

  test('SHARE-04 KEYS-03 the viewer’s own undo never reverses a collaborator’s sheet deletion', () => {
    const { a, b } = pair();
    const { s2 } = workbook(a);
    const undo = createUndoManager(b, { captureTimeout: 0 });
    deleteSheet(a, s2);
    expect(sheetById(b, s2)).toBeNull();
    expect(undo.canUndo()).toBe(false);
    undo.undo();
    expect(sheetById(b, s2)).toBeNull();
  });
});
