/**
 * The shell's sheet commands (ADR-048, #165): delete with its announcement,
 * toast and undo; ⌫ ownership; the neighbour rule for this replica and for
 * a collaborator's deletion; rename as one undo step.
 *
 * FAKES, all labelled: `fake-indexeddb` stands in for the browser's
 * IndexedDB; `FakeRoom` speaks the real y-websocket wire format in memory;
 * the REST documents API is replaced with vi.fn() returning the server's
 * real shape.
 */
import 'fake-indexeddb/auto';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import { listSheets, openDocument, toPresenceState, type GedeDoc } from '@gede/core';

import type * as DocumentsApi from '../../api/documents.js';
import { setDocumentSeamsForTests } from '../../doc/use-document.js';
import { FakeRoom, until } from '../../test/fake-websocket.js';
import { installMatchMedia } from '../../test/match-media.js';
import { renderRoutes, withConfig } from '../../test/helpers.js';
import { routes } from '../../routes.js';

const user = { sub: 'sub-1', email: 'meena@1cloudhub.com', name: 'Meena' };

vi.mock('../../auth/cognito.js', () => ({
  isPasskeySupported: () => true,
  accessToken: () => Promise.resolve('tok'),
  refreshAccessToken: () => Promise.resolve('fresh'),
  currentUser: () => Promise.resolve(user),
  onAuthEvent: () => () => undefined,
  signOutLocal: vi.fn(() => Promise.resolve()),
  classifyError: () => ({ kind: 'other', message: 'x' }),
}));

vi.mock('../../api/documents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentsApi>();
  return { ...actual, getDocument: vi.fn(), renameDocument: vi.fn(() => Promise.resolve()) };
});

const docs = await import('../../api/documents.js');
const ID = '6f1b2c3d-0000-4000-8000-00000000abce';
const record = {
  id: ID,
  title: 'Everest trek',
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:00:00Z',
  ownerId: 'sub-1',
  permission: 'owner' as const,
  sharedWithOthers: true,
};

let room: FakeRoom;
let storeSeq = 0;
function roomDoc(): GedeDoc['doc'] {
  return room.doc;
}

async function openShell() {
  renderRoutes(routes, [`/d/${ID}`]);
  await waitFor(() => {
    expect(screen.getByTestId('plane')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: /Sheet 1/ })).toBeInTheDocument();
  });
}

async function addTable() {
  await userEvent.click(screen.getByRole('button', { name: 'Add table' }));
  await waitFor(() => {
    expect(screen.getAllByRole('grid').length).toBeGreaterThan(0);
  });
  return screen.getAllByRole('grid')[0]!;
}

/** The strip's + then a table on the new sheet: "2° Sheet 2 1". */
async function addSheetWithTable() {
  await userEvent.click(screen.getByRole('button', { name: 'Add sheet' }));
  await screen.findByRole('tab', { name: /2°.*Sheet 2/ });
  await addTable();
  await until(() => roomDoc().getArray('sheets').length === 2);
  await until(() => roomDoc().getMap('tables').size === 1);
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });
const sheetTabs = () => within(screen.getByRole('tablist', { name: 'Sheets' })).getAllByRole('tab');
const live = () => screen.getByTestId('live-region');
const layerTransform = () => screen.getByTestId('layer').style.transform;

async function openSheetMenu(element: HTMLElement): Promise<HTMLElement> {
  act(() => {
    element.focus();
  });
  fireEvent.keyDown(element, { code: 'F10', shiftKey: true });
  return await screen.findByRole('menu', { name: 'Sheet menu' });
}

