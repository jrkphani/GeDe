import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellText,
  createSheet,
  createTable,
  hideColumn,
  insertRowBefore,
  openDocument,
  setCellText,
  tableById,
  tableMap,
  unhideColumn,
  type GedeDoc,
} from '../doc/index.js';
import { commitCellText } from '../engine/commit.js';
import { createGraphPair, setGraphDimensions } from '../graph/mutations.js';
import { addDerivedColumn } from '../ref/derive.js';
import { approximateFind, editDistance, exactFind } from './distance.js';
import { createSearchEngine, replaceInText } from './engine.js';
import { inferFormat, resolveFormat } from './format.js';
import { foldGraphemes, graphemes } from './graphemes.js';
import { fuzzyBudget, indexEntry, search, type IndexedEntry, type SearchMatch } from './matcher.js';
import { parseQuery } from './query.js';
import { buildSearchSnapshot, cellTexts, graphEntriesOf, tableEntries } from './snapshot.js';

/** A minimal entry for matcher tests; only what the matcher reads. */
function cell(
  id: string,
  value: string,
  extra: Partial<{
    colLabel: string;
    format: 'currency' | 'date' | 'number' | 'text';
    readOnly: boolean;
    sheetOrdinal: number;
    rowIndex: number;
    colIndex: number;
    tableId: string;
    formula: boolean;
  }> = {},
): IndexedEntry {
  const field = extra.formula === true ? 'formula' : 'value';
  return {
    kind: 'cell',
    id,
    sheetId: 's1',
    sheetOrdinal: extra.sheetOrdinal ?? 1,
    tableId: extra.tableId ?? 't1',
    tableTitle: 'Table 1',
    rowId: `r${id}`,
    colId: 'c1',
    rowIndex: extra.rowIndex ?? Number(id),
    colIndex: extra.colIndex ?? 0,
    colLabel: extra.colLabel ?? 'Name',
    format: extra.format ?? inferFormat(value),
    readOnly: extra.readOnly ?? false,
    texts: [{ field, text: value, folded: foldGraphemes(value) }],
  };
}

const ids = (matches: readonly SearchMatch[]) => matches.map((m) => m.entryId);

describe('graphemes', () => {
  test('SORT-03 (partial: matcher only) splits Tamil and Hindi text into grapheme clusters, never code units', () => {
    // Tamil: a consonant with its pulli (virama) or vowel sign is one cluster (UAX #29).
    expect(graphemes('சிங்கப்பூர்')).toEqual(['சி', 'ங்', 'க', 'ப்', 'பூ', 'ர்']);
    expect('சிங்கப்பூர்'.length).toBe(11);
    // Devanagari: the conjunct क्ष (KA + VIRAMA + SSA) is one cluster, so क्षत्रिय is three, not eight units.
    expect(graphemes('क्षत्रिय')).toEqual(['क्ष', 'त्रि', 'य']);
    expect('क्षत्रिय'.length).toBe(8);
    expect(graphemes('सिंगापुर')).toEqual(['सिं', 'गा', 'पु', 'र']);
    // Combining marks and emoji sequences are one cluster each; NFC folds composed forms.
    expect(graphemes('é')).toEqual(['é']);
    expect(graphemes('👩‍💻x')).toEqual(['👩‍💻', 'x']);
  });

  test('SORT-03 (partial: matcher only) edit distance counts clusters: one typo in a conjunct is one edit', () => {
    expect(editDistance(graphemes('क्षत्रिय'), graphemes('क्षत्रीय'), 2)).toBe(1);
    expect(editDistance(graphemes('singapore'), graphemes('sngapore'), 2)).toBe(1);
    expect(editDistance(graphemes('singapore'), graphemes('sngapor'), 2)).toBe(2);
    expect(editDistance(graphemes('singapore'), graphemes('sngapo'), 2)).toBe(3); // capped at max + 1
    expect(editDistance([], graphemes('ab'), 2)).toBe(2);
  });
});

