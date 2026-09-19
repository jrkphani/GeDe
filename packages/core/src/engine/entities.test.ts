/**
 * The entity index and its search (REF-01, FX-04, HIER-04; ADR-052): every
 * cell is an entity listed by its value, a row is labelled by its outline
 * column with a fallback to the first column that has text, a blank column
 * label is spelled by its grid letter, and a query matches values as well as
 * paths.
 */
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  cellsMap,
  columnsArray,
  createSheet,
  createTable,
  fragmentText,
  hideColumn,
  isFormula,
  openDocument,
  setCellText,
  setTableTitle,
  tableById,
  tableMap,
  type GedeDoc,
} from '../doc/index.js';
import { cellKey, type CellKey, type Id } from '../ids.js';
import { nestRow } from '../hier/mutations.js';
import { workbookIndexOf } from './commit.js';
import {
  buildEntityIndex,
  cellMayRelabel,
  columnSegment,
  rowLabelOf,
  searchEntities,
} from './entities.js';
import { tableStructure } from './snapshot.js';
import { workbookCellId, type TableStructure } from './types.js';

interface Fixture {
  gd: GedeDoc;
  tableId: Id;
  rows: readonly Id[];
  cols: readonly Id[];
  readonly structure: () => TableStructure;
  readonly textOf: (tableId: Id, key: CellKey) => string;
}

/** A titled table with `labels` as column headers and `grid` as its cells, row-major. */
function fixture(title: string, labels: readonly string[], grid: readonly string[][]): Fixture {
  const gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, {
    sheetId,
    at: { col: 1, row: 1 },
    columns: labels.length,
    rows: grid.length,
    title,
  });
  const record = tableById(gd, tableId);
  if (record === null) throw new Error('no table');
  const cols = record.columns.map((c) => c.id);
  const table = tableMap(gd, tableId);
  if (table === null) throw new Error('no table');
  gd.doc.transact(() => {
    columnsArray(table)
      .toArray()
      .forEach((column, i) => {
        column.set('label', labels[i] ?? '');
      });
  }, gd.origin);
  grid.forEach((row, r) => {
    row.forEach((text, c) => {
      if (text !== '') setCellText(gd, tableId, record.rows[r] ?? '', cols[c] ?? '', text);
    });
  });
  return {
    gd,
    tableId,
    rows: record.rows,
    cols,
    structure: () => tableStructure(table),
    // The document's reader, as `workbookIndexOf` wires it: text, never a formula.
    textOf: (id, key) => {
      const content = id === tableId ? cellsMap(table).get(key) : undefined;
      return content === undefined || isFormula(content) ? '' : fragmentText(content);
    },
  };
}

/** The document's own reader, as `workbookIndexOf` wires it. */
function indexOf(f: Fixture) {
  return workbookIndexOf(f.gd).entityIndex();
}

