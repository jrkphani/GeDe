import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  cellAddress,
  createSheet,
  createTable,
  createUndoManager,
  LEGACY_HEIGHTS_ORIGIN,
  mergeCells,
  needsLegacyHeightSettling,
  openDocument,
  rowMeta,
  setCellAppearance,
  setCellText,
  setColumnAppearance,
  setColumnWidth,
  setColumnWrap,
  setRowHeight,
  setRowWrap,
  setTableLook,
  tableById,
  tableMap,
  tableRecord,
  TYPE_SIZE_PX,
  type GedeDoc,
  type TableMap,
} from '@gede/core';

import {
  fitRowsToContent,
  memoised,
  rowsToMeasure,
  wrappedLines,
  type FitMeasure,
} from '../style/fit.js';
import { fitTouched, installAutoHeight, touchedRows } from './auto-height.js';

/**
 * A fake measurer, labelled as such: every character is `TYPE_SIZE_PX[size] / 2`
 * canvas px wide, whatever the font, so a line's width is a function of its
 * length alone and the tests can reason in characters. jsdom has no 2D
 * context to measure real text with.
 */
const fakeMeasure: FitMeasure = memoised({
  measure: (text, font) => text.length * (TYPE_SIZE_PX[font.size] / 2),
});

function fixture(): { gd: GedeDoc; id: string; t: TableMap; rows: string[]; cols: string[] } {
  const gd = openDocument(new Y.Doc());
  const sheet = createSheet(gd);
  const id = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 2, rows: 3 });
  const rec = tableById(gd, id);
  const t = tableMap(gd, id);
  if (rec === null || t === null) throw new Error('fixture');
  return { gd, id, t, rows: [...rec.rows], cols: rec.columns.map((c) => c.id) };
}

const fit = () => ({ locale: 'en-US' as const, measure: fakeMeasure });
const deps = { fit, editable: () => true };
/** Column ids of a table map, in order. */
const cols = (t: TableMap): string[] => tableRecord(t).columns.map((c) => c.id);

// One unit of width (160 px) less the 17 px of chrome holds 143 px: 24 characters at 5.75 px.
const LONG = 'a'.repeat(60); // three lines wrapped, one line clipped

