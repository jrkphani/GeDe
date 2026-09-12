/**
 * Sort, filter and grouping (SORT-01..06, HIER-08, non-negotiable 3): a stored
 * view validates against the table, collation follows the active
 * locale's script rules, the projection filters then sorts then groups, and
 * none of it moves an address.
 */
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  cellAddress,
  createSheet,
  createTable,
  openDocument,
  setCellText,
  setColumnFormat,
  tableAddresses,
  tableById,
  tableMap,
  type CellValue,
  type GedeDoc,
  type Id,
  type TableMap,
} from '../index.js';
import {
  buildProjectionInput,
  columnsRead,
  createCollator,
  EMPTY_VIEW,
  evaluatedText,
  handleViewRequest,
  isViewActive,
  isViewRequest,
  normaliseTableView,
  projectTableView,
  wordCount,
  type ProjectionInput,
  type ProjectionRow,
  type TableViewState,
} from './index.js';

function fresh(): GedeDoc {
  return openDocument(new Y.Doc());
}

interface Fixture {
  gd: GedeDoc;
  tableId: Id;
  table: TableMap;
  rows: Id[];
  cols: Id[];
}

/** A table with one column of `values` (and a second column so emptiness is per row). */
function tableOf(
  values: readonly (string | null)[],
  second: readonly (string | null)[] = [],
): Fixture {
  const gd = fresh();
  const sheetId = createSheet(gd);
  const tableId = createTable(gd, {
    sheetId,
    at: { col: 0, row: 0 },
    columns: 2,
    rows: values.length,
  });
  const record = tableById(gd, tableId);
  if (record === null) throw new Error('no table');
  const cols = record.columns.map((c) => c.id);
  const rows = [...record.rows];
  const [c0, c1] = cols;
  if (c0 === undefined || c1 === undefined) throw new Error('no columns');
  values.forEach((v, i) => {
    const rowId = rows[i];
    if (rowId === undefined) return;
    if (v !== null) setCellText(gd, tableId, rowId, c0, v);
    const s = second[i];
    if (s !== undefined && s !== null) setCellText(gd, tableId, rowId, c1, s);
  });
  const table = tableMap(gd, tableId);
  if (table === null) throw new Error('no map');
  return { gd, tableId, table, rows, cols };
}

/** Project a fixture's table on the calling thread and return the visible texts of column 0. */
function projectTexts(f: Fixture, view: TableViewState, locale = 'en-US'): string[] {
  const input = buildProjectionInput(f.table, view, locale);
  const p = projectTableView(input);
  const c0 = f.cols[0] ?? '';
  const textOf = new Map(input.rows.map((r) => [r.rowId, r.cells[c0] ?? '']));
  return p.rowIds.map((id) => textOf.get(id) ?? '');
}

const az = (colId: Id): TableViewState => ({
  sortBy: { colId, mode: 'az' },
  filter: null,
  groupBy: null,
});

describe('view state (SORT-01, SORT-06)', () => {
  test('SORT-01 a stored view is validated against the columns the table has now; unknown columns read as none', () => {
    const cols = new Set(['a', 'b']);
    expect(normaliseTableView(undefined, cols)).toEqual(EMPTY_VIEW);
    expect(normaliseTableView('junk', cols)).toEqual(EMPTY_VIEW);
    expect(
      normaliseTableView(
        {
          sortBy: { colId: 'a', mode: 'za' },
          filter: { colId: 'b', text: 'x', fuzzy: true, facet: 'email' },
          groupBy: 'b',
        },
        cols,
      ),
    ).toEqual({
      sortBy: { colId: 'a', mode: 'za' },
      filter: { colId: 'b', text: 'x', fuzzy: true, facet: 'email' },
      groupBy: 'b',
    });
    // A column deleted since: the sort and grouping fall back to none, the filter to every column.
    expect(
      normaliseTableView(
        {
          sortBy: { colId: 'gone', mode: 'az' },
          filter: { colId: 'gone', text: 'x', fuzzy: false, facet: null },
          groupBy: 'gone',
        },
        cols,
      ),
    ).toEqual({
      sortBy: null,
      filter: { colId: null, text: 'x', fuzzy: false, facet: null },
      groupBy: null,
    });
    // An empty filter (no text, no facet) and an unknown mode read as none.
    expect(
      normaliseTableView(
        { sortBy: { colId: 'a', mode: 'sideways' }, filter: { text: '  ' } },
        cols,
      ),
    ).toEqual(EMPTY_VIEW);
    expect(isViewActive(EMPTY_VIEW)).toBe(false);
    expect(isViewActive({ ...EMPTY_VIEW, groupBy: 'a' })).toBe(true);
  });

  test('SORT-01 SORT-06 the document carries no view keys: the schema layer neither writes nor reads them', () => {
    const f = tableOf(['b', 'a']);
    // Whatever an older build stored, the table record and addressing ignore it.
    f.gd.doc.transact(() => {
      f.table.set('sortBy', { colId: f.cols[0], mode: 'az' });
      f.table.set('groupBy', f.cols[0]);
    });
    const record = tableById(f.gd, f.tableId)!;
    expect(record).not.toHaveProperty('sortBy');
    expect(record).not.toHaveProperty('groupBy');
    expect(record.rows).toEqual(f.rows);
    expect(tableAddresses(f.table).flat()).toEqual(['A4', 'B4', 'A5', 'B5']);
  });
});