describe('buildEntityIndex (ADR-052)', () => {
  test('REF-01 FX-04 every cell of a labelled row is an entry carrying its value; the row entry carries the label; entries come row before columns, in workbook order', () => {
    const f = fixture(
      'Deliverables',
      ['Deliverable', 'Owner', 'Status'],
      [
        ['Onboarding flow', 'Priya', 'In progress'],
        ['Billing export', 'Marcus', ''],
      ],
    );
    const entries = indexOf(f).entries;
    expect(entries.map((e) => [e.text, e.value, e.column])).toEqual([
      ['@Deliverables."Onboarding flow"', 'Onboarding flow', null],
      ['@Deliverables."Onboarding flow".Owner', 'Priya', 'Owner'],
      ['@Deliverables."Onboarding flow".Status', 'In progress', 'Status'],
      ['@Deliverables."Billing export"', 'Billing export', null],
      ['@Deliverables."Billing export".Owner', 'Marcus', 'Owner'],
      // An empty cell is still addressable by its path (the reference fills in later); no value.
      ['@Deliverables."Billing export".Status', '', 'Status'],
    ]);
    expect(entries[1]?.cellId).toBe(
      workbookCellId(f.tableId, cellKey(f.rows[0] ?? '', f.cols[1] ?? '')),
    );
  });

  test('REF-01 FX-04 a row whose first cell is blank is labelled by the first visible column that has text, and its other columns are addressed under that label', () => {
    const f = fixture(
      'Team',
      ['Name', 'Role', 'Capacity'],
      [
        ['', 'Product engineer', '20'],
        ['Marcus', '', '18'],
      ],
    );
    const index = indexOf(f);
    expect(index.entries.map((e) => e.text)).toEqual([
      '@Team."Product engineer"',
      '@Team."Product engineer".Name',
      '@Team."Product engineer".Capacity',
      '@Team.Marcus',
      '@Team.Marcus.Role',
      '@Team.Marcus.Capacity',
    ]);
    expect(rowLabelOf(f.structure(), 0, f.textOf)).toEqual({
      colId: f.cols[1],
      label: 'Product engineer',
    });
    // The row entry points at the cell that labels it: Role, not the blank Name.
    expect(index.entries[0]?.cellId).toBe(
      workbookCellId(f.tableId, cellKey(f.rows[0] ?? '', f.cols[1] ?? '')),
    );
    // A hidden column never labels a row.
    hideColumn(f.gd, f.tableId, f.cols[1] ?? '');
    expect(indexOf(f).entries[0]?.text).toBe('@Team."20"');
  });

  test('FX-04 a column with a blank label is spelled by its grid letter — the letter its cells carry in their A1 address — and a hidden blank column is skipped', () => {
    const f = fixture('T', ['Name', '', ''], [['Lukla', '2860', 'Nepal']]);
    const structure = f.structure();
    // The table sits at lattice column 1, so its columns are B, C and D.
    expect(columnSegment(structure, f.cols[1] ?? '')).toBe('C');
    expect(columnSegment(structure, f.cols[2] ?? '')).toBe('D');
    expect(indexOf(f).entries.map((e) => [e.text, e.value])).toEqual([
      ['@T.Lukla', 'Lukla'],
      ['@T.Lukla.C', '2860'],
      ['@T.Lukla.D', 'Nepal'],
    ]);
    hideColumn(f.gd, f.tableId, f.cols[1] ?? '');
    // The hidden column has no letter; D is now the second visible column, spelled C.
    expect(indexOf(f).entries.map((e) => e.text)).toEqual(['@T.Lukla', '@T.Lukla.C']);
    expect(indexOf(f).entries[1]?.cellId).toBe(
      workbookCellId(f.tableId, cellKey(f.rows[0] ?? '', f.cols[2] ?? '')),
    );
  });

  test('REF-01 a value with spaces or dots is quoted in the written path and shown as typed in the value', () => {
    const f = fixture(
      'Everest trek',
      ['Stop', 'Note'],
      [['Namche (3440 m)', 'Rest day. Acclimatise']],
    );
    const [row, note] = indexOf(f).entries;
    expect(row).toMatchObject({
      text: '@"Everest trek"."Namche (3440 m)"',
      value: 'Namche (3440 m)',
    });
    expect(note).toMatchObject({
      text: '@"Everest trek"."Namche (3440 m)".Note',
      value: 'Rest day. Acclimatise',
      column: 'Note',
    });
  });

  test('HIER-04 FX-04 a row nested from column C is labelled by its column-C text, qualified by its parent, and its parent’s children are qualified by the same label', () => {
    const f = fixture(
      'Regions',
      ['Region', 'Country', 'City'],
      [
        ['Asia', '', ''],
        ['', 'Nepal', 'Kathmandu'],
        ['', 'India', 'Leh'],
        ['', '', 'Pokhara'],
      ],
    );
    nestRow(f.gd, f.tableId, f.rows[1] ?? '', f.cols[1]); // Nepal, outlined in Country
    nestRow(f.gd, f.tableId, f.rows[2] ?? '', f.cols[1]); // India, outlined in Country
    nestRow(f.gd, f.tableId, f.rows[3] ?? '', f.cols[2]); // Pokhara, outlined in City
    nestRow(f.gd, f.tableId, f.rows[3] ?? '', f.cols[2]); // under India
    expect(indexOf(f).entries.map((e) => e.text)).toEqual([
      '@Regions.Asia',
      '@Regions.Asia.Country',
      '@Regions.Asia.City',
      '@Regions.Asia.Nepal',
      '@Regions.Asia.Nepal.Region',
      '@Regions.Asia.Nepal.City',
      '@Regions.Asia.India',
      '@Regions.Asia.India.Region',
      '@Regions.Asia.India.City',
      '@Regions.Asia.India.Pokhara',
      '@Regions.Asia.India.Pokhara.Region',
      '@Regions.Asia.India.Pokhara.Country',
    ]);
    // One-to-many: Asia's related values in the other columns are each their own entry.
    const values = indexOf(f).entries.filter((e) => e.value === 'Kathmandu' || e.value === 'Leh');
    expect(values.map((e) => e.text)).toEqual([
      '@Regions.Asia.Nepal.City',
      '@Regions.Asia.India.City',
    ]);
  });

  test('FX-04 a table with no title or no column contributes nothing; a formula cell has no value', () => {
    const f = fixture('', ['A'], [['x']]);
    expect(indexOf(f).entries).toEqual([]);
    setTableTitle(f.gd, f.tableId, 'Now');
    expect(indexOf(f).entries.map((e) => e.text)).toEqual(['@Now.x']);
    const empty = buildEntityIndex([{ ...f.structure(), columns: [] }], () => 'x');
    expect(empty.entries).toEqual([]);
  });
});

