import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { commitCellText } from '../engine/commit.js';
import { FormulaEngine } from '../engine/engine.js';
import { observeWorkbook } from '../engine/snapshot.js';
import { workbookCellId, type CellResult } from '../engine/types.js';
import { nestRow } from '../hier/mutations.js';
import { cellKey, type Id } from '../ids.js';
import { tableAddresses } from './geometry.js';
import { applyGuardedUpdate, lockedTablesEdited } from './lock-guard.js';
import {
  addRow,
  createTable,
  ensureFirstSheet,
  setCellText,
  setTablePosition,
  setTableTitle,
} from './mutations.js';
import {
  addSection,
  anyLock,
  clampToSection,
  listSections,
  lockReasonAt,
  lockReasonOfTable,
  nextSectionRange,
  renameSection,
  sectionLockReason,
  setSectionLocked,
  setSheetLocked,
} from './sections.js';
import {
  cellReadOnlyReason,
  cellText,
  openDocument,
  tableById,
  tableMap,
  type GedeDoc,
  type TableKind,
} from './schema.js';
import { setRangeColumn } from './set-range.js';
import {
  structureLayout,
  SUMMARY_ALGEBRA_LIMIT,
  sectionSummary,
  sheetSummary,
  summarySets,
  superSetArray,
  universalSet,
} from './sheet-sets.js';

let gd: GedeDoc;
let sheetId: Id;

beforeEach(() => {
  gd = openDocument(new Y.Doc());
  sheetId = ensureFirstSheet(gd);
});

function setTable(title: string, elements: readonly string[], col = 0, kind: TableKind = 'simple') {
  const id = createTable(gd, { sheetId, at: { col, row: 2 }, columns: 2, rows: 0, kind, title });
  const colId = rangeOf(id);
  for (const element of elements) setCellText(gd, id, addRow(gd, id), colId, element);
  return id;
}

function rangeOf(tableId: Id): Id {
  const record = tableById(gd, tableId);
  const colId = record === null ? null : setRangeColumn(record);
  if (colId === null) throw new Error('no range column');
  return colId;
}

function section(name: string, firstColumn: number, lastColumn: number): Id {
  const id = addSection(gd, sheetId, { name, firstColumn, lastColumn });
  if (id === null) throw new Error('section refused');
  return id;
}