describe('addresses (non-negotiable 3, HIER-09)', () => {
  test('SORT-01 SORT-05 sorting, filtering and grouping change no A1 address and no row id', () => {
    const f = tableOf(['pear', 'apple', 'fig', null], ['x', 'y', 'z', null]);
    const c0 = f.cols[0] ?? '';
    const c1 = f.cols[1] ?? '';
    const before = tableAddresses(f.table).map((r) => [...r]);
    const beforeRows = [...(tableById(f.gd, f.tableId)?.rows ?? [])];
    const r2 = f.rows[2] ?? '';
    expect(cellAddress(f.table, r2, c1)).toBe('B6');
    const view: TableViewState = {
      sortBy: { colId: c0, mode: 'az' },
      filter: { colId: c0, text: 'p', fuzzy: false, facet: null },
      groupBy: c0,
    };
    const p = projectTableView(buildProjectionInput(f.table, view, 'en-US'));
    expect(p.rowIds).not.toEqual(beforeRows);
    expect(tableAddresses(f.table)).toEqual(before);
    expect(tableById(f.gd, f.tableId)?.rows).toEqual(beforeRows);
    expect(cellAddress(f.table, r2, c1)).toBe('B6');
  });
});

describe('collation (SORT-02)', () => {
  test('SORT-02 the collator is numeric and base-sensitive for the active locale', () => {
    const c = createCollator('en-IN');
    expect(c.resolvedOptions().numeric).toBe(true);
    expect(c.resolvedOptions().sensitivity).toBe('base');
    expect(createCollator('ta-IN').resolvedOptions().locale).toMatch(/^ta/);
    expect(['banana', 'Apple', 'Row 10', 'Row 9'].sort((a, b) => c.compare(a, b))).toEqual([
      'Apple',
      'banana',
      'Row 9',
      'Row 10',
    ]);
  });

  test('SORT-02 Tamil orders by script rules: Grantha letters after the native consonants, pulli before the vowel, digits by value', () => {
    const f = tableOf(['ஜ', 'ன', 'ச', 'ஞ', '௧௦', '௯', 'க', 'க்']);
    const c0 = f.cols[0] ?? '';
    const sorted = projectTexts(f, az(c0), 'ta-IN');
    // Code-point order would put ஜ (U+0B9C) between ச and ஞ, and ௧௦ before ௯.
    expect(sorted).toEqual(['௯', '௧௦', 'க்', 'க', 'ச', 'ஞ', 'ன', 'ஜ']);
    const codePoints = [...sorted].sort();
    expect(sorted).not.toEqual(codePoints);
  });

  test('SORT-02 Hindi orders a nukta form beside its base letter, not after the visarga; Devanagari digits by value', () => {
    const f = tableOf(['कः', 'क', 'क़', 'का', '१०', '९']);
    const c0 = f.cols[0] ?? '';
    const sorted = projectTexts(f, az(c0), 'hi-IN');
    expect(sorted).toEqual(['९', '१०', 'क', 'क़', 'कः', 'का']);
    expect(sorted).not.toEqual([...sorted].sort());
  });

  test('SORT-02 Telugu orders vocalic RR after vocalic R, not after the last consonant', () => {
    const f = tableOf(['ఴ', 'ౠ', 'ఋ', '౧౦', '౯']);
    const c0 = f.cols[0] ?? '';
    const sorted = projectTexts(f, az(c0), 'te-IN');
    expect(sorted).toEqual(['౯', '౧౦', 'ఋ', 'ౠ', 'ఴ']);
    expect(sorted).not.toEqual([...sorted].sort());
  });

  test('SORT-02 Z–A reverses A–Z but blanks stay last in both directions', () => {
    const f = tableOf(['b', null, 'c', 'a']);
    const c0 = f.cols[0] ?? '';
    expect(projectTexts(f, az(c0))).toEqual(['a', 'b', 'c', '']);
    expect(projectTexts(f, { ...az(c0), sortBy: { colId: c0, mode: 'za' } })).toEqual([
      'c',
      'b',
      'a',
      '',
    ]);
  });

  test('SORT-02 a Number column orders by value and a Date column chronologically regardless of pattern', () => {
    const n = tableOf(['1,000', '9', '12,34,567', '-5']);
    setColumnFormat(n.gd, n.tableId, n.cols[0] ?? '', 'number');
    expect(projectTexts(n, az(n.cols[0] ?? ''), 'en-IN')).toEqual([
      '-5',
      '9',
      '1,000',
      '12,34,567',
    ]);
    const d = tableOf(['2026-09-12', '1 Jan 2020', '31/12/2024']);
    setColumnFormat(d.gd, d.tableId, d.cols[0] ?? '', 'date');
    expect(projectTexts(d, az(d.cols[0] ?? ''), 'en-GB')).toEqual([
      '1 Jan 2020',
      '31/12/2024',
      '2026-09-12',
    ]);
    // Under Automatic, values come before dates, dates before text.
    const m = tableOf(['zebra', '2026-09-12', '42']);
    expect(projectTexts(m, az(m.cols[0] ?? ''))).toEqual(['42', '2026-09-12', 'zebra']);
  });

  test('SORT-02 the sort is stable: equal keys keep document order', () => {
    const f = tableOf(['same', 'other', 'same', 'Same']);
    const c0 = f.cols[0] ?? '';
    const input = buildProjectionInput(f.table, az(c0), 'en-US');
    const p = projectTableView(input);
    expect(p.rowIds).toEqual([f.rows[1], f.rows[0], f.rows[2], f.rows[3]]);
  });
});