describe('cellMayRelabel (ADR-052)', () => {
  test('FX-04 REF-01 a cell in the row’s outline column may re-spell the path; another column may only while that cell is blank', () => {
    const f = fixture(
      'T',
      ['A', 'B'],
      [
        ['Lukla', '2860'],
        ['', 'Namche'],
      ],
    );
    const structure = f.structure();
    const textOf = f.textOf;
    expect(cellMayRelabel(structure, cellKey(f.rows[0] ?? '', f.cols[0] ?? ''), textOf)).toBe(true);
    expect(cellMayRelabel(structure, cellKey(f.rows[0] ?? '', f.cols[1] ?? ''), textOf)).toBe(
      false,
    );
    expect(cellMayRelabel(structure, cellKey(f.rows[1] ?? '', f.cols[1] ?? ''), textOf)).toBe(true);
    expect(cellMayRelabel(structure, cellKey('nope', f.cols[1] ?? ''), textOf)).toBe(false);
    // The outline column decides, not the first column.
    nestRow(f.gd, f.tableId, f.rows[1] ?? '', f.cols[1]);
    setCellText(f.gd, f.tableId, f.rows[1] ?? '', f.cols[0] ?? '', 'Second');
    const nested = f.structure();
    expect(cellMayRelabel(nested, cellKey(f.rows[1] ?? '', f.cols[0] ?? ''), textOf)).toBe(false);
    expect(cellMayRelabel(nested, cellKey(f.rows[1] ?? '', f.cols[1] ?? ''), textOf)).toBe(true);
  });
});