describe('approximateFind', () => {
  test('FIND-05 finds a substring within two edits and reports the span in clusters', () => {
    const hay = foldGraphemes('The Singapore office');
    expect(exactFind(hay, foldGraphemes('singapore'))).toEqual({ distance: 0, start: 4, end: 13 });
    expect(approximateFind(hay, foldGraphemes('Sngapore'), 2)).toEqual({
      distance: 1,
      start: 4,
      end: 13,
    });
    expect(approximateFind(hay, foldGraphemes('Singapura'), 2)).toMatchObject({ distance: 2 });
    expect(approximateFind(hay, foldGraphemes('Sngapor'), 2)).toMatchObject({ distance: 1 });
    expect(approximateFind(hay, foldGraphemes('Mumbai'), 2)).toBeNull();
    expect(approximateFind([], foldGraphemes('ab'), 2)).toBeNull();
    expect(approximateFind(hay, [], 2)).toEqual({ distance: 0, start: 0, end: 0 });
  });

  test('FIND-05 prefers the exact occurrence, then the earliest start', () => {
    const hay = foldGraphemes('Sngapore and Singapore');
    expect(approximateFind(hay, foldGraphemes('Singapore'), 2)).toEqual({
      distance: 0,
      start: 13,
      end: 22,
    });
    expect(approximateFind(foldGraphemes('abcabc'), foldGraphemes('abd'), 1)).toEqual({
      distance: 1,
      start: 0,
      end: 3,
    });
  });

  test('FIND-05 a needle longer than the haystack plus the budget is rejected before the table is built', () => {
    // 200k clusters pasted into the field against a 2,000-cluster cell: without the guard
    // that is a 400M-cell table for this one cell (seconds), with it nothing.
    const essay = foldGraphemes('Singapore '.repeat(20_000));
    const started = performance.now();
    expect(approximateFind(foldGraphemes('Singapore '.repeat(200)), essay, 2)).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
    // Exactly at the boundary the needle can still match with `max` deletions.
    expect(approximateFind(foldGraphemes('abc'), foldGraphemes('abcde'), 2)).toMatchObject({
      distance: 2,
    });
    expect(approximateFind(foldGraphemes('abc'), foldGraphemes('abcdef'), 2)).toBeNull();
  });
});

describe('parseQuery', () => {
  test('FIND-04 reads col: and is: operators and joins bare terms into one phrase', () => {
    expect(parseQuery('col:Group is:currency base camp')).toEqual({
      phrase: 'base camp',
      columns: ['Group'],
      formats: ['currency'],
    });
    expect(parseQuery('col:"Work Group" IS:Date|number|bogus')).toEqual({
      phrase: '',
      columns: ['Work Group'],
      formats: ['date', 'number'],
    });
    expect(parseQuery('  Everest   trek ')).toEqual({
      phrase: 'Everest trek',
      columns: [],
      formats: [],
    });
    // A stray colon is not an operator; Tamil terms pass through untouched.
    expect(parseQuery('12:30 சிங்கப்பூர்')).toEqual({
      phrase: '12:30 சிங்கப்பூர்',
      columns: [],
      formats: [],
    });
    expect(parseQuery('')).toEqual({ phrase: '', columns: [], formats: [] });
  });
});

describe('format inference', () => {
  test('FIND-04 resolves currency, date, number and text; a declared column format wins', () => {
    expect(inferFormat('S$ 1,200.50')).toBe('currency');
    expect(inferFormat('₹12,34,567')).toBe('currency');
    expect(inferFormat('1200 SGD')).toBe('currency');
    expect(inferFormat('12,345.6')).toBe('number');
    expect(inferFormat('-42')).toBe('number');
    expect(inferFormat('௧௨')).toBe('number');
    expect(inferFormat('2026-09-12')).toBe('date');
    expect(inferFormat('12/09/2026')).toBe('date');
    expect(inferFormat('12 Sep 2026')).toBe('date');
    expect(inferFormat('Base camp')).toBe('text');
    expect(inferFormat('')).toBe('text');
    expect(resolveFormat('Base camp', 'currency')).toBe('currency');
    expect(resolveFormat('42', 'automatic')).toBe('number');
    expect(resolveFormat('42', undefined)).toBe('number');
  });
});

