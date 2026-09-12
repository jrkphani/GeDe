// Find inside the real document shell (keyboard map, canvas, viewport). FAKES,
// all labelled: `fake-indexeddb` for the replica, `FakeRoom` for the
// y-websocket room, `vi.fn()` for the documents REST API returning the
// server's real shape. The search Worker is absent under jsdom, so the
// main-thread fallback runs.
import 'fake-indexeddb/auto';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSheet, createTable, openDocument, setCellText, tableById } from '@gede/core';
import type * as DocumentsApi from '../../../api/documents.js';
import { setDocumentSeamsForTests } from '../../../doc/use-document.js';
import { FakeRoom, until } from '../../../test/fake-websocket.js';
import { installMatchMedia } from '../../../test/match-media.js';
import { renderRoutes, withConfig } from '../../../test/helpers.js';
import { routes } from '../../../routes.js';

const user = { sub: 'sub-1', email: 'meena@1cloudhub.com', name: 'Meena' };

vi.mock('../../../auth/cognito.js', () => ({
  isPasskeySupported: () => true,
  accessToken: () => Promise.resolve('tok'),
  refreshAccessToken: () => Promise.resolve('fresh'),
  currentUser: () => Promise.resolve(user),
  onAuthEvent: () => () => undefined,
  signOutLocal: vi.fn(() => Promise.resolve()),
  classifyError: () => ({ kind: 'other', message: 'x' }),
}));

vi.mock('../../../api/documents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentsApi>();
  return {
    ...actual,
    getDocument: vi.fn(),
    renameDocument: vi.fn(() => Promise.resolve()),
    listDocuments: vi.fn(() => Promise.resolve([])),
  };
});

const docs = await import('../../../api/documents.js');
const ID = '6f1b2c3d-0000-4000-8000-00000000f1d0';
const record = {
  id: ID,
  title: 'Everest trek',
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:00:00Z',
  ownerId: 'sub-1',
  permission: 'owner' as const,
};

let room: FakeRoom;
let storeSeq = 0;

/** A collaborator has already authored two sheets; sheet 2's table sits far from A1. */
function seedRoom() {
  const gd = openDocument(room.doc);
  const sheet1 = createSheet(gd, { label: 'Trek' });
  const sheet2 = createSheet(gd, { label: 'Budget' });
  const t1 = createTable(gd, { sheetId: sheet1, at: { col: 1, row: 1 }, columns: 2, rows: 3 });
  const r1 = tableById(gd, t1)!;
  setCellText(gd, t1, r1.rows[0]!, r1.columns[0]!.id, 'Singapore');
  setCellText(gd, t1, r1.rows[1]!, r1.columns[0]!.id, 'Mumbai');
  setCellText(gd, t1, r1.rows[2]!, r1.columns[1]!.id, 'Sngapore');
  const t2 = createTable(gd, { sheetId: sheet2, at: { col: 30, row: 200 }, columns: 1, rows: 1 });
  const r2 = tableById(gd, t2)!;
  setCellText(gd, t2, r2.rows[0]!, r2.columns[0]!.id, 'Singapore budget');
  return { sheet1, sheet2, t1, t2 };
}

async function openShell() {
  const view = renderRoutes(routes, [`/d/${ID}`]);
  await waitFor(() => {
    expect(screen.getByTestId('plane')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: /Trek/ })).toBeInTheDocument();
  });
  await until(() => room.doc.getMap('tables').size === 2);
  await waitFor(() => {
    expect(screen.getAllByRole('grid').length).toBeGreaterThan(0);
  });
  return view;
}

const chord = (init: KeyboardEventInit) =>
  fireEvent.keyDown(window, { bubbles: true, cancelable: true, ...init });
const findBar = () => screen.queryByRole('search', { name: 'Find' });
const count = () => screen.getByTestId('find-count').textContent;
const layerTransform = () => screen.getByTestId('layer').style.transform;

