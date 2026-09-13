/**
 * The sheet strip's commands (ADR-048): the tab's context menu per state,
 * inline rename, and the keys a focused tab handles. The strip sits inside
 * the document's one `ContextMenu`, as it does in the shell; the sheet
 * commands are recorded by labelled fakes and the document is a real Y.Doc.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  listSheets,
  openDocument,
  renameSheet,
  sheetById,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { TooltipProvider } from '@gede/ui';

import { LiveRegion } from '../../announce.js';
import { useGrid } from './grid/use-grid.js';
import type { CellClipboard } from './keys/clipboard.js';
import { DocumentContextMenu } from './menus/DocumentContextMenu.js';
import type { MenuContext } from './menus/entries.js';
import { emptyNameReason, LAST_SHEET_REASON } from './sheets.js';
import { SheetTabs, type SheetEditing } from './SheetTabs.js';

let gd: GedeDoc;
let first: Id;
let second: Id;

const clipboard = {
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
} satisfies CellClipboard;
const canvas = { addTable: vi.fn(), fit: vi.fn(), actualSize: vi.fn() };

/** The shell's sheet commands, as fakes: rename state is real, the rest is recorded. */
const sheets = {
  add: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
};

function Harness({
  editable: wanted = true,
  phone = false,
}: {
  editable?: boolean;
  phone?: boolean;
}) {
  const editable = wanted && !phone; // RESP-02: the phone is read-only whatever the permission
  const g = useGrid(gd, editable);
  const [active, setActive] = useState<Id>(first);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const edit: SheetEditing = {
    renaming,
    startRename: (id) => {
      sheets.rename(id);
      setRenaming(id);
    },
    commitRename: (id, label) => {
      if (label.trim() === '') return false;
      renameSheet(gd, id, label);
      setRenaming(null);
      return true;
    },
    cancelRename: () => {
      setRenaming(null);
    },
    remove: sheets.remove,
  };
  const context: MenuContext = {
    gd,
    editable,
    commands: g.commands,
    clipboard,
    selectedCell: g.cell,
    canvas,
    sheets: {
      ...sheets,
      rename: (id) => {
        edit.startRename(id);
      },
    },
  };
  return (
    <TooltipProvider>
      <DocumentContextMenu gd={gd} phone={phone} context={context} actions={g.actions}>
        <div className="gd-canvas__plane" data-testid="plane" />
        <SheetTabs
          gd={gd}
          activeSheetId={active}
          onSelect={setActive}
          onAppend={editable ? sheets.add : undefined}
          edit={editable ? edit : undefined}
          bottom={phone}
        />
        <LiveRegion />
      </DocumentContextMenu>
    </TooltipProvider>
  );
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });
const menuItems = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((el) => el.querySelector('.gd-menu__label')?.textContent ?? '');

async function openMenuOn(element: HTMLElement): Promise<HTMLElement> {
  act(() => {
    element.focus();
  });
  fireEvent.keyDown(element, { code: 'F10', shiftKey: true });
  return await screen.findByRole('menu', { name: 'Sheet menu' });
}