describe('DocumentShell sheets (ADR-048)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia((q) => q.includes('min-width: 1200'));
    // Chords use ⌘ on Apple platforms; jsdom's UA says "darwin", not "Macintosh".
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) jsdom');
    room = new FakeRoom();
    const store = `shell-sheets-store-${String(++storeSeq)}`;
    setDocumentSeamsForTests({ WebSocketImpl: room.WebSocket, storeName: () => store });
    vi.mocked(docs.getDocument).mockResolvedValue(record);
  });
  afterEach(() => {
    setDocumentSeamsForTests(null);
    vi.restoreAllMocks();
  });

  it('DOC-03 MENU-01 A11Y-05 LIB-D9 Delete sheet from the tab menu removes the active sheet with its table in one step: the neighbour shows, the announcement names what went and the chord, a toast offers Undo, focus is on the tab now active; Undo brings it back and shows it', async () => {
    await openShell();
    await addSheetWithTable();
    const menu = await openSheetMenu(tab(/2°.*Sheet 2/));
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Delete sheet/ }));
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /Sheet 2/ })).not.toBeInTheDocument();
    });
    expect(live()).toHaveTextContent(
      'Deleted Sheet 2 with 1 table — press ⌘Z to undo. Now on Sheet 1',
    );
    expect(sheetTabs()).toHaveLength(1);
    expect(tab(/1°.*Sheet 1/)).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(tab(/1°.*Sheet 1/)).toHaveFocus();
    });
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    await until(() => roomDoc().getArray('sheets').length === 1);
    expect(roomDoc().getMap('tables').size).toBe(0);
    // LIB-D9 / ADR-031: no dialog; the toast with Undo is the safety.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo.closest('.gd-toast')).toHaveTextContent('Deleted Sheet 2 with 1 table');
    await userEvent.click(undo);
    const back = await screen.findByRole('tab', { name: /2°.*Sheet 2.*1 object/ });
    expect(back).toHaveAttribute('aria-selected', 'true');
    expect(live()).toHaveTextContent('Restored Sheet 2');
    expect(screen.getByRole('grid')).toBeInTheDocument();
    await until(() => roomDoc().getArray('sheets').length === 2);
    expect(roomDoc().getMap('tables').size).toBe(1);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });
  });

  it('KEYS-03 KEYS-08 ⌫ on a focused sheet tab deletes that sheet — never the table selected on the canvas (#165) — and ⌫ on the strip’s + touches nothing; ⌘Z restores the sheet and shows it', async () => {
    await openShell();
    const grid = await addTable();
    await until(() => roomDoc().getMap('tables').size === 1);
    await userEvent.click(within(grid).getAllByRole('gridcell')[0]!);
    expect(screen.getByTestId('selected-table')).toHaveTextContent('Table 1');
    // A second sheet, then back to the first with its table still selected.
    await userEvent.click(screen.getByRole('button', { name: 'Add sheet' }));
    await screen.findByRole('tab', { name: /2°.*Sheet 2/ });
    await userEvent.click(tab(/1°.*Sheet 1/));
    await userEvent.click(within(screen.getByRole('grid')).getAllByRole('gridcell')[0]!);
    expect(screen.getByTestId('selected-table')).toHaveTextContent('Table 1');
    // Backspace with focus on + in the strip: the table is neither deleted nor cleared.
    const plus = screen.getByRole('button', { name: 'Add sheet' });
    act(() => {
      plus.focus();
    });
    fireEvent.keyDown(plus, { code: 'Backspace' });
    expect(screen.getByRole('grid')).toBeInTheDocument();
    expect(roomDoc().getMap('tables').size).toBe(1);
    // Delete with focus on the active tab: the sheet goes, with its table, as the sheet's own command.
    const first = tab(/1°.*Sheet 1/);
    act(() => {
      first.focus();
    });
    fireEvent.keyDown(first, { code: 'Delete' });
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /Sheet 1/ })).not.toBeInTheDocument();
    });
    expect(live()).toHaveTextContent(
      'Deleted Sheet 1 with 1 table — press ⌘Z to undo. Now on Sheet 1, Sheet 2',
    );
    // Ordinals renumber; labels are names and stay (DOC-03).
    const remaining = tab(/1°.*Sheet 2/);
    expect(remaining).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => {
      expect(remaining).toHaveFocus();
    });
    expect(screen.queryByTestId('selected-table')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { code: 'KeyZ', metaKey: true });
    const back = await screen.findByRole('tab', { name: /1°.*Sheet 1.*1 object/ });
    expect(back).toHaveAttribute('aria-selected', 'true');
    expect(live()).toHaveTextContent('Restored Sheet 1');
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });

  it('MENU-02 A11Y-05 the last sheet stays: ⌫ on its tab announces why, and the menu’s Delete sheet is disabled with the reason', async () => {
    await openShell();
    const only = tab(/1°.*Sheet 1/);
    act(() => {
      only.focus();
    });
    fireEvent.keyDown(only, { code: 'Delete' });
    expect(live()).toHaveTextContent('A workscape keeps at least one sheet');
    expect(sheetTabs()).toHaveLength(1);
    const menu = await openSheetMenu(tab(/1°.*Sheet 1/));
    const del = within(menu).getByRole('menuitem', { name: /Delete sheet/ });
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveAttribute('title', 'a workscape keeps at least one sheet');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('LIB-D9 the toast’s Undo goes once a later local edit is the latest step, so it never undoes something else', async () => {
    await openShell();
    await userEvent.click(screen.getByRole('button', { name: 'Add sheet' }));
    await screen.findByRole('tab', { name: /2°.*Sheet 2/ });
    const second = tab(/2°.*Sheet 2/);
    act(() => {
      second.focus();
    });
    fireEvent.keyDown(second, { code: 'Delete' });
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument();
    // A later local step: a table added.
    await addTable();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });
    expect(sheetTabs()).toHaveLength(1);
  });

  it('SHARE-04 A11Y-05 a collaborator deletes the sheet this replica shows: the neighbour is shown and said, selection and viewport reset, focus lands on the tab, presence follows; this replica’s own ⌘Z does not bring it back', async () => {
    await openShell();
    await addSheetWithTable();
    const grid = screen.getByRole('grid');
    await userEvent.click(within(grid).getAllByRole('gridcell')[0]!);
    expect(screen.getByTestId('selected-table')).toHaveTextContent('Table 1');
    fireEvent.wheel(screen.getByTestId('plane'), { deltaX: 100, deltaY: 50 });
    expect(layerTransform()).toContain('translate(-100px, -50px)');
    const other = openDocument(roomDoc());
    const sheet2 = listSheets(other)[1]!;
    await until(() =>
      Array.from(room.awareness.getStates().values()).some(
        (s) => toPresenceState(s)?.sheetId === sheet2.id,
      ),
    );
    // The other participant renames Sheet 2: the tab re-labels live (ADR-048 §7).
    room.edit((d) => {
      (d.getArray('sheets').get(1) as Y.Map<unknown>).set('label', 'Budget');
    });
    await screen.findByRole('tab', { name: /2°.*Budget.*1 object/ });
    // Then deletes it with its table, as their client would.
    room.edit((d) => {
      const tables = d.getMap('tables');
      for (const key of Array.from(tables.keys())) tables.delete(key);
      d.getArray('sheets').delete(1, 1);
    });
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: /Budget/ })).not.toBeInTheDocument();
    });
    expect(live()).toHaveTextContent('Budget was deleted — now on Sheet 1');
    expect(tab(/1°.*Sheet 1/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('selected-table')).not.toBeInTheDocument();
    expect(layerTransform()).toContain('translate(0px, 0px)');
    await waitFor(() => {
      expect(tab(/1°.*Sheet 1/)).toHaveFocus();
    });
    const sheet1 = listSheets(other)[0]!;
    await until(() =>
      Array.from(room.awareness.getStates().values()).some(
        (s) => toPresenceState(s)?.sheetId === sheet1.id,
      ),
    );
    // KEYS-03: the undo manager tracks the local origin only.
    fireEvent.keyDown(window, { code: 'KeyZ', metaKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('tab', { name: /Budget/ })).not.toBeInTheDocument();
    expect(roomDoc().getArray('sheets').length).toBe(1);
  });

  it('DOC-03 A11Y-05 KEYS-03 F2 renames the focused tab inline; the commit is announced and is one undo step; the room and the strip carry the new name', async () => {
    await openShell();
    await userEvent.click(screen.getByRole('button', { name: 'Add sheet' }));
    const second = await screen.findByRole('tab', { name: /2°.*Sheet 2/ });
    act(() => {
      second.focus();
    });
    fireEvent.keyDown(second, { code: 'F2' });
    const field = await screen.findByRole('textbox', { name: 'Sheet name' });
    expect(field.closest('[role="tab"]')).toBeNull();
    fireEvent.change(field, { target: { value: ' Budget ' } });
    fireEvent.keyDown(field, { code: 'Enter' });
    const renamed = await screen.findByRole('tab', { name: /2°.*Budget.*0 objects/ });
    expect(live()).toHaveTextContent('Renamed Sheet 2 to Budget');
    await waitFor(() => {
      expect(renamed).toHaveFocus();
    });
    await until(() => listSheets(openDocument(roomDoc()))[1]?.label === 'Budget');
    fireEvent.keyDown(window, { code: 'KeyZ', metaKey: true });
    expect(await screen.findByRole('tab', { name: /2°.*Sheet 2/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { code: 'KeyZ', metaKey: true, shiftKey: true });
    expect(await screen.findByRole('tab', { name: /2°.*Budget/ })).toBeInTheDocument();
  });
});
