// FAKES, all labelled: `fake-indexeddb` stands in for the browser's IndexedDB;
// `FakeRoom` speaks the real y-websocket wire format in memory; the REST
// documents API is replaced with vi.fn() returning the server's real shape.
import 'fake-indexeddb/auto';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import { createSheet, LATTICE, openDocument, tableById, type GedeDoc } from '@gede/core';
import type * as DocumentsApi from '../../api/documents.js';
import { setDocumentSeamsForTests } from '../../doc/use-document.js';
import { TIER_MESO_MIN } from '../../doc/viewport.js';
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
const cognito = await import('../../auth/cognito.js');
const ID = '6f1b2c3d-0000-4000-8000-00000000abcd';
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
/** The room's replica: what the client wrote is what the room holds. */
function roomDoc(): GedeDoc['doc'] {
  return room.doc;
}

async function openShell(path = `/d/${ID}`) {
  const view = renderRoutes(routes, [path]);
  await waitFor(() => {
    expect(screen.getByTestId('plane')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: /Sheet 1/ })).toBeInTheDocument();
  });
  return view;
}

/** Type into the rich editor by mutating the contenteditable; ProseMirror reads it on a microtask. */
async function typeInto(editor: HTMLElement, text: string): Promise<void> {
  const paragraphs = editor.querySelectorAll('p');
  const p = paragraphs[paragraphs.length - 1] ?? editor;
  const last = p.lastChild;
  let node: Node;
  if (last !== null && last.nodeType === Node.TEXT_NODE) {
    last.textContent = `${last.textContent ?? ''}${text}`;
    node = last;
  } else {
    if (last !== null && last.nodeName === 'BR') last.remove();
    node = p.appendChild(document.createTextNode(text));
  }
  // The caret follows the typed text, as it does in a browser.
  document.getSelection()?.collapse(node, node.textContent?.length ?? 0);
  await act(async () => {
    await Promise.resolve();
  });
}

function layerTransform(): string {
  return screen.getByTestId('layer').style.transform;
}

async function addTable() {
  await userEvent.click(screen.getByRole('button', { name: 'Add table' }));
  await waitFor(() => {
    expect(screen.getAllByRole('grid').length).toBeGreaterThan(0);
  });
  return screen.getAllByRole('grid')[0]!;
}