describe('sections (SET-17)', () => {
  test('SET-17 a section is a named lane on lattice columns, listed left to right', () => {
    section('Second', 8, 12);
    section('First', 0, 5);
    expect(listSections(gd, sheetId).map((s) => [s.name, s.firstColumn, s.lastColumn])).toEqual([
      ['First', 0, 5],
      ['Second', 8, 12],
    ]);
  });

  test('SET-17 two sections keep one empty lattice column between them', () => {
    section('A', 0, 5);
    expect(addSection(gd, sheetId, { name: 'touching', firstColumn: 6, lastColumn: 9 })).toBeNull();
    expect(addSection(gd, sheetId, { name: 'overlap', firstColumn: 4, lastColumn: 9 })).toBeNull();
    expect(addSection(gd, sheetId, { name: 'ok', firstColumn: 7, lastColumn: 9 })).not.toBeNull();
    expect(addSection(gd, sheetId, { name: ' ', firstColumn: 20, lastColumn: 21 })).toBeNull();
    expect(
      addSection(gd, sheetId, { name: 'backwards', firstColumn: 30, lastColumn: 29 }),
    ).toBeNull();
  });

  test('SET-17 the next section starts a gutter after the last', () => {
    expect(nextSectionRange(gd, sheetId, 4)).toEqual({ firstColumn: 0, lastColumn: 3 });
    section('A', 0, 5);
    expect(nextSectionRange(gd, sheetId, 4)).toEqual({ firstColumn: 7, lastColumn: 10 });
  });

  test('SET-17 Rename section… trims, refuses an empty name, and is one undo-able write', () => {
    const id = section('Old', 0, 5);
    expect(renameSection(gd, sheetId, id, '  New  ')).toBe(true);
    expect(listSections(gd, sheetId)[0]?.name).toBe('New');
    expect(renameSection(gd, sheetId, id, '  ')).toBe(false);
    expect(listSections(gd, sheetId)[0]?.name).toBe('New');
  });

  test('SET-17 tables snap within their section', () => {
    section('A', 2, 7);
    const id = setTable('E', ['a'], 0);
    expect(clampToSection(gd, sheetId, 6, 2)).toBe(6);
    expect(clampToSection(gd, sheetId, 7, 2)).toBe(6);
    expect(clampToSection(gd, sheetId, 3, 9)).toBe(2);
    expect(clampToSection(gd, sheetId, 20, 2)).toBe(20);
    setTablePosition(gd, id, { col: 7, row: 2 });
    expect(tableById(gd, id)?.gridCol).toBe(6);
  });

  test('SET-17 a section changes no table’s A1 addresses', () => {
    const id = setTable('E', ['a', 'b'], 3);
    const table = tableMap(gd, id) ?? new Y.Map();
    const before = tableAddresses(table);
    section('Lane', 0, 9);
    expect(tableAddresses(table)).toEqual(before);
  });

  test('SET-17 sections added on two replicas apart both survive the merge', () => {
    const other = openDocument(new Y.Doc());
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(gd.doc));
    section('mine', 0, 3);
    addSection(other, sheetId, { name: 'theirs', firstColumn: 10, lastColumn: 13 });
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(gd.doc));
    Y.applyUpdate(gd.doc, Y.encodeStateAsUpdate(other.doc));
    expect(listSections(gd, sheetId).map((s) => s.name)).toEqual(['mine', 'theirs']);
    expect(listSections(other, sheetId).map((s) => s.name)).toEqual(['mine', 'theirs']);
  });
});

describe('lock (SET-18)', () => {
  test('SET-18 a locked section stops edits of its tables and names the section', () => {
    const lane = section('Lane', 0, 5);
    const inside = setTable('E', ['a'], 1);
    const outside = setTable('C', ['b'], 10);
    expect(lockReasonOfTable(gd, inside)).toBeNull();
    setSectionLocked(gd, sheetId, lane, true);
    expect(lockReasonOfTable(gd, inside)).toBe('section');
    expect(lockReasonOfTable(gd, outside)).toBeNull();
    const table = tableMap(gd, inside) ?? new Y.Map();
    const row = tableById(gd, inside)?.rows[0] ?? '';
    expect(cellReadOnlyReason(table, row, rangeOf(inside))).toBe('sectionLocked');
    expect(
      cellReadOnlyReason(tableMap(gd, outside) ?? new Y.Map(), row, rangeOf(outside)),
    ).toBeNull();
    setSectionLocked(gd, sheetId, lane, false);
    expect(lockReasonOfTable(gd, inside)).toBeNull();
  });

  test('SET-18 a locked sheet stops every table and wins over a section', () => {
    const lane = section('Lane', 0, 5);
    const inside = setTable('E', ['a'], 1);
    const outside = setTable('C', ['b'], 10);
    setSectionLocked(gd, sheetId, lane, true);
    setSheetLocked(gd, sheetId, true);
    expect(lockReasonOfTable(gd, inside)).toBe('sheet');
    expect(lockReasonOfTable(gd, outside)).toBe('sheet');
    expect(lockReasonAt(gd, sheetId, 99)).toBe('sheet');
    const row = tableById(gd, outside)?.rows[0] ?? '';
    expect(cellReadOnlyReason(tableMap(gd, outside) ?? new Y.Map(), row, rangeOf(outside))).toBe(
      'sheetLocked',
    );
    // Unlocking the sheet leaves the section's own lock where it was.
    setSheetLocked(gd, sheetId, false);
    expect(lockReasonOfTable(gd, inside)).toBe('section');
    expect(lockReasonOfTable(gd, outside)).toBeNull();
  });

  test('SET-18 a locked section cannot be renamed, but anyone can unlock it', () => {
    const lane = section('Lane', 0, 5);
    setSectionLocked(gd, sheetId, lane, true);
    expect(sectionLockReason(gd, sheetId, lane)).toBe('section');
    expect(renameSection(gd, sheetId, lane, 'Other')).toBe(false);
    expect(setSectionLocked(gd, sheetId, lane, false)).toBe(true);
    expect(renameSection(gd, sheetId, lane, 'Other')).toBe(true);
    setSheetLocked(gd, sheetId, true);
    expect(sectionLockReason(gd, sheetId, lane)).toBe('sheet');
    expect(addSection(gd, sheetId, { name: 'late', firstColumn: 20, lastColumn: 22 })).toBeNull();
  });

  test('SET-18 a rename and a lock made apart both survive the merge', () => {
    const lane = section('Lane', 0, 5);
    const other = openDocument(new Y.Doc());
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(gd.doc));
    renameSection(gd, sheetId, lane, 'Renamed');
    setSectionLocked(other, sheetId, lane, true);
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(gd.doc));
    Y.applyUpdate(gd.doc, Y.encodeStateAsUpdate(other.doc));
    expect(listSections(gd, sheetId)[0]).toMatchObject({ name: 'Renamed', locked: true });
    expect(anyLock(gd)).toBe(true);
  });
});