describe('searchEntities (ADR-052)', () => {
  /** Deliverables and Team in one document, as the guided sample lays them out. */
  function workscape() {
    const f = fixture(
      'Deliverables',
      ['Deliverable', 'Owner', 'Status'],
      [
        ['Onboarding flow', 'Priya', 'In progress'],
        ['Billing export', 'Marcus', 'Blocked'],
        ['Passkey sign-in', 'Priya', 'Blocked'],
      ],
    );
    const teamId = createTable(f.gd, {
      sheetId: tableById(f.gd, f.tableId)?.sheetId ?? '',
      at: { col: 10, row: 1 },
      columns: 2,
      rows: 2,
      title: 'Team',
    });
    const team = tableById(f.gd, teamId);
    const teamMap = tableMap(f.gd, teamId);
    if (team === null || teamMap === null) throw new Error('no team');
    f.gd.doc.transact(() => {
      columnsArray(teamMap)
        .toArray()
        .forEach((column, i) => {
          column.set('label', ['Name', 'Role'][i] ?? '');
        });
    }, f.gd.origin);
    const [name, role] = team.columns.map((c) => c.id);
    setCellText(f.gd, teamId, team.rows[0] ?? '', name ?? '', 'Priya');
    setCellText(f.gd, teamId, team.rows[0] ?? '', role ?? '', 'Product engineer');
    setCellText(f.gd, teamId, team.rows[1] ?? '', name ?? '', 'Marcus');
    setCellText(f.gd, teamId, team.rows[1] ?? '', role ?? '', 'Platform engineer');
    return { f, teamId };
  }

  test('FX-04 REF-01 a prefix on the value ranks with a prefix on the path; the table being edited comes first, then the rest in workbook order; a name in several rows lists once per row', () => {
    const { f, teamId } = workscape();
    const fromDeliverables = searchEntities(indexOf(f), 'Pri', { tableId: f.tableId });
    expect(fromDeliverables.entries.map((e) => [e.text, e.value])).toEqual([
      ['@Deliverables."Onboarding flow".Owner', 'Priya'],
      ['@Deliverables."Passkey sign-in".Owner', 'Priya'],
      ['@Team.Priya', 'Priya'],
    ]);
    expect(fromDeliverables.more).toBe(0);
    // Edited from Team, the Team row leads and the Owner cells follow.
    expect(
      searchEntities(indexOf(f), 'Pri', { tableId: teamId }).entries.map((e) => e.text),
    ).toEqual([
      '@Team.Priya',
      '@Deliverables."Onboarding flow".Owner',
      '@Deliverables."Passkey sign-in".Owner',
    ]);
    // Without a table, workbook order (tables by id: Deliverables was created first).
    expect(searchEntities(indexOf(f), 'Pri').entries.map((e) => e.text)).toEqual([
      '@Deliverables."Onboarding flow".Owner',
      '@Deliverables."Passkey sign-in".Owner',
      '@Team.Priya',
    ]);
    // Typed as a path, the same query reaches the same cells.
    expect(
      searchEntities(indexOf(f), 'Deliverables."Onboarding').entries.map((e) => e.text),
    ).toEqual([
      '@Deliverables."Onboarding flow"',
      '@Deliverables."Onboarding flow".Owner',
      '@Deliverables."Onboarding flow".Status',
    ]);
  });

  test('FX-04 contains on the value ranks with contains on the last segment, after every prefix match; case does not matter; a value shared by two rows lists both, in row order', () => {
    const { f } = workscape();
    expect(searchEntities(indexOf(f), 'LOCK').entries.map((e) => [e.text, e.value])).toEqual([
      ['@Deliverables."Billing export".Status', 'Blocked'],
      ['@Deliverables."Passkey sign-in".Status', 'Blocked'],
    ]);
    expect(searchEntities(indexOf(f), 'Blocked').entries).toHaveLength(2);
    // Prefix matches first (Billing export and its Blocked), then the contains match (Onboarding).
    const mixed = searchEntities(indexOf(f), 'b', { tableId: f.tableId });
    expect(mixed.entries.map((e) => e.value)).toEqual([
      'Billing export',
      'Blocked',
      'Blocked',
      'Onboarding flow',
    ]);
  });

  test('FX-04 the limit is the caller’s and the overflow is counted; an empty query lists the edited table first, rows before their columns, in row order; a blank value never matches', () => {
    const { f, teamId } = workscape();
    const page = searchEntities(indexOf(f), '', { limit: 2, tableId: teamId });
    expect(page.entries.map((e) => e.text)).toEqual(['@Team.Priya', '@Team.Priya.Role']);
    // 9 Deliverables entries + 4 Team entries, 2 shown.
    expect(page.more).toBe(11);
    expect(searchEntities(indexOf(f), 'Pri', { limit: 1 })).toMatchObject({ more: 2 });
    expect(searchEntities(indexOf(f), 'Pri', { limit: 12 }).entries).toHaveLength(3);
    // The default limit is eight.
    expect(searchEntities(indexOf(f), '').entries).toHaveLength(8);
    const blanks = fixture('T', ['A', 'B'], [['x', '']]);
    expect(searchEntities(indexOf(blanks), 'y').entries).toEqual([]);
    expect(searchEntities(indexOf(blanks), 'y').more).toBe(0);
  });
});