describe('matcher', () => {
  const entries = [
    cell('0', 'Singapore'),
    cell('1', 'Sngapore'),
    cell('2', 'Mumbai'),
    cell('3', 'S$ 1,200', { colLabel: 'Amount' }),
    cell('4', '2026-09-12', { colLabel: 'Date' }),
    cell('5', 'Singapore hub', { colLabel: 'Group' }),
    cell('6', '=Concat(A2, "Singapore")', { formula: true }),
  ];

  test('FIND-05 fuzzy is on by default: "Sngapore" finds "Singapore"; off it does not', () => {
    const fuzzy = search(entries, 'Sngapore');
    expect(ids(fuzzy)).toEqual(['1', '0', '5', '6']);
    expect(fuzzy[0]?.distance).toBe(0);
    expect(fuzzy[1]?.distance).toBe(1);
    const exact = search(entries, 'Sngapore', { fuzzy: false, formulas: true, documents: true });
    expect(ids(exact)).toEqual(['1']);
    // Short needles get a smaller budget so two-letter queries do not match everything.
    expect(fuzzyBudget(2)).toBe(0);
    expect(fuzzyBudget(4)).toBe(1);
    expect(fuzzyBudget(9)).toBe(2);
    expect(ids(search(entries, 'mu'))).toEqual(['2']);
  });

  test('FIND-05 ranking: exact hits first, then by distance, then document order', () => {
    const matches = search(
      [
        cell('a', 'Singapore', { sheetOrdinal: 2, rowIndex: 0 }),
        cell('b', 'Sngapore', { sheetOrdinal: 1, rowIndex: 5 }),
        cell('c', 'Singapore', { sheetOrdinal: 1, rowIndex: 9 }),
        cell('d', 'Singapor', { sheetOrdinal: 1, rowIndex: 1 }),
      ],
      'Singapore',
    );
    expect(ids(matches)).toEqual(['c', 'a', 'd', 'b']);
  });

  test('FIND-04 col: restricts to matching columns and is: to the resolved format; bare terms match anywhere', () => {
    expect(ids(search(entries, 'col:Group Singapore'))).toEqual(['5']);
    expect(ids(search(entries, 'is:currency'))).toEqual(['3']);
    expect(ids(search(entries, 'is:date|currency'))).toEqual(['3', '4']);
    expect(ids(search(entries, 'is:text singa'))).toEqual(['0', '5', '6', '1']);
    expect(ids(search(entries, 'col:amount 1,200'))).toEqual(['3']);
    expect(ids(search(entries, 'col:nowhere Singapore'))).toEqual([]);
    expect(search(entries, '')).toEqual([]);
    expect(search(entries, '   ')).toEqual([]);
  });

  test('FIND-03 formula expressions are searched unless the gear turns formulas off', () => {
    expect(ids(search(entries, 'Concat'))).toEqual(['6']);
    expect(search(entries, 'Concat')[0]?.field).toBe('formula');
    expect(
      ids(search(entries, 'Concat', { fuzzy: true, formulas: false, documents: true })),
    ).toEqual([]);
  });

  test('FIND-03 document names form their own group after cells and can be excluded', () => {
    const withDoc: IndexedEntry[] = [
      ...entries,
      {
        kind: 'document',
        id: 'document/d1',
        docId: 'd1',
        title: 'Singapore budget',
        readOnly: true,
        texts: [
          { field: 'name', text: 'Singapore budget', folded: foldGraphemes('Singapore budget') },
        ],
      },
    ];
    const all = search(withDoc, 'Singapore');
    // Cells (exact, then fuzzy) come first; the document group is last whatever its distance.
    expect(ids(all)).toEqual(['0', '5', '6', '1', 'document/d1']);
    expect(all.at(-1)?.target).toEqual({
      kind: 'document',
      docId: 'd1',
      title: 'Singapore budget',
    });
    expect(all.at(-1)?.readOnly).toBe(true);
    expect(
      ids(search(withDoc, 'Singapore', { fuzzy: true, formulas: true, documents: false })),
    ).not.toContain('document/d1');
    // Operators name columns, so documents never match an operator query.
    expect(ids(search(withDoc, 'col:Name Singapore'))).not.toContain('document/d1');
  });

  test('SORT-03 (partial: matcher only) fuzzy matching operates on Tamil and Hindi clusters', () => {
    const list = [cell('0', 'சிங்கப்பூர்'), cell('1', 'क्षत्रिय'), cell('2', 'मुंबई')];
    // One cluster wrong in the Tamil word (ங் → ங).
    expect(ids(search(list, 'சிஙகப்பூர்'))).toEqual(['0']);
    // One cluster substituted in the Devanagari word.
    expect(ids(search(list, 'क्षत्रीय'))).toEqual(['1']);
    expect(ids(search(list, 'मुंबई', { fuzzy: false, formulas: true, documents: true }))).toEqual([
      '2',
    ]);
  });
});

