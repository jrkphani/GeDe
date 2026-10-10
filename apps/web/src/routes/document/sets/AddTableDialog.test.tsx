/**
 * Add table's kind picker and Fill column's dialog (SET-01, SET-09, SET-10, DOC-02) over a
 * real Yjs document: the set tables offered are the sheet's own.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  openDocument,
  setTableTitle,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { AddTableDialog } from './AddTableDialog.js';
import { FillColumnDialog } from './FillColumnDialog.js';
import { addTableOfKind } from './set-tables.js';

let gd: GedeDoc;
let sheetId: Id;

function set(title: string, col: number): Id {
  const id = addTableOfKind(gd, { sheetId, at: { col, row: 1 }, kind: 'simple' })!;
  setTableTitle(gd, id, title);
  return id;
}

beforeEach(() => {
  gd = openDocument(new Y.Doc());
  sheetId = createSheet(gd);
});

describe('SET-01 Add table asks the kind', () => {
  it('SET-01 DOC-02 Plain table is preselected and focused, so Enter adds today’s table', async () => {
    const onAdd = vi.fn();
    render(<AddTableDialog gd={gd} sheetId={sheetId} open onOpenChange={vi.fn()} onAdd={onAdd} />);
    const dialog = await screen.findByRole('dialog', { name: 'What kind of table is this?' });
    const group = within(dialog).getByRole('radiogroup', { name: 'Table kind' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual([
      expect.stringMatching(/^Plain table/),
      expect.stringMatching(/^Simple set/),
      expect.stringMatching(/^Family of sets/),
      expect.stringMatching(/^Computed by formula/),
      expect.stringMatching(/^Cartesian product/),
    ]);
    const plain = within(group).getByRole('radio', { name: /^Plain table/ });
    expect(plain).toBeChecked();
    await waitFor(() => {
      expect(plain).toHaveFocus();
    });
    expect(within(dialog).getByRole('button', { name: 'Add table' })).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledWith('plain');
  });

  it('SET-01 a set kind adds at once; a computed kind reads Pick sets and asks for its operation and sets', async () => {
    const e = set('E', 1);
    const c = set('C', 4);
    const onAdd = vi.fn();
    const { unmount } = render(
      <AddTableDialog gd={gd} sheetId={sheetId} open onOpenChange={vi.fn()} onAdd={onAdd} />,
    );
    await userEvent.click(await screen.findByRole('radio', { name: /^Simple set/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add table' }));
    expect(onAdd).toHaveBeenLastCalledWith('simple');
    unmount();

    render(<AddTableDialog gd={gd} sheetId={sheetId} open onOpenChange={vi.fn()} onAdd={onAdd} />);
    await userEvent.click(await screen.findByRole('radio', { name: /^Computed by formula/ }));
    expect(screen.queryByRole('button', { name: 'Add table' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Pick sets' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a computed table' });
    const ops = within(dialog).getByRole('radiogroup', { name: 'Operation' });
    expect(
      within(ops)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual([
      expect.stringMatching(/^Union/),
      expect.stringMatching(/^Inter/),
      expect.stringMatching(/^Diff/),
      expect.stringMatching(/^Power/),
    ]);
    expect(within(dialog).getByTestId('set-picker-formula')).toHaveTextContent('= Union(E, C)');
    await userEvent.click(within(ops).getByRole('radio', { name: /^Diff/ }));
    expect(within(dialog).getByTestId('set-picker-formula')).toHaveTextContent('= Diff(E, C)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add table' }));
    expect(onAdd).toHaveBeenLastCalledWith('computed', {
      op: 'Diff',
      sets: [e, c],
      shape: 'spread',
    });
  });

  it('SET-09 a Cartesian product picks its sets in order, may repeat one, and asks where each tuple goes', async () => {
    const e = set('E', 1);
    const c = set('C', 4);
    const onAdd = vi.fn();
    render(<AddTableDialog gd={gd} sheetId={sheetId} open onOpenChange={vi.fn()} onAdd={onAdd} />);
    await userEvent.click(await screen.findByRole('radio', { name: /^Cartesian product/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Pick sets' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a computed table' });
    expect(within(dialog).queryByRole('radiogroup', { name: 'Operation' })).toBeNull();
    expect(within(dialog).getByTestId('set-picker-formula')).toHaveTextContent('= Cross(E, C)');
    // Two sets is the least: no Delete until a third is added (SET-19: Delete, not Remove).
    expect(within(dialog).queryByRole('button', { name: /^(Remove|Delete) set/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add another set' }));
    expect(within(dialog).getByTestId('set-picker-formula')).toHaveTextContent('= Cross(E, C, C)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete set 2' }));
    expect(within(dialog).getByTestId('set-picker-formula')).toHaveTextContent('= Cross(E, C)');
    const shape = within(dialog).getByRole('radiogroup', { name: 'Each tuple goes in' });
    expect(within(shape).getByRole('radio', { name: /^One column per set/ })).toBeChecked();
    await userEvent.click(within(shape).getByRole('radio', { name: /^One column\b(?! per)/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add table' }));
    expect(onAdd).toHaveBeenLastCalledWith('product', {
      op: 'Cross',
      sets: [e, c],
      shape: 'column',
    });
  });

  it('SET-01 with no set on the sheet the computed step says so and cannot add', async () => {
    createTable(gd, { sheetId, at: { col: 1, row: 1 } });
    render(
      <AddTableDialog gd={gd} sheetId={sheetId} open onOpenChange={vi.fn()} onAdd={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole('radio', { name: /^Cartesian product/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Pick sets' }));
    expect(
      await screen.findByText('There are no sets on this sheet yet. Add a Simple set first.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add table' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('radio', { name: /^Cartesian product/ })).toBeChecked();
  });
});

describe('SET-10 Fill column with formula…', () => {
  it('SET-10 SET-09 the dialog names the column, offers every set operation and confirms with Fill column', async () => {
    const e = set('E', 1);
    const c = set('C', 4);
    const plain = createTable(gd, { sheetId, at: { col: 1, row: 10 }, columns: 2, rows: 0 });
    const onFill = vi.fn();
    render(
      <FillColumnDialog
        gd={gd}
        sheetId={sheetId}
        tableId={plain}
        column="Column 1"
        open
        onOpenChange={vi.fn()}
        onFill={onFill}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Fill Column 1 with a formula' });
    const ops = within(dialog).getByRole('radiogroup', { name: 'Operation' });
    expect(within(ops).getAllByRole('radio')).toHaveLength(5);
    expect(within(ops).getByRole('radio', { name: /^Cross/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Fill column' }));
    expect(onFill).toHaveBeenCalledWith({ op: 'Cross', sets: [e, c], shape: 'spread' });
  });
});

describe('Phase 3 red-team regressions', () => {
  it('SET-01 I18N-01 Enter with keyCode 229 (an IME commit) adds nothing', async () => {
    const onAdd = vi.fn();
    render(<AddTableDialog gd={gd} sheetId={sheetId} open onOpenChange={vi.fn()} onAdd={onAdd} />);
    const plain = await screen.findByRole('radio', { name: /^Plain table/ });
    fireEvent.keyDown(plain, { code: 'Enter', key: 'Enter', keyCode: 229 });
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.keyDown(plain, { code: 'Enter', key: 'Enter', keyCode: 13 });
    expect(onAdd).toHaveBeenCalledWith('plain');
  });

  it('SET-09 SET-01 Pick sets moves focus to the checked operation card, named once', async () => {
    set('E', 1);
    set('C', 4);
    render(
      <AddTableDialog gd={gd} sheetId={sheetId} open onOpenChange={vi.fn()} onAdd={vi.fn()} />,
    );
    await userEvent.click(await screen.findByRole('radio', { name: /^Computed by formula/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Pick sets' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a computed table' });
    const union = within(dialog).getByRole('radio', { name: /^Union/ });
    await waitFor(() => {
      expect(union).toHaveFocus();
    });
    // The operation is one radio group under a visible heading, not a group inside a group
    // with the same name, so a screen reader says "Operation" once.
    expect(within(dialog).getByRole('radiogroup', { name: 'Operation' })).toBeInTheDocument();
    expect(within(dialog).queryAllByRole('group', { name: 'Operation' })).toHaveLength(0);
  });

  it('SET-10 SET-02 Fill column does not offer the table being filled as its own operand', async () => {
    const e = set('E', 1);
    const c = set('C', 4);
    render(
      <FillColumnDialog
        gd={gd}
        sheetId={sheetId}
        tableId={e}
        column="range"
        open
        onOpenChange={vi.fn()}
        onFill={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Fill range with a formula' });
    // Only C is left on the sheet besides E, so the picker's first pick is C twice.
    expect(within(dialog).getByTestId('set-picker-formula').textContent).toBe('= Cross(C, C)');
    expect(c).not.toBe(e);
  });

  it('SET-10 a set a peer renames while the dialog is open shows its new title', async () => {
    set('E', 1);
    const c = set('C', 4);
    const plain = createTable(gd, { sheetId, at: { col: 1, row: 10 }, columns: 2, rows: 0 });
    render(
      <FillColumnDialog
        gd={gd}
        sheetId={sheetId}
        tableId={plain}
        column="Column 1"
        open
        onOpenChange={vi.fn()}
        onFill={vi.fn()}
      />,
    );
    const formula = await screen.findByTestId('set-picker-formula');
    expect(formula.textContent).toBe('= Cross(E, C)');
    act(() => {
      setTableTitle(gd, c, 'Colours');
    });
    expect(formula.textContent).toBe('= Cross(E, Colours)');
  });
});
