import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { nestRow } from '../hier/mutations.js';
import type { Id } from '../ids.js';
import { setTableLook } from '../style/table.js';
import { tableAddresses, tableUnitBounds } from './geometry.js';
import { addRow, createTable, setCellText, setFooterRows } from './mutations.js';
import {
  cellText,
  openDocument,
  rowMeta,
  rowMetaMap,
  tableById,
  tableMap,
  type GedeDoc,
  type TableKind,
} from './schema.js';
import {
  degreeLabels,
  readDefinition,
  SET_DEGREE,
  setRangeColumn,
  setTableFacts,
  specialStatus,
  splitIntoRows,
  splitOffer,
} from './set-table.js';
import { createUndoManager } from './undo.js';

let gd: GedeDoc;
const sheetId = 'sheet';

beforeEach(() => {
  gd = openDocument(new Y.Doc());
});

function setTable(kind: TableKind, elements: readonly string[]): Id {
  const id = createTable(gd, { sheetId, at: { col: 2, row: 2 }, columns: 2, rows: 0, kind });
  for (const element of elements) {
    const rowId = addRow(gd, id);
    setCellText(gd, id, rowId, range(id), element);
  }
  return id;
}

function range(tableId: Id): Id {
  const record = tableById(gd, tableId);
  const colId = record === null ? null : setRangeColumn(record);
  if (colId === null) throw new Error('no range column');
  return colId;
}

function facts(tableId: Id) {
  const table = tableMap(gd, tableId);
  if (table === null) throw new Error('no table');
  const out = setTableFacts(table);
  if (out === null) throw new Error('not a set table');
  return out;
}

function rows(tableId: Id): Id[] {
  return [...(tableById(gd, tableId)?.rows ?? [])];
}

