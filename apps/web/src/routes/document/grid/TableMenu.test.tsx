import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  openDocument,
  tableById,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { createGridCommands, type GridCommands } from './commands.js';
import { frozenOptions, TableMenu } from './TableMenu.js';

let gd: GedeDoc;
let tableId: Id;
let commands: GridCommands;
const announce = vi.fn();

beforeEach(() => {
  gd = openDocument(new Y.Doc());
  const sheet = createSheet(gd);
  tableId = createTable(gd, { sheetId: sheet, at: { col: 0, row: 0 }, columns: 3, rows: 2 });
  announce.mockClear();
  commands = createGridCommands({
    gd,
    editable: () => true,
    state: () => ({ selection: null, editing: null }),
    dispatch: () => undefined,
    announce,
  });
});

describe('TableMenu (A11Y-01, MENU-02)', () => {
  it('DOC-02 MENU-02 with a table selected, cell commands are disabled with the reason; the menu carries only the commands whose home it is — no Add row, header, footer, frozen or wrap (#140, ADR 41)', async () => {
    render(<TableMenu gd={gd} selection={{ tableId, cell: null }} editable commands={commands} />);
    await userEvent.click(screen.getByRole('button', { name: 'Table menu' }));
    expect(screen.getByRole('menuitem', { name: 'Delete row' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Delete row' })).toHaveAttribute(
      'title',
      'select a cell first',
    );
    // MENU-02 (#126): the reason is reachable by assistive tech, not on hover alone.
    expect(screen.getByRole('menuitem', { name: 'Delete row' })).toHaveAccessibleDescription(
      'select a cell first',
    );
    const menu = screen.getByRole('menu');
    expect(
      Array.from(menu.querySelectorAll('.gd-menu__label')).map((el) => el.textContent),
    ).toEqual([
      'Insert row above',
      'Delete row',
      'Insert column before',
      'Delete column',
      'Hide column',
      'Unhide columns',
      'Widen column',
      'Narrow column',
      'Delete table',
    ]);
  });

  it('ADR-047 KEYS-08 Delete table is at home here, names ⌫, and calls the shell with the selected table; without a handler it says what it needs', async () => {
    const onDeleteTable = vi.fn();
    const view = render(
      <TableMenu
        gd={gd}
        selection={{ tableId, cell: null }}
        editable
        commands={commands}
        onDeleteTable={onDeleteTable}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Table menu' }));
    const item = screen.getByRole('menuitem', { name: /^Delete table/ });
    expect(item).not.toHaveAttribute('aria-disabled');
    expect(item).toHaveTextContent('⌫');
    await userEvent.click(item);
    expect(onDeleteTable).toHaveBeenCalledWith(tableId);
    view.rerender(
      <TableMenu gd={gd} selection={{ tableId, cell: null }} editable commands={commands} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Table menu' }));
    expect(screen.getByRole('menuitem', { name: /^Delete table/ })).toHaveAttribute(
      'title',
      'select a table first',
    );
  });

  it('GRID-02 GRID-08 with a cell selected, row and column commands act on it: hide, unhide, widen, narrow, delete', async () => {
    const rec = tableById(gd, tableId)!;
    const cell = { rowId: rec.rows[0]!, colId: rec.columns[1]!.id };
    const view = render(
      <TableMenu gd={gd} selection={{ tableId, cell }} editable commands={commands} />,
    );
    const open = () => userEvent.click(screen.getByRole('button', { name: 'Table menu' }));
    await open();
    expect(screen.getByRole('menuitem', { name: 'Narrow column' })).toHaveAttribute(
      'title',
      'already one unit wide',
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Widen column' }));
    expect(tableById(gd, tableId)?.columns[1]?.width).toBe(2);
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Narrow column' }));
    expect(tableById(gd, tableId)?.columns[1]?.width).toBe(1);
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Hide column' }));
    expect(tableById(gd, tableId)?.columns[1]?.hidden).toBe(true);
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Unhide 1 column' }));
    expect(tableById(gd, tableId)?.columns[1]?.hidden).toBe(false);
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Insert row above' }));
    expect(tableById(gd, tableId)?.rows).toHaveLength(3);
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete column' }));
    expect(tableById(gd, tableId)?.columns).toHaveLength(2);
    view.rerender(
      <TableMenu
        gd={gd}
        selection={{ tableId, cell: { rowId: rec.rows[0]!, colId: rec.columns[0]!.id } }}
        editable
        commands={commands}
      />,
    );
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete row' }));
    expect(tableById(gd, tableId)?.rows).toHaveLength(2);
  });

  it('SHARE-03 a view-only participant sees every command disabled with the reason; nothing is hidden', async () => {
    render(
      <TableMenu
        gd={gd}
        selection={{ tableId, cell: null }}
        editable={false}
        commands={commands}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Table menu' }));
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item).toHaveAttribute('aria-disabled', 'true');
      expect(item).toHaveAttribute('title', 'you have view-only access');
    }
    expect(screen.getAllByRole('menuitem').length).toBe(9);
  });

  it('GRID-10 frozen-column choices run to every count short of the whole table — no other cap', () => {
    expect(frozenOptions(0)).toEqual([0]);
    expect(frozenOptions(1)).toEqual([0]);
    expect(frozenOptions(2)).toEqual([0, 1]);
    expect(frozenOptions(3)).toEqual([0, 1, 2]);
    expect(frozenOptions(9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