describe('volume and frequency (SORT-01, PRD §9)', () => {
  test('SORT-01 Chars orders longest first, counting grapheme clusters: a Tamil conjunct is one character', () => {
    const f = tableOf(['க்ஷ', 'abcd', 'ab', 'கக']);
    const c0 = f.cols[0] ?? '';
    // க்ஷ is five code units but one cluster; கக is two.
    expect(projectTexts(f, { ...az(c0), sortBy: { colId: c0, mode: 'chars' } })).toEqual([
      'abcd',
      'ab',
      'கக',
      'க்ஷ',
    ]);
  });

  test('SORT-01 Words orders by word count, longest first, through the locale segmenter', () => {
    expect(wordCount('one two  three', 'en-US')).toBe(3);
    expect(wordCount('  ', 'en-US')).toBe(0);
    expect(wordCount('இது ஒரு சோதனை', 'ta-IN')).toBe(3);
    const f = tableOf(['a b', 'a b c d', 'a', null]);
    const c0 = f.cols[0] ?? '';
    expect(projectTexts(f, { ...az(c0), sortBy: { colId: c0, mode: 'words' } })).toEqual([
      'a b c d',
      'a b',
      'a',
      '',
    ]);
  });

  test('SORT-01 Freq orders the most frequent string first; case and surrounding space do not split a count', () => {
    const f = tableOf(['x', 'y', 'Y ', 'z', 'y', 'z']);
    const c0 = f.cols[0] ?? '';
    expect(projectTexts(f, { ...az(c0), sortBy: { colId: c0, mode: 'freq' } })).toEqual([
      'y',
      'y',
      'Y ',
      'z',
      'z',
      'x',
    ]);
  });
});

