/**
 * Formula entry through the real grid editor (FX-02, FX-04, FX-05, FX-06,
 * FX-07, KEYS-06) — `TableView` + `useGrid` over a real Yjs document, the
 * engine on the inline transport (no Worker in jsdom). Nothing is mocked.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addRow,
  cellText,
  createSheet,
  createTable,
  insertRowBefore,
  openDocument,
  setTableTitle,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import { engineFor } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import { useGrid } from '../grid/use-grid.js';
import { TableView } from '../TableView.js';
import { resetFormulaEditingForTests } from './editing-store.js';

function Harness({ gd, tableId }: { gd: GedeDoc; tableId: Id }) {
  const g = useGrid(gd, true);
  useYVersion(gd.tables, { depth: 'shallow' });
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  return (
    <>
      <TableView
        table={map}
        tier="micro"
        selected={g.state.selection?.tableId === tableId}
        selectedCell={g.cell}
        editing={g.state.editing}
        editable
        presence={[]}
        pinnedLeft={null}
        actions={g.actions}
        commands={g.commands}
      />
      <LiveRegion />
    </>
  );
}

let gd: GedeDoc;
let tableId: Id;
let rows: readonly Id[];
let cols: readonly Id[];

const cells = () => within(screen.getByRole('grid')).getAllByRole('gridcell');
const cellAt = (r: number, c: number) => cells()[r * 3 + c]!;
const settled = () => engineFor(gd.doc).settled();

beforeEach(() => {
  gd = openDocument(new Y.Doc());
  const sheet = createSheet(gd);
  // A 3 × 3 table at B2: title rows 2–3, header row 4, data B5:D7.
  tableId = createTable(gd, { sheetId: sheet, at: { col: 1, row: 1 }, columns: 3, rows: 3 });
  const rec = tableById(gd, tableId)!;
  rows = rec.rows;
  cols = rec.columns.map((c) => c.id);
  setTableTitle(gd, tableId, 'Trek');
});

afterEach(() => {
  resetFormulaEditingForTests();
});

async function type(cell: HTMLElement, text: string): Promise<HTMLTextAreaElement> {
  await userEvent.dblClick(cell);
  const editor = screen.getByRole('textbox');
  await userEvent.clear(editor);
  await userEvent.type(editor, text);
  return editor as HTMLTextAreaElement;
}

describe('formula entry in the grid editor', () => {
  it('FX-02 typing = opens the forms menu; Sum is offered on a number column, and the pick leaves the editor open', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), '1200');
    await userEvent.keyboard('{Enter}');
    await type(cellAt(1, 0), '34');
    await userEvent.keyboard('{Enter}');
    const editor = await type(cellAt(2, 0), '=');
    const forms = await screen.findByRole('listbox', { name: 'Formula forms' });
    expect(editor).toHaveFocus();
    expect(editor).toHaveAttribute('aria-controls', forms.id);
    expect(screen.getByRole('option', { name: /Sum/ })).not.toHaveAttribute('aria-disabled');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(editor).toHaveValue('=Sum(');
    expect(editor).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('FX-05 FX-06 FX-07 clicking cells while editing inserts their addresses; Enter commits an id-bound formula; the cell shows the value and badge; re-opening shows the expression', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), '1200');
    await userEvent.keyboard('{Enter}');
    await type(cellAt(1, 0), '34');
    await userEvent.keyboard('{Enter}');
    const editor = await type(cellAt(2, 0), '=Sum(');
    // Pressing another cell does not select it: the address goes into the draft.
    fireEvent.pointerDown(cellAt(0, 0), { button: 0, pointerId: 1 });
    expect(editor).toHaveValue('=Sum(B5');
    expect(editor).toBeInTheDocument();
    fireEvent.pointerDown(cellAt(1, 0), { button: 0, pointerId: 1 });
    expect(editor).toHaveValue('=Sum(B5, B6');
    await userEvent.keyboard(')');
    await userEvent.keyboard('{Enter}');
    // Stored bound, shown projected.
    const stored = cellText(tableMap(gd, tableId)!, rows[2]!, cols[0]!);
    expect(stored).toMatch(/^=Sum\(\{c:.*\}, \{c:.*\}\)$/);
    await act(() => settled());
    await waitFor(() => {
      expect(within(cellAt(2, 0)).getByText('1,234')).toBeInTheDocument();
    });
    expect(within(cellAt(2, 0)).getByLabelText('Formula, 2 references')).toHaveTextContent('ƒ2');
    expect(cellAt(2, 0)).toHaveAttribute('title', '=Sum(B5, B6)');
    // Re-opening restores the expression, not the value (FX-07).
    await userEvent.dblClick(cellAt(2, 0));
    expect(screen.getByRole('textbox')).toHaveValue('=Sum(B5, B6)');
    await userEvent.keyboard('{Escape}');
    // Editing a referenced cell updates the dependent (FX-06).
    await type(cellAt(1, 0), '66');
    await userEvent.keyboard('{Enter}');
    await act(() => settled());
    await waitFor(() => {
      expect(within(cellAt(2, 0)).getByText('1,266')).toBeInTheDocument();
    });
  });

  it('FX-06 inserting a row above the referenced cells keeps the value and re-spells the expression (PRD §20)', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), '5');
    await userEvent.keyboard('{Enter}');
    await type(cellAt(2, 0), '=Sum(B5)');
    await userEvent.keyboard('{Enter}');
    await act(() => settled());
    await waitFor(() => {
      expect(within(cellAt(2, 0)).getByText('5')).toBeInTheDocument();
    });
    act(() => {
      insertRowBefore(gd, tableId, rows[0]!);
    });
    await act(() => settled());
    // The formula is now the fourth row; the 5 moved to B6 and the expression says so.
    const formulaCell = cells()[3 * 3]!;
    expect(within(formulaCell).getByText('5')).toBeInTheDocument();
    expect(formulaCell).toHaveAttribute('title', '=Sum(B6)');
  });

  it('FX-04 @ opens the workbook entity index at the caret and Enter inserts the path, editor still open', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), 'Lukla');
    await userEvent.keyboard('{Enter}');
    await type(cellAt(0, 1), '2860');
    await userEvent.keyboard('{Enter}');
    const editor = await type(cellAt(2, 1), '=Sum(@Luk');
    const list = await screen.findByRole('listbox', { name: 'Entities' });
    expect(list.textContent).toContain('@Trek.Lukla');
    expect(editor).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(editor).toHaveValue('=Sum(@Trek.Lukla');
    expect(editor).toHaveFocus();
    await userEvent.keyboard('."Column 2")');
    await userEvent.keyboard('{Enter}');
    expect(cellText(tableMap(gd, tableId)!, rows[2]!, cols[1]!)).toMatch(/^=Sum\(\{e:/);
    await act(() => settled());
    await waitFor(() => {
      expect(within(cellAt(2, 1)).getByText('2,860')).toBeInTheDocument();
    });
  });

  it('KEYS-06 Escape closes an open list first; the next Escape cancels the edit', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    const editor = await type(cellAt(0, 0), '=');
    await screen.findByRole('listbox');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(editor).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(cellText(tableMap(gd, tableId)!, rows[0]!, cols[0]!)).toBe('');
  });

  it('FX-06 a deleted referenced row shows ⚠ reference removed with icon and text; a row appended later is unaffected', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), '7');
    await userEvent.keyboard('{Enter}');
    await type(cellAt(2, 0), '=Sum(B5)');
    await userEvent.keyboard('{Enter}');
    await act(() => settled());
    act(() => {
      addRow(gd, tableId);
    });
    await act(() => settled());
    expect(within(cells()[2 * 3]!).getByText('7')).toBeInTheDocument();
    act(() => {
      gd.doc.transact(() => {
        const ys = tableMap(gd, tableId)!.get('rows') as Y.Array<Id>;
        ys.delete(0, 1);
      }, gd.origin);
    });
    await act(() => settled());
    const formulaCell = cells()[1 * 3]!;
    await waitFor(() => {
      expect(within(formulaCell).getByText('reference removed')).toBeInTheDocument();
    });
    expect(formulaCell).toHaveAttribute('title', '=Sum(#REF)');
    expect(within(formulaCell).getByTestId('formula-cell')).toHaveAttribute(
      'title',
      expect.stringContaining('deleted') as string,
    );
  });
});
