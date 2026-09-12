/**
 * FIND-05 budget: a fuzzy query over 10,000 indexed cells in under 100 ms.
 * Run with `npx vitest bench src/search` from packages/core (not part of verify).
 */
import { bench, describe } from 'vitest';

import { createSearchEngine } from './engine.js';
import { indexEntry, search } from './matcher.js';
import type { CellEntry, TableEntries } from './snapshot.js';

const CITIES = [
  'Singapore',
  'Kuala Lumpur',
  'Manila',
  'Jakarta',
  'Mumbai',
  'Chennai',
  'Hyderabad',
  'Bengaluru',
  'சிங்கப்பூர்',
  'मुंबई',
  'हैदराबाद',
  'சென்னை',
];
const NOTES = [
  'Base camp before the col',
  'Invoice S$ 1,200 due 12 Sep 2026',
  'Regional office lease renewal',
  'Q3 head-count review with finance',
];

function entry(i: number): CellEntry {
  const city = CITIES[i % CITIES.length] ?? 'Singapore';
  const note = NOTES[i % NOTES.length] ?? '';
  const value =
    i % 3 === 0 ? city : i % 3 === 1 ? `${note} ${city}` : `${String(i)} ${city} ${note}`;
  return {
    kind: 'cell',
    id: `t${String(i % 20)}/r${String(i)}:c${String(i % 5)}`,
    sheetId: 's1',
    sheetOrdinal: 1,
    tableId: `t${String(i % 20)}`,
    tableTitle: 'Table',
    rowId: `r${String(i)}`,
    colId: `c${String(i % 5)}`,
    rowIndex: Math.floor(i / 5),
    colIndex: i % 5,
    colLabel: ['Name', 'City', 'Amount', 'Date', 'Notes'][i % 5] ?? 'Name',
    format: i % 5 === 2 ? 'currency' : 'text',
    readOnly: false,
    texts: [{ field: 'value', text: value }],
  };
}

const COUNT = 10_000;
const entries = Array.from({ length: COUNT }, (_, i) => entry(i));
const indexed = entries.map(indexEntry);
const tables = new Map<string, CellEntry[]>();
for (const e of entries) {
  const list = tables.get(e.tableId) ?? [];
  list.push(e);
  tables.set(e.tableId, list);
}
const snapshot = {
  tables: Array.from(tables, ([tableId, list]): TableEntries => ({
    tableId,
    sheetId: 's1',
    entries: list,
  })),
  graphs: [],
  documents: [],
};
const engine = createSearchEngine();
engine.handle({ type: 'reset', snapshot });
const options = { fuzzy: true, formulas: true, documents: true };

describe(`fuzzy query over ${String(COUNT)} cells`, () => {
  bench('matcher: "Sngapore" (fuzzy, distance 2)', () => {
    search(indexed, 'Sngapore', options);
  });
  bench('matcher: "சிஙகப்பூர்" (Tamil, fuzzy)', () => {
    search(indexed, 'சிஙகப்பூர்', options);
  });
  bench('matcher: "col:City Mumbai" (operator + fuzzy)', () => {
    search(indexed, 'col:City Mumbai', options);
  });
  bench('matcher: "Singapore" (fuzzy off)', () => {
    search(indexed, 'Singapore', { ...options, fuzzy: false });
  });
  bench('engine: index 10,000 cells (reset message, segments and folds)', () => {
    createSearchEngine().handle({ type: 'reset', snapshot });
  });
  bench('engine round trip: query message → results', () => {
    engine.handle({ type: 'query', id: 1, query: 'Sngapore', options });
  });
});
