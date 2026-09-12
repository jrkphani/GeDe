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
  setColumnFormat,
  setColumnHidden,
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

/** The open ProseMirror editable (the rich editor draws it as the cell). */
function editable(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.gd-rich-editor');
  if (el === null) throw new Error('no editor is open');
  return el;
}

/**
 * Type into the rich editor the way a browser does: mutate the contenteditable
 * and let ProseMirror's DOM observer read the change (a microtask). The caret
 * sits at the end of the text when the editor opens, which is where this appends.
 */
async function typeText(editor: HTMLElement, text: string): Promise<void> {
  const p = editor.querySelector('p') ?? editor;
  const last = p.lastChild;
  let node: Node;
  if (last !== null && last.nodeType === Node.TEXT_NODE) {
    last.textContent = `${last.textContent ?? ''}${text}`;
    node = last;
  } else {
    if (last !== null && last.nodeName === 'BR') last.remove();
    node = p.appendChild(document.createTextNode(text));
  }
  document.getSelection()?.collapse(node, node.textContent?.length ?? 0);
  await act(async () => {
    await Promise.resolve();
  });
}

/** Replace the editor's text the way a browser edit does (select all, type), via PM's DOM observer. */
async function retype(editor: HTMLElement, text: string): Promise<void> {
  const p = editor.querySelector('p') ?? editor;
  const node = p.firstChild;
  if (node?.nodeType !== Node.TEXT_NODE) throw new Error('no text to retype');
  node.textContent = text;
  document.getSelection()?.collapse(node, text.length);
  await act(async () => {
    await Promise.resolve();
  });
}

/** Open the editor on a cell by typing over it (GRID-04) and append the rest. */
async function type(cell: HTMLElement, text: string): Promise<HTMLElement> {
  const [first = '', ...rest] = text;
  await userEvent.click(cell);
  await userEvent.keyboard(first);
  const editor = editable();
  if (rest.length > 0) await typeText(editor, rest.join(''));
  return editor;
}

function press(code: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(editable(), { code, key: code, ...init });
}

describe('formula entry in the grid editor', () => {
  it('FX-02 typing = opens the forms menu; Sum is offered on a Number column, and the pick leaves the editor open', async () => {
    // FX-02 "offered only when the column is Number or Currency": the format, not the contents.
    setColumnFormat(gd, tableId, cols[0]!, 'number');
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), '1200');
    press('Enter');
    await type(cellAt(1, 0), '34');
    press('Enter');
    const editor = await type(cellAt(2, 0), '=');
    const forms = await screen.findByRole('listbox', { name: 'Formula forms' });
    expect(editor).toHaveFocus();
    expect(editor).toHaveAttribute('aria-controls', forms.id);
    expect(screen.getByRole('option', { name: /Sum/ })).not.toHaveAttribute('aria-disabled');
    press('ArrowDown');
    press('Enter');
    expect(editor).toHaveTextContent('=Sum(');
    expect(editor).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('FX-05 FX-06 FX-07 clicking cells while editing inserts their addresses; Enter commits an id-bound formula; the cell shows the value and badge; re-opening shows the expression', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), '1200');
    press('Enter');
    await type(cellAt(1, 0), '34');
    press('Enter');
    const editor = await type(cellAt(2, 0), '=Sum(');
    // Pressing another cell does not select it: the address goes into the draft.
    fireEvent.pointerDown(cellAt(0, 0), { button: 0, pointerId: 1 });
    expect(editor).toHaveTextContent('=Sum(B5');
    expect(editor).toBeInTheDocument();
    fireEvent.pointerDown(cellAt(1, 0), { button: 0, pointerId: 1 });
    expect(editor).toHaveTextContent('=Sum(B5, B6');
    await typeText(editor, ')');
    press('Enter');
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
    expect(editable()).toHaveTextContent('=Sum(B5, B6)');
    press('Escape');
    // Editing a referenced cell updates the dependent (FX-06).
    await type(cellAt(1, 0), '66');
    press('Enter');
    await act(() => settled());
    await waitFor(() => {
      expect(within(cellAt(2, 0)).getByText('1,266')).toBeInTheDocument();
    });
  });

  it('FX-06 inserting a row above the referenced cells keeps the value and re-spells the expression (PRD §20)', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), '5');
    press('Enter');
    await type(cellAt(2, 0), '=Sum(B5)');
    press('Enter');
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
    press('Enter');
    await type(cellAt(0, 1), '2860');
    press('Enter');
    const editor = await type(cellAt(2, 1), '=Sum(@Luk');
    const list = await screen.findByRole('listbox', { name: 'Entities' });
    expect(list.textContent).toContain('@Trek.Lukla');
    expect(editor).toHaveFocus();
    press('Enter');
    expect(editor).toHaveTextContent('=Sum(@Trek.Lukla');
    expect(editor).toHaveFocus();
    await typeText(editor, '."Column 2")');
    press('Enter');
    expect(cellText(tableMap(gd, tableId)!, rows[2]!, cols[1]!)).toMatch(/^=Sum\(\{e:/);
    await act(() => settled());
    await waitFor(() => {
      expect(within(cellAt(2, 1)).getByText('2,860')).toBeInTheDocument();
    });
  });

  it('KEYS-06 (partial: Escape ordering only; nest and promote are hierarchy work) Escape closes an open list first; the next Escape cancels the edit', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    const editor = await type(cellAt(0, 0), '=');
    await screen.findByRole('listbox');
    press('Escape');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(editor).toBeInTheDocument();
    press('Escape');
    expect(document.querySelector('.gd-rich-editor')).toBeNull();
    expect(cellText(tableMap(gd, tableId)!, rows[0]!, cols[0]!)).toBe('');
  });

  it('FX-06 a deleted referenced row shows ⚠ reference removed with icon and text; a row appended later is unaffected', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 0), '7');
    press('Enter');
    await type(cellAt(2, 0), '=Sum(B5)');
    press('Enter');
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

  it('FX-07 a formula shown with #hidden survives an edit through the editor: the binding stays and evaluates after unhide', async () => {
    render(<Harness gd={gd} tableId={tableId} />);
    await type(cellAt(0, 1), '8');
    press('Enter');
    await type(cellAt(2, 2), '=Sum(C5)');
    press('Enter');
    await act(() => settled());
    act(() => {
      setColumnHidden(gd, tableId, cols[1]!, true);
    });
    // Column C is hidden: the grid has two visible columns now; the formula cell shows #hidden.
    const formulaCell = cells()[2 * 2 + 1]!;
    expect(formulaCell).toHaveAttribute('title', '=Sum(#hidden)');
    await userEvent.dblClick(formulaCell);
    expect(editable()).toHaveTextContent('=Sum(#hidden)');
    await retype(editable(), '=Sum(#hidden, 1)');
    press('Enter');
    const stored = cellText(tableMap(gd, tableId)!, rows[2]!, cols[2]!);
    expect(stored).toMatch(/^=Sum\(\{c:[0-9A-Z:]+\}, 1\)$/);
    await act(() => settled());
    await waitFor(() => {
      expect(within(cells()[2 * 2 + 1]!).getByText('9')).toBeInTheDocument();
    });
    act(() => {
      setColumnHidden(gd, tableId, cols[1]!, false);
    });
    expect(cells()[2 * 3 + 2]).toHaveAttribute('title', '=Sum(C5, 1)');
  });
});
