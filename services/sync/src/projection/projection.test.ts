import pino from 'pino';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  addRow,
  cellKey,
  cellsMap,
  createSheet,
  createTable,
  encodeSeededDocument,
  listSheets,
  openDocument,
  seedNewDocument,
  setCellText,
  setRowDepth,
  tableById,
  tableMap,
  type GedeDoc,
} from '@gede/core';

import { FakeRepo } from '../test/fake-repo.js';
import { json, startServer, WEB_ORIGIN, type TestServer } from '../test/fakes.js';
import { bearerProtocols, sleep, waitFor, YClient } from '../test/y-client.js';
import { fragmentToProseMirror, projectDocument } from './project.js';
import { ProjectionWorker } from './worker.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-00000000d0c1';

/** A seeded document with one table: two columns, three rows, plain, rich and formula cells. */
function sample(): {
  gd: GedeDoc;
  sheetId: string;
  tableId: string;
  rows: string[];
  cols: string[];
} {
  const doc = new Y.Doc();
  const { sheetId } = seedNewDocument(doc, {
    title: 'Everest trek',
    createdAt: '2026-09-12T00:00:00Z',
  });
  const gd = openDocument(doc);
  const tableId = createTable(gd, {
    sheetId,
    at: { col: 2, row: 3 },
    columns: 2,
    rows: 2,
    title: 'Gear',
  });
  const table = tableById(gd, tableId);
  if (!table) throw new Error('table');
  const cols = table.columns.map((c) => c.id);
  const rows = [...table.rows, addRow(gd, tableId)];
  const [r1, r2, r3] = rows;
  const [c1, c2] = cols;
  if (!r1 || !r2 || !r3 || !c1 || !c2) throw new Error('ids');
  setCellText(gd, tableId, r1, c1, 'Down jacket');
  setCellText(gd, tableId, r1, c2, '=Sum(B2:B3)');
  setCellText(gd, tableId, r2, c1, 'Sleeping bag\nminus twenty');
  setRowDepth(gd, tableId, r2, 1);
  // A rich cell: bold "Crampons" then plain text, as the ProseMirror binding writes it.
  const map = tableMap(gd, tableId);
  if (!map) throw new Error('map');
  doc.transact(() => {
    const fragment = new Y.XmlFragment();
    const p = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    p.insert(0, [text]);
    fragment.insert(0, [p]);
    cellsMap(map).set(cellKey(r3, c1), fragment);
    text.insert(0, 'Crampons', { bold: {} });
    text.insert(8, ' for the icefall', {}); // `{}`: no formatting; omitting it would inherit the bold
  });
  return { gd, sheetId, tableId, rows, cols };
}

describe('projectDocument', () => {
  test('FIND-03 projects sheets, tables, columns, rows and cells with text_plain, rich and formula', () => {
    const { gd, sheetId, tableId, rows, cols } = sample();
    const projection = projectDocument(gd.doc, DOC_ID);
    expect(projection.sheets).toEqual([
      { id: sheetId, documentId: DOC_ID, ordinal: 1, label: 'Sheet 1', parentContext: null },
    ]);
    expect(projection.tables).toEqual([
      { id: tableId, sheetId, title: 'Gear', gridCol: 2, gridRow: 3 },
    ]);
    expect(projection.columns).toEqual([
      { id: cols[0], tableId, ordinal: 1, label: 'Column 1', widthUnits: 1 },
      { id: cols[1], tableId, ordinal: 2, label: 'Column 2', widthUnits: 1 },
    ]);
    expect(projection.rows).toEqual([
      { id: rows[0], tableId, ordinal: 1, depth: 0, collapsed: false },
      { id: rows[1], tableId, ordinal: 2, depth: 1, collapsed: false },
      { id: rows[2], tableId, ordinal: 3, depth: 0, collapsed: false },
    ]);
    const cell = (r: number, c: number) =>
      projection.cells.find((x) => x.rowId === rows[r] && x.columnId === cols[c]);
    expect(cell(0, 0)).toEqual({
      rowId: rows[0],
      columnId: cols[0],
      textPlain: 'Down jacket',
      formula: null,
      rich: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Down jacket' }] }],
      },
    });
    // A formula cell: the source is what is searched (FIND-03 "formula expressions") and stored as formula.
    expect(cell(0, 1)).toMatchObject({
      textPlain: '=Sum(B2:B3)',
      formula: '=Sum(B2:B3)',
      rich: null,
    });
    // Two paragraphs flatten to two lines.
    expect(cell(1, 0)?.textPlain).toBe('Sleeping bag\nminus twenty');
    expect(cell(1, 0)?.rich?.content).toHaveLength(2);
    // Marks survive as ProseMirror marks; the plain text drops them.
    expect(cell(2, 0)).toEqual({
      rowId: rows[2],
      columnId: cols[0],
      textPlain: 'Crampons for the icefall',
      formula: null,
      rich: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Crampons', marks: [{ type: 'bold' }] },
              { type: 'text', text: ' for the icefall' },
            ],
          },
        ],
      },
    });
    expect(projection.cells).toHaveLength(4);
  });

  test('FIND-03 cells whose row or column is gone are left out so the foreign keys hold; empty docs project nothing', () => {
    const { gd, tableId, rows, cols } = sample();
    const map = tableMap(gd, tableId);
    if (!map || !rows[0] || !cols[1]) throw new Error('ids');
    // A cell keyed to a row that no longer exists in the rows array.
    gd.doc.transact(() => {
      cellsMap(map).set(cellKey('01ARZ3NDEKTSV4RRFFQ69G5FAV', cols[1] ?? ''), 'orphan');
    });
    const projection = projectDocument(gd.doc, DOC_ID);
    expect(projection.cells.some((c) => c.textPlain === 'orphan')).toBe(false);

    const empty = projectDocument(new Y.Doc(), DOC_ID);
    expect(empty).toEqual({
      documentId: DOC_ID,
      sheets: [],
      tables: [],
      columns: [],
      rows: [],
      cells: [],
    });
  });

  test('FIND-03 a second sheet and nested elements project in order; mark attrs become mark attrs', () => {
    const { gd } = sample();
    createSheet(gd, { label: 'Children of α', parentContext: 'α' });
    const projection = projectDocument(gd.doc, DOC_ID);
    expect(projection.sheets.map((s) => [s.ordinal, s.label, s.parentContext])).toEqual([
      [1, 'Sheet 1', null],
      [2, 'Children of α', 'α'],
    ]);
    expect(listSheets(gd)).toHaveLength(2);

    const fragment = new Y.XmlFragment();
    const doc = new Y.Doc();
    doc.getMap('x').set('f', fragment);
    const p = new Y.XmlElement('paragraph');
    p.setAttribute('align', 'right');
    const t = new Y.XmlText();
    p.insert(0, [t]);
    fragment.insert(0, [p]);
    t.insert(0, 'link', { link: { href: 'https://gede.work' } });
    expect(fragmentToProseMirror(fragment)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { align: 'right' },
          content: [
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://gede.work' } }],
            },
          ],
        },
      ],
    });
  });
});