describe('sheet tab menu (ADR-048)', () => {
  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
    gd = openDocument(new Y.Doc());
    first = createSheet(gd, { label: 'Trek' });
    second = createSheet(gd, { label: 'Budget' });
    createTable(gd, { sheetId: first, at: { col: 1, row: 1 } });
  });

  it('MENU-01 DOC-03 KEYS-08 Shift+F10 on a focused tab opens the sheet menu — Add sheet · Rename sheet F2 · Delete sheet ⌫, separators between kinds — acting on that tab’s sheet, which need not be the active one', async () => {
    render(<Harness />);
    const menu = await openMenuOn(tab(/Budget/));
    expect(menuItems(menu)).toEqual(['Add sheet', 'Rename sheet', 'Delete sheet']);
    expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(within(menu).getByRole('menuitem', { name: /Rename sheet/ })).toHaveTextContent('F2');
    const del = within(menu).getByRole('menuitem', { name: /Delete sheet/ });
    expect(del).toHaveTextContent('⌫');
    expect(del).toHaveClass('gd-menu__item--danger');
    await userEvent.click(del);
    expect(sheets.remove).toHaveBeenCalledWith(second);
    const again = await openMenuOn(tab(/Trek/));
    await userEvent.click(within(again).getByRole('menuitem', { name: /Add sheet/ }));
    expect(sheets.add).toHaveBeenCalledTimes(1);
    // A right-click on an inactive tab opens its menu without selecting that sheet.
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await userEvent.click(tab(/Trek/));
    fireEvent.contextMenu(tab(/Budget/));
    const third = await screen.findByRole('menu', { name: 'Sheet menu' });
    expect(tab(/Trek/)).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(third).getByRole('menuitem', { name: /Delete sheet/ }));
    expect(sheets.remove).toHaveBeenLastCalledWith(second);
    expect(tab(/Trek/)).toHaveAttribute('aria-selected', 'true');
  });

  it('MENU-05 Escape closes the sheet menu and focus returns to the tab it opened on', async () => {
    render(<Harness />);
    const budget = tab(/Budget/);
    const menu = await openMenuOn(budget);
    fireEvent.keyDown(menu, { code: 'Escape', key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(tab(/Budget/)).toHaveFocus();
    });
  });

  it('MENU-02 the last sheet’s Delete is present, disabled, with the reason for a pointer and for assistive tech', async () => {
    gd = openDocument(new Y.Doc());
    first = createSheet(gd, { label: 'Only' });
    render(<Harness />);
    const menu = await openMenuOn(tab(/Only/));
    const item = within(menu).getByRole('menuitem', { name: /Delete sheet/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveAttribute('title', LAST_SHEET_REASON);
    const described = document.getElementById(item.getAttribute('aria-describedby') ?? '');
    expect(described).toHaveTextContent(LAST_SHEET_REASON);
    expect(within(menu).getByRole('menuitem', { name: /Rename sheet/ })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('MENU-02 RESP-02 view-only shows every sheet command disabled with the reason; the phone opens no menu and no rename', async () => {
    const { unmount } = render(<Harness editable={false} />);
    const menu = await openMenuOn(tab(/Budget/));
    for (const name of [/Add sheet/, /Rename sheet/, /Delete sheet/]) {
      const item = within(menu).getByRole('menuitem', { name });
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveAttribute('title', 'you have view-only access');
    }
    fireEvent.keyDown(tab(/Budget/), { code: 'Delete' });
    fireEvent.keyDown(tab(/Budget/), { code: 'F2' });
    expect(sheets.remove).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    unmount();
    render(<Harness phone />);
    fireEvent.keyDown(tab(/Budget/), { code: 'F10', shiftKey: true });
    fireEvent.contextMenu(tab(/Budget/));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add sheet' })).not.toBeInTheDocument();
    fireEvent.doubleClick(tab(/Budget/));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('MENU-05 A11Y-01 Rename sheet from the menu puts focus in the name field in the tab’s place; Enter commits the trimmed name in one step and focus returns to the tab', async () => {
    render(<Harness />);
    const menu = await openMenuOn(tab(/Budget/));
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Rename sheet/ }));
    const field = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Sheet name' });
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    expect(field).toHaveValue('Budget');
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('Budget'.length);
    // The tab stepped aside: a text field never nests inside a tab button (axe nested-interactive).
    expect(field.closest('[role="tab"]')).toBeNull();
    expect(screen.queryByRole('tab', { name: /Budget/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    // Arrows move the caret, never the tab.
    fireEvent.keyDown(field, { code: 'ArrowLeft', key: 'ArrowLeft' });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: '  Costs  ' } });
    fireEvent.keyDown(field, { code: 'Enter' });
    expect(sheetById(gd, second)?.label).toBe('Costs');
    const renamed = await screen.findByRole('tab', { name: /2°.*Costs.*0 objects/ });
    expect(renamed).toHaveFocus();
  });

  it('DOC-03 MENU-05 renaming an inactive sheet from its menu keeps the active sheet: the commit does not select the renamed tab (focusing an inactive Radix tab would) and focus lands on the active tab', async () => {
    render(<Harness />);
    // A right-click on the inactive tab opens its menu without focusing it (the pointer path).
    fireEvent.contextMenu(tab(/Budget/));
    const menu = await screen.findByRole('menu', { name: 'Sheet menu' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Rename sheet/ }));
    const field = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Sheet name' });
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    expect(tab(/1°/)).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(field, { target: { value: 'Costs' } });
    fireEvent.keyDown(field, { code: 'Enter' });
    expect(sheetById(gd, second)?.label).toBe('Costs');
    await screen.findByRole('tab', { name: /2°.*Costs/ });
    // Sheet 1 is still the shown sheet, and the keyboard is on its tab, not on body.
    expect(tab(/1°/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/2°.*Costs/)).toHaveAttribute('aria-selected', 'false');
    await waitFor(() => {
      expect(tab(/1°/)).toHaveFocus();
    });
  });

  it('DOC-03 KEYS-06 F2 or a double-click renames; Escape cancels and keeps the old name; an empty name is refused with the reason', async () => {
    render(<Harness />);
    act(() => {
      tab(/Trek/).focus();
    });
    fireEvent.keyDown(tab(/Trek/), { code: 'F2' });
    const field = await screen.findByRole('textbox', { name: 'Sheet name' });
    fireEvent.change(field, { target: { value: 'Abandoned' } });
    fireEvent.keyDown(field, { code: 'Escape' });
    expect(sheetById(gd, first)?.label).toBe('Trek');
    expect(await screen.findByRole('tab', { name: /Trek/ })).toHaveFocus();

    fireEvent.doubleClick(tab(/Trek/));
    const again = await screen.findByRole('textbox', { name: 'Sheet name' });
    fireEvent.change(again, { target: { value: '   ' } });
    fireEvent.keyDown(again, { code: 'Enter' });
    // Refused: the field stays, says why (A11Y-04: words, not a red border alone), and announces.
    expect(again).toBeInTheDocument();
    expect(again).toHaveAttribute('aria-invalid', 'true');
    const reason = document.getElementById(again.getAttribute('aria-describedby') ?? '');
    expect(reason).toHaveTextContent(emptyNameReason());
    expect(screen.getByTestId('live-region')).toHaveTextContent(emptyNameReason());
    expect(sheetById(gd, first)?.label).toBe('Trek');
    // Leaving the field with nothing in it is a cancel, not a rename to nothing.
    fireEvent.blur(again);
    expect(sheetById(gd, first)?.label).toBe('Trek');
    expect(await screen.findByRole('tab', { name: /Trek/ })).toBeInTheDocument();
  });

  it('DOC-03 leaving the field commits the typed name; a rename that changes nothing is not a write', async () => {
    render(<Harness />);
    fireEvent.doubleClick(tab(/Trek/));
    const field = await screen.findByRole('textbox', { name: 'Sheet name' });
    fireEvent.change(field, { target: { value: 'Plan' } });
    fireEvent.blur(field);
    expect(sheetById(gd, first)?.label).toBe('Plan');
    expect(await screen.findByRole('tab', { name: /Plan/ })).toBeInTheDocument();
    fireEvent.doubleClick(tab(/Plan/));
    const same = await screen.findByRole('textbox', { name: 'Sheet name' });
    fireEvent.keyDown(same, { code: 'Enter' });
    expect(sheetById(gd, first)?.label).toBe('Plan');
    expect(await screen.findByRole('tab', { name: /Plan/ })).toBeInTheDocument();
  });

  it('I18N-01 Enter and Escape do nothing in the name field while an IME composes', async () => {
    render(<Harness />);
    fireEvent.doubleClick(tab(/Trek/));
    const field = await screen.findByRole('textbox', { name: 'Sheet name' });
    fireEvent.change(field, { target: { value: 'தமிழ்' } });
    fireEvent.keyDown(field, { code: 'Enter', isComposing: true });
    expect(field).toBeInTheDocument();
    expect(sheetById(gd, first)?.label).toBe('Trek');
    fireEvent.keyDown(field, { code: 'Escape', keyCode: 229 });
    expect(field).toBeInTheDocument();
    fireEvent.keyDown(field, { code: 'Enter' });
    expect(sheetById(gd, first)?.label).toBe('தமிழ்');
  });

  it('KEYS-03 KEYS-08 Delete or Backspace on a focused tab (by physical key, no modifier) deletes that sheet and is claimed before the shell’s ⌫; F2 with a modifier is not a rename', () => {
    render(<Harness />);
    const budget = tab(/Budget/);
    act(() => {
      budget.focus();
    });
    expect(fireEvent.keyDown(budget, { code: 'Delete' })).toBe(false); // default prevented
    expect(sheets.remove).toHaveBeenCalledWith(second);
    expect(fireEvent.keyDown(budget, { code: 'Backspace' })).toBe(false);
    expect(sheets.remove).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(budget, { code: 'Delete', metaKey: true });
    fireEvent.keyDown(budget, { code: 'Backspace', altKey: true });
    fireEvent.keyDown(budget, { code: 'Delete', isComposing: true });
    expect(sheets.remove).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(budget, { code: 'F2', ctrlKey: true });
    expect(sheets.rename).not.toHaveBeenCalled();
    // ⌫ elsewhere in the strip (the + button) deletes nothing, and is still claimed so the
    // shell's ⌫ never acts on the canvas selection while focus is in the strip (#165 §5).
    const plus = screen.getByRole('button', { name: 'Add sheet' });
    expect(fireEvent.keyDown(plus, { code: 'Backspace' })).toBe(false);
    expect(sheets.remove).toHaveBeenCalledTimes(2);
  });

  it('MENU-01 the tab under the pointer resolves by id, so a right-click on the second tab while the first is renamed still targets the second', async () => {
    render(<Harness />);
    fireEvent.doubleClick(tab(/Trek/));
    await screen.findByRole('textbox', { name: 'Sheet name' });
    fireEvent.contextMenu(tab(/Budget/));
    const menu = await screen.findByRole('menu', { name: 'Sheet menu' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Delete sheet/ }));
    expect(sheets.remove).toHaveBeenCalledWith(second);
    expect(listSheets(gd)).toHaveLength(2);
  });
});
