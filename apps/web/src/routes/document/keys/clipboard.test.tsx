// FAKE, labelled: jsdom has no ClipboardEvent with data, so the native events
// below carry a hand-made `clipboardData` store; `navigator.clipboard` is a
// spy pair. The document, the grid commands and the marks are real.
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  cellRich,
  cellText,
  createSheet,
  createTable,
  docNode,
  openDocument,
  paragraphNode,
  setCellRich,
  setCellText,
  setColumnFormat,
  tableById,
  textNode,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import { useGrid } from '../grid/use-grid.js';
import { RICH_MIME, useCellClipboard, type CellClipboard } from './clipboard.js';

let gd: GedeDoc;
let tableId: Id;
let rows: readonly Id[];
let cols: readonly Id[];

class FakeClipboardData {
  private readonly store = new Map<string, string>();
  setData(type: string, value: string) {
    this.store.set(type, value);
  }
  getData(type: string): string {
    return this.store.get(type) ?? '';
  }
}

function clipboardEvent(type: 'copy' | 'cut' | 'paste', data: FakeClipboardData): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  return event;
}

const handle: { current: CellClipboard | null } = { current: null };

function Harness({ cell, editable = true }: { cell: 0 | 1 | null; editable?: boolean }) {
  const grid = useGrid(gd, editable);
  const selected = cell === null ? null : { tableId, rowId: rows[cell]!, colId: cols[0]! };
  handle.current = useCellClipboard({
    gd,
    cell: selected,
    editing: false,
    editable,
    locale: 'en-US',
    commands: grid.commands,
    addressOf: () => 'B5',
  });
  return <LiveRegion />;
}