describe('snapshot', () => {
  function fixture(): { gd: GedeDoc; tableId: string; sheetId: string } {
    const gd = openDocument(new Y.Doc());
    const sheetId = createSheet(gd, { label: 'Trek' });
    const tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 3 });
    const record = tableById(gd, tableId)!;
    const [c1, c2] = record.columns.map((c) => c.id);
    const [r1, r2, r3] = record.rows;
    setCellText(gd, tableId, r1!, c1!, 'Base camp');
    setCellText(gd, tableId, r1!, c2!, 'S$ 1,200');
    setCellText(gd, tableId, r2!, c1!, '=Sum(B5:B7)');
    setCellText(gd, tableId, r3!, c1!, '=Concat(@Trek.Camp, " to ", @"Base camp".Name)');
    return { gd, tableId, sheetId };
  }

  test('FIND-03 indexes cell values, formula expressions and reference paths per table', () => {
    const { gd, tableId, sheetId } = fixture();
    const t = tableEntries(gd, tableId)!;
    expect(t.sheetId).toBe(sheetId);
    expect(t.entries.map((e) => e.texts.map((x) => `${x.field}:${x.text}`))).toEqual([
      ['header:Column 1'],
      ['header:Column 2'],
      ['value:Base camp'],
      ['value:S$ 1,200'],
      ['formula:=Sum(B5:B7)', 'reference:B5:B7'],
      [
        'formula:=Concat(@Trek.Camp, " to ", @"Base camp".Name)',
        'reference:@Trek.Camp',
        'reference:@"Base camp".Name',
      ],
    ]);
    const cells = t.entries.filter((e) => e.kind === 'cell');
    expect(cells.map((e) => [e.rowIndex, e.colIndex, e.format, e.readOnly])).toEqual([
      [0, 0, 'text', false],
      [0, 1, 'currency', false],
      [1, 0, 'text', false],
      [2, 0, 'text', false],
    ]);
    expect(cells[0]?.id).toBe(`${tableId}/${cells[0]!.rowId}:${cells[0]!.colId}`);
    // DOC-06: header cells are addressable, so Find reaches them; read-only until column rename lands.
    const headers = t.entries.filter((e) => e.kind === 'header');
    expect(headers.map((h) => [h.colIndex, h.colLabel, h.readOnly, h.id])).toEqual([
      [0, 'Column 1', true, `${tableId}/header:${headers[0]!.colId}`],
      [1, 'Column 2', true, `${tableId}/header:${headers[1]!.colId}`],
    ]);
    const found = search(t.entries.map(indexEntry), 'Column 2');
    expect(found.map((m) => [m.target.kind, m.field, m.distance])).toEqual([
      ['header', 'header', 0],
      ['header', 'header', 1],
    ]);
    // `col:` reaches headers too; `is:` is about values and leaves them out.
    const exact = { fuzzy: false, formulas: true, documents: true };
    expect(
      search(t.entries.map(indexEntry), 'col:"Column 1" column', exact).map((m) => m.target.kind),
    ).toEqual(['header']);
    expect(search(t.entries.map(indexEntry), 'is:text column')).toEqual([]);
    expect(tableEntries(gd, 'nope')).toBeNull();
    expect(cellTexts('=Sum(')).toEqual([expect.objectContaining({ field: 'formula' })]);
  });

  test('FIND-03 a committed (id-bound) formula is indexed as the expression the person reads, never as its tokens', () => {
    const { gd, tableId } = fixture();
    const record = tableById(gd, tableId)!;
    const [r1, r2] = record.rows;
    const c1 = record.columns[0]!.id;
    commitCellText(gd, tableId, r2!, c1, '=Sum(B5:B7)');
    const stored = cellText(tableMap(gd, tableId)!, r2!, c1);
    expect(stored).toMatch(/^=Sum\(\{r:/);
    const t = tableEntries(gd, tableId)!;
    const texts = t.entries.find((e) => e.kind === 'cell' && e.rowId === r2)!.texts;
    expect(texts).toEqual([
      { field: 'formula', text: '=Sum(B5:B7)' },
      { field: 'reference', text: 'B5:B7' },
    ]);
    const entries = t.entries.map(indexEntry);
    expect(search(entries, 'B5:B7').map((m) => m.field)).toContain('formula');
    expect(search(entries, 'Sum(B5').length).toBeGreaterThan(0);
    // A ULID fragment out of the stored token finds nothing.
    const ulid = /\{r:([0-9A-Z]{26})/.exec(stored)![1]!;
    expect(
      search(entries, ulid.slice(0, 10), { fuzzy: false, formulas: true, documents: true }),
    ).toEqual([]);
    // Inserting a row above re-spells the indexed expression to where the cells sit now.
    addRow(gd, tableId, undefined);
    insertRowBefore(gd, tableId, r1!);
    const after = tableEntries(gd, tableId)!.entries.find(
      (e) => e.kind === 'cell' && e.rowId === r2,
    )!;
    expect(after.texts[0]).toEqual({ field: 'formula', text: '=Sum(B6:B8)' });
    expect(
      buildSearchSnapshot(gd).tables[0]!.entries.some((e) =>
        e.texts.some((x) => x.text.includes('{r:')),
      ),
    ).toBe(false);
  });

  test('FIND-03 the whole snapshot carries tables, graph parameter values and document names; a graph indexes its dimension titles and distinct values, never column ids (#125)', () => {
    const { gd, tableId, sheetId } = fixture();
    const empty = buildSearchSnapshot(gd, [{ id: 'd1', title: 'Everest trek' }]);
    expect(empty.tables).toHaveLength(1);
    expect(empty.graphs).toEqual([]);
    expect(empty.documents).toEqual([
      expect.objectContaining({
        kind: 'document',
        docId: 'd1',
        title: 'Everest trek',
        readOnly: true,
      }),
    ]);
    // A bound pair (GRAPH-01) with the table's two columns as dimensions; the
    // second column reads "S$ 1,200" in row 1 and nothing below it.
    const record = tableById(gd, tableId)!;
    const [c1, c2] = record.columns.map((c) => c.id);
    const [, r2] = record.rows;
    setCellText(gd, tableId, r2!, c2!, 'Nepal');
    const pair = createGraphPair(gd, { sheetId, tableId });
    setGraphDimensions(gd, pair.pairId, [c1!, c2!]);
    const withGraph = buildSearchSnapshot(gd);
    // One entry per pair, not one per half; titled by the table and kind.
    expect(withGraph.graphs).toHaveLength(1);
    expect(withGraph.graphs[0]).toMatchObject({
      kind: 'graph',
      id: `graph/${pair.pairId}`,
      graphId: pair.ringId,
      sheetId,
      title: 'Table 1 ring',
      readOnly: true,
    });
    const texts = withGraph.graphs[0]!.texts.map((t) => `${t.field}:${t.text}`);
    expect(texts).toContain('dimension:Column 1');
    expect(texts).toContain('dimension:Base camp');
    expect(texts).toContain('dimension:Column 2');
    expect(texts).toContain('dimension:S$ 1,200');
    expect(texts).toContain('dimension:Nepal');
    // Formula cells are not parameters; column ids never are.
    expect(texts.some((t) => t.includes('=Sum'))).toBe(false);
    expect(texts.some((t) => t.includes(c1!.slice(0, 12)))).toBe(false);
    const matches = search(
      [...withGraph.tables[0]!.entries, ...withGraph.graphs].map(indexEntry),
      'Nepal',
    );
    expect(matches.map((m) => m.target.kind)).toEqual(['cell', 'graph']);
    expect(matches[1]?.readOnly).toBe(true);
    // An unbound pair has nothing to find.
    createGraphPair(gd, { sheetId, tableId: null });
    expect(graphEntriesOf(gd)).toHaveLength(1);
  });

  test('FIND-03 FIND-08 with a value reader, formula cells index their evaluated result and derived columns index one result per row, read-only (#125)', () => {
    const { gd, tableId } = fixture();
    const record = tableById(gd, tableId)!;
    const [c1, c2] = record.columns.map((c) => c.id);
    const [r1, r2, r3] = record.rows;
    const derived = addDerivedColumn(gd, tableId, {
      sourceColId: c1!,
      method: 'Concat',
      args: [' desk'],
    })!;
    // The reader stands in for the engine host: what each computed cell shows.
    const results = new Map<string, string>([
      [`${r2!}:${c1!}`, '3,600'],
      [`${r3!}:${c1!}`, 'Camp to Nepal'],
      [`${r1!}:${derived}`, 'Base camp desk'],
      [`${r2!}:${derived}`, ' desk'],
    ]);
    const valueOf = (_table: string, rowId: string, colId: string) =>
      results.get(`${rowId}:${colId}`);
    const t = tableEntries(gd, tableId, valueOf)!;
    const byId = new Map(t.entries.map((e) => [e.id, e] as const));
    expect(byId.get(`${tableId}/${r2!}:${c1!}`)?.texts.map((x) => `${x.field}:${x.text}`)).toEqual([
      'formula:=Sum(B5:B7)',
      'reference:B5:B7',
      'result:3,600',
    ]);
    const derivedEntry = byId.get(`${tableId}/${r1!}:${derived}`);
    expect(derivedEntry).toMatchObject({
      kind: 'cell',
      colId: derived,
      readOnly: true,
      texts: [{ field: 'result', text: 'Base camp desk' }],
    });
    // A row with no result yet is simply absent; nothing is invented.
    expect(byId.has(`${tableId}/${r3!}:${derived}`)).toBe(false);
    expect(byId.has(`${tableId}/${r1!}:${c2!}`)).toBe(true);
    // Without a reader the index is as before: expressions only, no derived cells.
    const plain = tableEntries(gd, tableId)!;
    expect(plain.entries.some((e) => e.kind === 'cell' && e.colId === derived)).toBe(false);
    expect(plain.entries.every((e) => e.texts.every((x) => x.field !== 'result'))).toBe(true);

    const indexed = t.entries.map(indexEntry);
    // The evaluated value finds the cell; the match is read-only (FIND-08).
    const desk = search(indexed, 'desk').filter((m) => m.target.kind === 'cell');
    expect(desk.map((m) => [m.field, m.readOnly])).toEqual([
      ['result', true],
      ['result', true],
    ]);
    const sum = search(indexed, '3,600', { fuzzy: false, formulas: true, documents: true });
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ field: 'result', readOnly: true });
    // When the expression matches too, it wins: the expression is what a person can edit.
    const camp = search(indexed, 'Camp', { fuzzy: false, formulas: true, documents: true });
    expect(camp.find((m) => m.target.kind === 'cell' && m.target.rowId === r3!)).toMatchObject({
      field: 'formula',
      readOnly: false,
    });
  });

  test('FIND-08 GRID-04 read-only comes from cellReadOnlyReason: derived, linked and pulled columns and category-band rows', () => {
    const { gd, tableId } = fixture();
    const table = gd.tables.get(tableId)!;
    const columns = table.get('columns') as Y.Array<Y.Map<unknown>>;
    const record = tableById(gd, tableId)!;
    gd.doc.transact(() => {
      columns.get(0).set('source', 'entered');
      columns.get(1).set('source', 'pulled');
    });
    let cells = tableEntries(gd, tableId)!.entries.filter((e) => e.kind === 'cell');
    expect(cells.map((e) => e.readOnly)).toEqual([false, true, false, false]);
    // A category-band (group) row is read-only whatever its column.
    const meta = new Y.Map<unknown>();
    meta.set('group', true);
    gd.doc.transact(() => {
      (table.get('rowMeta') as Y.Map<Y.Map<unknown>>).set(record.rows[0]!, meta);
    });
    cells = tableEntries(gd, tableId)!.entries.filter((e) => e.kind === 'cell');
    expect(cells.map((e) => e.readOnly)).toEqual([true, true, false, false]);
  });

  test('FIND-03 GRID-02 a hidden column has no lattice presence: its header and cells leave the index', () => {
    const { gd, tableId } = fixture();
    const record = tableById(gd, tableId)!;
    hideColumn(gd, tableId, record.columns[1]!.id);
    const t = tableEntries(gd, tableId)!;
    expect(t.entries.map((e) => e.texts[0]?.text)).toEqual([
      'Column 1',
      'Base camp',
      '=Sum(B5:B7)',
      '=Concat(@Trek.Camp, " to ", @"Base camp".Name)',
    ]);
    unhideColumn(gd, tableId, record.columns[1]!.id);
    expect(tableEntries(gd, tableId)!.entries).toHaveLength(6);
  });
});