describe('lock on received updates (SET-18)', () => {
  /** What a second replica sends after `edit` ran on it, starting from the room's state. */
  function update(edit: (replica: GedeDoc) => void): Uint8Array {
    const replica = openDocument(new Y.Doc());
    Y.applyUpdate(replica.doc, Y.encodeStateAsUpdate(gd.doc));
    const before = Y.encodeStateVector(replica.doc);
    edit(replica);
    return Y.encodeStateAsUpdate(replica.doc, before);
  }

  test('SET-18 a document with no lock lets every update through', () => {
    const id = setTable('E', ['a']);
    const sent = update((r) =>
      setCellText(r, id, tableById(r, id)?.rows[0] ?? '', rangeOf(id), 'z'),
    );
    expect(lockedTablesEdited(gd, sent)).toEqual([]);
  });

  test('SET-18 an edit to a table in a locked section is refused, one elsewhere is not', () => {
    const lane = section('Lane', 0, 5);
    const inside = setTable('E', ['a'], 1);
    const outside = setTable('C', ['b'], 10);
    setSectionLocked(gd, sheetId, lane, true);
    const row = (d: GedeDoc, id: Id) => tableById(d, id)?.rows[0] ?? '';
    const edited = (edit: (r: GedeDoc) => void) => lockedTablesEdited(gd, update(edit));
    expect(edited((r) => setCellText(r, inside, row(r, inside), rangeOf(inside), 'z'))).toEqual([
      inside,
    ]);
    expect(edited((r) => setTableTitle(r, inside, 'Renamed table'))).toEqual([inside]);
    expect(edited((r) => setCellText(r, outside, row(r, outside), rangeOf(outside), 'z'))).toEqual(
      [],
    );
  });

  test('SET-18 a locked sheet refuses every table, and an update that unlocks and edits is refused whole', () => {
    const id = setTable('E', ['a'], 30);
    setSheetLocked(gd, sheetId, true);
    const both = update((r) => {
      setSheetLocked(r, sheetId, false);
      setCellText(r, id, tableById(r, id)?.rows[0] ?? '', rangeOf(id), 'z');
    });
    expect(lockedTablesEdited(gd, both)).toEqual([id]);
    // Unlocking alone touches no table.
    expect(
      lockedTablesEdited(
        gd,
        update((r) => setSheetLocked(r, sheetId, false)),
      ),
    ).toEqual([]);
  });

  test('SET-18 a table added or removed inside a locked section is refused', () => {
    const lane = section('Lane', 0, 5);
    const inside = setTable('E', ['a'], 1);
    setSectionLocked(gd, sheetId, lane, true);
    const added = update((r) => {
      createTable(r, { sheetId, at: { col: 2, row: 20 }, columns: 1, rows: 1, title: 'New one' });
    });
    expect(lockedTablesEdited(gd, added)).toHaveLength(1);
    const removed = update((r) => {
      r.tables.delete(inside);
    });
    expect(lockedTablesEdited(gd, removed)).toEqual([inside]);
  });

  test('SET-18 a refused update is applied, then the locked table is put back as it was', () => {
    const lane = section('Lane', 0, 5);
    const inside = setTable('E', ['a'], 1);
    const outside = setTable('C', ['b'], 10);
    setSectionLocked(gd, sheetId, lane, true);
    const row = (d: GedeDoc, id: Id) => tableById(d, id)?.rows[0] ?? '';
    // One client, two updates: the second builds on the first, so the first must be applied.
    const client = openDocument(new Y.Doc());
    Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(gd.doc));
    const sent: Uint8Array[] = [];
    client.doc.on('update', (u: Uint8Array) => sent.push(u));
    setCellText(client, inside, row(client, inside), rangeOf(inside), 'z');
    setCellText(client, outside, row(client, outside), rangeOf(outside), 'y');
    expect(applyGuardedUpdate(gd, sent[0] ?? new Uint8Array(), 'client')).toEqual([inside]);
    expect(applyGuardedUpdate(gd, sent[1] ?? new Uint8Array(), 'client')).toEqual([]);
    const text = (id: Id) => cellText(tableMap(gd, id) ?? new Y.Map(), row(gd, id), rangeOf(id));
    expect(text(inside)).toBe('a');
    expect(text(outside)).toBe('y');
  });

  test('SET-18 the reconcilers still write a locked table: its rows and a pulled row’s cells', () => {
    const lane = section('Lane', 0, 5);
    const id = setTable('E', ['a'], 1);
    setSectionLocked(gd, sheetId, lane, true);
    // A row added by a machine (row membership is open) and its cell, on a row a source owns.
    const rowId = 'ROWPULLED';
    const sent = update((r) => {
      const table = tableMap(r, id);
      if (table === null) return;
      r.doc.transact(() => {
        const meta = new Y.Map<unknown>();
        meta.set('depth', 0);
        meta.set('pulledFrom', { tableId: 'src', rowId: 'x' });
        (table.get('rows') as Y.Array<string>).push([rowId]);
        (table.get('rowMeta') as Y.Map<unknown>).set(rowId, meta);
      });
    });
    expect(lockedTablesEdited(gd, sent)).toEqual([]);
  });
});