describe('measuring what a row needs (GRID-09, INSP-04, ADR-049)', () => {
  it('GRID-09 wrappedLines moves whole words to the next line and breaks a word wider than the line', () => {
    const font = { family: 'ui' as const, weight: 400 as const, size: 'cell' as const };
    const runs = (text: string) => [{ text, marks: [] }];
    expect(wrappedLines(runs('short'), font, 143, fakeMeasure)).toBe(1);
    expect(wrappedLines(runs('twelve chars twelve chars twelve'), font, 143, fakeMeasure)).toBe(2);
    expect(wrappedLines(runs(LONG), font, 143, fakeMeasure)).toBe(3);
    expect(wrappedLines(runs(''), font, 143, fakeMeasure)).toBe(1);
  });

  it('GRID-09 fitRowsToContent: a wrapped cell needs as many rows as its lines; an unwrapped cell needs one per paragraph; an empty row needs one', () => {
    const { gd, id, t, rows, cols } = fixture();
    const [r1, r2, r3] = rows as [string, string, string];
    setCellText(gd, id, r1, cols[0] ?? '', LONG);
    setCellText(gd, id, r2, cols[0] ?? '', 'one\ntwo');
    const rec = () => tableById(gd, id)!;
    // Nothing wraps: the long text clips on one line; the two paragraphs take two rows.
    expect(fitRowsToContent(t, rec(), fit()).map((n) => n.units)).toEqual([1, 2, 1]);
    // Column wrap: three 15.5 px lines and 2 px of padding need 48.6 px → 3 rows.
    setColumnWrap(gd, id, cols[0] ?? '', true);
    expect(fitRowsToContent(t, rec(), fit()).map((n) => n.units)).toEqual([3, 2, 1]);
    // A wider column needs fewer lines.
    setColumnWidth(gd, id, cols[0] ?? '', 3);
    expect(fitRowsToContent(t, rec(), fit()).map((n) => n.units)).toEqual([1, 2, 1]);
    // A preview width measures without a write.
    expect(
      fitRowsToContent(t, rec(), { ...fit(), widths: new Map([[cols[0] ?? '', 1]]) }).map(
        (n) => n.units,
      ),
    ).toEqual([3, 2, 1]);
    // A display size needs its line box even unwrapped (ADR-034): h2 at 25 px → 2 rows.
    setCellAppearance(gd, id, r3, cols[1] ?? '', { size: 'h2' });
    expect(fitRowsToContent(t, rec(), fit()).map((n) => n.units)).toEqual([1, 2, 2]);
    // `only` restricts the answer.
    expect(fitRowsToContent(t, rec(), { ...fit(), only: [r2] })).toEqual([{ rowId: r2, units: 2 }]);
  });

  it('GRID-09 a formula cell is measured by its evaluated value; the expression line is paint and never drives the height (ADR-024, ADR-043)', () => {
    const { gd, id, t, rows, cols } = fixture();
    setCellText(gd, id, rows[0] ?? '', cols[0] ?? '', '=Concat("a", "b")');
    const rec = () => tableById(gd, id)!;
    const short = () => ({ kind: 'text' as const, text: 'ab' });
    const long = () => ({ kind: 'text' as const, text: LONG });
    setRowWrap(gd, id, rows[0] ?? '', true);
    expect(fitRowsToContent(t, rec(), { ...fit(), cellValue: short })[0]?.units).toBe(1);
    expect(fitRowsToContent(t, rec(), { ...fit(), cellValue: long })[0]?.units).toBe(3);
    // No engine value: the formula measures as empty text.
    expect(fitRowsToContent(t, rec(), fit())[0]?.units).toBe(1);
  });

  it('GRID-09 ADR-033 a merged span is measured over its whole width and the height it needs beyond its other rows lands on its last row', () => {
    const { gd, id, t, rows, cols } = fixture();
    const [r1, r2, r3] = rows as [string, string, string];
    const rec = () => tableById(gd, id)!;
    setColumnWrap(gd, id, cols[0] ?? '', true);
    setCellText(gd, id, r1, cols[0] ?? '', LONG); // 3 lines in one column
    mergeCells(gd, id, r1, cols[0] ?? '', { rows: 2, cols: 1 });
    // Two rows of one unit already hold two lines' worth; the third line's unit goes to r2.
    expect(fitRowsToContent(t, rec(), fit()).map((n) => n.units)).toEqual([1, 2, 1]);
    // Across two columns the text fits on two lines: nothing beyond the rows' own units.
    mergeCells(gd, id, r1, cols[0] ?? '', { rows: 2, cols: 2 });
    expect(fitRowsToContent(t, rec(), fit()).map((n) => n.units)).toEqual([1, 1, 1]);
    expect(rowsToMeasure(t, rec(), [r1])).toEqual([r1, r2]);
    expect(rowsToMeasure(t, rec(), [r3])).toEqual([r3]);
  });
});

