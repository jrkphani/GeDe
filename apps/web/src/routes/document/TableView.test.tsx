/**
 * TableView keyboard and pointer matrix (GRID-03..11, KEYS-06, I18N-01/02,
 * A11Y-01/04, RESP-02) against a real Yjs document — no shell, no room. The
 * harness is the same `useGrid` the shell uses, so what passes here is what
 * the document runs.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  addRow,
  cellRich,
  createSheet,
  createTable,
  createUndoManager,
  docNode,
  hideColumn,
  LATTICE,
  markSplitChildren,
  nestRow,
  openDocument,
  paragraphNode,
  rowMeta,
  setCellFormat,
  setCellRich,
  setCellText,
  setColumnFormat,
  setOutlineColumn,
  setRowCollapsed,
  tableById,
  tableMap,
  textNode,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { LiveRegion } from '../../announce.js';
import { useYVersion } from '../../doc/use-y.js';
import type { ZoomTier } from '../../doc/viewport.js';
import { useGrid, type Grid } from './grid/use-grid.js';
import { TableView } from './TableView.js';

interface HarnessProps {
  gd: GedeDoc;
  tableId: Id;
  editable?: boolean;
  pinnedLeft?: number | null;
  tier?: ZoomTier;
  undo?: Y.UndoManager | undefined;
  grid: { current: Grid | null };
}

function Harness({
  gd,
  tableId,
  editable = true,
  pinnedLeft = null,
  tier = 'micro',
  undo,
  grid,
}: HarnessProps) {
  const g = useGrid(gd, editable, { undo });
  grid.current = g;
  useYVersion(gd.tables, { depth: 'shallow' });
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  return (
    <>
      <TableView
        table={map}
        tier={tier}
        selected={g.state.selection?.tableId === tableId}
        selectedCell={g.cell}
        editing={g.state.editing}
        editable={editable}
        presence={[]}
        pinnedLeft={pinnedLeft}
        undo={undo}
        actions={g.actions}
        commands={g.commands}
      />
      <LiveRegion />
    </>
  );
}

function Mount(
  props: Omit<HarnessProps, 'grid'> & { onGrid: (g: { current: Grid | null }) => void },
) {
  const ref = useRef<Grid | null>(null);
  props.onGrid(ref);
  return <Harness {...props} grid={ref} />;
}

let gd: GedeDoc;
let tableId: Id;
let rows: readonly Id[];
let cols: readonly Id[];
const gridRef: { current: Grid | null } = { current: null };

/**
 * Type into the rich editor the way a browser does: mutate the contenteditable
 * and let ProseMirror's DOM observer read the change (a microtask). Selection
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
  // The caret follows the typed text, as it does in a browser.
  document.getSelection()?.collapse(node, node.textContent?.length ?? 0);
  await act(async () => {
    await Promise.resolve();
  });
}

function mount(props: Partial<Omit<HarnessProps, 'grid' | 'gd' | 'tableId'>> = {}) {
  let holder: { current: Grid | null } = { current: null };
  const view = render(
    <Mount
      gd={gd}
      tableId={tableId}
      {...props}
      onGrid={(r) => {
        holder = r;
      }}
    />,
  );
  Object.defineProperty(gridRef, 'current', { get: () => holder.current, configurable: true });
  return view;
}

// A flat table is a grid; one with nesting is a treegrid (HIER-04). Both are the same element.
const grid = () => screen.queryByRole('treegrid') ?? screen.getByRole('grid');
const cells = () => within(grid()).getAllByRole('gridcell');
const cellAt = (r: number, c: number, columns = 3) => cells()[r * columns + c]!;
const live = () => screen.getByTestId('live-region');
const selected = () =>
  cells()
    .find((el) => el.getAttribute('aria-selected') === 'true')
    ?.getAttribute('data-address') ?? null;

beforeEach(() => {
  gd = openDocument(new Y.Doc());
  const sheet = createSheet(gd);
  // A 3 × 3 table at B2: title rows 2–3, header row 4, data B5:D7.
  tableId = createTable(gd, { sheetId: sheet, at: { col: 1, row: 1 }, columns: 3, rows: 3 });
  const rec = tableById(gd, tableId)!;
  rows = rec.rows;
  cols = rec.columns.map((c) => c.id);
});

describe('selection (GRID-03)', () => {
  it('GRID-03 a single click arms a cell: aria-selected, the selection-ring class, the address announced', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    expect(cellAt(0, 0)).toHaveAttribute('aria-selected', 'true');
    expect(cellAt(0, 0)).toHaveClass('gd-cell--selected');
    expect(cellAt(0, 0)).toHaveFocus();
    expect(live()).toHaveTextContent('Selected B5 in Table 1');
    act(() => {
      gridRef.current?.actions.clear();
    });
    expect(cellAt(0, 0)).not.toHaveAttribute('aria-selected');
    expect(live()).toHaveTextContent('Selection cleared');
  });

  it('A11Y-01 tabbing onto the first cell arms it (roving tabindex: one tab stop per table)', async () => {
    mount();
    expect(cells().filter((el) => el.tabIndex === 0)).toHaveLength(1);
    await userEvent.tab();
    expect(cellAt(0, 0)).toHaveFocus();
    expect(cellAt(0, 0)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('editing (GRID-04, GRID-06)', () => {
  it('GRID-04 Enter opens the editor on the existing text; Escape cancels; Delete clears', async () => {
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'Kathmandu');
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'Enter', key: 'Enter' });
    const editor = screen.getByLabelText('Edit B5');
    expect(editor).toHaveTextContent('Kathmandu');
    expect(editor).toHaveFocus();
    await typeText(editor, ' changed');
    expect(editor).toHaveTextContent('Kathmandu changed');
    fireEvent.keyDown(editor, { code: 'Escape', key: 'Escape' });
    expect(screen.queryByLabelText('Edit B5')).not.toBeInTheDocument();
    expect(cellAt(0, 0)).toHaveTextContent('Kathmandu');
    expect(cellAt(0, 0)).toHaveFocus();
    fireEvent.keyDown(cellAt(0, 0), { code: 'Delete', key: 'Delete' });
    expect(cellAt(0, 0)).toHaveTextContent('');
  });

  it('GRID-04 typing any printable character overwrites and enters edit, seeded with that character', async () => {
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'old');
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'KeyK', key: 'K' });
    const editor = screen.getByLabelText('Edit B5');
    expect(editor).toHaveTextContent('K');
    await typeText(editor, 'ath');
    fireEvent.keyDown(editor, { code: 'Enter', key: 'Enter' });
    expect(cellAt(0, 0)).toHaveTextContent('Kath');
    expect(cellAt(0, 0)).not.toHaveTextContent('old');
  });

  it('I18N-02 the typed character comes from event.key, so a Tamil99 keystroke seeds Tamil; modifiers never type', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'KeyA', key: 'அ' });
    expect(screen.getByLabelText('Edit B5')).toHaveTextContent('அ');
    fireEvent.keyDown(screen.getByLabelText('Edit B5'), { code: 'Escape', key: 'Escape' });
    fireEvent.keyDown(cellAt(0, 0), { code: 'KeyC', key: 'c', metaKey: true });
    expect(screen.queryByLabelText('Edit B5')).not.toBeInTheDocument();
    fireEvent.keyDown(cellAt(0, 0), { code: 'F5', key: 'F5' });
    expect(screen.queryByLabelText('Edit B5')).not.toBeInTheDocument();
  });

  it('GRID-04 double-click opens the editor', async () => {
    mount();
    await userEvent.dblClick(cellAt(1, 1));
    expect(screen.getByLabelText('Edit C6')).toBeInTheDocument();
  });

  it('GRID-06 Enter commits and moves down; Tab commits and moves right; Shift+Tab left; blur commits in place', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'KeyA', key: 'a' });
    fireEvent.keyDown(screen.getByLabelText('Edit B5'), { code: 'Enter', key: 'Enter' });
    expect(cellAt(0, 0)).toHaveTextContent('a');
    expect(selected()).toBe('B6');
    fireEvent.keyDown(cellAt(1, 0), { code: 'KeyB', key: 'b' });
    fireEvent.keyDown(screen.getByLabelText('Edit B6'), { code: 'Tab', key: 'Tab' });
    expect(cellAt(1, 0)).toHaveTextContent('b');
    expect(selected()).toBe('C6');
    fireEvent.keyDown(cellAt(1, 1), { code: 'KeyC', key: 'c' });
    fireEvent.keyDown(screen.getByLabelText('Edit C6'), {
      code: 'Tab',
      key: 'Tab',
      shiftKey: true,
    });
    expect(cellAt(1, 1)).toHaveTextContent('c');
    expect(selected()).toBe('B6');
    fireEvent.keyDown(cellAt(1, 0), { code: 'KeyD', key: 'd' });
    fireEvent.blur(screen.getByLabelText('Edit B6'));
    expect(cellAt(1, 0)).toHaveTextContent('d');
    expect(selected()).toBe('B6');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('GRID-06 I18N-01 nothing commits, moves or cancels while an IME is composing (isComposing or keyCode 229)', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'Enter', key: 'Enter' });
    const editor = screen.getByLabelText('Edit B5');
    await typeText(editor, 'தமிழ்');
    fireEvent.keyDown(editor, { code: 'Enter', key: 'Enter', isComposing: true });
    fireEvent.keyDown(editor, { code: 'Tab', key: 'Tab', isComposing: true });
    fireEvent.keyDown(editor, { code: 'Escape', key: 'Escape', isComposing: true });
    fireEvent.keyDown(editor, { code: 'ArrowDown', key: 'ArrowDown', isComposing: true });
    fireEvent.keyDown(editor, { code: 'Enter', key: 'Enter', keyCode: 229 });
    expect(screen.getByLabelText('Edit B5')).toBeInTheDocument();
    expect(selected()).toBe('B5');
    fireEvent.keyDown(editor, { code: 'Enter', key: 'Enter' });
    expect(cellAt(0, 0)).toHaveTextContent('தமிழ்');
    expect(selected()).toBe('B6');
    // An armed cell hands a starting composition to the editor, so the conjunct forms there.
    fireEvent.keyDown(cellAt(1, 0), { code: 'KeyK', key: 'Process', keyCode: 229 });
    expect(screen.getByLabelText('Edit B6')).toHaveTextContent('');
    // The arrows stay inside the grid while composing on an armed cell too.
    fireEvent.keyDown(screen.getByLabelText('Edit B6'), { code: 'Escape', key: 'Escape' });
    fireEvent.keyDown(cellAt(1, 0), { code: 'ArrowDown', key: 'ArrowDown', isComposing: true });
    expect(selected()).toBe('B6');
  });

  it('GRID-06 an edit begun by typing commits on the arrows and moves that way; an Enter edit keeps the arrows for the caret', async () => {
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'text');
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'KeyX', key: 'x' });
    fireEvent.keyDown(screen.getByLabelText('Edit B5'), { code: 'ArrowRight', key: 'ArrowRight' });
    expect(cellAt(0, 0)).toHaveTextContent('x');
    expect(selected()).toBe('C5');
    fireEvent.keyDown(cellAt(0, 1), { code: 'Enter', key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('Edit C5'), { code: 'ArrowLeft', key: 'ArrowLeft' });
    expect(screen.getByLabelText('Edit C5')).toBeInTheDocument();
    expect(selected()).toBe('C5');
  });

  it('GRID-06 KEYS-03 a commit is one undo step', async () => {
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'KeyZ', key: 'z' });
    fireEvent.keyDown(screen.getByLabelText('Edit B5'), { code: 'Enter', key: 'Enter' });
    expect(cellAt(0, 0)).toHaveTextContent('z');
    act(() => {
      undo.undo();
    });
    expect(cellAt(0, 0)).toHaveTextContent('');
  });
});

describe('read-only cells (GRID-04, A11Y-04)', () => {
  it('GRID-04 A11Y-04 derived, linked, pulled and group cells refuse Enter, typing, double-click and Delete, and carry a lock plus a text reason', async () => {
    const t = tableMap(gd, tableId)!;
    (t.get('columns') as Y.Array<Y.Map<unknown>>).get(1).set('source', 'derived');
    setCellText(gd, tableId, rows[0]!, cols[1]!, 'kept');
    const meta = new Y.Map<unknown>();
    meta.set('group', true);
    (t.get('rowMeta') as Y.Map<unknown>).set(rows[2]!, meta);
    mount();
    const locked = cellAt(0, 1);
    expect(locked).toHaveAttribute('aria-readonly', 'true');
    expect(locked).toHaveClass('gd-cell--locked');
    expect(locked.querySelector('.gd-cell__lock svg')).not.toBeNull();
    expect(locked).toHaveAttribute('aria-label', 'C5, kept, Read-only: derived column');
    expect(locked).toHaveAttribute('title', 'kept — Read-only: derived column');
    await userEvent.click(locked);
    fireEvent.keyDown(locked, { code: 'Enter', key: 'Enter' });
    expect(screen.queryByLabelText('Edit C5')).not.toBeInTheDocument();
    expect(live()).toHaveTextContent('C5 is read-only: derived column');
    fireEvent.keyDown(locked, { code: 'KeyA', key: 'a' });
    expect(screen.queryByLabelText('Edit C5')).not.toBeInTheDocument();
    await userEvent.dblClick(locked);
    expect(screen.queryByLabelText('Edit C5')).not.toBeInTheDocument();
    fireEvent.keyDown(locked, { code: 'Delete', key: 'Delete' });
    expect(locked).toHaveTextContent('kept');
    // A category band row is read-only across every column.
    expect(cellAt(2, 0)).toHaveAttribute('aria-readonly', 'true');
    expect(cellAt(2, 0)).toHaveAttribute('data-read-only', 'group');
    // Traversal still passes through a locked cell.
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'Tab', key: 'Tab' });
    expect(selected()).toBe('C5');
  });
});

describe('traversal (GRID-05, A11Y-01, KEYS-06 (partial: nest and promote later))', () => {
  it('GRID-05 KEYS-06 (partial: ⌘] and ⌘[ nest and promote ship with the hierarchy work) Tab, Shift+Tab and the arrows move; Tab and the arrows wrap at row ends', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    const key = (code: string, shiftKey = false) => {
      const target = cells().find((el) => el.getAttribute('aria-selected') === 'true')!;
      fireEvent.keyDown(target, { code, key: code, shiftKey });
    };
    key('Tab');
    expect(selected()).toBe('C5');
    key('Tab');
    expect(selected()).toBe('D5');
    key('Tab'); // wraps to the next row
    expect(selected()).toBe('B6');
    key('Tab', true); // and back
    expect(selected()).toBe('D5');
    key('ArrowDown');
    expect(selected()).toBe('D6');
    key('ArrowLeft');
    expect(selected()).toBe('C6');
    key('ArrowUp');
    expect(selected()).toBe('C5');
    key('ArrowRight');
    key('ArrowRight'); // wraps
    expect(selected()).toBe('B6');
    key('ArrowLeft'); // and back
    expect(selected()).toBe('D5');
    key('ArrowUp'); // first row: stays
    expect(selected()).toBe('D5');
    expect(cells().find((el) => el.getAttribute('aria-selected') === 'true')).toHaveFocus();
  });

  it('GRID-05 moving past the final row appends a row and places the cursor in it (Tab, ArrowDown, Enter-commit)', async () => {
    mount();
    await userEvent.click(cellAt(2, 2));
    fireEvent.keyDown(cellAt(2, 2), { code: 'Tab', key: 'Tab' });
    expect(within(grid()).getAllByRole('row')).toHaveLength(5); // header + 4
    expect(selected()).toBe('B8');
    expect(live()).toHaveTextContent('Added a row');
    fireEvent.keyDown(cellAt(3, 0), { code: 'ArrowDown', key: 'ArrowDown' });
    expect(within(grid()).getAllByRole('row')).toHaveLength(6);
    expect(selected()).toBe('B9');
    fireEvent.keyDown(cellAt(4, 0), { code: 'KeyQ', key: 'q' });
    fireEvent.keyDown(screen.getByLabelText('Edit B9'), { code: 'Enter', key: 'Enter' });
    expect(within(grid()).getAllByRole('row')).toHaveLength(7);
    expect(selected()).toBe('B10');
    expect(cellAt(4, 0)).toHaveTextContent('q');
  });

  it('A11Y-01 Shift+Tab on the first cell leaves the grid instead of trapping focus; ⌃⇥ and ⌥⌘↓ are left to the shell', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    const shiftTab = new KeyboardEvent('keydown', {
      code: 'Tab',
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    cellAt(0, 0).dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(false);
    expect(selected()).toBe('B5');
    const ctrlTab = new KeyboardEvent('keydown', {
      code: 'Tab',
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    cellAt(0, 0).dispatchEvent(ctrlTab);
    expect(ctrlTab.defaultPrevented).toBe(false);
    const addRow = new KeyboardEvent('keydown', {
      code: 'ArrowDown',
      key: 'ArrowDown',
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    cellAt(0, 0).dispatchEvent(addRow);
    expect(addRow.defaultPrevented).toBe(false);
    expect(selected()).toBe('B5');
  });

  it('GRID-03 GRID-05 A11Y-01 after Escape clears the selection, Tab and the arrows on the still-focused cell re-arm it and move — never dead keys', async () => {
    mount();
    await userEvent.click(cellAt(1, 1));
    act(() => {
      gridRef.current?.actions.clear(); // what the shell does on Escape (GRID-03)
    });
    expect(selected()).toBeNull();
    expect(cellAt(1, 1)).toHaveFocus();
    fireEvent.keyDown(cellAt(1, 1), { code: 'Tab', key: 'Tab' });
    expect(selected()).toBe('D6');
    act(() => {
      gridRef.current?.actions.clear();
    });
    fireEvent.keyDown(cellAt(1, 2), { code: 'ArrowDown', key: 'ArrowDown' });
    expect(selected()).toBe('D7');
    expect(cellAt(2, 2)).toHaveFocus();
  });

  it('GRID-05 GRID-02 traversal skips hidden columns and addresses recompute around them', () => {
    mount();
    act(() => {
      gridRef.current?.actions.selectCell({ tableId, rowId: rows[0]!, colId: cols[0]! });
    });
    act(() => {
      gridRef.current?.commands.hideColumn(tableId, cols[1]!);
    });
    expect(within(grid()).getAllByRole('columnheader')).toHaveLength(2);
    expect(cellAt(0, 1, 2)).toHaveAttribute('data-address', 'C5');
    fireEvent.keyDown(cellAt(0, 0, 2), { code: 'ArrowRight', key: 'ArrowRight' });
    expect(selected()).toBe('C5');
    act(() => {
      gridRef.current?.commands.unhideAllColumns(tableId);
    });
    expect(within(grid()).getAllByRole('columnheader')).toHaveLength(3);
    expect(cellAt(0, 2)).toHaveAttribute('data-address', 'D5');
  });
});

describe('structure affordances (GRID-07, GRID-08)', () => {
  it('GRID-07 the add-row strip and add-column stub render for the selected table only, one lattice unit each, and work', async () => {
    mount();
    expect(screen.queryByRole('button', { name: /Add row to/ })).not.toBeInTheDocument();
    await userEvent.click(cellAt(0, 0));
    const strip = screen.getByRole('button', { name: 'Add row to Table 1' });
    const stub = screen.getByRole('button', { name: 'Add column to Table 1' });
    expect(strip.style.height).toBe(`${String(LATTICE.row)}px`);
    expect(stub.style.width).toBe(`${String(LATTICE.col)}px`);
    expect(stub.style.height).toBe(`${String(LATTICE.row)}px`);
    expect(stub.style.left).toBe(`${String(LATTICE.col * 3)}px`);
    await userEvent.click(strip);
    expect(within(grid()).getAllByRole('row')).toHaveLength(5);
    expect(selected()).toBe('B8');
    await userEvent.click(stub);
    expect(within(grid()).getAllByRole('columnheader')).toHaveLength(4);
    expect(selected()).toBe('E8');
  });

  it('GRID-08 the column-header divider resizes that column by the keyboard, snapped to whole units, and the addresses follow', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    const divider = screen.getByRole('separator', { name: 'Resize column Column 1' });
    expect(divider).toHaveAttribute('aria-valuenow', '1');
    expect(divider.tabIndex).toBe(0); // the selected column's divider is the one tab stop
    expect(screen.getByRole('separator', { name: 'Resize column Column 2' }).tabIndex).toBe(-1);
    divider.focus();
    fireEvent.keyDown(divider, { code: 'ArrowRight', key: 'ArrowRight' });
    expect(screen.getByRole('separator', { name: 'Resize column Column 1' })).toHaveAttribute(
      'aria-valuenow',
      '2',
    );
    const header = within(grid()).getAllByRole('columnheader')[0]!;
    expect(header.style.width).toBe(`${String(LATTICE.col * 2)}px`);
    expect(cellAt(0, 0).style.width).toBe(`${String(LATTICE.col * 2)}px`);
    expect(cellAt(0, 1)).toHaveAttribute('data-address', 'D5');
    expect(screen.getByRole('button', { name: 'Add column to Table 1' }).style.left).toBe(
      `${String(LATTICE.col * 4)}px`,
    );
    expect(live()).toHaveTextContent('Column 1 is 2 units wide');
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize column Column 1' }), {
      code: 'ArrowLeft',
      key: 'ArrowLeft',
    });
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize column Column 1' }), {
      code: 'ArrowLeft',
      key: 'ArrowLeft',
    });
    expect(screen.getByRole('separator', { name: 'Resize column Column 1' })).toHaveAttribute(
      'aria-valuenow',
      '1',
    );
  });

  it('GRID-08 GRID-01 a pointer drag on the divider previews the snapped width and commits once on release', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    let writes = 0;
    gd.doc.on('update', () => {
      writes += 1;
    });
    const divider = screen.getByRole('separator', { name: 'Resize column Column 1' });
    fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientX: 100, clientY: 0 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 100 + 70, clientY: 0 }); // 170 px → rounds to 1 unit
    expect(cellAt(0, 0).style.width).toBe(`${String(LATTICE.col)}px`);
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 100 + 90, clientY: 0 }); // 250 px → 2 units
    expect(cellAt(0, 0).style.width).toBe(`${String(LATTICE.col * 2)}px`);
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 100 + 400, clientY: 0 }); // 560 px → 4 units
    expect(cellAt(0, 0).style.width).toBe(`${String(LATTICE.col * 4)}px`);
    expect(writes).toBe(0); // preview only
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 500, clientY: 0 });
    expect(writes).toBe(1);
    expect(tableById(gd, tableId)?.columns[0]?.width).toBe(4);
    expect(cellAt(0, 0).style.width).toBe(`${String(LATTICE.col * 4)}px`);
    // Dragging below one unit floors at one.
    const again = screen.getByRole('separator', { name: 'Resize column Column 1' });
    fireEvent.pointerDown(again, { pointerId: 2, button: 0, clientX: 800, clientY: 0 });
    fireEvent.pointerMove(again, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(again, { pointerId: 2, clientX: 0, clientY: 0 });
    expect(tableById(gd, tableId)?.columns[0]?.width).toBe(1);
  });

  it('GRID-08 the corner handle scales the whole table: the arrows share width out across the columns and snap rows to compact or wrapped', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    const corner = screen.getByRole('separator', { name: 'Resize Table 1' });
    expect(corner).toHaveAttribute('aria-valuenow', '3');
    expect(corner.tabIndex).toBe(0);
    fireEvent.keyDown(corner, { code: 'ArrowRight', key: 'ArrowRight' });
    expect(tableById(gd, tableId)?.columns.map((c) => c.width)).toEqual([2, 1, 1]);
    expect(screen.getByRole('separator', { name: 'Resize Table 1' })).toHaveAttribute(
      'aria-valuenow',
      '4',
    );
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Table 1' }), {
      code: 'ArrowDown',
      key: 'ArrowDown',
    });
    const dataRows = within(grid()).getAllByRole('row').slice(1);
    expect(dataRows.every((r) => r.style.height === `${String(LATTICE.row * 2)}px`)).toBe(true);
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B7');
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Table 1' }), {
      code: 'ArrowUp',
      key: 'ArrowUp',
    });
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B6');
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Table 1' }), {
      code: 'ArrowLeft',
      key: 'ArrowLeft',
    });
    expect(tableById(gd, tableId)?.columns.map((c) => c.width)).toEqual([1, 1, 1]);
    // A drag: 330 px right, 40 px down → 5 units wide (from 3), rows wrapped (3 rows: 66 → 106 ≥ 99).
    const handle = screen.getByRole('separator', { name: 'Resize Table 1' });
    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 330, clientY: 40 });
    expect(screen.getByRole('grid').closest<HTMLElement>('.gd-table')!.style.width).toBe(
      `${String(LATTICE.col * 5)}px`,
    );
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 330, clientY: 40 });
    expect(tableById(gd, tableId)?.columns.map((c) => c.width)).toEqual([2, 2, 1]);
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B7');
  });
});

describe('wrap, freeze, header and footer (GRID-09..11)', () => {
  it('GRID-09 a wrapped column makes every row two lattice units and the addresses stay exact', () => {
    mount();
    act(() => {
      gridRef.current?.commands.setColumnWrap(tableId, cols[1]!, true);
    });
    const dataRows = within(grid()).getAllByRole('row').slice(1);
    expect(dataRows.map((r) => r.style.height)).toEqual(
      Array<string>(3).fill(`${String(LATTICE.row * 2)}px`),
    );
    expect(cellAt(0, 1)).toHaveClass('gd-cell--wrap');
    expect(cellAt(0, 0)).toHaveAttribute('data-address', 'B5');
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B7');
    expect(cellAt(2, 0)).toHaveAttribute('data-address', 'B9');
    act(() => {
      gridRef.current?.commands.setColumnWrap(tableId, cols[1]!, false);
      gridRef.current?.commands.setRowWrap(tableId, rows[0]!, true);
    });
    expect(within(grid()).getAllByRole('row')[1]!.style.height).toBe(
      `${String(LATTICE.row * 2)}px`,
    );
    expect(within(grid()).getAllByRole('row')[2]!.style.height).toBe(`${String(LATTICE.row)}px`);
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B7');
    expect(cellAt(2, 0)).toHaveAttribute('data-address', 'B8');
    // A row wrapped on its own wraps every cell in it, and only that row.
    expect(cellAt(0, 0)).toHaveClass('gd-cell--wrap');
    expect(cellAt(0, 2)).toHaveClass('gd-cell--wrap');
    expect(cellAt(1, 0)).not.toHaveClass('gd-cell--wrap');
  });

  it('GRID-10 frozen columns are shaded with a heavier rule at the boundary, and the pinned panel carries them', () => {
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'Frozen text');
    const { rerender } = render(<Mount gd={gd} tableId={tableId} onGrid={() => undefined} />);
    act(() => {
      // Freeze two columns from the document side, as the inspector would.
      tableMap(gd, tableId)!.set('frozenColumns', 2);
    });
    expect(cellAt(0, 0)).toHaveClass('gd-cell--frozen');
    expect(cellAt(0, 1)).toHaveClass('gd-cell--frozen', 'gd-cell--freeze-edge');
    expect(cellAt(0, 2)).not.toHaveClass('gd-cell--frozen');
    expect(within(grid()).getAllByRole('columnheader')[1]).toHaveClass(
      'gd-table__header--freeze-edge',
    );
    expect(screen.queryByTestId('pinned-panel')).not.toBeInTheDocument();
    rerender(<Mount gd={gd} tableId={tableId} pinnedLeft={100} onGrid={() => undefined} />);
    const panel = screen.getByTestId('pinned-panel');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(panel.style.left).toBe('100px');
    expect(panel.style.width).toBe(`${String(LATTICE.col * 2)}px`);
    expect(panel).toHaveTextContent('Frozen text');
    expect(panel.querySelectorAll('[tabindex]')).toHaveLength(0);
    fireEvent.pointerDown(panel.querySelector('.gd-cell')!);
    expect(selected()).toBe('B5');
  });

  it('GRID-11 header 0 hides the column-header row and moves the addresses up; footer 1 shows a one-unit count strip', () => {
    mount();
    expect(within(grid()).getAllByRole('columnheader')).toHaveLength(3);
    act(() => {
      gridRef.current?.commands.setHeaderRows(tableId, 0);
    });
    expect(within(grid()).queryAllByRole('columnheader')).toHaveLength(0);
    expect(grid()).toHaveAttribute('aria-rowcount', '3');
    expect(cellAt(0, 0)).toHaveAttribute('data-address', 'B4');
    expect(screen.queryByTestId('table-footer')).not.toBeInTheDocument();
    act(() => {
      gridRef.current?.commands.setFooterRows(tableId, 1);
    });
    const footer = screen.getByTestId('table-footer');
    expect(footer.style.height).toBe(`${String(LATTICE.row)}px`);
    expect(footer).toHaveTextContent('3 rows');
    expect(footer).toHaveTextContent('3 columns');
    act(() => {
      gridRef.current?.commands.setHeaderRows(tableId, 1);
    });
    expect(cellAt(0, 0)).toHaveAttribute('data-address', 'B5');
  });
});

describe('commands keep the selection sane (GRID-02)', () => {
  it('GRID-02 deleting the selected row or column hands the selection to the neighbour; undo restores the cells', async () => {
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    setCellText(gd, tableId, rows[1]!, cols[1]!, 'middle');
    mount();
    await userEvent.click(cellAt(1, 1));
    act(() => {
      gridRef.current?.commands.deleteRow(tableId, rows[1]!);
    });
    expect(within(grid()).getAllByRole('row')).toHaveLength(3);
    expect(selected()).toBe('C6'); // the row that moved up into its place
    act(() => {
      undo.undo();
    });
    expect(within(grid()).getAllByRole('row')).toHaveLength(4);
    expect(cellAt(1, 1)).toHaveTextContent('middle');
    await userEvent.click(cellAt(1, 2));
    act(() => {
      gridRef.current?.commands.deleteColumn(tableId, cols[2]!);
    });
    expect(within(grid()).getAllByRole('columnheader')).toHaveLength(2);
    expect(selected()).toBe('C6'); // no column after: the one before
    act(() => {
      gridRef.current?.commands.insertRowAbove(tableId, rows[0]!);
    });
    expect(selected()).toBe('C5');
    expect(within(grid()).getAllByRole('row')).toHaveLength(5);
    act(() => {
      gridRef.current?.commands.insertColumnBefore(tableId, cols[0]!);
    });
    expect(selected()).toBe('B5');
  });
});

describe('read-only viewers (RESP-02, SHARE-03)', () => {
  it('RESP-02 with editable false nothing edits: no editor on Enter, typing or double-click, no strip, stub, divider or corner', async () => {
    mount({ editable: false });
    await userEvent.click(cellAt(0, 0));
    expect(cellAt(0, 0)).toHaveAttribute('aria-selected', 'true'); // selecting is allowed
    fireEvent.keyDown(cellAt(0, 0), { code: 'Enter', key: 'Enter' });
    fireEvent.keyDown(cellAt(0, 0), { code: 'KeyA', key: 'a' });
    await userEvent.dblClick(cellAt(0, 0));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    // Traversal works for reading, but never appends a row.
    await userEvent.click(cellAt(2, 2));
    const tab = new KeyboardEvent('keydown', {
      code: 'Tab',
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    cellAt(2, 2).dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(within(grid()).getAllByRole('row')).toHaveLength(4);
    fireEvent.keyDown(cellAt(2, 2), { code: 'ArrowDown', key: 'ArrowDown' });
    expect(within(grid()).getAllByRole('row')).toHaveLength(4);
    expect(gridRef.current?.commands.insertRowBelow(tableId)).toBeNull();
    expect(gridRef.current?.commands.setFrozenColumns(tableId, 1)).toBeNull();
  });
});

describe('rich text in the grid (marks, formats, undo)', () => {
  const bold = { type: 'bold' } as const;

  it('INSP-06 (partial) a marked cell renders its marks at rest, without ProseMirror', () => {
    setCellRich(
      gd,
      tableId,
      rows[0]!,
      cols[0]!,
      docNode([paragraphNode([textNode('Base ', [bold]), textNode('camp')])]),
    );
    mount();
    const cell = cellAt(0, 0);
    expect(cell.querySelector('.gd-rich strong')).toHaveTextContent('Base');
    expect(cell).toHaveTextContent('Base camp');
    expect(cell.querySelector('.ProseMirror')).toBeNull();
    expect(cell.getAttribute('aria-label')).toBe('B5, Base camp');
  });

  it('KEYS-05 (partial) ⌘B inside the editor marks the text; the mark survives commit and re-render', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'Everest');
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'Enter', key: 'Enter' });
    const editor = screen.getByLabelText('Edit B5');
    fireEvent.keyDown(editor, { code: 'KeyA', key: 'a', ctrlKey: true }); // ProseMirror's select-all
    fireEvent.keyDown(editor, { code: 'KeyB', key: 'b', metaKey: true });
    fireEvent.keyDown(editor, { code: 'Enter', key: 'Enter' });
    expect(cellAt(0, 0).querySelector('.gd-rich strong')).toHaveTextContent('Everest');
    expect(cellRich(tableMap(gd, tableId)!, rows[0]!, cols[0]!)).toEqual(
      docNode([paragraphNode([textNode('Everest', [bold])])]),
    );
    expect(selected()).toBe('B6');
    vi.restoreAllMocks();
  });

  it('KEYS-03 with the document undo manager, a committed rich edit is one step: undo reverts it', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh)');
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'Everest');
    undo.stopCapturing();
    const before = undo.undoStack.length;
    mount({ undo });
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'Enter', key: 'Enter' });
    const editor = screen.getByLabelText('Edit B5');
    fireEvent.keyDown(editor, { code: 'KeyA', key: 'a', ctrlKey: true });
    fireEvent.keyDown(editor, { code: 'KeyB', key: 'b', metaKey: true });
    fireEvent.keyDown(editor, { code: 'KeyI', key: 'i', metaKey: true });
    fireEvent.keyDown(editor, { code: 'Enter', key: 'Enter' });
    expect(undo.undoStack.length).toBe(before + 1);
    act(() => {
      undo.undo();
    });
    expect(cellAt(0, 0).querySelector('.gd-rich strong')).toBeNull();
    expect(cellAt(0, 0)).toHaveTextContent('Everest');
    vi.restoreAllMocks();
  });

  it('FMT-02 FMT-05 a Number column right-aligns and groups; text under it is tinted with a glyph, never zero', () => {
    setCellText(gd, tableId, rows[0]!, cols[0]!, '1234.5');
    setCellText(gd, tableId, rows[1]!, cols[0]!, 'n/a');
    setColumnFormat(gd, tableId, cols[0]!, 'number', { decimals: 2 });
    mount();
    expect(cellAt(0, 0).querySelector('.gd-rich')).toHaveClass('gd-rich--right');
    expect(cellAt(0, 0)).toHaveTextContent('1,234.50');
    expect(cellAt(0, 0).getAttribute('aria-label')).toBe('B5, 1,234.50');
    const invalid = cellAt(1, 0).querySelector('.gd-rich')!;
    expect(invalid).toHaveClass('gd-rich--invalid');
    expect(invalid.querySelector('svg[data-name="warning"]')).not.toBeNull();
    expect(cellAt(1, 0)).toHaveTextContent('n/a');
  });

  it('FMT-01 a cell override beats the column format; Automatic shows text as typed', () => {
    setCellText(gd, tableId, rows[0]!, cols[0]!, '2026');
    setCellText(gd, tableId, rows[1]!, cols[0]!, '2026');
    setColumnFormat(gd, tableId, cols[0]!, 'number');
    setCellFormat(gd, tableId, rows[1]!, cols[0]!, 'auto');
    mount();
    expect(cellAt(0, 0)).toHaveTextContent('2,026');
    expect(cellAt(1, 0)).toHaveTextContent('2026');
    expect(cellAt(1, 0).querySelector('.gd-rich')).toHaveClass('gd-rich--right');
  });

  it('GRID-10 the pinned panel mirrors marks and formats too', () => {
    setCellRich(
      gd,
      tableId,
      rows[0]!,
      cols[0]!,
      docNode([paragraphNode([textNode('Pinned', [bold])])]),
    );
    gd.doc.transact(() => {
      tableMap(gd, tableId)!.set('frozenColumns', 1);
    });
    mount({ pinnedLeft: 0 });
    const strongs = screen
      .getByRole('grid')
      .parentElement!.querySelectorAll('.gd-cell--frozen .gd-rich strong');
    expect(strongs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('row hierarchy in the grid (HIER, KEYS-06)', () => {
  /** Three more rows so the fixture is B5:D10; r1 and r2 nested under r0, r2 two deep. */
  function outlineFixture(): void {
    const r3 = addRow(gd, tableId);
    const r4 = addRow(gd, tableId);
    const r5 = addRow(gd, tableId);
    rows = [...rows, r3, r4, r5];
    rows.forEach((rowId, i) => {
      setCellText(gd, tableId, rowId, cols[0]!, `Row ${String(i + 1)}`);
    });
    nestRow(gd, tableId, rows[1]!);
    nestRow(gd, tableId, rows[2]!);
    nestRow(gd, tableId, rows[2]!);
  }
  const rowEls = () => within(grid()).getAllByRole('row').slice(1); // after the header
  const chevronIn = (row: HTMLElement) => within(row).queryByTestId('outline-chevron');
  const levels = () => rowEls().map((r) => r.getAttribute('aria-level'));

  // The chords resolve `mod` from the platform: ⌘ here, Ctrl elsewhere (I18N-02).
  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) jsdom');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HIER-04 HIER-09 depth indents the outline column by --outline-indent per level and prefixes ↳; no other column moves and no address changes', () => {
    outlineFixture();
    mount();
    const before = cells().map((el) => el.getAttribute('data-address'));
    expect(before.slice(0, 3)).toEqual(['B5', 'C5', 'D5']);
    // r2 at depth 2: the outline cell carries the depth; the others carry nothing.
    const outlineCell = cellAt(2, 0);
    expect(outlineCell).toHaveClass('gd-cell--outline');
    expect(outlineCell.style.getPropertyValue('--gd-outline-depth')).toBe('2');
    expect(within(outlineCell).getByText('↳')).toHaveAttribute('aria-hidden', 'true');
    expect(cellAt(2, 1)).not.toHaveClass('gd-cell--outline');
    expect(cellAt(2, 1).style.getPropertyValue('--gd-outline-depth')).toBe('');
    // The top-level row has no prefix and no indent.
    expect(cellAt(0, 0).style.getPropertyValue('--gd-outline-depth')).toBe('');
    expect(within(cellAt(0, 0)).queryByText('↳')).toBeNull();
    // HIER-09: addresses B5:D10 exactly as without any depth.
    expect(cells().map((el) => el.getAttribute('data-address'))).toEqual(before);
    expect(cellAt(2, 0)).toHaveAttribute('data-address', 'B7');
    // The rows speak their level to assistive tech.
    expect(levels()).toEqual(['1', '2', '3', '1', '1', '1']);
  });

  it('HIER-05 HIER-06 a row with descendants shows a labelled chevron with aria-expanded; pressing it hides the whole subtree, the rows below take the freed addresses, and the row says so', async () => {
    outlineFixture();
    mount();
    const parent = rowEls()[0]!;
    const child = rowEls()[1]!;
    const chevron = chevronIn(parent)!;
    expect(chevron.tagName).toBe('BUTTON');
    expect(chevron).toHaveAccessibleName('Collapse B5');
    expect(chevron).toHaveAttribute('aria-expanded', 'true');
    expect(parent).toHaveAttribute('aria-expanded', 'true');
    // r1 has r2 under it, so it has a chevron; r2, r3.. have none.
    expect(chevronIn(child)).not.toBeNull();
    expect(chevronIn(rowEls()[2]!)).toBeNull();
    expect(chevronIn(rowEls()[3]!)).toBeNull();
    await userEvent.click(chevron);
    // r1 and r2 (the grandchild) are gone; r3 moved from B8 to B6.
    expect(rowEls()).toHaveLength(4);
    expect(
      rowEls().map((r) => within(r).getAllByRole('gridcell')[0]!.getAttribute('data-address')),
    ).toEqual(['B5', 'B6', 'B7', 'B8']);
    expect(cellAt(1, 0)).toHaveTextContent('Row 4');
    expect(chevronIn(rowEls()[0]!)).toHaveAccessibleName('Expand B5');
    expect(rowEls()[0]).toHaveAttribute('aria-expanded', 'false');
    expect(grid()).toHaveAttribute('aria-rowcount', '5'); // header + 4
    expect(live()).toHaveTextContent('Collapsed the row');
    // Pressing the chevron did not arm the cell under it.
    expect(cellAt(0, 0)).not.toHaveAttribute('aria-selected');
    await userEvent.click(chevronIn(rowEls()[0]!)!);
    expect(rowEls()).toHaveLength(6);
    expect(live()).toHaveTextContent('Expanded the row');
    // A11Y-01: with a cell selected elsewhere, the chevron does not take its focus either.
    await userEvent.click(cellAt(3, 1));
    expect(cellAt(3, 1)).toHaveFocus();
    await userEvent.click(chevronIn(rowEls()[0]!)!);
    expect(rowEls()).toHaveLength(4);
    expect(cellAt(1, 1)).toHaveFocus(); // the same cell, now drawn one row up
    expect(selected()).toBe('C6');
  });

  it('HIER-06 collapsing with a cell inside the subtree selected hands the selection to the parent, before anything hides', async () => {
    outlineFixture();
    mount();
    await userEvent.click(cellAt(2, 1)); // C7, the grandchild
    expect(selected()).toBe('C7');
    act(() => {
      gridRef.current?.commands.setCollapsed(tableId, rows[0]!, true);
    });
    expect(selected()).toBe('C5');
    expect(cellAt(0, 1)).toHaveFocus();
  });

  it('HIER-06 A11Y-01 ⌥← collapses and ⌥→ expands the selected row by physical key; on a childless row they do nothing', async () => {
    outlineFixture();
    mount();
    await userEvent.click(cellAt(1, 2)); // D6, r1 (which has r2 under it)
    fireEvent.keyDown(cellAt(1, 2), { code: 'ArrowLeft', key: 'ArrowLeft', altKey: true });
    expect(rowEls()).toHaveLength(5);
    expect(selected()).toBe('D6');
    fireEvent.keyDown(cellAt(1, 2), { code: 'ArrowRight', key: 'ArrowRight', altKey: true });
    expect(rowEls()).toHaveLength(6);
    await userEvent.click(cellAt(4, 0)); // a leaf
    fireEvent.keyDown(cellAt(4, 0), { code: 'ArrowLeft', key: 'ArrowLeft', altKey: true });
    expect(rowEls()).toHaveLength(6);
    expect(selected()).toBe('B9');
  });

  it('KEYS-06 HIER-01 (partial: the keyboard half; the inspector mounts the panel in the integration PR) HIER-02 I18N-02 ⌘] nests and ⌘[ promotes the selected row by physical key, the subtree with it; a refused nest announces why', async () => {
    outlineFixture();
    mount();
    await userEvent.click(cellAt(3, 1)); // C8: r3, at depth 0 right after r0's subtree
    fireEvent.keyDown(cellAt(3, 1), { code: 'BracketRight', key: ']', metaKey: true });
    expect(rowEls()[3]).toHaveAttribute('aria-level', '2');
    expect(live()).toHaveTextContent('Nested to level 2');
    expect(selected()).toBe('C8'); // HIER-09: same address
    // Twice more: r2 above it is at depth 2, so depth 3 is the most HIER-02 allows; then it stops.
    fireEvent.keyDown(cellAt(3, 1), { code: 'BracketRight', key: ']', metaKey: true });
    fireEvent.keyDown(cellAt(3, 1), { code: 'BracketRight', key: ']', metaKey: true });
    expect(rowEls()[3]).toHaveAttribute('aria-level', '4');
    fireEvent.keyDown(cellAt(3, 1), { code: 'BracketRight', key: ']', metaKey: true });
    expect(rowEls()[3]).toHaveAttribute('aria-level', '4');
    expect(live()).toHaveTextContent('Cannot nest deeper than one level under the row above');
    // ⌘[ on r1 promotes it with r2 and (now) r3 under it.
    await userEvent.click(cellAt(1, 0));
    fireEvent.keyDown(cellAt(1, 0), { code: 'BracketLeft', key: '[', metaKey: true });
    expect(levels()).toEqual(['1', '1', '2', '3', '1', '1']);
    expect(live()).toHaveTextContent('Promoted to the top level');
    fireEvent.keyDown(cellAt(1, 0), { code: 'BracketLeft', key: '[', metaKey: true });
    expect(live()).toHaveTextContent('Already at the top level');
    // I18N-02: the produced character is irrelevant — a layout that types ௗ on that key still nests.
    fireEvent.keyDown(cellAt(1, 0), { code: 'BracketRight', key: 'ௗ', metaKey: true });
    expect(rowEls()[1]).toHaveAttribute('aria-level', '2');
    // Neither chord fires without the modifier, nor with Shift added.
    fireEvent.keyDown(cellAt(1, 0), { code: 'BracketLeft', key: '[' });
    fireEvent.keyDown(cellAt(1, 0), {
      code: 'BracketLeft',
      key: '{',
      metaKey: true,
      shiftKey: true,
    });
    expect(rowEls()[1]).toHaveAttribute('aria-level', '2');
  });

  it('KEYS-03 HIER-01 (partial: keyboard half) a nest by keyboard is one undo step', async () => {
    const undo = createUndoManager(gd);
    outlineFixture();
    undo.clear();
    mount({ undo });
    await userEvent.click(cellAt(3, 0));
    fireEvent.keyDown(cellAt(3, 0), { code: 'BracketRight', key: ']', metaKey: true });
    expect(undo.undoStack).toHaveLength(1);
    act(() => {
      undo.undo();
    });
    expect(rowEls()[3]).toHaveAttribute('aria-level', '1');
  });

  it('HIER-07 (partial: Split() in formulas) a split child row renders nested, read-only with the reason, and collapses with its parent', async () => {
    outlineFixture();
    markSplitChildren(gd, tableId, rows[3]!, [rows[4]!]);
    mount();
    const child = cellAt(4, 0);
    expect(rowEls()[4]).toHaveAttribute('aria-level', '2');
    expect(child).toHaveAttribute('aria-readonly', 'true');
    expect(child).toHaveAttribute('data-read-only', 'splitChild');
    expect(child).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Read-only: split child row'),
    );
    await userEvent.click(child);
    fireEvent.keyDown(child, { code: 'Enter', key: 'Enter' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(live()).toHaveTextContent('B9 is read-only: split child row');
    await userEvent.click(chevronIn(rowEls()[3]!)!);
    expect(rowEls()).toHaveLength(5);
  });

  it('HIER-08 while the table is grouped the outline column shows no depth, prefix or chevron, and the data keeps it; ungrouping restores the outline', () => {
    outlineFixture();
    gd.doc.transact(() => {
      tableMap(gd, tableId)!.set('groupBy', cols[1]);
    });
    mount();
    expect(cellAt(2, 0)).not.toHaveClass('gd-cell--outline');
    expect(screen.queryByTestId('outline-chevron')).toBeNull();
    expect(screen.queryByText('↳')).toBeNull();
    expect(rowEls()[2]).not.toHaveAttribute('aria-level');
    expect(rowMeta(tableMap(gd, tableId)!, rows[2]!).depth).toBe(2);
    act(() => {
      gd.doc.transact(() => {
        tableMap(gd, tableId)!.set('groupBy', null);
      });
    });
    expect(cellAt(2, 0)).toHaveClass('gd-cell--outline');
    expect(rowEls()[2]).toHaveAttribute('aria-level', '3');
  });

  it('HIER-04 the designated outline column carries the outline; a hidden one falls back to the first visible column', () => {
    outlineFixture();
    setOutlineColumn(gd, tableId, cols[1]!);
    mount();
    expect(cellAt(2, 1)).toHaveClass('gd-cell--outline');
    expect(cellAt(2, 0)).not.toHaveClass('gd-cell--outline');
    act(() => {
      hideColumn(gd, tableId, cols[1]!);
    });
    expect(cellAt(2, 0, 2)).toHaveClass('gd-cell--outline');
  });

  it('RESP-02 HIER-05 a read-only viewer sees the indent, the prefix and the chevron state but no control: nothing toggles, ⌘] and ⌥← write nothing', async () => {
    outlineFixture();
    setRowCollapsed(gd, tableId, rows[1]!, true);
    mount({ editable: false });
    expect(rowEls()).toHaveLength(5);
    const parent = rowEls()[0]!;
    const glyph = chevronIn(parent)!;
    expect(glyph.tagName).toBe('SPAN');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(parent).toHaveAttribute('aria-expanded', 'true');
    expect(rowEls()[1]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(cellAt(1, 0).style.getPropertyValue('--gd-outline-depth')).toBe('1');
    await userEvent.click(glyph);
    expect(rowEls()).toHaveLength(5);
    await userEvent.click(cellAt(2, 0));
    const chord = new KeyboardEvent('keydown', {
      code: 'BracketRight',
      key: ']',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    cellAt(2, 0).dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(false);
    fireEvent.keyDown(cellAt(0, 0), { code: 'ArrowLeft', key: 'ArrowLeft', altKey: true });
    expect(rowEls()).toHaveLength(5);
    expect(rowMeta(tableMap(gd, tableId)!, rows[2]!).depth).toBe(2);
    expect(gridRef.current?.commands.nestRow(tableId, rows[3]!)).toBe(false);
    expect(gridRef.current?.commands.collapseAll(tableId)).toEqual([]);
  });

  it('HIER-06 collapse all and expand all through the commands act on the whole table and keep the selection on a rendered row', async () => {
    outlineFixture();
    mount();
    await userEvent.click(cellAt(2, 2)); // D7, two deep
    act(() => {
      gridRef.current?.commands.collapseAll(tableId);
    });
    expect(rowEls()).toHaveLength(4);
    expect(selected()).toBe('D5');
    expect(live()).toHaveTextContent('Collapsed 2 rows');
    act(() => {
      gridRef.current?.commands.expandAll(tableId);
    });
    expect(rowEls()).toHaveLength(6);
    expect(live()).toHaveTextContent('Expanded 2 rows');
  });

  it('HIER-06 GRID-05 traversal skips a collapsed subtree: ArrowDown from the parent lands on the next drawn row', async () => {
    outlineFixture();
    setRowCollapsed(gd, tableId, rows[0]!, true);
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'ArrowDown', key: 'ArrowDown' });
    expect(selected()).toBe('B6');
    expect(cellAt(1, 0)).toHaveTextContent('Row 4');
  });

  it('HIER-10 GRID-10 a collaborator’s collapse arrives through the document: the subtree leaves the grid and the pinned mirror alike, and a selection on it moves', async () => {
    outlineFixture();
    gd.doc.transact(() => {
      tableMap(gd, tableId)!.set('frozenColumns', 1);
    });
    const other = openDocument(new Y.Doc());
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(gd.doc));
    mount({ pinnedLeft: 0 });
    await userEvent.click(cellAt(1, 1));
    const pinned = () => screen.getByTestId('pinned-panel');
    expect(pinned().querySelectorAll('.gd-cell--outline .gd-cell__branch')).toHaveLength(2);
    act(() => {
      setRowCollapsed(other, tableId, rows[0]!, true);
      Y.applyUpdate(gd.doc, Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(gd.doc)));
    });
    expect(rowEls()).toHaveLength(4);
    expect(pinned().querySelectorAll('.gd-table__row')).toHaveLength(5); // header + 4
    expect(pinned().querySelectorAll('.gd-cell__branch')).toHaveLength(0);
    expect(selected()).toBe('C5'); // the collapsed parent, same column
    expect(gridRef.current?.cell?.rowId).toBe(rows[0]);
  });
});