describe('DocumentShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia((q) => q.includes('min-width: 1200'));
    // Chords use ⌘ on Apple platforms; jsdom's UA says "darwin", not "Macintosh".
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) jsdom');
    room = new FakeRoom();
    const store = `shell-store-${String(++storeSeq)}`;
    setDocumentSeamsForTests({ WebSocketImpl: room.WebSocket, storeName: () => store });
    vi.mocked(docs.getDocument).mockResolvedValue(record);
  });
  afterEach(() => {
    setDocumentSeamsForTests(null);
    vi.restoreAllMocks();
  });

  it('DOC-01 chrome: mark to library, title bound to the document, Shared, sync status; the first sheet is seeded once', async () => {
    await openShell();
    expect(screen.getByRole('link', { name: 'Back to my workscapes' })).toHaveAttribute(
      'href',
      '/',
    );
    const title = screen.getByLabelText('Workscape title');
    await waitFor(() => {
      expect(title).toHaveValue('Everest trek');
    });
    expect(screen.getByText('Shared')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('sync-status')).toHaveTextContent('Synced');
    });
    await until(() => roomDoc().getArray('sheets').length === 1);
    expect(roomDoc().getMap('meta').get('title')).toBe('Everest trek');
    expect(sessionStorage.getItem('gede.lastDocument')).toContain('Everest trek');
  });

  it('DOC-01 SHARE-05 typing the title updates meta.title in the room and PATCHes once the debounce settles (LOAD-04 aria-busy)', async () => {
    let resolveRename: () => void = () => undefined;
    vi.mocked(docs.renameDocument).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRename = resolve;
        }),
    );
    await openShell();
    const title = screen.getByLabelText('Workscape title');
    await waitFor(() => {
      expect(title).toHaveValue('Everest trek');
    });
    await userEvent.clear(title);
    await userEvent.type(title, 'Everest 2027');
    // The document is the state: the room sees every keystroke before any PATCH.
    await until(() => roomDoc().getMap('meta').get('title') === 'Everest 2027');
    expect(docs.renameDocument).not.toHaveBeenCalled();
    await waitFor(
      () => {
        expect(docs.renameDocument).toHaveBeenCalledWith(ID, 'Everest 2027');
      },
      { timeout: 2000 },
    );
    expect(screen.getByText('Saving…').closest('.gd-doc__title-wrap')).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await act(async () => {
      resolveRename();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByText('Saving…')).not.toBeInTheDocument();
    });
  });

  it('SHARE-05 SHARE-04 another participant in the room shows as an avatar in the Shared badge', async () => {
    room.awareness.setLocalState({
      userId: 'u-2',
      name: 'Sembian V',
      colour: 3,
      sheetId: null,
    });
    await openShell();
    await waitFor(() => {
      expect(screen.getByTitle('Sembian V')).toHaveTextContent('SV');
    });
    expect(screen.getByLabelText('Shared · Sembian V is here')).toBeInTheDocument();
  });

  it('DOC-02 toolbar clusters: working commands work, unimplemented ones are present but disabled with a reason; aria-keyshortcuts carry key tokens', async () => {
    await openShell();
    const toolbar = screen.getByRole('toolbar', { name: 'Document tools' });
    for (const name of ['Insert', 'Arrange', 'Data', 'View', 'Inspectors']) {
      expect(within(toolbar).getByRole('group', { name })).toBeInTheDocument();
    }
    const graph = screen.getByRole('button', { name: 'Add graph' });
    expect(graph).toHaveAttribute('aria-disabled', 'true');
    expect(graph.title).toMatch(/Wave 2/);
    expect(graph).not.toBeDisabled(); // reachable, so the reason is available on hover and focus
    const addRow = screen.getByRole('button', { name: 'Add row' });
    expect(addRow).toHaveAttribute('aria-disabled', 'true');
    expect(addRow.title).toMatch(/select a table first/);
    // Every command shows its shortcut beside it (KEYS-08).
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Meta+Equal',
    );
    expect(screen.getByRole('button', { name: 'Zoom in' }).title).toBe('Zoom in (⌘+)');
    expect(screen.getByRole('button', { name: 'Fit to canvas' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Shift+Meta+0',
    );

    const grid = await addTable();
    expect(screen.getByRole('button', { name: 'Add row' })).not.toHaveAttribute('aria-disabled');
    expect(within(grid).getAllByRole('row')).toHaveLength(6); // header + 5
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(within(grid).getAllByRole('row')).toHaveLength(7);
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(4);

    const gridlines = screen.getByRole('button', { name: 'Gridlines' });
    expect(gridlines).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(gridlines);
    expect(gridlines).toHaveAttribute('aria-pressed', 'false');

    const format = screen.getByRole('button', { name: 'Format inspector' });
    expect(format).toHaveAttribute('aria-pressed', 'true'); // wide screens start open
    await userEvent.click(format);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Organize inspector' }));
    expect(screen.getByRole('complementary', { name: 'Organize inspector' })).toBeInTheDocument();
  });

  it('DOC-03 sheet tabs carry ordinal, name and object count; + appends; selecting swaps contents, clears selection, resets to A1', async () => {
    await openShell();
    const grid = await addTable();
    const first = screen.getByRole('tab', { name: /1°.*Sheet 1/ });
    expect(within(first).getByLabelText('1 object')).toBeInTheDocument();
    await userEvent.click(within(grid).getAllByRole('gridcell')[0]!);
    expect(screen.getByTestId('selected-table')).toHaveTextContent('Table 1');
    fireEvent.wheel(screen.getByTestId('plane'), { deltaX: 100, deltaY: 50 });
    expect(layerTransform()).toContain('translate(-100px, -50px)');

    await userEvent.click(screen.getByRole('button', { name: 'Add sheet' }));
    const second = screen.getByRole('tab', { name: /2°.*Sheet 2/ });
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(within(second).getByLabelText('0 objects')).toBeInTheDocument();
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('selected-table')).not.toBeInTheDocument();
    expect(layerTransform()).toContain('translate(0px, 0px)');
    await until(() => roomDoc().getArray('sheets').length === 2);

    await userEvent.click(first);
    expect(screen.getByRole('grid')).toBeInTheDocument();
    // ⌃⇥ steps to the next sheet, ⌃⇧⇥ back (KEYS-07).
    fireEvent.keyDown(window, { code: 'Tab', ctrlKey: true });
    expect(screen.getByRole('tab', { name: /Sheet 2/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(window, { code: 'Tab', ctrlKey: true, shiftKey: true });
    expect(screen.getByRole('tab', { name: /Sheet 1/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('DOC-04 drag pans, pan clamps so A1 stays top-left, ⌥scroll zooms, the plane extends right and down', async () => {
    await openShell();
    const plane = screen.getByTestId('plane');
    fireEvent.pointerDown(plane, { pointerId: 1, button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(plane, { pointerId: 1, clientX: 200, clientY: 250 });
    fireEvent.pointerUp(plane, { pointerId: 1 });
    expect(layerTransform()).toContain('translate(-100px, -50px)');
    // Dragging back past the origin clamps at A1.
    fireEvent.pointerDown(plane, { pointerId: 2, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(plane, { pointerId: 2, clientX: 900, clientY: 900 });
    fireEvent.pointerUp(plane, { pointerId: 2 });
    expect(layerTransform()).toContain('translate(0px, 0px)');
    // Far right and down is allowed.
    fireEvent.wheel(plane, { deltaX: 100_000, deltaY: 100_000 });
    expect(layerTransform()).toContain('translate(-100000px, -100000px)');
    // ⌥scroll zooms.
    fireEvent.wheel(plane, { deltaY: -200, altKey: true, clientX: 0, clientY: 0 });
    expect(layerTransform()).toMatch(/scale\(1\.3/);
    // ⌘+ / ⌘− / ⌘0 (KEYS-07).
    fireEvent.keyDown(window, { code: 'Digit0', metaKey: true });
    expect(layerTransform()).toContain('scale(1)');
    fireEvent.keyDown(window, { code: 'Equal', metaKey: true });
    expect(layerTransform()).toContain('scale(1.22)');
    fireEvent.keyDown(window, { code: 'Minus', metaKey: true });
    expect(layerTransform()).toContain('scale(1)');
  });

  it('DOC-05 semantic zoom: micro renders rich cell text, macro renders block titles only with no cell layout', async () => {
    await openShell();
    const grid = await addTable();
    const cell = within(grid).getAllByRole('gridcell')[0]!;
    await userEvent.dblClick(cell);
    await userEvent.keyboard('Base camp{Enter}');
    expect(screen.getByText('Base camp')).toBeInTheDocument();
    expect(screen.getByTestId('plane').closest('.gd-canvas')).toHaveAttribute(
      'data-zoom-tier',
      'micro',
    );
    // ⌥scroll about A1 keeps the table in view while the tier changes.
    const plane = screen.getByTestId('plane');
    const tier = () => plane.closest('.gd-canvas')?.getAttribute('data-zoom-tier') ?? '';
    let guard = 0;
    while (tier() !== 'macro' && guard < 20) {
      fireEvent.wheel(plane, { deltaY: 400, altKey: true, clientX: 0, clientY: 0 });
      guard += 1;
    }
    expect(tier()).toBe('macro');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(screen.queryByText('Base camp')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('layer')).getByText('Table 1')).toBeInTheDocument();
    // Back to meso: structure without text.
    while (tier() !== 'meso' && guard < 40) {
      fireEvent.wheel(plane, { deltaY: -100, altKey: true, clientX: 0, clientY: 0 });
      guard += 1;
    }
    expect(tier()).toBe('meso');
    expect(screen.getByRole('grid')).toBeInTheDocument();
    expect(screen.queryByText('Base camp')).not.toBeInTheDocument();
    const zoom = Number(/scale\(([\d.]+)\)/.exec(layerTransform())?.[1]);
    expect(zoom).toBeGreaterThanOrEqual(TIER_MESO_MIN);
  });

  it('DOC-06 rulers: column letters along the top and row numbers down the left track pan and zoom; column headers show grid letters', async () => {
    await openShell();
    const cols = screen.getByTestId('ruler-columns');
    const rows = screen.getByTestId('ruler-rows');
    const a = within(cols).getByText('A');
    expect(a.style.left).toBe('0px');
    expect(a.style.width).toBe(`${String(LATTICE.col)}px`);
    expect(within(rows).getByText('1').style.height).toBe(`${String(LATTICE.row)}px`);
    fireEvent.wheel(screen.getByTestId('plane'), { deltaX: 160, deltaY: 44 });
    expect(within(cols).queryByText('A')).not.toBeInTheDocument();
    expect(within(cols).getByText('B').style.left).toBe('0px');
    expect(within(rows).getByText('3').style.top).toBe('0px');
    fireEvent.keyDown(window, { code: 'Digit0', metaKey: true });
    fireEvent.keyDown(window, { code: 'Minus', metaKey: true });
    expect(Number.parseFloat(within(cols).getByText('B').style.width)).toBeCloseTo(
      LATTICE.col / 1.22,
      6,
    );
    const grid = await addTable();
    const headers = within(grid).getAllByRole('columnheader');
    // The table was placed at column B (index 1): its headers carry B, C, D.
    expect(headers.map((h) => within(h).getByLabelText(/^Column [A-Z]+$/).textContent)).toEqual([
      'B',
      'C',
      'D',
    ]);
  });

  it('DOC-07 Fit frames every table on the sheet together', async () => {
    await openShell();
    await addTable();
    await addTable();
    await until(() => roomDoc().getMap('tables').size === 2);
    fireEvent.wheel(screen.getByTestId('plane'), { deltaX: 5000, deltaY: 5000 });
    await userEvent.click(screen.getByRole('button', { name: 'Fit to canvas' }));
    // Both tables start at column 1: x = 160 × zoom − 16 padding; zoom ≤ 1.
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(layerTransform());
    expect(m).not.toBeNull();
    const [, tx, ty, zoom] = m!.map(Number) as [number, number, number, number];
    expect(zoom).toBeLessThanOrEqual(1);
    // The layer translates by the negated viewport offset.
    expect(-tx).toBeCloseTo(LATTICE.col * zoom - 16, 3);
    expect(-ty).toBeCloseTo(LATTICE.row * zoom - 16, 3);
    expect(screen.getByTestId('live-region')).toHaveTextContent('Fitted to canvas');
  });

  it('GRID-01 a placed table sits on whole lattice units and its rows are 22 px', async () => {
    await openShell();
    const grid = await addTable();
    const table = grid.closest<HTMLElement>('.gd-table')!;
    expect(table.style.left).toBe(`${String(LATTICE.col)}px`);
    expect(table.style.top).toBe(`${String(LATTICE.row)}px`);
    expect(table.style.width).toBe(`${String(LATTICE.col * 3)}px`);
    const rows = within(grid).getAllByRole('row');
    expect(rows[1]!.style.height).toBe(`${String(LATTICE.row)}px`);
    // Double-clicking empty canvas places a table snapped to the lattice.
    const plane = screen.getByTestId('plane');
    fireEvent.doubleClick(plane, { clientX: 330, clientY: 500 });
    await waitFor(() => {
      expect(screen.getAllByRole('grid')).toHaveLength(2);
    });
    const second = screen.getAllByRole('grid')[1]!.closest<HTMLElement>('.gd-table')!;
    expect(Number.parseFloat(second.style.left) % LATTICE.col).toBe(0);
    expect(Number.parseFloat(second.style.top) % LATTICE.row).toBe(0);
  });

  it('GRID-02 (partial) GRID-03 INSP-03 single click arms a cell with the selection ring, the inspector head states the object and its A1 address, Escape clears', async () => {
    await openShell();
    const grid = await addTable();
    const cells = within(grid).getAllByRole('gridcell');
    await userEvent.click(cells[0]!);
    expect(cells[0]).toHaveAttribute('aria-selected', 'true');
    expect(cells[0]).toHaveClass('gd-cell--selected');
    const inspector = screen.getByRole('complementary', { name: 'Format inspector' });
    expect(within(inspector).getByText('Table 1')).toBeInTheDocument();
    // Table at B2 (col 1, row 1): title rows 2–3, header row 4, first data cell B5.
    expect(within(inspector).getByLabelText('Address B5')).toHaveTextContent('B5');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Selected B5 in Table 1');
    await userEvent.click(cells[4]!); // row 2, column 2
    expect(within(inspector).getByLabelText('Address C6')).toBeInTheDocument();
    fireEvent.keyDown(window, { code: 'Escape' });
    expect(cells[4]).not.toHaveAttribute('aria-selected');
    expect(within(inspector).getByText('Nothing selected')).toBeInTheDocument();
    expect(screen.getByTestId('live-region')).toHaveTextContent('Selection cleared');
  });

  it('GRID-07 the add-row strip and add-column stub appear for the selected table and each occupy one lattice unit', async () => {
    await openShell();
    const grid = await addTable();
    // A freshly added table is selected; clicking empty canvas clears it and the affordances go.
    expect(screen.getByTitle('Add a row beneath the last row (⌥⌘↓)')).toBeInTheDocument();
    const plane = screen.getByTestId('plane');
    fireEvent.pointerDown(plane, { pointerId: 9, button: 0, clientX: 700, clientY: 600 });
    fireEvent.pointerUp(plane, { pointerId: 9 });
    expect(screen.queryByTitle('Add a row beneath the last row (⌥⌘↓)')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Add a column at the right edge (⌥⌘→)')).not.toBeInTheDocument();
    await userEvent.click(within(grid).getAllByRole('gridcell')[0]!);
    const strip = screen.getByTitle('Add a row beneath the last row (⌥⌘↓)');
    const stub = screen.getByTitle('Add a column at the right edge (⌥⌘→)');
    expect(strip.style.height).toBe(`${String(LATTICE.row)}px`);
    expect(stub.style.width).toBe(`${String(LATTICE.col)}px`);
    expect(stub.style.height).toBe(`${String(LATTICE.row)}px`);
    expect(stub.style.left).toBe(`${String(LATTICE.col * 3)}px`);
    await userEvent.click(strip);
    expect(within(grid).getAllByRole('row')).toHaveLength(7);
    await userEvent.click(stub);
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(4);
  });

  it('LOAD-05 I18N-01 a cell edit renders immediately and reaches the room behind it; Enter commits, Escape cancels, nothing commits mid-composition', async () => {
    await openShell();
    const grid = await addTable();
    const cell = within(grid).getAllByRole('gridcell')[0]!;
    await userEvent.dblClick(cell);
    const editor = screen.getByLabelText('Edit B5');
    await userEvent.type(editor, 'Kathmandu');
    // An IME mid-composition Enter must not commit (GRID-06).
    fireEvent.keyDown(editor, { code: 'Enter', isComposing: true });
    expect(screen.getByLabelText('Edit B5')).toBeInTheDocument();
    fireEvent.keyDown(editor, { code: 'Enter' });
    expect(screen.queryByLabelText('Edit B5')).not.toBeInTheDocument();
    expect(cell).toHaveTextContent('Kathmandu');
    await until(() => JSON.stringify(roomDoc().getMap('tables').toJSON()).includes('Kathmandu'));
    await userEvent.dblClick(cell);
    await userEvent.type(screen.getByLabelText('Edit B5'), ' changed');
    fireEvent.keyDown(screen.getByLabelText('Edit B5'), { code: 'Escape' });
    expect(cell).toHaveTextContent('Kathmandu');
    expect(cell).not.toHaveTextContent('changed');
    // Delete clears (GRID-04 subset).
    fireEvent.keyDown(cell, { code: 'Delete' });
    expect(cell).toHaveTextContent('');
  });

  it('GRID-06 LOAD-05 selecting another cell while editing commits the draft instead of dropping it', async () => {
    await openShell();
    const grid = await addTable();
    const [first, second] = within(grid).getAllByRole('gridcell');
    await userEvent.dblClick(first!);
    await userEvent.type(screen.getByLabelText('Edit B5'), 'Base camp');
    // The pointerdown on another cell moves the selection before the browser blurs the editor.
    fireEvent.pointerDown(second!);
    await waitFor(() => {
      expect(screen.queryByLabelText('Edit B5')).not.toBeInTheDocument();
    });
    expect(first).toHaveTextContent('Base camp');
    await until(() => JSON.stringify(roomDoc().getMap('tables').toJSON()).includes('Base camp'));
  });

  it('LOAD-06 A11Y-05 going offline shows the local-save banner and announces; coming back clears it', async () => {
    await openShell();
    await waitFor(() => {
      expect(screen.getByTestId('sync-status')).toHaveTextContent('Synced');
    });
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('Work is saved on this device.')).toBeInTheDocument();
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'Offline. Work is saved on this device',
    );
    // Edits keep landing in the document while offline.
    await addTable();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(screen.queryByText('Work is saved on this device.')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Synced');
  });

  it('SHARE-03 a 4403 before first render is the catalogue 403 page, not a permanent skeleton', async () => {
    room.options = { refuseWith: { code: 4403, reason: 'not a participant' } };
    renderRoutes(routes, [`/d/${ID}`]);
    expect(
      await screen.findByRole('heading', { name: 'You do not have access to this workscape' }),
    ).toBeInTheDocument();
    expect(document.querySelector('.gd-skeleton')).toBeNull();
  });

  it('a 4404 before first render is the catalogue 404 page', async () => {
    room.options = { refuseWith: { code: 4404, reason: 'document deleted' } };
    renderRoutes(routes, [`/d/${ID}`]);
    expect(
      await screen.findByRole('heading', { name: 'Nothing at this address' }),
    ).toBeInTheDocument();
  });

  it('AUTH-09 a terminal 4401 before first render is the catalogue session page, path retained', async () => {
    room.options = { refuseWith: { code: 4401, reason: 'expired' } };
    renderRoutes(routes, [`/d/${ID}?cell=B5`]);
    expect(await screen.findByRole('heading', { name: 'Your session ended' })).toBeInTheDocument();
    // Both transports with the stale token, then both with a refreshed one, before it became terminal.
    expect(room.urls).toHaveLength(4);
    expect(room.tokens[2]).toBe('fresh');
    // The path is remembered synchronously on the click; the sign-in screen then takes it.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(sessionStorage.getItem('gede.returnTo')).toBe(`/d/${ID}?cell=B5`);
  });

  it('LOAD-05 SHARE-03 a terminal refusal after render surfaces one banner with Retry; editing goes on', async () => {
    await openShell();
    await addTable();
    room.options = { refuseWith: { code: 4403, reason: 'not a participant' } };
    act(() => {
      room.dropAll();
    });
    await waitFor(() => {
      expect(screen.getByText('Changes are not syncing.')).toBeInTheDocument();
    });
    expect(screen.getByText(/no longer have access/)).toBeInTheDocument();
    expect(screen.getByRole('grid')).toBeInTheDocument(); // the document stays on screen
    room.options = {};
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByText('Changes are not syncing.')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('sync-status')).toHaveTextContent('Synced');
    });
  });

  it('AUTH-09 a terminal 4401 after render shows the session banner; Sign in keeps the document path', async () => {
    const { router } = await openShell(`/d/${ID}?cell=B5`);
    room.options = { refuseWith: { code: 4401, reason: 'expired' } };
    act(() => {
      room.dropAll();
    });
    await waitFor(() => {
      expect(screen.getByText('Your session ended.')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(sessionStorage.getItem('gede.returnTo')).toBe(`/d/${ID}?cell=B5`);
    // The dead tokens are dropped before the sign-in screen (which, with this test's always-signed-in
    // session, bounces straight back to the retained path — the round trip AUTH-01 asks for).
    await waitFor(() => {
      expect(cognito.signOutLocal).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/d/${ID}`);
    });
  });

  it('SHARE-03 the server’s read-only notice removes edit affordances mid-session and says why', async () => {
    room.options = { viewOnly: true };
    await openShell();
    await waitFor(() => {
      expect(screen.getByText('Your access is now view-only.')).toBeInTheDocument();
    });
    const add = screen.getByRole('button', { name: 'Add table' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByLabelText('Workscape title')).not.toBeInTheDocument();
  });

  it('DOC-01 the record’s title shows at once and wins over a stale room title', async () => {
    const other = openDocument(roomDoc());
    createSheet(other);
    room.edit((d) => {
      d.getMap('meta').set('title', 'Stale room title');
    });
    await openShell();
    await waitFor(() => {
      expect(screen.getByLabelText('Workscape title')).toHaveValue('Everest trek');
    });
    await until(() => roomDoc().getMap('meta').get('title') === 'Everest trek');
  });

  it('A11Y-01 a keyboard user can Tab to a table’s first cell, arm it, and press Enter to edit', async () => {
    await openShell();
    const grid = await addTable();
    // Clear the selection the add left behind, then walk in with Tab.
    fireEvent.keyDown(window, { code: 'Escape' });
    const first = within(grid).getAllByRole('gridcell')[0]!;
    expect(first).toHaveAttribute('tabindex', '0');
    expect(within(grid).getAllByRole('gridcell')[1]).toHaveAttribute('tabindex', '-1');
    act(() => {
      first.focus();
    });
    expect(first).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(first, { code: 'Enter' });
    const editor = screen.getByLabelText('Edit B5');
    // The rich editor is a ProseMirror contenteditable drawn as the cell, not a textarea.
    expect(editor.getAttribute('contenteditable')).toBe('true');
    expect(editor).toHaveAttribute('role', 'textbox');
    await typeInto(editor, 'Line one');
    fireEvent.keyDown(editor, { code: 'Enter', key: 'Enter', shiftKey: true });
    await typeInto(editor, 'Line two');
    fireEvent.keyDown(editor, { code: 'Enter' });
    expect(first).toHaveTextContent('Line one');
    expect(first.getAttribute('aria-label')).toBe('B5, Line one\nLine two');
  });

  it('LOAD-01 LOAD-02 LOAD-03 while the document loads a content-shaped skeleton appears after 200 ms with 22 px lattice rows', async () => {
    vi.mocked(docs.getDocument).mockReturnValue(new Promise(() => undefined));
    renderRoutes(routes, [`/d/${ID}`]);
    expect(document.querySelector('.gd-skeleton')).toBeNull();
    await waitFor(
      () => {
        expect(document.querySelector('.gd-skeleton')).not.toBeNull();
      },
      { timeout: 1000 },
    );
    const skeleton = document.querySelector<HTMLElement>('.gd-skeleton')!;
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton.style.getPropertyValue('--gd-skeleton-row')).toBe(`${String(LATTICE.row)}px`);
    expect(skeleton.querySelectorAll('.gd-skeleton__bar')).toHaveLength(8);
  });

  it('RESP-02 below 768 px the document is read-only: no toolbar, no inspector, no edit affordance, bottom sheet bar, "View only on phone"', async () => {
    installMatchMedia((q) => q.includes('767.98') || q.includes('899.98'));
    await openShell();
    expect(screen.getByText('View only on phone')).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Workscape title')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Everest trek');
    expect(screen.queryByRole('button', { name: 'Add sheet' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Sheet 1/ }).closest('.gd-doc__sheets')).toHaveClass(
      'gd-doc__sheets--bottom',
    );
    fireEvent.keyDown(window, { code: 'KeyI', metaKey: true, altKey: true });
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('RESP-01 RESP-02 real content on phone keeps its lattice geometry and offers no editor, no strips', async () => {
    // Author a table at desktop width, then reopen the same replica on a phone.
    const first = await openShell();
    const grid = await addTable();
    const desktopGeometry = grid.closest<HTMLElement>('.gd-table')!.style.cssText;
    await until(() => roomDoc().getMap('tables').size === 1);
    // The replica stores only what arrives after it opened; wait for it before closing the tab.
    await waitFor(() => {
      expect(document.querySelector('.gd-doc')).toHaveAttribute('data-replica', 'ready');
    });
    first.unmount();
    installMatchMedia((q) => q.includes('767.98') || q.includes('899.98'));
    await openShell();
    await waitFor(() => {
      expect(screen.getByRole('grid')).toBeInTheDocument();
    });
    const phoneTable = screen.getByRole('grid').closest<HTMLElement>('.gd-table')!;
    expect(phoneTable.style.cssText).toBe(desktopGeometry);
    const cell = within(screen.getByRole('grid')).getAllByRole('gridcell')[0]!;
    await userEvent.click(cell);
    expect(cell).toHaveAttribute('aria-selected', 'true'); // selecting to view is allowed
    await userEvent.dblClick(cell);
    expect(screen.queryByLabelText(/^Edit /)).not.toBeInTheDocument();
    fireEvent.keyDown(cell, { code: 'Enter' });
    expect(screen.queryByLabelText(/^Edit /)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Add a row beneath the last row (⌥⌘↓)')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Add a column at the right edge (⌥⌘→)')).not.toBeInTheDocument();
  });

  it('SHARE-03 a view-only participant at desktop width sees the commands disabled with the reason and no editor', async () => {
    vi.mocked(docs.getDocument).mockResolvedValue({ ...record, permission: 'view' });
    await openShell();
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.queryByLabelText('Workscape title')).not.toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add table' });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add.title).toMatch(/view-only/);
    expect(screen.queryByRole('button', { name: 'Add sheet' })).not.toBeInTheDocument();
  });

  it('a 404 from the API renders the catalogue page', async () => {
    const { ApiError } = await import('../../api/client.js');
    vi.mocked(docs.getDocument).mockRejectedValue(new ApiError(404, 'x', undefined));
    renderRoutes(routes, [`/d/${ID}`]);
    expect(
      await screen.findByRole('heading', { name: 'Nothing at this address' }),
    ).toBeInTheDocument();
  });

  it('KEYS-07 ⌥⌘I toggles the inspector; ⌥⌘1 and ⌥⌘2 pick Format and Organize', async () => {
    await openShell();
    expect(screen.getByRole('complementary', { name: 'Format inspector' })).toBeInTheDocument();
    fireEvent.keyDown(window, { code: 'KeyI', metaKey: true, altKey: true });
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { code: 'Digit2', metaKey: true, altKey: true });
    expect(screen.getByRole('complementary', { name: 'Organize inspector' })).toBeInTheDocument();
    fireEvent.keyDown(window, { code: 'Digit1', metaKey: true, altKey: true });
    expect(screen.getByRole('complementary', { name: 'Format inspector' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse inspector' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('GRID-02 (partial: delete and hide are Wave 2) addresses recompute after a row is added above: the same cell reads one row lower', async () => {
    await openShell();
    const grid = await addTable();
    const cells = within(grid).getAllByRole('gridcell');
    await userEvent.click(cells[3]!); // row 2, column 1 → B6
    const inspector = screen.getByRole('complementary', { name: 'Format inspector' });
    expect(within(inspector).getByLabelText('Address B6')).toBeInTheDocument();
    // Another participant inserts a row at the top of the table: the address moves, the id does not.
    const other = openDocument(roomDoc());
    const tableId = Array.from(other.tables.keys())[0]!;
    expect(tableById(other, tableId)?.rows).toHaveLength(5);
    room.edit(() => {
      const rows = other.tables.get(tableId)?.get('rows') as Y.Array<string>;
      rows.insert(0, ['01ARZ3NDEKTSV4RRFFQ69G5FAV']);
    });
    await waitFor(() => {
      expect(within(inspector).getByLabelText('Address B7')).toBeInTheDocument();
    });
  });
});