describe('set tables (ADR-056)', () => {
  test('SET-05 cardinality counts distinct elements under FX-09 equality; the bag counts every entry', () => {
    const id = setTable('simple', ['a', ' b', 'a', 'b́', 'b́'.normalize('NFC'), 'A', '']);
    const f = facts(id);
    // a, b, b́, A — trimmed, NFC, case-sensitive; the empty row is no element.
    expect(f.cardinality).toBe(4);
    expect(f.bag).toBe(6);
  });

  test('SET-02 a repeated element is kept and flagged with the degree of its first occurrence', () => {
    const id = setTable('simple', ['a', 'b', 'c', 'b']);
    const f = facts(id);
    const [first, second, third, fourth] = rows(id).map((r) => f.rows.get(r));
    expect(first?.repeatOf).toBeNull();
    expect(second?.repeatOf).toBeNull();
    expect(third?.repeatOf).toBeNull();
    expect(fourth?.repeatOf).toBe('+2°');
    expect(f.cardinality).toBe(3);
    expect(f.bag).toBe(4);
  });

  test('SET-03 special status is null when empty, singleton at cardinality 1, none otherwise', () => {
    expect(specialStatus(0)).toBe('null');
    expect(specialStatus(1)).toBe('singleton');
    expect(specialStatus(2)).toBeNull();
    expect(facts(setTable('simple', [])).status).toBe('null');
    expect(facts(setTable('simple', ['x', 'x'])).status).toBe('singleton');
  });

  test('SET-03 a definition GeDe cannot read yields no value, never a guess', () => {
    for (const caption of ['', 'the letters of abc', '{ a, b, c }', 'letters | vowels']) {
      expect(readDefinition(caption), caption).toEqual({
        finite: null,
        variable: null,
        quantifier: null,
      });
    }
  });

  test('SET-03 set-builder notation and quantifiers are read (v1 default 1)', () => {
    expect(readDefinition('{ x | x is a letter in ‘abc’ }')).toEqual({
      finite: 'finite',
      variable: 'bound',
      quantifier: null,
    });
    expect(readDefinition('{n : n < 10}').variable).toBe('bound');
    expect(readDefinition('∀x x is a vowel')).toEqual({
      finite: 'finite',
      variable: 'bound',
      quantifier: 'universal',
    });
    expect(readDefinition('there exists y with y in E').quantifier).toBe('existential');
    expect(readDefinition('For all elements, ∃ a successor').quantifier).toBe('universal');
    expect(readDefinition('∃ a successor for all of them').quantifier).toBe('existential');
    // A quantifier with no variable after it binds nothing GeDe can name.
    expect(readDefinition('for all of them').variable).toBeNull();
  });

  test('SET-04 the definition is the caption: changing it changes the meta row', () => {
    const id = setTable('simple', ['a']);
    expect(facts(id).definition.quantifier).toBeNull();
    setTableLook(gd, id, { caption: '∀x x ∈ E' });
    expect(facts(id).definition.quantifier).toBe('universal');
  });

  test('SET-07 degrees run +n° at the top level and +n.m° by depth, with U+00B0', () => {
    expect(degreeLabels([0, 0, 1, 1, 0, 1, 2, 1])).toEqual([
      '+1°',
      '+2°',
      '+2.1°',
      '+2.2°',
      '+3°',
      '+3.1°',
      '+3.1.1°',
      '+3.2°',
    ]);
    expect(SET_DEGREE).toEqual({ meta: '−2°', title: '−1°', header: '±0°' });
    for (const label of [...Object.values(SET_DEGREE), ...degreeLabels([0, 1])]) {
      expect(label.endsWith('°')).toBe(true);
      expect(label).not.toContain('º');
    }
    // A stored depth a merge left too deep reads as HIER-02 allows.
    expect(degreeLabels([2, 0])).toEqual(['+1°', '+2°']);
  });

  test('SET-07 the meta, title and degree rail never move an A1 address', () => {
    const plain = createTable(gd, { sheetId, at: { col: 2, row: 2 }, columns: 2, rows: 3 });
    const set = createTable(gd, {
      sheetId,
      at: { col: 2, row: 2 },
      columns: 2,
      rows: 3,
      kind: 'family',
    });
    const plainMap = tableMap(gd, plain);
    const setMap = tableMap(gd, set);
    if (plainMap === null || setMap === null) throw new Error('no table');
    expect(tableAddresses(setMap)).toEqual(tableAddresses(plainMap));
    const [, second] = rows(set);
    if (second === undefined) throw new Error('no row');
    nestRow(gd, set, second);
    // Depth is presentation: the nested row keeps its address (HIER-09).
    expect(tableAddresses(setMap)).toEqual(tableAddresses(plainMap));
  });

  test('SET-05 a set table shows its footer count strip by default; a plain table does not (GRID-11)', () => {
    const plain = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 2, rows: 1 });
    const set = createTable(gd, {
      sheetId,
      at: { col: 0, row: 0 },
      columns: 2,
      rows: 1,
      kind: 'simple',
    });
    expect(tableById(gd, plain)?.footerRows).toBe(0);
    expect(tableById(gd, set)?.footerRows).toBe(1);
    const setMap = tableMap(gd, set);
    const plainMap = tableMap(gd, plain);
    if (setMap === null || plainMap === null) throw new Error('no table');
    expect(tableUnitBounds(setMap).rows).toBe(tableUnitBounds(plainMap).rows + 1);
    setFooterRows(gd, set, 0);
    expect(tableById(gd, set)?.footerRows).toBe(0);
  });

  test('SET-06 a family counts top-level members and every leaf at any depth', () => {
    // The FamilyOfSets design: d, A = {a, b}, {{a}, {c}}.
    const id = setTable('family', ['d', 'A', 'a', 'b', '{ {a}, {c} }', '{a}', 'a', '{c}', 'c']);
    const [, , a, b, , unitA, a2, unitC, c] = rows(id);
    // In document order, each row nested to its depth before the next is touched.
    for (const [row, times] of [
      [a, 1],
      [b, 1],
      [unitA, 1],
      [a2, 2],
      [unitC, 1],
      [c, 2],
    ] as const) {
      for (let n = 0; n < times; n += 1) nestRow(gd, id, row ?? '');
    }
    const f = facts(id);
    expect(rows(id).map((r) => f.rows.get(r)?.degree)).toEqual([
      '+1°',
      '+2°',
      '+2.1°',
      '+2.2°',
      '+3°',
      '+3.1°',
      '+3.1.1°',
      '+3.2°',
      '+3.2.1°',
    ]);
    expect(rows(id).map((r) => f.rows.get(r)?.kind)).toEqual([
      'element',
      'set',
      'element',
      'element',
      'family',
      'set',
      'element',
      'set',
      'element',
    ]);
    expect(f.cardinality).toBe(3);
    // d, a, b, a, c.
    expect(f.bag).toBe(5);
    // a under A and a under {a} are in different sets: neither is a repeat.
    expect(rows(id).every((r) => f.rows.get(r)?.repeatOf === null)).toBe(true);
  });

  test('SET-06 kind is read from nesting alone: Nest and Promote change it', () => {
    const id = setTable('family', ['A', 'a']);
    const [parent, child] = rows(id);
    expect(facts(id).rows.get(parent ?? '')?.kind).toBe('element');
    nestRow(gd, id, child ?? '');
    expect(facts(id).rows.get(parent ?? '')?.kind).toBe('set');
    expect(facts(id).cardinality).toBe(1);
  });

  test('SET-12 a lost computed row is no longer in the set', () => {
    const id = setTable('simple', ['a', 'b']);
    const table = tableMap(gd, id);
    const [, second] = rows(id);
    if (table === null || second === undefined) throw new Error('no row');
    rowMetaMap(table).get(second)?.set('lostFrom', 'col');
    expect(rowMeta(table, second).lostFrom).toBe('col');
    expect(facts(id).cardinality).toBe(1);
    expect(facts(id).rows.get(second)?.degree).toBe('+2°');
  });

  test('SET-02 a plain table has no set facts and no range column', () => {
    const id = createTable(gd, { sheetId, at: { col: 0, row: 0 } });
    const table = tableMap(gd, id);
    if (table === null) throw new Error('no table');
    expect(setTableFacts(table)).toBeNull();
    const record = tableById(gd, id);
    expect(record === null ? 'missing' : setRangeColumn(record)).toBeNull();
  });
});

