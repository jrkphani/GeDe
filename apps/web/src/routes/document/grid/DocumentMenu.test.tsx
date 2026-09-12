import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  createUndoManager,
  openDocument,
  setCellText,
  tableById,
} from '@gede/core';

import { DocumentMenu } from './DocumentMenu.js';

describe('DocumentMenu (KEYS-02, KEYS-03, KEYS-08)', () => {
  it('KEYS-08 KEYS-02 KEYS-03 Open, Print, Undo and Redo each have a pointer route beside their chord; undo and redo say when there is nothing to do', async () => {
    const gd = openDocument(new Y.Doc());
    const sheet = createSheet(gd);
    const tableId = createTable(gd, {
      sheetId: sheet,
      at: { col: 0, row: 0 },
      columns: 1,
      rows: 1,
    });
    const undo = createUndoManager(gd);
    const onOpen = vi.fn();
    const onPrint = vi.fn();
    render(<DocumentMenu editable undo={undo} onOpen={onOpen} onPrint={onPrint} />);
    const open = () => userEvent.click(screen.getByRole('button', { name: 'Document menu' }));
    await open();
    expect(screen.getByRole('menuitem', { name: /Open the library/ })).toHaveTextContent('⌘O');
    expect(screen.getByRole('menuitem', { name: /Print/ })).toHaveTextContent('⌘P');
    const undoItem = screen.getByRole('menuitem', { name: /Undo/ });
    expect(undoItem).toHaveTextContent('⌘Z');
    expect(undoItem).toHaveAttribute('aria-disabled', 'true');
    expect(undoItem).toHaveAccessibleDescription('nothing to undo');
    expect(screen.getByRole('menuitem', { name: /Redo/ })).toHaveTextContent('⇧⌘Z');
    await userEvent.click(screen.getByRole('menuitem', { name: /Print/ }));
    expect(onPrint).toHaveBeenCalledTimes(1);
    await open();
    await userEvent.click(screen.getByRole('menuitem', { name: /Open the library/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);

    const record = tableById(gd, tableId)!;
    setCellText(gd, tableId, record.rows[0]!, record.columns[0]!.id, 'Lukla');
    await open();
    expect(screen.getByRole('menuitem', { name: /Undo/ })).not.toHaveAttribute('aria-disabled');
    await userEvent.click(screen.getByRole('menuitem', { name: /Undo/ }));
    expect(undo.canRedo()).toBe(true);
    await open();
    expect(screen.getByRole('menuitem', { name: /Redo/ })).not.toHaveAttribute('aria-disabled');
  });

  it('SHARE-03 a view-only participant sees undo and redo disabled with the reason', async () => {
    const gd = openDocument(new Y.Doc());
    render(
      <DocumentMenu
        editable={false}
        undo={createUndoManager(gd)}
        onOpen={vi.fn()}
        onPrint={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Document menu' }));
    expect(screen.getByRole('menuitem', { name: /Undo/ })).toHaveAttribute(
      'title',
      'you have view-only access',
    );
    expect(screen.getByRole('menuitem', { name: /Open the library/ })).not.toHaveAttribute(
      'aria-disabled',
    );
  });
});
