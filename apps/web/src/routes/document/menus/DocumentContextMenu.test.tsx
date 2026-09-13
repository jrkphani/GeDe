/**
 * Context menus (MENU-01..05) over a real table: `TableView` inside
 * `DocumentContextMenu`, driven by the same `useGrid` the shell uses. The
 * clipboard is a labelled fake (no `navigator.clipboard` in jsdom).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  LATTICE,
  openDocument,
  setCellText,
  spanAt,
  tableAddresses,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import { useYVersion } from '../../../doc/use-y.js';
import { useGrid, type Grid } from '../grid/use-grid.js';
import type { CellClipboard } from '../keys/clipboard.js';
import { TableView } from '../TableView.js';
import { DocumentContextMenu, resolveMenuTarget } from './DocumentContextMenu.js';
import { cellMenuEntries, columnMenuEntries, menuEntriesFor, type MenuContext } from './entries.js';

let gd: GedeDoc;
let tableId: Id;
const grid: { current: Grid | null } = { current: null };
const clipboard: CellClipboard = {
  copy: vi.fn(() => Promise.resolve()),
  copySnapshot: vi.fn(() => Promise.resolve()),
  cut: vi.fn(() => Promise.resolve()),
  paste: vi.fn(() => Promise.resolve()),
  pasteMatchStyle: vi.fn(() => Promise.resolve()),
  armMatchStyle: vi.fn(),
  reason: () => undefined,
  column: {
    copy: vi.fn(() => Promise.resolve()),
    copySnapshot: vi.fn(() => Promise.resolve()),
    cut: vi.fn(() => Promise.resolve()),
    paste: vi.fn(() => Promise.resolve()),
    pasteMatchStyle: vi.fn(() => Promise.resolve()),
    clear: vi.fn(),
    reason: () => undefined,
  },
};
const canvas = { addTable: vi.fn(), fit: vi.fn(), actualSize: vi.fn() };
const sheets = { add: vi.fn(), rename: vi.fn(), remove: vi.fn() };

function Harness({ editable = true, phone = false }: { editable?: boolean; phone?: boolean }) {
  const g = useGrid(gd, editable);
  grid.current = g;
  useYVersion(gd.tables, { depth: 'shallow' });
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  const context: MenuContext = {
    gd,
    editable,
    commands: g.commands,
    clipboard,
    selectedCell: g.cell,
    canvas,
    sheets,
    slots: undefined,
  };
  return (
    <DocumentContextMenu gd={gd} phone={phone} context={context} actions={g.actions}>
      <div className="gd-canvas__plane" data-testid="plane">
        <TableView
          table={map}
          tier="micro"
          selected={g.state.selection?.tableId === tableId}
          selectedCell={g.cell}
          editing={g.state.editing}
          editable={editable}
          presence={[]}
          pinnedLeft={null}
          actions={g.actions}
          commands={g.commands}
        />
      </div>
      <LiveRegion />
    </DocumentContextMenu>
  );
}

// Radix hides the page behind an open menu (`aria-hidden`), so cells are queried as hidden.
const cells = () => screen.getAllByRole('gridcell', { hidden: true });
const labels = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).map(
    (el) => el.querySelector('.gd-menu__label')?.textContent ?? '',
  );

describe('context menus', () => {
  beforeEach(async () => {
    // Radix returns focus from the previous test's unmounted menu on a zero timer; let it
    // run before this test mounts, or it lands on this test's cell and dismisses its menu.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
    gd = openDocument(new Y.Doc());
    const sheetId = createSheet(gd);
    tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 3 });
    const record = tableById(gd, tableId)!;
    setCellText(gd, tableId, record.rows[0]!, record.columns[0]!.id, 'Kathmandu');
  });

  it('MENU-04 MENU-01 right-click on a cell selects it and opens the cell menu in desktop order with separators between kinds', async () => {
    render(<Harness />);
    fireEvent.contextMenu(cells()[4]!, { clientX: 300, clientY: 80 });
    const menu = await screen.findByRole('menu', { name: 'Cell menu' });
    expect(cells()[4]).toHaveAttribute('aria-selected', 'true');
    expect(labels(menu)).toEqual([
      'Graph this table',
      'Freeze header row',
      'Freeze columns through Column 2',
      'Add row above',
      'Add row below',
      'Add column before',
      'Add column after',
      'Delete row',
      'Delete column',
      'Show sort options',
      'Quick filter…',
      'Show filter options',
      'Show category options',
      'Merge with cell to the right',
      'Merge with cell below',
      'Unmerge cells',
      'Cut',
      'Copy',
      'Copy snapshot',
      'Paste',
      'Paste and match style',
      'Clear all',
      'Select the table',
      'Wrap text',
    ]);
    expect(within(menu).getAllByRole('separator').length).toBeGreaterThanOrEqual(7);
    // KEYS-08: the shortcut sits beside its command.
    expect(screen.getByRole('menuitem', { name: /Add row below/ })).toHaveTextContent('⌥⌘↓');
    expect(screen.getByRole('menuitem', { name: /^Copy\s*⌘C$/ })).toHaveTextContent('⌘C');
  });

  it('MENU-02 unavailable commands are present, disabled, with the reason on hover — never hidden', async () => {
    render(<Harness />);
    fireEvent.contextMenu(cells()[0]!, { clientX: 10, clientY: 10 });
    await screen.findByRole('menu');
    const sort = screen.getByRole('menuitem', { name: 'Show sort options' });
    expect(sort).toHaveAttribute('aria-disabled', 'true');
    expect(sort).toHaveAttribute('title', 'arrives with the sort and filter release');
    expect(screen.getByRole('menuitem', { name: 'Graph this table' })).toHaveAttribute(
      'title',
      'arrives with #86 (context graphs)',
    );
    // MENU-02 / INSP-04: Fit width needs a text measurer; jsdom has none, so the item says so.
    fireEvent.contextMenu(screen.getAllByRole('columnheader')[1]!, { clientX: 200, clientY: 5 });
    const fit = await screen.findByRole('menuitem', { name: 'Fit width to content' });
    expect(fit).toHaveAttribute('aria-disabled', 'true');
    expect(fit).toHaveAttribute('title', 'text cannot be measured in this browser');
    await userEvent.keyboard('{Escape}');
    fireEvent.contextMenu(cells()[0]!, { clientX: 10, clientY: 10 });
    await screen.findByRole('menu');
    // MENU-04: a live limit reads as its own reason — the cell is not merged, so nothing to unmerge.
    const unmerge = screen.getByRole('menuitem', { name: 'Unmerge cells' });
    expect(unmerge).toHaveAttribute('aria-disabled', 'true');
    expect(unmerge).toHaveAttribute('title', 'the cell is not merged');
  });

  it('MENU-04 GRID-01 merge with the cell to the right and below spans from the cell; covered cells leave the grid but keep their addresses; unmerge brings them back', async () => {
    render(<Harness />);
    const table = tableMap(gd, tableId)!;
    const record = tableById(gd, tableId)!;
    const before = tableAddresses(table);
    const target = cells()[0]!;
    fireEvent.contextMenu(target, { clientX: 10, clientY: 10 });
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Merge with cell to the right' }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    fireEvent.contextMenu(cells()[0]!, { clientX: 10, clientY: 10 });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Merge with cell below' }));
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(spanAt(table, record.rows[0]!, record.columns[0]!.id)).toMatchObject({
      rows: 2,
      cols: 2,
    });
    expect(tableAddresses(table)).toEqual(before);
    // The anchor draws over two columns and two rows; the three covered cells are placeholders.
    const anchor = screen.getByRole('gridcell', { name: /^B5/ });
    expect(anchor).toHaveClass('gd-cell--span');
    expect(anchor.style.width).toBe(`${String(2 * LATTICE.col)}px`);
    expect(anchor.style.height).toBe(`${String(2 * LATTICE.row)}px`);
    expect(document.querySelectorAll('[data-covered="true"]')).toHaveLength(3);
    expect(screen.queryByRole('gridcell', { name: /^C5/ })).not.toBeInTheDocument();
    // Traversal skips the covered cells: right from the anchor lands on D5.
    anchor.focus();
    fireEvent.keyDown(anchor, { code: 'ArrowRight', key: 'ArrowRight' });
    expect(screen.getByRole('gridcell', { name: /^D5/ })).toHaveAttribute('aria-selected', 'true');
    // Unmerge from a menu on the anchor.
    fireEvent.contextMenu(screen.getByRole('gridcell', { name: /^B5/ }), {
      clientX: 10,
      clientY: 10,
    });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Unmerge cells' }));
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(spanAt(table, record.rows[0]!, record.columns[0]!.id)).toBeNull();
    expect(screen.getByRole('gridcell', { name: /^C5/ })).toBeInTheDocument();
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'unmerged; the cells it covered are back',
    );
  });

  it('MENU-04 MENU-05 the commands act on the right-clicked cell and the menu closes with focus back on it', async () => {
    render(<Harness />);
    const target = cells()[3]!; // row 2, column 1
    target.focus();
    fireEvent.contextMenu(target, { clientX: 10, clientY: 40 });
    await screen.findByRole('menu');
    await userEvent.click(screen.getByRole('menuitem', { name: /Add row above/ }));
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(screen.getAllByRole('row')).toHaveLength(5); // header + 4
    expect(screen.getByTestId('live-region')).toHaveTextContent('Inserted a row above');
    // Escape closes and focus returns to the cell that had it (MENU-05).
    const cell = cells()[0]!;
    cell.focus();
    fireEvent.contextMenu(cell, { clientX: 10, clientY: 10 });
    await screen.findByRole('menu');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(cell).toHaveFocus();
    // Clipboard commands go to the clipboard controller.
    fireEvent.contextMenu(cell, { clientX: 10, clientY: 10 });
    await userEvent.click(await screen.findByRole('menuitem', { name: /Copy snapshot/ }));
    expect(clipboard.copySnapshot).toHaveBeenCalledTimes(1);
  });

  it('MENU-03 right-click on a column header opens the column menu; hide and freeze act on that column', async () => {
    render(<Harness />);
    const header = screen.getAllByRole('columnheader')[1]!;
    fireEvent.contextMenu(header, { clientX: 200, clientY: 5 });
    const menu = await screen.findByRole('menu', { name: 'Column menu' });
    expect(labels(menu)).toEqual([
      'Graph this table',
      'Freeze columns through Column 2',
      'Sort ascending',
      'Sort descending',
      'Show sort options',
      'Quick filter…',
      'Show filter options',
      'Add category for Column 2',
      'Remove Column 2 category',
      'Show category options',
      'Add column before',
      'Add column after',
      'Delete column',
      'Hide column',
      'Fit width to content',
      'Cut column',
      'Copy column',
      'Copy column snapshot',
      'Paste into column',
      'Paste into column and match style',
      'Clear column',
      'Wrap text',
    ]);
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Freeze columns/ }));
    await waitFor(() => {
      expect(tableById(gd, tableId)?.frozenColumns).toBe(2);
    });
    fireEvent.contextMenu(screen.getAllByRole('columnheader')[2]!, { clientX: 400, clientY: 5 });
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Hide column' }));
    await waitFor(() => {
      expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    });
  });

  it("MENU-03 the column menu's clipboard commands act on the right-clicked column, not the selected cell (#123)", async () => {
    render(<Harness />);
    // C1 is selected; the menu opens on column 1's header.
    await userEvent.click(cells()[2]!);
    const record = tableById(gd, tableId)!;
    const header = screen.getAllByRole('columnheader')[0]!;
    fireEvent.contextMenu(header, { clientX: 20, clientY: 5 });
    await screen.findByRole('menu', { name: 'Column menu' });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Clear column' }));
    expect(clipboard.column.clear).toHaveBeenLastCalledWith({
      tableId,
      colId: record.columns[0]!.id,
    });
    expect(clipboard.cut).not.toHaveBeenCalled();
    fireEvent.contextMenu(header, { clientX: 20, clientY: 5 });
    await screen.findByRole('menu', { name: 'Column menu' });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cut column' }));
    expect(clipboard.column.cut).toHaveBeenLastCalledWith({
      tableId,
      colId: record.columns[0]!.id,
    });
    expect(clipboard.column.paste).not.toHaveBeenCalled();
  });

  it('REF-05 the column menu disables Cut, Paste and Clear on a read-only column, with the reason (#123)', () => {
    render(<Harness />);
    const record = tableById(gd, tableId)!;
    const ctx: MenuContext = {
      gd,
      editable: true,
      commands: grid.current!.commands,
      clipboard: {
        ...clipboard,
        column: {
          ...clipboard.column,
          reason: (_target, command) =>
            command === 'copy' ? undefined : 'derived columns are read-only',
        },
      },
      selectedCell: null,
      canvas,
      sheets,
    };
    const entries = columnMenuEntries(ctx, {
      kind: 'column',
      tableId,
      colId: record.columns[0]!.id,
    });
    const byId = (id: string) => entries.find((e) => e.id === id);
    for (const id of ['cut', 'paste', 'paste-match', 'clear']) {
      expect(byId(id)).toMatchObject({ disabledReason: 'derived columns are read-only' });
    }
    expect(byId('copy')).toMatchObject({ disabledReason: undefined });
    expect(byId('copy-snapshot')).toMatchObject({ disabledReason: undefined });
  });

  it('MENU-05 Escape from a column menu returns focus to the header it opened on; a command that moves the selection sends focus to the new cell (#131)', async () => {
    render(<Harness />);
    await userEvent.click(cells()[0]!);
    const header = screen.getAllByRole('columnheader')[1]!;
    fireEvent.contextMenu(header, { clientX: 200, clientY: 5 });
    await screen.findByRole('menu', { name: 'Column menu' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(header).toHaveFocus();
    fireEvent.contextMenu(header, { clientX: 200, clientY: 5 });
    await screen.findByRole('menu', { name: 'Column menu' });
    await userEvent.click(screen.getByRole('menuitem', { name: /^Add column after/ }));
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    const selected = document.querySelector('[role="gridcell"][aria-selected="true"]');
    expect(selected).not.toBeNull();
    expect(selected).toHaveFocus();
  });

  it('KEYS Shift+F10 and the ContextMenu key open the menu for the focused cell', async () => {
    render(<Harness />);
    const cell = cells()[1]!;
    await userEvent.click(cell);
    fireEvent.keyDown(cell, { code: 'F10', key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menu', { name: 'Cell menu' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    fireEvent.keyDown(cell, { code: 'ContextMenu', key: 'ContextMenu' });
    expect(await screen.findByRole('menu', { name: 'Cell menu' })).toBeInTheDocument();
  });

  it('RESP-02 on phone nothing opens; view-only shows every write disabled with the reason', async () => {
    const { unmount } = render(<Harness phone />);
    fireEvent.contextMenu(cells()[0]!, { clientX: 10, clientY: 10 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    unmount();
    render(<Harness editable={false} />);
    fireEvent.contextMenu(cells()[0]!, { clientX: 10, clientY: 10 });
    await screen.findByRole('menu');
    expect(screen.getByRole('menuitem', { name: /Add row below/ })).toHaveAttribute(
      'title',
      'you have view-only access',
    );
    expect(screen.getByRole('menuitem', { name: /^Copy\s*⌘C$/ })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('MENU-01 the canvas and table-title targets resolve from the DOM, and the entry builders cover every target', () => {
    render(<Harness />);
    const plane = screen.getByTestId('plane');
    expect(resolveMenuTarget(gd, plane)).toEqual({ kind: 'canvas' });
    expect(resolveMenuTarget(gd, screen.getByText('Table 1'))).toEqual({ kind: 'table', tableId });
    expect(resolveMenuTarget(gd, document.body)).toBeNull();
    const ctx: MenuContext = {
      gd,
      editable: true,
      commands: grid.current!.commands,
      clipboard,
      selectedCell: null,
      canvas,
      sheets,
    };
    expect(menuEntriesFor(ctx, { kind: 'canvas' }).map((e) => e.id)).toEqual([
      'add-table',
      'add-shaped-table',
      'add-graph',
      's-view',
      'fit',
      'actual',
    ]);
    // ADR-048 / #165: the tab's menu is the home of Rename and Delete (DOC-02); + on the strip appends.
    expect(menuEntriesFor(ctx, { kind: 'sheet', sheetId: 'x' }).map((e) => e.id)).toEqual([
      'sheet-add',
      's-rename',
      'sheet-rename',
      's-delete',
      'sheet-delete',
    ]);
    expect(menuEntriesFor(ctx, { kind: 'table', tableId }).some((e) => e.id === 'fit')).toBe(true);
    const record = tableById(gd, tableId)!;
    const column = columnMenuEntries(ctx, {
      kind: 'column',
      tableId,
      colId: record.columns[0]!.id,
    });
    // #123: the column menu's clipboard group is the column's own, not the selected cell's.
    expect(column.find((e) => e.id === 'copy')).toMatchObject({
      label: 'Copy column',
      disabledReason: undefined,
    });
    const cell = cellMenuEntries(ctx, {
      kind: 'cell',
      tableId,
      rowId: record.rows[0]!,
      colId: record.columns[2]!.id,
    });
    // The last visible column cannot be the freeze edge: nothing would scroll.
    expect(cell.find((e) => e.id === 'freeze-columns')).toMatchObject({
      disabledReason: 'freezing every column would leave nothing to scroll',
    });
  });
});
