// FAKE, labelled: jsdom has no ClipboardEvent with data, so the native events
// below carry a hand-made `clipboardData` store; `navigator.clipboard` is a
// spy pair. The document, the grid commands and the marks are real.
import { act, render } from '@testing-library/react';
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

  it('KEYS-03 ⌘C copies the cell as text plus its marks; ⌘V into another cell restores the marks; ⌥⇧⌘V pastes plain text', async () => {
    const { rerender } = render(<Harness cell={0} />);
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

    // Paste and match style: the async API, text only.
    const readText = vi.fn(() => Promise.resolve('Plain'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText, writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    });
    await act(async () => {
      await handle.current!.pasteMatchStyle();
    });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(cellText(table, rows[1]!, cols[0]!)).toBe('Plain');
    expect(cellRich(table, rows[1]!, cols[0]!).content[0]?.content?.[0]?.marks).toBeUndefined();
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