describe('Split into rows (SET-02)', () => {
  test('SET-02 a comma value in the range column is offered for splitting; other cells are not', () => {
    const id = setTable('simple', ['a, b; c', 'single', '(1, 2)', '{a, b}']);
    const [many, single, tuple, braces] = rows(id);
    const col = range(id);
    expect(splitOffer(gd, id, many ?? '', col)).toEqual(['a', 'b', 'c']);
    expect(splitOffer(gd, id, single ?? '', col)).toBeNull();
    // A separator inside brackets or braces does not split (FX-09, FX-10).
    expect(splitOffer(gd, id, tuple ?? '', col)).toBeNull();
    expect(splitOffer(gd, id, braces ?? '', col)).toBeNull();
    const other = tableById(gd, id)?.columns[1]?.id ?? '';
    setCellText(gd, id, single ?? '', other, 'x, y');
    expect(splitOffer(gd, id, single ?? '', other)).toBeNull();
    // A formula is not text to split.
    setCellText(gd, id, single ?? '', col, '=Union("a, b", "c")');
    expect(splitOffer(gd, id, single ?? '', col)).toBeNull();
    // A plain table has no set to split into.
    const plain = createTable(gd, { sheetId, at: { col: 0, row: 0 }, rows: 1 });
    const plainRow = rows(plain)[0] ?? '';
    const plainCol = tableById(gd, plain)?.columns[0]?.id ?? '';
    setCellText(gd, plain, plainRow, plainCol, 'a, b');
    expect(splitOffer(gd, plain, plainRow, plainCol)).toBeNull();
  });

  test('SET-02 Split into rows writes one row per element after the row, repeats kept, as one undo step', () => {
    const id = setTable('simple', ['first', 'a, b, a', 'last']);
    const [, cell, last] = rows(id);
    const col = range(id);
    const undo = createUndoManager(gd);
    const added = splitIntoRows(gd, id, cell ?? '', col);
    expect(added).toHaveLength(2);
    const table = tableMap(gd, id);
    if (table === null) throw new Error('no table');
    expect(rows(id).map((r) => cellText(table, r, col))).toEqual(['first', 'a', 'b', 'a', 'last']);
    expect(rows(id).at(-1)).toBe(last);
    const f = facts(id);
    expect(f.rows.get(rows(id)[3] ?? '')?.repeatOf).toBe('+2°');
    expect(f.cardinality).toBe(4);
    expect(f.bag).toBe(5);
    undo.undo();
    expect(rows(id).map((r) => cellText(table, r, col))).toEqual(['first', 'a, b, a', 'last']);
  });

  test('SET-02 in a family the new rows are siblings of the split row, after its subtree', () => {
    const id = setTable('family', ['A', 'x, y', 'child', 'after']);
    const [, split, child] = rows(id);
    nestRow(gd, id, split ?? '');
    nestRow(gd, id, child ?? '');
    nestRow(gd, id, child ?? '');
    const col = range(id);
    expect(splitIntoRows(gd, id, split ?? '', col)).toHaveLength(1);
    const table = tableMap(gd, id);
    if (table === null) throw new Error('no table');
    expect(rows(id).map((r) => [cellText(table, r, col), rowMeta(table, r).depth])).toEqual([
      ['A', 0],
      ['x', 1],
      ['child', 2],
      ['y', 1],
      ['after', 0],
    ]);
  });

  test('SET-02 a cell not on offer is left alone', () => {
    const id = setTable('simple', ['a']);
    expect(splitIntoRows(gd, id, rows(id)[0] ?? '', range(id))).toBeNull();
    expect(rows(id)).toHaveLength(1);
  });
});
