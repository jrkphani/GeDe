import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  buildProjectionInput,
  createSheet,
  createTable,
  openDocument,
  setCellText,
  tableById,
  tableMap,
  type ViewResponse,
} from '@gede/core';

/**
 * The Worker entry runs against jsdom's `self` (the window): importing it
 * installs `onmessage`, and `postMessage` is spied on to capture the answer.
 * The engine itself is `@gede/core`'s and tested there; this covers the
 * plumbing — a good request is answered, a malformed one refused.
 */
describe('sort worker (SORT-01..05, PRD §20)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    self.onmessage = null;
  });

  test('SORT-01 answers a projection request off the caller and refuses a malformed message', async () => {
    const posted: ViewResponse[] = [];
    vi.spyOn(self, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as ViewResponse);
    });
    await import('./sort.worker.js');
    expect(self.onmessage).toBeTypeOf('function');

    const gd = openDocument(new Y.Doc());
    const sheetId = createSheet(gd);
    const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 1, rows: 3 });
    const record = tableById(gd, tableId)!;
    const col = record.columns[0]!.id;
    ['pear', 'apple', 'fig'].forEach((v, i) => {
      setCellText(gd, tableId, record.rows[i]!, col, v);
    });
    const input = buildProjectionInput(
      tableMap(gd, tableId)!,
      { sortBy: { colId: col, mode: 'az' }, filter: null, groupBy: null },
      'en-US',
    );
    self.onmessage!({ data: { id: 3, tableId, input } } as MessageEvent);
    expect(posted).toHaveLength(1);
    const first = posted[0]!;
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.id).toBe(3);
      expect(first.projection.rowIds).toEqual([record.rows[1], record.rows[2], record.rows[0]]);
    }

    self.onmessage!({ data: { id: 4, nonsense: true } } as MessageEvent);
    expect(posted[1]).toEqual({ id: 4, tableId: '', ok: false, error: 'malformed request' });
    self.onmessage!({ data: 'not even an object' } as MessageEvent);
    expect(posted[2]).toEqual({ id: -1, tableId: '', ok: false, error: 'malformed request' });
  });
});