describe('universal set, super set and summaries (SET-13..16)', () => {
  test('SET-13 U lists every distinct element once in first-seen order, sets in sheet order', () => {
    setTable('E', ['a', 'b', 'c']);
    setTable('C', ['b', 'x', 'a'], 10);
    expect(universalSet(summarySets(gd, sheetId))).toEqual(['a', 'b', 'c', 'x']);
  });

  test('SET-13 a family contributes its elements, not the sets it holds', () => {
    const fam = setTable('S', ['{a, b}', 'a', 'b'], 0, 'family');
    const [, a, b] = tableById(gd, fam)?.rows ?? [];
    nestRow(gd, fam, a ?? '');
    nestRow(gd, fam, b ?? '');
    expect(universalSet(summarySets(gd, sheetId))).toEqual(['a', 'b']);
  });

  test('SET-13 @U is the sheet’s universal set in a formula, and follows the sets', () => {
    const engine = new FormulaEngine();
    const results = new Map<string, CellResult>();
    observeWorkbook(gd, (changes) => {
      for (const r of engine.apply(changes).results) results.set(r.cellId, r);
    });
    const e = setTable('E', ['a', 'b']);
    const c = setTable('C', ['b', 'x'], 10);
    const probe = createTable(gd, {
      sheetId,
      at: { col: 20, row: 2 },
      columns: 1,
      rows: 1,
      title: 'P',
    });
    const probeRow = tableById(gd, probe)?.rows[0] ?? '';
    const probeCol = tableById(gd, probe)?.columns[0]?.id ?? '';
    commitCellText(gd, probe, probeRow, probeCol, '=Comp(@E, @U)');
    const value = (): unknown => {
      const v = results.get(workbookCellId(probe, cellKey(probeRow, probeCol)))?.value;
      return v?.kind === 'list' ? v.items.map((i) => (i.kind === 'text' ? i.text : '?')) : v;
    };
    expect(value()).toEqual(['x']);
    setCellText(gd, c, addRow(gd, c), rangeOf(c), 'y');
    expect(value()).toEqual(['x', 'y']);
    setCellText(gd, e, addRow(gd, e), rangeOf(e), 'y');
    expect(value()).toEqual(['x']);
  });

  test('SET-13 @U on another sheet does not read this one', () => {
    const engine = new FormulaEngine();
    const results = new Map<string, CellResult>();
    observeWorkbook(gd, (changes) => {
      for (const r of engine.apply(changes).results) results.set(r.cellId, r);
    });
    setTable('E', ['a']);
    const other = 'other-sheet';
    const probe = createTable(gd, {
      sheetId: other,
      at: { col: 0, row: 0 },
      columns: 1,
      rows: 1,
      title: 'P',
    });
    const row = tableById(gd, probe)?.rows[0] ?? '';
    const col = tableById(gd, probe)?.columns[0]?.id ?? '';
    commitCellText(gd, probe, row, col, '=Union(@U)');
    const result = results.get(workbookCellId(probe, cellKey(row, col)));
    expect(result?.error).not.toBeNull();
  });

  test('SET-14 the super set array holds U and every set’s name', () => {
    setTable('E', ['a', 'b']);
    setTable('C', ['b', 'x'], 10);
    expect(superSetArray(summarySets(gd, sheetId))).toEqual({
      elements: ['a', 'b', 'x'],
      sets: ['E', 'C'],
    });
  });

  function relationSections() {
    section('Foundation', 0, 20);
    setTable('E', ['a', 'b', 'c'], 0);
    setTable('A', ['a', 'b', 'c'], 3);
    setTable('C', ['b', 'c', 'x'], 6);
    setTable('D', ['b', 'c'], 9);
    setTable('K', ['x'], 12);
    const fam = setTable('S', ['{a, b, c}', 'a', 'b', 'c'], 15, 'family');
    const [, a, b, c] = tableById(gd, fam)?.rows ?? [];
    for (const r of [a, b, c]) nestRow(gd, fam, r ?? '');
    return summarySets(gd, sheetId);
  }

  test('SET-15 a section summary counts sets and distinct elements', () => {
    const summary = sectionSummary(relationSections());
    expect(summary.setCount).toBe(6);
    expect(summary.elementCount).toBe(4);
    expect(summary.rows.map((r) => r.name)).toEqual(['E', 'A', 'C', 'D', 'K', 'S']);
  });

  test('SET-15 each row gives cardinality, bag and special status', () => {
    const rows = sectionSummary(relationSections()).rows;
    const byName = (name: string) => rows.find((r) => r.name === name);
    expect(byName('E')).toMatchObject({ cardinality: 3, bag: 3, status: null });
    expect(byName('K')).toMatchObject({ cardinality: 1, bag: 1, status: 'singleton' });
    // The family holds one member, the set {a, b, c}, made of three leaves.
    expect(byName('S')).toMatchObject({ cardinality: 1, bag: 3 });
  });

  test('SET-15 equal sets, ⊆, ⊂ and ∈ are found among the section’s sets', () => {
    const rows = sectionSummary(relationSections()).rows;
    const byName = (name: string) => rows.find((r) => r.name === name);
    expect(byName('E')?.equal).toEqual(['A']);
    expect(byName('E')?.improperSubsetOf).toEqual(['A']);
    expect(byName('E')?.properSubsetOf).toEqual([]);
    expect(byName('D')?.properSubsetOf).toEqual(['E', 'A', 'C']);
    expect(byName('D')?.equal).toEqual([]);
    expect(byName('E')?.elementOf).toEqual(['S']);
    expect(byName('A')?.elementOf).toEqual(['S']);
    expect(byName('C')?.elementOf).toEqual([]);
  });

  test('SET-15 pairs whose intersection, union or difference equals the set', () => {
    const rows = sectionSummary(relationSections()).rows;
    const byName = (name: string) => rows.find((r) => r.name === name);
    expect(byName('D')?.intersection).toEqual(['E ∩ C', 'A ∩ C']);
    expect(byName('K')?.difference).toEqual(['C − E', 'C − A', 'C − D']);
    expect(byName('C')?.union).toEqual(['D ∪ K']);
    expect(byName('E')?.union).toEqual(['A ∪ D']);
    expect(byName('K')?.intersection).toEqual([]);
  });

  test('SET-15 above 30 sets the pair columns are not computed', () => {
    section('Big', 0, 200);
    for (let i = 0; i <= SUMMARY_ALGEBRA_LIMIT; i += 1)
      setTable(`T${String(i)}`, [String(i)], i * 3);
    const summary = sectionSummary(summarySets(gd, sheetId));
    expect(summary.setCount).toBe(SUMMARY_ALGEBRA_LIMIT + 1);
    expect(summary.algebra).toBe(false);
    expect(summary.rows[0]).toMatchObject({ intersection: null, union: null, difference: null });
    expect(summary.rows[0]?.equal).toEqual([]);
  });

  test('SET-16 the sheet summary lists each section with its set and element counts', () => {
    const first = section('First', 0, 8);
    const second = section('Second', 10, 20);
    setTable('E', ['a', 'b'], 0);
    setTable('C', ['b', 'c'], 4);
    setTable('B', ['x'], 11);
    const sets = summarySets(gd, sheetId);
    expect(sheetSummary(listSections(gd, sheetId), sets)).toEqual([
      { sectionId: first, name: 'First', setCount: 2, elementCount: 3 },
      { sectionId: second, name: 'Second', setCount: 1, elementCount: 1 },
    ]);
  });

  test('SET-15 SET-16 the band sits under the tables: each section’s summary under its lane, the sheet’s blocks under them', () => {
    expect(structureLayout(5, [], [])).toBeNull();
    const first = section('First', 0, 8);
    const second = section('Second', 10, 14);
    setTable('E', ['a', 'b'], 0);
    setTable('C', ['b', 'c'], 4);
    setTable('B', ['x'], 11);
    const layout = structureLayout(5, listSections(gd, sheetId), summarySets(gd, sheetId));
    expect(layout?.sections).toEqual([
      { sectionId: first, block: { col: 0, row: 5, cols: 9, rows: 3 + 2 + 1 } },
      { sectionId: second, block: { col: 10, row: 5, cols: 5, rows: 3 + 1 + 1 } },
    ]);
    // Sheet summary: title, counts, header and a row per section; then U and the super set array.
    expect(layout?.sheetSummary).toEqual({ col: 0, row: 12, cols: 15, rows: 3 + 2 });
    expect(layout?.universe).toEqual({ col: 0, row: 18, cols: 15, rows: 2 + 1 + 1 });
    expect(layout?.superSet).toEqual({ col: 0, row: 23, cols: 15, rows: 2 + 1 });
    expect(layout?.end).toBe(26);
  });
});