describe('engine', () => {
  test('FIND-03 the engine indexes incrementally: reset, upsert one table, remove it, set documents', () => {
    const engine = createSearchEngine();
    const gd = openDocument(new Y.Doc());
    const sheetId = createSheet(gd);
    const t1 = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 1, rows: 1 });
    const r1 = tableById(gd, t1)!;
    setCellText(gd, t1, r1.rows[0]!, r1.columns[0]!.id, 'Singapore');
    engine.handle({ type: 'reset', snapshot: buildSearchSnapshot(gd) });
    const options = { fuzzy: true, formulas: true, documents: true };
    const q = (id: number) => engine.handle({ type: 'query', id, query: 'Singapore', options });
    expect(q(1)).toMatchObject({ type: 'results', id: 1, indexed: 2 }); // one header, one cell
    expect(q(1)?.matches).toHaveLength(1);

    const t2 = createTable(gd, { sheetId, at: { col: 1, row: 20 }, columns: 1, rows: 1 });
    const r2 = tableById(gd, t2)!;
    setCellText(gd, t2, r2.rows[0]!, r2.columns[0]!.id, 'Sngapore');
    expect(engine.handle({ type: 'upsertTables', tables: [tableEntries(gd, t2)!] })).toBeNull();
    expect(q(2)?.matches.map((m) => m.target.kind === 'cell' && m.target.tableId)).toEqual([
      t1,
      t2,
    ]);
    engine.handle({ type: 'removeTables', tableIds: [t1] });
    expect(q(3)?.matches.map((m) => m.distance)).toEqual([1]);
    engine.handle({
      type: 'setDocuments',
      documents: [
        {
          kind: 'document',
          id: 'document/d',
          docId: 'd',
          title: 'Singapore',
          readOnly: true,
          texts: [{ field: 'name', text: 'Singapore' }],
        },
      ],
    });
    expect(q(4)?.matches.map((m) => m.target.kind)).toEqual(['cell', 'document']);
    expect(engine.size()).toBe(3); // t2's header and cell, plus the document
  });

  test('FIND-08 replaceInText rewrites the matched span in clusters and leaves an empty span alone', () => {
    const hay = 'The Singapore office';
    const found = approximateFind(foldGraphemes(hay), foldGraphemes('Sngapore'), 2)!;
    expect(replaceInText(hay, found, 'Mumbai')).toBe('The Mumbai office');
    expect(replaceInText(hay, { start: 0, end: 0 }, 'x')).toBe(hay);
    const tamil = 'சிங்கப்பூர் அலுவலகம்';
    const span = approximateFind(foldGraphemes(tamil), foldGraphemes('சிங்கப்பூர்'), 0)!;
    expect(replaceInText(tamil, span, 'மும்பை')).toBe('மும்பை அலுவலகம்');
    // A span past the end of the text cannot be located: the text is left as it is, never
    // swapped wholesale for the replacement.
    expect(replaceInText('short', { start: 0, end: 40 }, 'x')).toBe('short');
  });
});
