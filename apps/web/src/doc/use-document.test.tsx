// `fake-indexeddb` (a FAKE, dev-only) installs an in-memory IndexedDB so
// y-indexeddb persists exactly as it would in a browser.
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cellText,
  createSheet,
  createTable,
  documentMeta,
  listSheets,
  openDocument,
  setCellText,
  tableById,
  tableMap,
} from '@gede/core';
import { LiveRegion } from '../announce.js';
import { FakeRoom, until } from '../test/fake-websocket.js';
import { withConfig } from '../test/helpers.js';
import { useDocument, type DocumentSession, type UseDocumentResult } from './use-document.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-000000000002';
let storeSeq = 0;

interface Probe {
  result: UseDocumentResult | null;
}

function Harness({
  room,
  probe,
  store,
  getToken,
  title = 'Everest trek',
  userSub = 'sub-1',
}: {
  room: FakeRoom;
  probe: Probe;
  store?: string | undefined;
  getToken?: () => Promise<string | null>;
  title?: string;
  userSub?: string;
}) {
  const result = useDocument(DOC_ID, {
    seed: { title, createdAt: '2026-09-12T00:00:00Z' },
    userSub,
    wsUrl: 'wss://ws.test/ws',
    getToken: getToken ?? (() => Promise.resolve('tok')),
    WebSocketImpl: room.WebSocket,
    ...(store === undefined ? {} : { storeName: () => store }),
  });
  probe.result = result;
  return (
    <div>
      <LiveRegion />
      <span data-testid="status">{result.sync.status}</span>
      <span data-testid="ready">{String(result.ready)}</span>
    </div>
  );
}

function session(probe: Probe): DocumentSession {
  const s = probe.result?.session;
  if (!s) throw new Error('no session yet');
  return s;
}

describe('useDocument', () => {
  let store: string;
  beforeEach(() => {
    withConfig();
    store = `test-store-${String(++storeSeq)}`;
  });
  afterEach(() => {
    // fake-indexeddb keeps databases across tests; each test uses its own name.
  });

  it('LOAD-06 opens a Y.Doc, persists to IndexedDB, syncs through the provider and seeds the first sheet once', async () => {
    const room = new FakeRoom();
    const probe: Probe = { result: null };
    const view = render(<Harness room={room} probe={probe} store={store} />);
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('synced');
    });
    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true');
    });
    const s = session(probe);
    expect(documentMeta(s.gd).title).toBe('Everest trek');
    expect(listSheets(s.gd)).toHaveLength(1);
    // The room saw the seed, and holds exactly one sheet.
    await until(() => room.doc.getArray('sheets').length === 1);

    // A local edit lands in the doc immediately and reaches the room behind it (LOAD-05).
    const sheetId = listSheets(s.gd)[0]?.id ?? '';
    const tableId = createTable(s.gd, { sheetId, at: { col: 1, row: 1 }, columns: 1, rows: 1 });
    const rec = tableById(s.gd, tableId);
    setCellText(s.gd, tableId, rec?.rows[0] ?? '', rec?.columns[0]?.id ?? '', 'offline first');
    await until(() => room.doc.getMap('tables').has(tableId));

    // Reopen from the local replica alone: the room is gone, IndexedDB is not.
    // (The replica only stores what arrives after it has opened; wait for that before closing.)
    await s.persistence?.whenSynced;
    view.unmount();
    const dead = new FakeRoom({ refuseWith: { code: 1011, reason: 'down' } });
    const probe2: Probe = { result: null };
    render(<Harness room={dead} probe={probe2} store={store} />);
    // The replica loads through fake-indexeddb's own scheduler; give it room under a loaded CI box.
    await waitFor(
      () => {
        expect(screen.getByTestId('ready')).toHaveTextContent('true');
      },
      { timeout: 5000 },
    );
    const s2 = session(probe2);
    const t2 = tableMap(s2.gd, tableId);
    expect(t2).not.toBeNull();
    expect(cellText(t2!, rec?.rows[0] ?? '', rec?.columns[0]?.id ?? '')).toBe('offline first');
    expect(listSheets(s2.gd)).toHaveLength(1);
    expect(screen.getByTestId('status')).not.toHaveTextContent('synced');
  });

  it('A11Y-05 sync status changes announce through the polite live region', async () => {
    const room = new FakeRoom();
    const probe: Probe = { result: null };
    render(<Harness room={room} probe={probe} store={store} />);
    await waitFor(() => {
      expect(screen.getByTestId('live-region')).toHaveTextContent('Synced');
    });
    act(() => {
      room.options = { refuseWith: { code: 1011, reason: 'down' } };
      room.dropAll();
    });
    await waitFor(() => {
      expect(screen.getByTestId('live-region')).toHaveTextContent('Reconnecting');
    });
  });

  it('AUTH-09 the replica is stored per user: the IndexedDB name carries the sub', async () => {
    const room = new FakeRoom();
    const probe: Probe = { result: null };
    render(<Harness room={room} probe={probe} userSub="sub-private" />);
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('synced');
    });
    expect(session(probe).persistence?.name).toBe(`gede-doc-sub-private-${DOC_ID}`);
    expect(localStorage.getItem('gede.replicas')).toContain(`gede-doc-sub-private-${DOC_ID}`);
  });

  it('DOC-03 a document the room already holds is never seeded again; seeded duplicates are collapsed on sync', async () => {
    const room = new FakeRoom();
    const other = openDocument(room.doc);
    createSheet(other, { label: 'Existing' });
    const probe: Probe = { result: null };
    render(<Harness room={room} probe={probe} store={store} />);
    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true');
    });
    expect(listSheets(session(probe).gd).map((s) => s.label)).toEqual(['Existing']);
    expect(room.doc.getArray('sheets').length).toBe(1);
  });

  it('DOC-01 the record’s title is the source of truth: a differing meta.title is re-seeded on open', async () => {
    const room = new FakeRoom();
    const other = openDocument(room.doc);
    other.doc.transact(() => {
      other.meta.set('title', 'Stale room title');
    });
    const probe: Probe = { result: null };
    render(<Harness room={room} probe={probe} store={store} title="Everest trek (library)" />);
    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true');
    });
    expect(documentMeta(session(probe).gd).title).toBe('Everest trek (library)');
    await until(() => room.doc.getMap('meta').get('title') === 'Everest trek (library)');
  });

  it('AUTH-09 the token is read from the session before each connect', async () => {
    const room = new FakeRoom();
    const probe: Probe = { result: null };
    const tokens = ['first', 'second'];
    render(
      <Harness
        room={room}
        probe={probe}
        store={store}
        getToken={() => Promise.resolve(tokens.shift() ?? 'later')}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('synced');
    });
    expect(room.tokens[0]).toBe('first');
  });
});