describe('filter (SORT-01, SORT-03, SORT-04)', () => {
  test('SORT-01 the contains filter keeps rows whose scoped cell contains the text, case-insensitively', () => {
    const f = tableOf(['Singapore office', 'Kuala Lumpur', 'singapore'], ['a', 'Singapore', 'c']);
    const c0 = f.cols[0] ?? '';
    const filter = { colId: c0, text: 'SINGA', fuzzy: false, facet: null };
    expect(projectTexts(f, { sortBy: null, filter, groupBy: null })).toEqual([
      'Singapore office',
      'singapore',
    ]);
    // Scope null reads every column: the second column's "Singapore" now matches too.
    expect(
      projectTexts(f, { sortBy: null, filter: { ...filter, colId: null }, groupBy: null }),
    ).toEqual(['Singapore office', 'Kuala Lumpur', 'singapore']);
  });

  test('SORT-03 the fuzzy filter tolerates an edit distance of two and operates on grapheme clusters', () => {
    const f = tableOf(['Singapore', 'Sngapore', 'Snigapor', 'Sydney', 'சிங்கப்பூர்', 'சிங்கபூர்']);
    const c0 = f.cols[0] ?? '';
    const fuzzy = (text: string) =>
      projectTexts(f, {
        sortBy: null,
        filter: { colId: c0, text, fuzzy: true, facet: null },
        groupBy: null,
      });
    expect(fuzzy('Sngapore')).toEqual(['Singapore', 'Sngapore', 'Snigapor']);
    // One dropped cluster in a Tamil word is one edit, whatever its code-unit length.
    expect(fuzzy('சிங்கப்பூர்')).toEqual(['சிங்கப்பூர்', 'சிங்கபூர்']);
    // Exact (non-fuzzy) matching keeps only the literal substring.
    expect(
      projectTexts(f, {
        sortBy: null,
        filter: { colId: c0, text: 'Sngapore', fuzzy: false, facet: null },
        groupBy: null,
      }),
    ).toEqual(['Sngapore']);
  });

  test('SORT-04 an entity facet keeps rows containing a Smart Chip match, with or without contains text', () => {
    const f = tableOf([
      'meena@1cloudhub.com',
      'Singapore',
      'plain text',
      'SGD 1,200',
      '12 Sep 2026',
      'Acme Pte Ltd',
    ]);
    const c0 = f.cols[0] ?? '';
    const facet = (kind: 'country' | 'company' | 'email' | 'date' | 'currency', text = '') =>
      projectTexts(f, {
        sortBy: null,
        filter: { colId: c0, text, fuzzy: false, facet: kind },
        groupBy: null,
      });
    expect(facet('email')).toEqual(['meena@1cloudhub.com']);
    expect(facet('country')).toEqual(['Singapore']);
    expect(facet('currency')).toEqual(['SGD 1,200']);
    expect(facet('date')).toEqual(['12 Sep 2026']);
    expect(facet('company')).toEqual(['Acme Pte Ltd']);
    expect(facet('company', 'zzz')).toEqual([]);
  });

  test('SORT-01 rows with no content anywhere are exempt from the filter and stay at the end', () => {
    const f = tableOf(['apple', null, 'pear']);
    const c0 = f.cols[0] ?? '';
    const p = projectTableView(
      buildProjectionInput(
        f.table,
        {
          sortBy: null,
          filter: { colId: c0, text: 'zzz', fuzzy: false, facet: null },
          groupBy: null,
        },
        'en-US',
      ),
    );
    expect(p.rowIds).toEqual([f.rows[1]]);
    expect(p.hiddenRowIds).toEqual([f.rows[0], f.rows[2]]);
  });
});

describe('grouping (SORT-05, HIER-08 (partial: bands only))', () => {
  test('SORT-05 grouping applies after sort and filter: bands carry the value and count, in sorted order', () => {
    const f = tableOf(
      ['b', 'a', 'b', 'c', 'a', null],
      ['Singapore', 'Sydney', 'Singapore', 'Singapore', 'Sydney', null],
    );
    const [c0, c1] = f.cols;
    if (c0 === undefined || c1 === undefined) throw new Error('cols');
    const view: TableViewState = {
      sortBy: { colId: c0, mode: 'za' },
      filter: { colId: c1, text: 'S', fuzzy: false, facet: null },
      groupBy: c0,
    };
    const p = projectTableView(buildProjectionInput(f.table, view, 'en-US'));
    expect(p.bands?.map((b) => [b.value, b.rowIds.length])).toEqual([
      ['c', 1],
      ['b', 2],
      ['a', 2],
    ]);
    // Within a band the sort's order (here document order among ties) and the predicate hold.
    expect(p.bands?.[1]?.rowIds).toEqual([f.rows[0], f.rows[2]]);
    // The empty row is loose, after every band.
    expect(p.loose).toEqual([f.rows[5]]);
    expect(p.rowIds.at(-1)).toBe(f.rows[5]);
    expect(p.bands?.[0]?.key).toBe('value:c');
  });

  test('SORT-05 rows whose grouped cell is blank share one band with an empty value', () => {
    const f = tableOf([null, 'x', null], ['has text', 'y', 'more']);
    const c0 = f.cols[0] ?? '';
    const p = projectTableView(
      buildProjectionInput(f.table, { sortBy: null, filter: null, groupBy: c0 }, 'en-US'),
    );
    expect(p.bands?.map((b) => [b.value, b.rowIds.length])).toEqual([
      ['', 2],
      ['x', 1],
    ]);
  });
});

