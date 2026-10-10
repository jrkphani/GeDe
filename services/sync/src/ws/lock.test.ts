import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  addRow,
  addSection,
  cellText,
  createTable,
  ensureFirstSheet,
  openDocument,
  setCellText,
  setSectionLocked,
  setSheetLocked,
  tableById,
  tableMap,
  type GedeDoc,
} from '@gede/core';

import { json, startServer, WEB_ORIGIN, type TestServer } from '../test/fakes.js';
import { bearerProtocols, sleep, waitFor, YClient } from '../test/y-client.js';

let server: TestServer;
let ownerToken: string;
let editorToken: string;
let docId: string;
const clients: YClient[] = [];

async function connect(token: string): Promise<YClient> {
  const client = await YClient.connect(`${server.wsUrl}/ws/${docId}`, WEB_ORIGIN, {
    protocols: bearerProtocols(token),
  });
  clients.push(client);
  await client.synced;
  return client;
}

beforeEach(async () => {
  server = await startServer();
  ownerToken = server.verifier.issue('tok-owner', 'sub-owner');
  editorToken = server.verifier.issue('tok-editor', 'sub-editor');
  const me = await json<{ id: string }>(server, 'GET', '/api/me', { token: ownerToken });
  const editor = await json<{ id: string }>(server, 'GET', '/api/me', { token: editorToken });
  docId = server.repo.seedDocument(me.body.id, 'locked doc').id;
  server.repo.share(docId, editor.body.id, 'edit');
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.close();
});

const room = () => {
  const found = server.app.rooms.get(docId);
  if (found === undefined) throw new Error('no room');
  return openDocument(found.doc);
};

function cell(gd: GedeDoc, tableId: string): string {
  const table = tableMap(gd, tableId);
  const record = tableById(gd, tableId);
  const row = record?.rows[0];
  const col = record?.columns[0]?.id;
  return table === null || row === undefined || col === undefined ? '' : cellText(table, row, col);
}

describe('lock on received updates (SET-18)', () => {
  test('SET-18 the room drops an edit to a table in a locked section, and keeps one elsewhere', async () => {
    const owner = await connect(ownerToken);
    const gd = openDocument(owner.doc);
    const sheetId = ensureFirstSheet(gd);
    const lane = addSection(gd, sheetId, { name: 'Lane', firstColumn: 0, lastColumn: 5 }) ?? '';
    const inside = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 1, rows: 1 });
    const outside = createTable(gd, { sheetId, at: { col: 10, row: 1 }, columns: 1, rows: 1 });
    await waitFor(() => tableById(room(), outside) !== null);
    setSectionLocked(gd, sheetId, lane, true);
    await waitFor(() => room().sheets.length > 0 && room().tables.size === 2);
    await sleep(30);

    const editor = await connect(editorToken);
    const theirs = openDocument(editor.doc);
    const row = (id: string) => tableById(theirs, id)?.rows[0] ?? '';
    const col = (id: string) => tableById(theirs, id)?.columns[0]?.id ?? '';
    setCellText(theirs, inside, row(inside), col(inside), 'sneaky');
    setCellText(theirs, outside, row(outside), col(outside), 'fine');
    await waitFor(() => cell(room(), outside) === 'fine');
    expect(cell(room(), inside)).toBe('');
    expect(server.app.rooms.get(docId)?.stats.lockedEdits).toBeGreaterThanOrEqual(1);
  });

  test('SET-18 a locked sheet drops every table’s edits until it is unlocked', async () => {
    const owner = await connect(ownerToken);
    const gd = openDocument(owner.doc);
    const sheetId = ensureFirstSheet(gd);
    const id = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 1, rows: 0 });
    addRow(gd, id);
    await waitFor(() => tableById(room(), id)?.rows.length === 1);
    setSheetLocked(gd, sheetId, true);
    await sleep(30);

    const editor = await connect(editorToken);
    const theirs = openDocument(editor.doc);
    const rowId = tableById(theirs, id)?.rows[0] ?? '';
    const colId = tableById(theirs, id)?.columns[0]?.id ?? '';
    setCellText(theirs, id, rowId, colId, 'refused');
    await waitFor(() => (server.app.rooms.get(docId)?.stats.lockedEdits ?? 0) >= 1);
    expect(cell(room(), id)).toBe('');

    setSheetLocked(gd, sheetId, false);
    await sleep(30);
    setCellText(gd, id, rowId, colId, 'now fine');
    await waitFor(() => cell(room(), id) === 'now fine');
  });
});