describe('ProjectionWorker', () => {
  test('FIND-03 debounces per document, keeps the latest bytes, serialises writes and keeps the last good projection on failure', async () => {
    const repo = new FakeRepo();
    const worker = new ProjectionWorker(
      repo.projection,
      { PROJECTION_DEBOUNCE_MS: 20 },
      pino({ level: 'silent' }),
    );
    const { gd } = sample();
    const v1 = Y.encodeStateAsUpdate(gd.doc);
    createSheet(gd, { label: 'Later' });
    const v2 = Y.encodeStateAsUpdate(gd.doc);
    worker.schedule(DOC_ID, v1);
    worker.schedule(DOC_ID, v2);
    expect(worker.pendingCount).toBe(1);
    await waitFor(() => worker.stats.runs === 1);
    expect(worker.stats.coalesced).toBe(1);
    expect(repo.projections.get(DOC_ID)?.sheets.map((s) => s.label)).toEqual(['Sheet 1', 'Later']);

    repo.failNextProjection = true;
    worker.schedule(DOC_ID, v1);
    await waitFor(() => worker.stats.failures === 1);
    expect(repo.projections.get(DOC_ID)?.sheets).toHaveLength(2); // previous rows kept
    await expect(worker.projectNow(DOC_ID, v1)).resolves.toBeUndefined();
    expect(repo.projections.get(DOC_ID)?.sheets).toHaveLength(1);

    // flush runs what is pending and waits; after close nothing is accepted.
    worker.schedule(DOC_ID, v2);
    await worker.close();
    expect(repo.projections.get(DOC_ID)?.sheets).toHaveLength(2);
    worker.schedule(DOC_ID, v1);
    await sleep(40);
    expect(repo.projections.get(DOC_ID)?.sheets).toHaveLength(2);
  });
});