describe('engine (message-shaped)', () => {
  test('SORT-01 the engine answers a request with the projection and refuses a malformed one', () => {
    const f = tableOf(['b', 'a']);
    const c0 = f.cols[0] ?? '';
    const input = buildProjectionInput(f.table, az(c0), 'en-US');
    expect(isViewRequest({ id: 1, tableId: f.tableId, input })).toBe(true);
    expect(
      isViewRequest({ id: 1, tableId: f.tableId, input: { ...input, view: { sortBy: 'az' } } }),
    ).toBe(false);
    expect(isViewRequest({ id: 'x' })).toBe(false);
    const res = handleViewRequest({ id: 7, tableId: f.tableId, input });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.projection.rowIds).toEqual([f.rows[1], f.rows[0]]);
    expect(res.id).toBe(7);
    // The request survives structured cloning: plain objects only.
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  });

  test('SORT-01 buildProjectionInput reads only the columns the view uses, but emptiness across every column', () => {
    const f = tableOf(['a', null, null], [null, 'second only', null]);
    const [c0, c1] = f.cols;
    if (c0 === undefined || c1 === undefined) throw new Error('cols');
    const view = az(c0);
    expect(columnsRead(view, tableById(f.gd, f.tableId)?.columns ?? []).map((c) => c.id)).toEqual([
      c0,
    ]);
    const input: ProjectionInput = buildProjectionInput(f.table, view, 'en-US');
    expect(input.columns.map((c) => c.id)).toEqual([c0]);
    const rows: readonly ProjectionRow[] = input.rows;
    expect(rows.map((r) => r.empty)).toEqual([false, false, true]);
    expect(rows[1]?.cells).toEqual({});
    // A filter over every column reads them all.
    const all = buildProjectionInput(
      f.table,
      {
        sortBy: null,
        filter: { colId: null, text: 'x', fuzzy: false, facet: null },
        groupBy: null,
      },
      'en-US',
    );
    expect(all.columns.map((c) => c.id)).toEqual([c0, c1]);
  });
  test('SORT-01 SORT-04 a formula column sorts, filters and facets by its evaluated value, never its source text', () => {
    const f = tableOf(
      ['=Concat(A6, "x")', '=Sum(B5:B6)', 'plain', '=Extract(C1)'],
      ['9', '1', '', ''],
    );
    const c0 = f.cols[0] ?? '';
    // FAKE engine results, as the formula Worker would answer them (labelled: a stub, not the engine).
    const results = new Map<string, CellValue>([
      [`${f.rows[0] ?? ''}:${c0}`, { kind: 'text', text: 'meena@1cloudhub.com' }],
      [`${f.rows[1] ?? ''}:${c0}`, { kind: 'currency', value: 1200, code: 'SGD' }],
      [`${f.rows[3] ?? ''}:${c0}`, { kind: 'date', iso: '2026-09-12' }],
    ]);
    const cellValue = (key: string) => results.get(key);
    const az: TableViewState = { sortBy: { colId: c0, mode: 'az' }, filter: null, groupBy: null };
    const input = buildProjectionInput(f.table, az, 'en-US', { cellValue });
    expect(input.rows.map((r) => r.cells[c0] ?? '')).toEqual([
      'meena@1cloudhub.com',
      'SGD 1200',
      'plain',
      '2026-09-12',
    ]);
    // Values before dates before text: the currency, the date, then the two texts.
    expect(projectTableView(input).rowIds).toEqual([f.rows[1], f.rows[3], f.rows[0], f.rows[2]]);
    const facet = (kind: 'email' | 'currency' | 'date') =>
      projectTableView(
        buildProjectionInput(
          f.table,
          {
            sortBy: null,
            filter: { colId: c0, text: '', fuzzy: false, facet: kind },
            groupBy: null,
          },
          'en-US',
          { cellValue },
        ),
      ).rowIds;
    expect(facet('email')).toEqual([f.rows[0]]);
    expect(facet('currency')).toEqual([f.rows[1]]);
    expect(facet('date')).toEqual([f.rows[3]]);
    // Without the resolver a formula reads as blank, never as "=…": the row stays content.
    const bare = buildProjectionInput(f.table, az, 'en-US');
    expect(bare.rows[0]?.cells[c0]).toBeUndefined();
    expect(bare.rows[0]?.empty).toBe(false);
    expect(evaluatedText({ kind: 'number', value: 1e21 })).toBe('1000000000000000000000');
    expect(evaluatedText({ kind: 'blank' })).toBe('');
    expect(evaluatedText(undefined)).toBe('');
  });
});
