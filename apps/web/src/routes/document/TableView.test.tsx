/**
 * TableView keyboard and pointer matrix (GRID-03..11, KEYS-06, I18N-01/02,
 * A11Y-01/04, RESP-02) against a real Yjs document — no shell, no room. The
 * harness is the same `useGrid` the shell uses, so what passes here is what
 * the document runs.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  createUndoManager,
  LATTICE,
  openDocument,
  setCellText,
  tableById,
  tableMap,
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
  grid: { current: Grid | null };
}

function Harness({
  gd,
  tableId,
  editable = true,
  pinnedLeft = null,
  tier = 'micro',
  grid,
}: HarnessProps) {
  const g = useGrid(gd, editable);
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

const grid = () => screen.getByRole('grid');
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
    expect(editor).toHaveValue('Kathmandu');
    expect(editor).toHaveFocus();
    await userEvent.type(editor, ' changed');
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
    expect(editor).toHaveValue('K');
    await userEvent.type(editor, 'ath');
    fireEvent.keyDown(editor, { code: 'Enter', key: 'Enter' });
    expect(cellAt(0, 0)).toHaveTextContent('Kath');
    expect(cellAt(0, 0)).not.toHaveTextContent('old');
  });

  it('I18N-02 the typed character comes from event.key, so a Tamil99 keystroke seeds Tamil; modifiers never type', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    fireEvent.keyDown(cellAt(0, 0), { code: 'KeyA', key: 'அ' });
    expect(screen.getByLabelText('Edit B5')).toHaveValue('அ');
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
    fireEvent.change(editor, { target: { value: 'தமிழ்' } });
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
    expect(screen.getByLabelText('Edit B6')).toHaveValue('');
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

describe('traversal (GRID-05, KEYS-06, A11Y-01)', () => {
  it('GRID-05 KEYS-06 Tab, Shift+Tab and the arrows move; Tab and the arrows wrap at row ends', async () => {
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