describe('Find in the document shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia((q) => q.includes('min-width: 1200'));
    // Chords use ⌘ on Apple platforms; jsdom's UA says "darwin", not "Macintosh".
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) jsdom');
    room = new FakeRoom();
    const store = `find-store-${String(++storeSeq)}`;
    setDocumentSeamsForTests({ WebSocketImpl: room.WebSocket, storeName: () => store });
    vi.mocked(docs.getDocument).mockResolvedValue(record);
    vi.mocked(docs.listDocuments).mockResolvedValue([]);
  });
  afterEach(() => {
    setDocumentSeamsForTests(null);
    vi.restoreAllMocks();
  });

  it('FIND-01 KEYS-04 I18N-02 ⌘F (by event.code, whatever the layout prints) and the toolbar magnifier open the bar and focus the field', async () => {
    seedRoom();
    await openShell();
    expect(findBar()).not.toBeInTheDocument();
    // Tamil99 puts "எ" on the physical F key; the code is still KeyF.
    chord({ code: 'KeyF', key: 'எ', metaKey: true });
    expect(findBar()).toBeInTheDocument();
    const field = screen.getByRole('textbox', { name: 'Find' });
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    expect(field).toHaveAttribute('aria-keyshortcuts', 'Meta+F');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(findBar()).not.toBeInTheDocument();
    const magnifier = screen.getByRole('button', { name: 'Find' });
    expect(magnifier).toHaveAttribute('aria-keyshortcuts', 'Meta+F');
    expect(magnifier.title).toBe('Find (⌘F)');
    await userEvent.click(magnifier);
    expect(findBar()).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Find' })).toHaveFocus();
    });
  });

  it('FIND-01 KEYS-04 ⌥⌘F opens with the replace field shown', async () => {
    seedRoom();
    await openShell();
    chord({ code: 'KeyF', metaKey: true, altKey: true });
    expect(findBar()).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Replace with' })).toBeInTheDocument();
  });

  it('FIND-02 FIND-06 the bar floats over the canvas without displacing it; matches tint in place on the active sheet', async () => {
    seedRoom();
    await openShell();
    const plane = screen.getByTestId('plane');
    chord({ code: 'KeyF', metaKey: true });
    const bar = findBar()!;
    // Floating: a sibling of the canvas inside the main area, not a grid row of its own.
    expect(bar.parentElement).toBe(plane.closest('.gd-doc__main'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Find' }), 'Singapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 3');
    });
    // Two of the three sit on sheet 1 (one exact, one fuzzy); the highlights live in the transformed layer.
    const layer = screen.getByTestId('layer');
    await waitFor(() => {
      expect(within(layer).getByTestId('find-highlights').children).toHaveLength(2);
    });
    const hits = within(layer).getByTestId('find-highlights').children;
    expect(hits[0]).toHaveClass('gd-find-hit--current');
    expect(hits[0]).toHaveStyle({ left: '160px', top: '88px' }); // B5 of the table at (1,1)
    expect(hits[1]).not.toHaveClass('gd-find-hit--current');
  });

  it('FIND-07 KEYS-04 ⌘G / ⇧⌘G step through matches from the field, switching sheet and moving the viewport', async () => {
    seedRoom();
    await openShell();
    chord({ code: 'KeyF', metaKey: true });
    const field = screen.getByRole('textbox', { name: 'Find' });
    await userEvent.type(field, 'Singapore');
    await waitFor(() => {
      expect(count()).toBe('1 of 3');
    });
    expect(field).toHaveFocus();
    expect(layerTransform()).toBe('translate(0px, 0px) scale(1)');
    // ⌘G with focus in the field (an editable target) still steps.
    chord({ code: 'KeyG', metaKey: true });
    expect(count()).toBe('2 of 3');
    // The second exact hit is on sheet 2, at (30, 200): the sheet switches and the viewport pans to it.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Budget/ })).toHaveAttribute('aria-selected', 'true');
    });
    expect(layerTransform()).not.toBe('translate(0px, 0px) scale(1)');
    // The layer translates by the negative viewport offset; the cell at (30, 200) is now on screen
    // (the plane is unmeasured under jsdom, so the shell assumes the lg fallback of 1024 × 768).
    const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(layerTransform()) ?? [];
    expect(-Number(x)).toBeGreaterThanOrEqual(30 * 160 + 160 - 1024);
    expect(-Number(y)).toBeGreaterThanOrEqual(200 * 22 + 22 + 3 * 22 - 768);
    expect(screen.getByTestId('live-region')).toHaveTextContent(/2 of 3, AE204 in Table 1/);
    chord({ code: 'KeyG', metaKey: true, shiftKey: true });
    expect(count()).toBe('1 of 3');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Trek/ })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('FIND-08 Replace writes through to the room and the counter follows; FIND-10 the bar stays open at zero', async () => {
    seedRoom();
    await openShell();
    chord({ code: 'KeyF', metaKey: true, altKey: true });
    await userEvent.type(screen.getByRole('textbox', { name: 'Find' }), 'Mumbai');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    await userEvent.type(screen.getByRole('textbox', { name: 'Replace with' }), 'Chennai');
    await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await until(() => JSON.stringify(room.doc.getMap('tables').toJSON()).includes('Chennai'));
    await waitFor(() => {
      expect(count()).toBe('No matches');
    });
    expect(findBar()).toBeInTheDocument();
  });

  it('FIND-09 Esc closes the bar (before it would clear the selection), clears highlights and selects the current match; the query is kept', async () => {
    seedRoom();
    await openShell();
    chord({ code: 'KeyF', metaKey: true });
    const field = screen.getByRole('textbox', { name: 'Find' });
    await userEvent.type(field, 'Mumbai');
    await waitFor(() => {
      expect(count()).toBe('1 of 1');
    });
    await waitFor(() => {
      expect(screen.getByTestId('find-highlights')).toBeInTheDocument();
    });
    // Escape from inside the field (an editable target) closes the bar.
    fireEvent.keyDown(field, { code: 'Escape', bubbles: true, cancelable: true });
    expect(findBar()).not.toBeInTheDocument();
    expect(screen.queryByTestId('find-highlights')).not.toBeInTheDocument();
    // The current match became the selection: B6 in Table 1 (row 2 of the table at (1,1)).
    await waitFor(() => {
      expect(screen.getByLabelText('Address B6')).toBeInTheDocument();
    });
    // Reopening keeps the query, selected.
    chord({ code: 'KeyF', metaKey: true });
    const again = screen.getByRole<HTMLInputElement>('textbox', { name: 'Find' });
    expect(again).toHaveValue('Mumbai');
    await waitFor(() => {
      expect(again).toHaveFocus();
    });
    expect(again.selectionEnd).toBe('Mumbai'.length);
    // A second Escape, now with the bar closed and a cell selected, clears the selection as before.
    fireEvent.keyDown(again, { code: 'Escape', bubbles: true, cancelable: true });
    expect(findBar()).not.toBeInTheDocument();
    act(() => {
      chord({ code: 'Escape' });
    });
    await waitFor(() => {
      expect(screen.queryByLabelText('Address B6')).not.toBeInTheDocument();
    });
  });
});