describe('projection through the room and GET /api/documents/:id/search', () => {
  let server: TestServer;
  let owner: string;
  let viewer: string;
  let stranger: string;
  const clients: YClient[] = [];

  beforeEach(async () => {
    server = await startServer({ PROJECTION_DEBOUNCE_MS: 20, SNAPSHOT_EVERY_UPDATES: 2 });
    owner = server.verifier.issue('tok-owner', 'sub-owner');
    viewer = server.verifier.issue('tok-viewer', 'sub-viewer');
    stranger = server.verifier.issue('tok-stranger', 'sub-stranger');
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.close();
  });

  async function create(): Promise<string> {
    const res = await json<{ document: { id: string } }>(server, 'POST', '/api/documents', {
      token: owner,
      body: { title: 'Everest trek' },
    });
    const id = res.body.document.id;
    const viewerId = (await json<{ id: string }>(server, 'GET', '/api/me', { token: viewer })).body
      .id;
    server.repo.share(id, viewerId, 'view');
    return id;
  }

  test('DOC-03 a new document is projected as its one sheet; compaction reprojects the cells; the endpoint finds them', async () => {
    const id = await create();
    await waitFor(() => server.repo.projections.get(id) !== undefined);
    expect(server.repo.projections.get(id)?.sheets.map((s) => s.label)).toEqual(['Sheet 1']);

    // A client edits through the room; SNAPSHOT_EVERY_UPDATES=2 compacts after two persisted updates.
    const client = await YClient.connect(`${server.wsUrl}/ws/${id}`, WEB_ORIGIN, {
      protocols: bearerProtocols(owner),
    });
    clients.push(client);
    await client.synced;
    const gd = openDocument(client.doc);
    const sheetId = listSheets(gd)[0]?.id ?? '';
    const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 1, rows: 1 });
    const table = tableById(gd, tableId);
    const rowId = table?.rows[0] ?? '';
    const colId = table?.columns[0]?.id ?? '';
    setCellText(gd, tableId, rowId, colId, 'Down jacket for the summit push');
    await waitFor(() => (server.repo.projections.get(id)?.cells.length ?? 0) === 1, {
      timeoutMs: 5000,
    });

    const found = await json<{ results: { rowId: string; columnId: string; snippet: string }[] }>(
      server,
      'GET',
      `/api/documents/${id}/search?q=summit%20jacket`,
      { token: viewer },
    );
    expect(found.status).toBe(200);
    expect(found.body.results).toEqual([
      { sheetId, tableId, rowId, columnId: colId, snippet: 'Down jacket for the summit push' },
    ]);
    const none = await json<{ results: unknown[] }>(
      server,
      'GET',
      `/api/documents/${id}/search?q=yeti`,
      { token: owner },
    );
    expect(none.body.results).toEqual([]);
  });

  test('SHARE-03 search is for participants only: 403 for a stranger, 401 without a token, 400 without a query', async () => {
    const id = await create();
    expect(
      (await json(server, 'GET', `/api/documents/${id}/search?q=x`, { token: stranger })).status,
    ).toBe(403);
    expect((await json(server, 'GET', `/api/documents/${id}/search?q=x`)).status).toBe(401);
    expect(
      (await json(server, 'GET', `/api/documents/${id}/search`, { token: owner })).status,
    ).toBe(400);
    expect(
      (await json(server, 'GET', `/api/documents/${id}/search?q=`, { token: owner })).status,
    ).toBe(400);
    expect(
      (
        await json(server, 'GET', `/api/documents/${crypto.randomUUID()}/search?q=x`, {
          token: owner,
        })
      ).status,
    ).toBe(404);
  });

  test('LIB-08 SHARE-03 a soft-deleted document is not searchable, by its owner or a participant, until it is recovered', async () => {
    const id = await create();
    await waitFor(() => server.repo.projections.get(id) !== undefined);
    const search = (token: string) =>
      json<{ results: unknown[] }>(server, 'GET', `/api/documents/${id}/search?q=sheet`, {
        token,
      });
    expect((await json(server, 'DELETE', `/api/documents/${id}`, { token: owner })).status).toBe(
      204,
    );
    // The projection rows are still there (the nightly purge removes them); the route must not serve them.
    expect(server.repo.projections.get(id)).toBeDefined();
    expect((await search(owner)).status).toBe(404);
    expect((await search(viewer)).status).toBe(404);
    expect((await search(stranger)).status).toBe(403);
    expect(
      (await json(server, 'POST', `/api/documents/${id}/recover`, { token: owner })).status,
    ).toBe(200);
    expect((await search(owner)).status).toBe(200);
  });

  test('FIND-03 results are capped at 50 and snippets window around the first match', async () => {
    const id = await create();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeSeededDocument({ title: 'Everest trek' }));
    const gd = openDocument(doc);
    const sheetId = listSheets(gd)[0]?.id ?? '';
    const tableId = createTable(gd, { sheetId, at: { col: 0, row: 0 }, columns: 1, rows: 60 });
    const table = tableById(gd, tableId);
    const colId = table?.columns[0]?.id ?? '';
    table?.rows.forEach((rowId, i) => {
      setCellText(
        gd,
        tableId,
        rowId,
        colId,
        `${'x'.repeat(60)} needle number ${String(i)} ${'y'.repeat(60)}`,
      );
    });
    await server.app.projection.projectNow(id, Y.encodeStateAsUpdate(doc));
    const res = await json<{ results: { snippet: string }[] }>(
      server,
      'GET',
      `/api/documents/${id}/search?q=needle`,
      { token: owner },
    );
    expect(res.body.results).toHaveLength(50);
    // 39 characters before the match (40 minus the space), 80 after (which reaches the end here, so no tail).
    expect(res.body.results[0]?.snippet).toMatch(/^…x{39} needle number 0 y{60}$/);
    expect(res.body.results[1]?.snippet).toMatch(/^…x{39} needle number 1 y{60}$/);
  });
});