describe('cell clipboard (KEYS-03, MENU-04)', () => {
  beforeEach(() => {
    gd = openDocument(new Y.Doc());
    const sheetId = createSheet(gd);
    tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 2 });
    const record = tableById(gd, tableId)!;
    rows = record.rows;
    cols = record.columns.map((c) => c.id);
    setCellRich(
      gd,
      tableId,
      rows[0]!,
      cols[0]!,
      docNode([paragraphNode([textNode('Base ', [{ type: 'bold' }]), textNode('camp')])]),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('KEYS-03 ⌘C copies the cell as text plus its marks; ⌘V into another cell restores the marks; ⌥⇧⌘V pastes plain text — all through the browser’s own events, never the permission-gated API', () => {
    const { rerender } = render(<Harness cell={0} />);
    // ADR-028: the chords are not claimed, so the browser runs its own command, which is
    // what raises the native event. Nothing here may touch `navigator.clipboard`.
    const read = vi.fn(() => Promise.reject(new Error('must not be called')));
    const readText = vi.fn(() => Promise.reject(new Error('must not be called')));
    Object.defineProperty(navigator, 'clipboard', {
      value: { read, readText, writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
    const data = new FakeClipboardData();
    const copy = clipboardEvent('copy', data);
    act(() => {
      document.dispatchEvent(copy);
    });
    expect(copy.defaultPrevented).toBe(true);
    expect(data.getData('text/plain')).toBe('Base camp');
    expect(JSON.parse(data.getData(RICH_MIME))).toMatchObject({ type: 'doc' });

    rerender(<Harness cell={1} />);
    act(() => {
      document.dispatchEvent(clipboardEvent('paste', data));
    });
    const table = gd.tables.get(tableId)!;
    expect(cellText(table, rows[1]!, cols[0]!)).toBe('Base camp');
    expect(cellRich(table, rows[1]!, cols[0]!).content[0]?.content?.[0]?.marks).toEqual([
      { type: 'bold' },
    ]);

    // ⌥⇧⌘V arms match-style; the browser's paste for the chord (Chromium, WebKit)
    // arrives in the same task and is taken as text only.
    act(() => {
      handle.current!.armMatchStyle();
      document.dispatchEvent(clipboardEvent('paste', data));
    });
    expect(cellText(table, rows[1]!, cols[0]!)).toBe('Base camp');
    expect(cellRich(table, rows[1]!, cols[0]!).content[0]?.content?.[0]?.marks).toBeUndefined();
    expect(screen.getByTestId('live-region')).toHaveTextContent('Pasted plain text into B5');
    expect(read).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    // The flag is consumed: the next plain paste restores marks again.
    act(() => {
      document.dispatchEvent(clipboardEvent('paste', data));
    });
    expect(cellRich(table, rows[1]!, cols[0]!).content[0]?.content?.[0]?.marks).toEqual([
      { type: 'bold' },
    ]);
  });

  it('KEYS-03 ⌥⇧⌘V on an engine that raises no paste for the chord falls back to readText once the task ends', async () => {
    render(<Harness cell={1} />);
    const readText = vi.fn(() => Promise.resolve('Plain'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText, writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
    act(() => {
      handle.current!.armMatchStyle();
    });
    expect(readText).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
    expect(readText).toHaveBeenCalledTimes(1);
    const table = gd.tables.get(tableId)!;
    expect(cellText(table, rows[1]!, cols[0]!)).toBe('Plain');
  });

  it('KEYS-03 ⌘X copies then clears; the native event is left alone with no cell or in a text field, and cut is refused view-only', () => {
    const { rerender } = render(<Harness cell={0} />);
    const data = new FakeClipboardData();
    act(() => {
      document.dispatchEvent(clipboardEvent('cut', data));
    });
    const table = gd.tables.get(tableId)!;
    expect(data.getData('text/plain')).toBe('Base camp');
    expect(cellText(table, rows[0]!, cols[0]!)).toBe('');

    setCellText(gd, tableId, rows[0]!, cols[0]!, 'Again');
    rerender(<Harness cell={null} />);
    const idle = clipboardEvent('copy', new FakeClipboardData());
    act(() => {
      document.dispatchEvent(idle);
    });
    expect(idle.defaultPrevented).toBe(false);

    rerender(<Harness cell={0} />);
    const input = document.body.appendChild(document.createElement('input'));
    const inField = clipboardEvent('copy', new FakeClipboardData());
    act(() => {
      input.dispatchEvent(inField);
    });
    expect(inField.defaultPrevented).toBe(false);
    input.remove();

    rerender(<Harness cell={0} editable={false} />);
    const viewOnly = clipboardEvent('cut', new FakeClipboardData());
    act(() => {
      document.dispatchEvent(viewOnly);
    });
    expect(cellText(table, rows[0]!, cols[0]!)).toBe('Again');
    expect(handle.current!.reason('cut')).toBe('you have view-only access');
    expect(handle.current!.reason('copy')).toBeUndefined();
  });

  it('GRID-04 MENU-04 a paste into a read-only cell is refused with the reason and never announced as pasted', async () => {
    // Column 1 of the fixture becomes derived, so its cells are read-only (GRID-04).
    const table = gd.tables.get(tableId)!;
    const columns = table.get('columns') as Y.Array<Y.Map<unknown>>;
    columns.get(0).set('source', 'derived');
    render(<Harness cell={1} />);
    const live = () => document.querySelector('[data-testid="live-region"]');
    // Native route.
    const data = new FakeClipboardData();
    data.setData('text/plain', 'Nope');
    act(() => {
      document.dispatchEvent(clipboardEvent('paste', data));
    });
    expect(cellText(table, rows[1]!, cols[0]!)).toBe('');
    expect(live()).toHaveTextContent(/is read-only: derived/);
    expect(live()).not.toHaveTextContent('Pasted');
    // Async route (chords and menu).
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn(() => Promise.resolve('Nope')), writeText: vi.fn() },
      configurable: true,
    });
    await act(async () => {
      await handle.current!.paste();
      await handle.current!.pasteMatchStyle();
    });
    expect(cellText(table, rows[1]!, cols[0]!)).toBe('');
    expect(live()).not.toHaveTextContent('Pasted');
  });

  it('MENU-04 the menu commands use the async clipboard: copy writes the source, copy snapshot the displayed value, and say when none is available', async () => {
    setColumnFormat(gd, tableId, cols[0]!, 'number', { decimals: 2 });
    setCellText(gd, tableId, rows[0]!, cols[0]!, '1234.5');
    render(<Harness cell={0} />);
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText: vi.fn(() => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    await act(async () => {
      await handle.current!.copy();
      await handle.current!.copySnapshot();
    });
    expect(writeText.mock.calls.map((c) => c[0])).toEqual(['1234.5', '1,234.50']);
    await act(async () => {
      await handle.current!.paste();
    });
    expect(document.querySelector('[data-testid="live-region"]')).toHaveTextContent(
      'The clipboard is not available here',
    );
  });
});

describe('column clipboard (MENU-03, REF-05, #123)', () => {
  beforeEach(() => {
    gd = openDocument(new Y.Doc());
    const sheetId = createSheet(gd);
    tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 3 });
    const record = tableById(gd, tableId)!;
    rows = record.rows;
    cols = record.columns.map((c) => c.id);
    setCellRich(
      gd,
      tableId,
      rows[0]!,
      cols[0]!,
      docNode([paragraphNode([textNode('Base ', [{ type: 'bold' }]), textNode('camp')])]),
    );
    setCellText(gd, tableId, rows[1]!, cols[0]!, 'Lukla');
    setCellText(gd, tableId, rows[2]!, cols[0]!, 'Namche');
    setCellText(gd, tableId, rows[0]!, cols[1]!, 'other');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('MENU-03 Cut column copies every cell of the right-clicked column, one line per row, and clears the column in one undo step — the selected cell in another column is untouched', async () => {
    render(<Harness cell={0} />);
    const undo = new Y.UndoManager(gd.tables, { trackedOrigins: new Set([gd.origin]) });
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText: vi.fn(() => Promise.resolve('')) },
      configurable: true,
    });
    const table = gd.tables.get(tableId)!;
    await act(async () => {
      await handle.current!.column.cut({ tableId, colId: cols[0]! });
    });
    expect(writeText).toHaveBeenCalledWith('Base camp\nLukla\nNamche');
    expect(rows.map((r) => cellText(table, r, cols[0]!))).toEqual(['', '', '']);
    expect(cellText(table, rows[0]!, cols[1]!)).toBe('other');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Cleared column Column 1: 3 cells');
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(rows.map((r) => cellText(table, r, cols[0]!))).toEqual(['Base camp', 'Lukla', 'Namche']);
  });

  it('MENU-03 Paste into column fills rows top to bottom from the clipboard lines, and one value fills every row', async () => {
    render(<Harness cell={null} />);
    const table = gd.tables.get(tableId)!;
    const readText = vi.fn(() => Promise.resolve('One\nTwo'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText, writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
    await act(async () => {
      await handle.current!.column.paste({ tableId, colId: cols[1]! });
    });
    expect(rows.map((r) => cellText(table, r, cols[1]!))).toEqual(['One', 'Two', '']);
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'Pasted into column Column 2: 2 cells',
    );
    readText.mockResolvedValue('Same');
    await act(async () => {
      await handle.current!.column.pasteMatchStyle({ tableId, colId: cols[1]! });
    });
    expect(rows.map((r) => cellText(table, r, cols[1]!))).toEqual(['Same', 'Same', 'Same']);
  });

  it('REF-05 a derived column refuses Cut, Paste and Clear with the reason; Copy gives what the column shows', async () => {
    const table = gd.tables.get(tableId)!;
    const columns = table.get('columns') as Y.Array<Y.Map<unknown>>;
    columns.get(0).set('source', 'derived');
    render(<Harness cell={null} />);
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, readText: vi.fn(() => Promise.resolve('x')) },
      configurable: true,
    });
    const scope = { tableId, colId: cols[0]! };
    expect(handle.current!.column.reason(scope, 'cut')).toBe('derived columns are read-only');
    expect(handle.current!.column.reason(scope, 'paste')).toBe('derived columns are read-only');
    expect(handle.current!.column.reason(scope, 'copy')).toBeUndefined();
    act(() => {
      handle.current!.column.clear(scope);
    });
    await act(async () => {
      await handle.current!.column.paste(scope);
    });
    // The guard holds in the commands too, not only in the menu's reason.
    expect(rows.map((r) => cellText(table, r, cols[0]!))).toEqual(['Base camp', 'Lukla', 'Namche']);
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'Column Column 1 is read-only: derived column',
    );
    await act(async () => {
      await handle.current!.column.copy(scope);
    });
    // No engine in jsdom: a derived cell shows nothing yet, and nothing is invented.
    expect(writeText).toHaveBeenCalledWith('\n\n');
  });
});