describe('the editing replica stores heights (GRID-09, KEYS-03, LOAD-06, ADR-049)', () => {
  it('GRID-09 touchedRows names the rows an edit touched; a height write touches nothing', () => {
    const { gd, id, rows, cols } = fixture();
    let last: ReturnType<typeof touchedRows> = new Map();
    gd.tables.observeDeep((events) => {
      last = touchedRows(events);
    });
    setCellText(gd, id, rows[1] ?? '', cols[0] ?? '', 'x');
    expect(last).toEqual(new Map([[id, new Set([rows[1]])]]));
    setRowHeight(gd, id, rows[1] ?? '', 4);
    expect(last).toEqual(new Map());
    setRowWrap(gd, id, rows[2] ?? '', true);
    expect(last).toEqual(new Map([[id, new Set([rows[2]])]]));
    setColumnWidth(gd, id, cols[0] ?? '', 2);
    expect(last).toEqual(new Map([[id, null]]));
    setTableLook(gd, id, { wrap: true });
    expect(last).toEqual(new Map([[id, null]]));
    setTableLook(gd, id, { alternating: true });
    expect(last).toEqual(new Map());
  });

  it('GRID-09 KEYS-03 typing into a wrapped column grows its row in the same undo step, and undo restores both; widening the column shrinks it back', () => {
    const { gd, id, t, rows, cols } = fixture();
    // The document's manager as the shell creates it: the observer's height write lands
    // inside the capture window of the edit that caused it, and the shell's `settle`
    // (stopCapturing after each command) is what separates one command from the next.
    const undo = createUndoManager(gd);
    const dispose = installAutoHeight(gd, deps);
    const [r1, r2] = rows as [string, string];
    setColumnWrap(gd, id, cols[0] ?? '', true);
    undo.stopCapturing();
    expect(rowMeta(t, r1).height).toBe(1);
    setCellText(gd, id, r1, cols[0] ?? '', LONG);
    undo.stopCapturing();
    expect(rowMeta(t, r1)).toMatchObject({ height: 3, fit: true });
    expect(rowMeta(t, r2).height).toBe(1);
    // The row below moved three addresses down: addressing follows the stored height.
    expect(cellAddress(t, r2, cols[0] ?? '')).toBe('A7');
    // One step for the text and the height together.
    expect(undo.undoStack).toHaveLength(2); // the wrap, then the text + height
    undo.undo();
    expect(rowMeta(t, r1).height).toBe(1);
    expect(cellAddress(t, r2, cols[0] ?? '')).toBe('A5');
    undo.redo();
    expect(rowMeta(t, r1).height).toBe(3);
    // Widening the column: fewer lines, the row follows its content down.
    setColumnWidth(gd, id, cols[0] ?? '', 3);
    expect(rowMeta(t, r1).height).toBe(1);
    // Wrap off at the cell: one clipped line.
    setColumnWidth(gd, id, cols[0] ?? '', 1);
    expect(rowMeta(t, r1).height).toBe(3);
    setCellAppearance(gd, id, r1, cols[0] ?? '', { wrap: false });
    expect(rowMeta(t, r1).height).toBe(1);
    dispose();
  });

  it('GRID-09 GRID-08 a row set by hand keeps its height whatever is typed (R-B); Fit to content measures it and it follows its content again', () => {
    const { gd, id, t, rows, cols } = fixture();
    const dispose = installAutoHeight(gd, deps);
    const r1 = rows[0] ?? '';
    setRowHeight(gd, id, r1, 2);
    setColumnWrap(gd, id, cols[0] ?? '', true);
    expect(rowMeta(t, r1)).toMatchObject({ height: 2, fit: false });
    setCellText(gd, id, r1, cols[0] ?? '', LONG);
    expect(rowMeta(t, r1)).toMatchObject({ height: 2, fit: false });
    const fitted = fitRowsToContent(t, tableById(gd, id)!, { ...fit(), only: [r1] });
    setRowHeight(gd, id, r1, fitted[0]?.units ?? 1, 'fit');
    expect(rowMeta(t, r1)).toMatchObject({ height: 3, fit: true });
    setCellText(gd, id, r1, cols[0] ?? '', 'short');
    expect(rowMeta(t, r1)).toMatchObject({ height: 1, fit: true });
    dispose();
  });

  it('GRID-09 ADR-034 a type size that needs more than one row grows the row at column and cell scope', () => {
    const { gd, id, t, rows, cols } = fixture();
    const dispose = installAutoHeight(gd, deps);
    setColumnAppearance(gd, id, cols[0] ?? '', { size: 'h2' });
    expect(rows.map((r) => rowMeta(t, r).height)).toEqual([2, 2, 2]);
    setColumnAppearance(gd, id, cols[0] ?? '', { size: null });
    expect(rows.map((r) => rowMeta(t, r).height)).toEqual([1, 1, 1]);
    setCellText(gd, id, rows[1] ?? '', cols[1] ?? '', 'தமிழ்');
    setCellAppearance(gd, id, rows[1] ?? '', cols[1] ?? '', { size: 'display' });
    expect(rowMeta(t, rows[1] ?? '').height).toBe(4); // 68 px at the 1.7 Indic floor
    dispose();
  });

  it('LOAD-06 SHARE-03 a remote transaction, an undo, and a view-only replica write no height; a replica without a 2D context writes none either', () => {
    const a = fixture();
    const b = openDocument(new Y.Doc());
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.gd.doc), 'remote');
    a.gd.doc.on('update', (update: Uint8Array) => {
      Y.applyUpdate(b.doc, update, 'remote');
    });
    b.doc.on('update', (update: Uint8Array) => {
      Y.applyUpdate(a.gd.doc, update, 'remote');
    });
    const writes: unknown[] = [];
    b.tables.observeDeep((_events, txn) => {
      if (txn.local) writes.push(txn.origin);
    });
    const disposeB = installAutoHeight(b, deps);
    setCellText(a.gd, a.id, a.rows[0] ?? '', a.cols[0] ?? '', LONG);
    // B received A's edit but measured nothing: nothing wraps, and a remote edit is A's to
    // measure (A had no auto-fit installed, so the row is 1).
    expect(writes).toEqual([]);
    expect(rowMeta(tableMap(b, a.id)!, a.rows[0] ?? '').height).toBe(1);
    // A wraps the column: the table now has the legacy shape (a wrapping column, rows never
    // settled), so B — the first replica that can write — settles it once, under the
    // housekeeping origin; the remote edit that follows is still not measured by B.
    setColumnWrap(a.gd, a.id, a.cols[0] ?? '', true);
    expect(writes).toEqual([LEGACY_HEIGHTS_ORIGIN]);
    expect(rowMeta(tableMap(b, a.id)!, a.rows[0] ?? '')).toMatchObject({ height: 3, fit: true });
    expect(rowMeta(a.t, a.rows[0] ?? '')).toMatchObject({ height: 3, fit: true });
    setCellText(a.gd, a.id, a.rows[0] ?? '', a.cols[0] ?? '', 'short');
    expect(writes).toEqual([LEGACY_HEIGHTS_ORIGIN]);
    expect(rowMeta(tableMap(b, a.id)!, a.rows[0] ?? '').height).toBe(3);
    disposeB();
    // A view-only replica and one that cannot measure write nothing on their own edits.
    const noWrite = fitTouched(a.gd, new Map([[a.id, null]]), { fit, editable: () => false });
    expect(noWrite.size).toBe(0);
    const noContext = fitTouched(a.gd, new Map([[a.id, null]]), {
      fit: () => null,
      editable: () => true,
    });
    expect(noContext.size).toBe(0);
    // With a measurer, the same call writes what the row now needs: 'short' fits one unit.
    const wrote = fitTouched(a.gd, new Map([[a.id, null]]), deps);
    expect(wrote.get(a.id)?.get(a.rows[0] ?? '')).toBe(1);
  });
});

describe('legacy wrapped tables settle once on the first editing open (ADR-049, review of #169)', () => {
  /**
   * A document written before ADR-049: a wrapping column, rows born with
   * `height: 1` and no `fit` key, one row wrapped the old way (`height: 2`
   * alone) — every row was two units by derivation, nothing stored.
   */
  function legacy(): ReturnType<typeof fixture> {
    const f = fixture();
    const [r1, r2] = f.rows as [string, string];
    setCellText(f.gd, f.id, r1, f.cols[0] ?? '', LONG);
    setCellText(f.gd, f.id, r2, f.cols[1] ?? '', 'short');
    const columns = f.t.get('columns') as Y.Array<Y.Map<unknown>>;
    const metas = f.t.get('rowMeta') as Y.Map<Y.Map<unknown>>;
    f.gd.doc.transact(() => {
      columns.get(0).set('wrap', true);
      metas.get(r2)?.set('height', 2);
    }, 'seed');
    return f;
  }

  it('GRID-09 LOAD-06 the first editing replica measures every row and stores it, not as an undo step; readers and a second open find nothing to do', () => {
    const { gd, t, rows } = legacy();
    const [r1, r2, r3] = rows as [string, string, string];
    expect(needsLegacyHeightSettling(t)).toBe(true);
    expect(rowMeta(t, r2)).toMatchObject({ height: 2, wrap: true }); // the legacy reader
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const origins: unknown[] = [];
    gd.doc.on('afterTransaction', (txn: Y.Transaction) => {
      origins.push(txn.origin);
    });
    // A view-only replica never measures (R-B).
    const disposeViewer = installAutoHeight(gd, { fit, editable: () => false });
    expect(needsLegacyHeightSettling(t)).toBe(true);
    disposeViewer();
    // The first editing replica settles it on install: measured heights, every row marked.
    const dispose = installAutoHeight(gd, deps);
    expect(rowMeta(t, r1)).toMatchObject({ height: 3, fit: true });
    expect(rowMeta(t, r2)).toMatchObject({ height: 1, fit: true, wrap: null }); // no longer legacy-wrapped
    expect(rowMeta(t, r3)).toMatchObject({ height: 1, fit: true });
    expect(cellAddress(t, r2, cols(t)[0] ?? '')).toBe('A7'); // the row after a three-unit row
    expect(needsLegacyHeightSettling(t)).toBe(false);
    expect(undo.undoStack).toHaveLength(0);
    expect(origins).toEqual([LEGACY_HEIGHTS_ORIGIN]);
    // Idempotent: a second install writes nothing.
    dispose();
    const again = installAutoHeight(gd, deps);
    expect(origins).toEqual([LEGACY_HEIGHTS_ORIGIN]);
    again();
  });

  it('LOAD-06 a legacy table that arrives over sync is settled by the editing replica that receives it; the other replica converges on the stored heights and addresses', () => {
    const a = legacy();
    const b = openDocument(new Y.Doc());
    const disposeB = installAutoHeight(b, deps); // B is editing, and has nothing yet
    b.doc.on('update', (update: Uint8Array) => {
      Y.applyUpdate(a.gd.doc, update, 'remote');
    });
    // A's document reaches B in one remote update.
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.gd.doc), 'remote');
    const tb = tableMap(b, a.id)!;
    const [r1, r2] = a.rows as [string, string];
    expect(rowMeta(tb, r1)).toMatchObject({ height: 3, fit: true });
    expect(needsLegacyHeightSettling(tb)).toBe(false);
    // A (a reader here, or a later editing open) receives the settled heights: same addresses.
    expect(rowMeta(a.t, r1)).toMatchObject({ height: 3, fit: true });
    expect(cellAddress(a.t, r2, cols(a.t)[0] ?? '')).toBe(cellAddress(tb, r2, cols(tb)[0] ?? ''));
    expect(a.gd.tables.toJSON()).toEqual(b.tables.toJSON());
    disposeB();
  });

  it('GRID-08 a row set by hand since keeps its height through the settling; a table with no wrapping column is left alone', () => {
    const f = legacy();
    const [r1, r2] = f.rows as [string, string];
    setRowHeight(f.gd, f.id, r2, 4);
    const dispose = installAutoHeight(f.gd, deps);
    expect(rowMeta(f.t, r1)).toMatchObject({ height: 3, fit: true });
    expect(rowMeta(f.t, r2)).toMatchObject({ height: 4, fit: false });
    dispose();
    const plain = fixture();
    const before = plain.gd.doc.clientID;
    let writes = 0;
    plain.gd.doc.on('afterTransaction', () => {
      writes += 1;
    });
    installAutoHeight(plain.gd, deps)();
    expect(writes).toBe(0);
    expect(plain.gd.doc.clientID).toBe(before);
  });
});
