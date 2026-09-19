/**
 * TableView keyboard and pointer matrix (GRID-03..11, KEYS-06, I18N-01/02,
 * A11Y-01/04, RESP-02) against a real Yjs document — no shell, no room. The
 * harness is the same `useGrid` the shell uses, so what passes here is what
 * the document runs.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  addColumnRule,
  addDerivedColumn,
  addMappingColumn,
  addRow,
  cellRich,
  columnsArray,
  createSheet,
  createTable,
  createUndoManager,
  docNode,
  hideColumn,
  LATTICE,
  markSplitChildren,
  mergeCells,
  commitCellText,
  setFrozenColumns,
  setHeaderRows,
  nestRow,
  openDocument,
  paragraphNode,
  promoteRow,
  rowMeta,
  setCellAppearance,
  setCellFormat,
  setCellRich,
  setCellText,
  setColumnAppearance,
  setColumnFormat,
  setColumnRules,
  setOutlineColumn,
  setRowCollapsed,
  setColumnWrap,
  setRowHeight,
  setRowWrap,
  TYPE_SIZE_PX,
  setTableLook,
  tableById,
  tableMap,
  textNode,
  unmergeCells,
  type GedeDoc,
  type Id,
  type PresenceState,
} from '@gede/core';

import { LiveRegion } from '../../announce.js';
import { useYVersion } from '../../doc/use-y.js';
import type { ZoomTier } from '../../doc/viewport.js';
import type { RenameTarget, TableRenaming } from './grid/rename.js';
import { useGrid, type Grid } from './grid/use-grid.js';
import { openViewStore, ViewStoreProvider, type ViewStore } from '../../doc/view-state.js';
import {
  createRuleEvaluator,
  setSharedRuleEvaluatorForTests,
  type FitMeasure,
  type FitOptions,
} from './style/index.js';
import { TableView } from './TableView.js';

interface HarnessProps {
  gd: GedeDoc;
  tableId: Id;
  editable?: boolean;
  pinnedLeft?: number | null;
  tier?: ZoomTier;
  undo?: Y.UndoManager | undefined;
  viewSorted?: boolean;
  presence?: readonly PresenceState[];
  /** ADR-049: a measurer for the auto-height of wrapped rows (jsdom has no canvas). */
  fit?: (() => FitOptions | null) | undefined;
  /** ADR-051: whether the shell hands the table its rename routes (it does when editable). */
  renamable?: boolean;
  grid: { current: Grid | null };
}

function Harness({
  gd,
  tableId,
  editable = true,
  pinnedLeft = null,
  tier = 'micro',
  undo,
  viewSorted,
  presence = [],
  fit,
  renamable = editable,
  grid,
}: HarnessProps) {
  const g = useGrid(gd, editable, { undo, fit });
  grid.current = g;
  useYVersion(gd.tables, { depth: 'shallow' });
  // ADR-051: the shell's rename state — one open field, committed through the grid commands.
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const rename: TableRenaming | undefined = renamable
    ? {
        target: renaming,
        start: setRenaming,
        commit: (target, name) => {
          const result =
            target.kind === 'column'
              ? g.commands.renameColumn(target.tableId, target.colId, name)
              : g.commands.setTableTitle(target.tableId, name);
          if (result.ok) setRenaming(null);
          return result;
        },
        cancel: () => {
          setRenaming(null);
        },
      }
    : undefined;
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  return (
    <ViewStoreProvider value={viewStore}>
      <TableView
        table={map}
        tier={tier}
        selected={g.state.selection?.tableId === tableId}
        selectedCell={g.cell}
        axisBand={g.state.selection?.tableId === tableId ? (g.state.selection.band ?? null) : null}
        fitter={
          fit === undefined
            ? undefined
            : {
                fit,
                reason: fit() === null ? 'text cannot be measured in this browser' : undefined,
              }
        }
        editing={g.state.editing}
        editable={editable}
        viewSorted={viewSorted}
        presence={presence}
        pinnedLeft={pinnedLeft}
        undo={undo}
        actions={g.actions}
        commands={g.commands}
        rename={rename}
      />
      <LiveRegion />
    </ViewStoreProvider>
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
/** The viewer's view store (ADR-026): grouping, sort and filter are the viewer's, never the document's. */
let viewStore: ViewStore;
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
  localStorage.clear();
  viewStore = openViewStore('user-1', 'doc-table-view');
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

  it('GRID-08 the corner handle scales the whole table: the arrows share width out across the columns and height across the rows, whole units each (ADR-049)', async () => {
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
    // ↓ adds one unit to the body: the first row takes it (distributeUnits' remainder rule).
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Table 1' }), {
      code: 'ArrowDown',
      key: 'ArrowDown',
    });
    let dataRows = within(grid()).getAllByRole('row').slice(1);
    expect(dataRows.map((r) => r.style.height)).toEqual(['44px', '22px', '22px']);
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B7');
    // Shift+↓: four more units → 8 in all, shared 3 / 3 / 2.
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Table 1' }), {
      code: 'ArrowDown',
      key: 'ArrowDown',
      shiftKey: true,
    });
    dataRows = within(grid()).getAllByRole('row').slice(1);
    expect(dataRows.map((r) => r.style.height)).toEqual(['88px', '44px', '44px']); // 2:1:1 kept
    expect(cellAt(2, 0)).toHaveAttribute('data-address', 'B11');
    expect(live()).toHaveTextContent('rows 8 units tall together');
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize Table 1' }), {
      code: 'ArrowLeft',
      key: 'ArrowLeft',
    });
    expect(tableById(gd, tableId)?.columns.map((c) => c.width)).toEqual([1, 1, 1]);
    // A drag: 330 px right, 40 px down → 5 units wide (from 3), 10 units tall (from 8).
    const handle = screen.getByRole('separator', { name: 'Resize Table 1' });
    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 330, clientY: 40 });
    expect(screen.getByRole('grid').closest<HTMLElement>('.gd-table')!.style.width).toBe(
      `${String(LATTICE.col * 5)}px`,
    );
    expect(
      within(grid())
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.style.height),
    ).toEqual(['110px', '66px', '44px']); // the live preview: 4:2:2 → 5:3:2
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 330, clientY: 40 });
    expect(tableById(gd, tableId)?.columns.map((c) => c.width)).toEqual([2, 2, 1]);
    expect(rows.map((r) => rowMeta(tableMap(gd, tableId)!, r).height)).toEqual([5, 3, 2]);
    expect(rowMeta(tableMap(gd, tableId)!, rows[0]!).fit).toBe(false);
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B10');
  });

  it('GRID-09 GRID-08 A11Y-01 a row divider in the gutter resizes the row by drag (live preview, one write) and by the keyboard; ⌥↓ from a cell focuses it (ADR-049)', async () => {
    mount();
    expect(screen.queryByRole('separator', { name: /Resize row/ })).not.toBeInTheDocument();
    await userEvent.click(cellAt(1, 0));
    // One divider per row, named by the ruler's row number; the selected row's is the tab stop.
    const dividers = screen.getAllByRole('separator', { name: /Resize row/ });
    expect(dividers.map((d) => d.getAttribute('aria-label'))).toEqual([
      'Resize row 5',
      'Resize row 6',
      'Resize row 7',
    ]);
    const divider = screen.getByRole('separator', { name: 'Resize row 6' });
    expect(divider).toHaveAttribute('aria-orientation', 'horizontal');
    expect(divider).toHaveAttribute('aria-valuenow', '1');
    expect(divider).toHaveAttribute('aria-valuemin', '1');
    expect(divider).not.toHaveAttribute('aria-valuemax');
    expect(divider.tabIndex).toBe(0);
    expect(screen.getByRole('separator', { name: 'Resize row 5' }).tabIndex).toBe(-1);
    // ⌥↓ from the cell focuses the row's bottom edge; ⌥↑ the edge above it (the row before's).
    fireEvent.keyDown(cellAt(1, 0), { code: 'ArrowDown', key: 'ArrowDown', altKey: true });
    expect(document.activeElement).toBe(divider);
    fireEvent.keyDown(cellAt(1, 0), { code: 'ArrowUp', key: 'ArrowUp', altKey: true });
    expect(document.activeElement).toBe(screen.getByRole('separator', { name: 'Resize row 5' }));
    // ⌥↑ on the first row has no edge above: nothing happens, the cell keeps focus.
    cellAt(0, 0).focus();
    fireEvent.keyDown(cellAt(0, 0), { code: 'ArrowUp', key: 'ArrowUp', altKey: true });
    expect(document.activeElement).toBe(cellAt(0, 0));
    divider.focus();
    let writes = 0;
    gd.doc.on('update', () => {
      writes += 1;
    });
    // A drag: 10 px down rounds to one unit (no change), 30 px to two, 50 px to three.
    fireEvent.pointerDown(divider, { pointerId: 5, button: 0, clientX: 0, clientY: 100 });
    fireEvent.pointerMove(divider, { pointerId: 5, clientX: 0, clientY: 110 });
    expect(cellAt(1, 0).closest('[role="row"]')).toHaveStyle({ height: '22px' });
    fireEvent.pointerMove(divider, { pointerId: 5, clientX: 0, clientY: 130 });
    expect(cellAt(1, 0).closest('[role="row"]')).toHaveStyle({ height: '44px' });
    fireEvent.pointerMove(divider, { pointerId: 5, clientX: 0, clientY: 150 });
    expect(cellAt(1, 0).closest('[role="row"]')).toHaveStyle({ height: '66px' });
    expect(cellAt(2, 0)).toHaveAttribute('data-address', 'B7'); // preview writes nothing
    expect(writes).toBe(0);
    fireEvent.pointerUp(divider, { pointerId: 5, clientX: 0, clientY: 150 });
    expect(writes).toBe(1);
    expect(rowMeta(tableMap(gd, tableId)!, rows[1]!)).toMatchObject({ height: 3, fit: false });
    expect(cellAt(2, 0)).toHaveAttribute('data-address', 'B9');
    expect(cellAt(1, 0).closest('[role="row"]')).toHaveAttribute(
      'aria-description',
      '3 units tall',
    );
    expect(live()).toHaveTextContent('Row 6 is 3 units tall');
    // Keyboard: ↑ one unit, ⇧↓ four, ⌥↑ one (the divider owns ⌥ arrows only while focused).
    const again = () => screen.getByRole('separator', { name: 'Resize row 6' });
    fireEvent.keyDown(again(), { code: 'ArrowUp', key: 'ArrowUp' });
    expect(again()).toHaveAttribute('aria-valuenow', '2');
    fireEvent.keyDown(again(), { code: 'ArrowDown', key: 'ArrowDown', shiftKey: true });
    expect(again()).toHaveAttribute('aria-valuenow', '6');
    fireEvent.keyDown(again(), { code: 'ArrowUp', key: 'ArrowUp', altKey: true });
    expect(again()).toHaveAttribute('aria-valuenow', '5');
    expect(again()).toHaveAttribute('aria-valuetext', '5 units, 110 px');
    // Below one unit it floors at one.
    fireEvent.pointerDown(again(), { pointerId: 6, button: 0, clientX: 0, clientY: 500 });
    fireEvent.pointerMove(again(), { pointerId: 6, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(again(), { pointerId: 6, clientX: 0, clientY: 0 });
    expect(rowMeta(tableMap(gd, tableId)!, rows[1]!).height).toBe(1);
  });

  it('GRID-08 KEYS-03 a press on a row handle or a column header selects the band; Shift extends it; a drag on any member resizes every member proportionally in one undo step (ADR-049, Numbers N2)', async () => {
    const undo = createUndoManager(gd);
    mount({ undo });
    await userEvent.click(cellAt(0, 0));
    // Rows 5 and 6 by handle and Shift-handle.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Select row 5' }), { button: 0 });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Select row 6' }), {
      button: 0,
      shiftKey: true,
    });
    expect(gridRef.current?.state.selection?.band).toEqual({
      axis: 'row',
      ids: [rows[0], rows[1]],
      anchor: rows[0],
    });
    expect(screen.getByRole('button', { name: 'Select row 5' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(cellAt(1, 0).closest('[role="row"]')).toHaveAttribute('aria-selected', 'true');
    expect(cellAt(2, 0).closest('[role="row"]')).not.toHaveAttribute('aria-selected');
    // Row 6 is two units already; dragging row 5's divider to 2 units doubles both (ratio 2).
    act(() => {
      setRowHeight(gd, tableId, rows[1]!, 2);
    });
    undo.stopCapturing();
    const divider = screen.getByRole('separator', { name: 'Resize row 5' });
    fireEvent.pointerDown(divider, { pointerId: 7, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(divider, { pointerId: 7, clientX: 0, clientY: 22 });
    expect(cellAt(0, 0).closest('[role="row"]')).toHaveStyle({ height: '44px' });
    expect(cellAt(1, 0).closest('[role="row"]')).toHaveStyle({ height: '88px' }); // previewed too
    expect(cellAt(2, 0).closest('[role="row"]')).toHaveStyle({ height: '22px' }); // not a member
    const before = undo.undoStack.length;
    fireEvent.pointerUp(divider, { pointerId: 7, clientX: 0, clientY: 22 });
    expect(rows.map((r) => rowMeta(tableMap(gd, tableId)!, r).height)).toEqual([2, 4, 1]);
    expect(undo.undoStack).toHaveLength(before + 1);
    expect(live()).toHaveTextContent('2 rows resized to 2, 4 units');
    undo.undo();
    expect(rows.map((r) => rowMeta(tableMap(gd, tableId)!, r).height)).toEqual([1, 2, 1]);
    // Columns: a press on a header selects it; ⇧→ from the cell extends to the next column.
    const headers = within(grid()).getAllByRole('columnheader');
    fireEvent.pointerDown(headers[0]!, { button: 0 });
    expect(gridRef.current?.state.selection?.band).toEqual({
      axis: 'column',
      ids: [cols[0]],
      anchor: cols[0],
    });
    expect(headers[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(cellAt(0, 0), { code: 'ArrowRight', key: 'ArrowRight', shiftKey: true });
    expect(gridRef.current?.state.selection?.band?.ids).toEqual([cols[0], cols[1]]);
    fireEvent.keyDown(cellAt(0, 0), { code: 'ArrowRight', key: 'ArrowRight', shiftKey: true });
    expect(gridRef.current?.state.selection?.band?.ids).toEqual([cols[0], cols[1], cols[2]]);
    // Dragging Column 1 to 2 units doubles all three; a divider outside a band resizes itself alone.
    const colDivider = screen.getByRole('separator', { name: 'Resize column Column 1' });
    fireEvent.pointerDown(colDivider, { pointerId: 8, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(colDivider, { pointerId: 8, clientX: 160, clientY: 0 });
    expect(cellAt(0, 2).style.width).toBe(`${String(LATTICE.col * 2)}px`);
    fireEvent.pointerUp(colDivider, { pointerId: 8, clientX: 160, clientY: 0 });
    expect(tableById(gd, tableId)?.columns.map((c) => c.width)).toEqual([2, 2, 2]);
    expect(live()).toHaveTextContent('3 columns are 2 units wide');
    // A plain arrow clears the band and moves.
    fireEvent.keyDown(cellAt(0, 0), { code: 'ArrowDown', key: 'ArrowDown' });
    expect(gridRef.current?.state.selection?.band).toBeUndefined();
  });

  it('INSP-04 GRID-08 GRID-09 double-click or Enter on a divider fits the column or the row to its content, with a measurer; without one the divider says why (ADR-049, Numbers N5)', async () => {
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'x'.repeat(40)); // 40 × 5.75 = 230 px + chrome → 2 units
    setColumnWrap(gd, tableId, cols[0]!, true);
    setRowHeight(gd, tableId, rows[0]!, 5); // set by hand: fit brings it back to what it needs
    const measure: FitMeasure = {
      measure: (text, font) => text.length * (TYPE_SIZE_PX[font.size] / 2),
    };
    mount({ fit: () => ({ locale: 'en-US', measure }) });
    await userEvent.click(cellAt(0, 0));
    // Enter on the row divider: 230 px wraps into two lines in one unit of width (143 px of
    // text room): 2 × 15.5 + 2 px → 2 units, and the row follows its content again.
    const rowDivider = screen.getByRole('separator', { name: 'Resize row 5' });
    expect(rowDivider).toHaveAttribute('aria-valuenow', '5');
    expect(rowDivider.title).toMatch(/double-click or Enter fits to content/);
    fireEvent.keyDown(rowDivider, { code: 'Enter', key: 'Enter' });
    expect(rowMeta(tableMap(gd, tableId)!, rows[0]!)).toMatchObject({ height: 2, fit: true });
    expect(live()).toHaveTextContent('Row 5 fits its content: 2 units tall');
    // Double-click on the column divider: the widest line + chrome → 2 units; the row that
    // now follows its content drops to one line in the same step (auto-height, R-B).
    const colDivider = screen.getByRole('separator', { name: 'Resize column Column 1' });
    fireEvent.doubleClick(colDivider);
    expect(tableById(gd, tableId)?.columns[0]?.width).toBe(2);
    expect(live()).toHaveTextContent('Fitted 1 column to content');
    expect(rowMeta(tableMap(gd, tableId)!, rows[0]!)).toMatchObject({ height: 1, fit: true });
  });

  it('INSP-04 a divider without a measurer carries the reason and neither double-click nor Enter writes', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    const divider = screen.getByRole('separator', { name: 'Resize column Column 1' });
    expect(divider.title).toMatch(/text cannot be measured in this browser/);
    fireEvent.doubleClick(divider);
    fireEvent.keyDown(divider, { code: 'Enter', key: 'Enter' });
    expect(tableById(gd, tableId)?.columns[0]?.width).toBe(1);
  });
});

describe('wrap, freeze, header and footer (GRID-09..11)', () => {
  it('GRID-09 wrap is paint at cell, row, column and table scope; heights are separate data, so a tall row shows its unwrapped cells on one line (ADR-049)', () => {
    mount();
    act(() => {
      gridRef.current?.commands.setColumnWrap(tableId, cols[1]!, true);
    });
    // Without a measurer nothing writes a height: the rows stay one unit, addresses too.
    const dataRows = within(grid()).getAllByRole('row').slice(1);
    expect(dataRows.map((r) => r.style.height)).toEqual(
      Array<string>(3).fill(`${String(LATTICE.row)}px`),
    );
    expect(cellAt(0, 1)).toHaveClass('gd-cell--wrap');
    expect(cellAt(0, 0)).not.toHaveClass('gd-cell--wrap');
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B6');
    // A row's wrap beats the column's; a cell's beats the row's; the table's is the default.
    act(() => {
      gridRef.current?.commands.setRowWrap(tableId, rows[0]!, false);
      gridRef.current?.commands.setTableWrap(tableId, true);
    });
    expect(cellAt(0, 1)).not.toHaveClass('gd-cell--wrap');
    expect(cellAt(1, 0)).toHaveClass('gd-cell--wrap'); // the table's default
    act(() => {
      gridRef.current?.commands.setCellAppearance(
        { tableId, rowId: rows[0]!, colId: cols[2]! },
        { wrap: true },
      );
    });
    expect(cellAt(0, 2)).toHaveClass('gd-cell--wrap');
    expect(live()).toHaveTextContent('Wrapped for D5');
    // A hand-set height of three units: every cell of the row is tall; only wrapping ones wrap.
    act(() => {
      gridRef.current?.commands.setRowHeights(tableId, [{ rowId: rows[0]!, units: 3 }]);
    });
    expect(within(grid()).getAllByRole('row')[1]!.style.height).toBe(
      `${String(LATTICE.row * 3)}px`,
    );
    expect(cellAt(0, 0)).toHaveClass('gd-cell--tall');
    expect(cellAt(0, 0)).not.toHaveClass('gd-cell--wrap');
    expect(cellAt(0, 2)).toHaveClass('gd-cell--tall', 'gd-cell--wrap');
    expect(cellAt(1, 0)).toHaveAttribute('data-address', 'B8');
    expect(cellAt(1, 0)).not.toHaveClass('gd-cell--tall');
  });

  it('GRID-09 INSP-06 text is cut at the last whole line that fits the row: `--gd-lines` follows the row height and the type size, wrapped or not (#167 criterion 11)', () => {
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'one\ntwo\nthree\nfour');
    mount();
    // One unit, cell size: 21 px holds one 15.5 px line.
    expect(cellAt(0, 0).style.getPropertyValue('--gd-lines')).toBe('1');
    expect(cellAt(0, 0).style.getPropertyValue('--gd-line-px')).toBe('15.525px');
    act(() => {
      setRowHeight(gd, tableId, rows[0]!, 3); // 65 px → four lines would be 62.1; padding-free
    });
    expect(cellAt(0, 0).style.getPropertyValue('--gd-lines')).toBe('4');
    act(() => {
      setRowWrap(gd, tableId, rows[0]!, true); // 2 px of padding: 63 px → still 4 lines
    });
    expect(cellAt(0, 0).style.getPropertyValue('--gd-lines')).toBe('4');
    act(() => {
      setRowHeight(gd, tableId, rows[0]!, 2); // 43 − 2 = 41 px → 2 lines of 15.5
    });
    expect(cellAt(0, 0).style.getPropertyValue('--gd-lines')).toBe('2');
    act(() => {
      gridRef.current?.commands.setCellAppearance(
        { tableId, rowId: rows[0]!, colId: cols[0]! },
        { size: 'h2' }, // 25 px line box: one line in 41 px
      );
    });
    expect(cellAt(0, 0).style.getPropertyValue('--gd-lines')).toBe('1');
    expect(cellAt(0, 0).style.getPropertyValue('--gd-line-px')).toBe('25px');
    // The full text stays on the cell's tooltip (Numbers N9: clipped, never spilled).
    expect(cellAt(0, 0).title).toBe('one\ntwo\nthree\nfour');
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

describe('column width with the header row hidden, and fit on a fresh table (GRID-08, ADR-051)', () => {
  it('GRID-08 GRID-11 A11Y-01 with header rows 0 the column dividers sit in a strip over the first body row: the selected column’s is the tab stop before the grid, the keyboard and a drag resize it, the grid’s rows are untouched', async () => {
    mount();
    act(() => {
      gridRef.current?.commands.setHeaderRows(tableId, 0);
    });
    await userEvent.click(cellAt(0, 1));
    expect(within(grid()).queryAllByRole('columnheader')).toHaveLength(0);
    const strip = screen.getByTestId('divider-strip');
    expect(strip.style.top).toBe(`${String(2 * LATTICE.row)}px`);
    expect(strip.style.height).toBe(`${String(LATTICE.row)}px`);
    // The strip is outside the grid, before it: aria-rowcount counts data rows only.
    expect(grid()).toHaveAttribute('aria-rowcount', '3');
    expect(strip.contains(grid())).toBe(false);
    expect(strip.compareDocumentPosition(grid()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const dividers = within(strip).getAllByRole('separator');
    expect(dividers.map((d) => d.getAttribute('aria-label'))).toEqual([
      'Resize column Column 1',
      'Resize column Column 2',
      'Resize column Column 3',
    ]);
    expect(dividers.map((d) => d.tabIndex)).toEqual([-1, 0, -1]);
    // Each slot is its column's box, so the divider lands on the boundary.
    const slots = strip.querySelectorAll<HTMLElement>('.gd-table__divider-slot');
    expect(Array.from(slots).map((el) => el.style.left)).toEqual(['0px', '160px', '320px']);
    dividers[1]!.focus();
    fireEvent.keyDown(dividers[1]!, { code: 'ArrowRight', key: 'ArrowRight' });
    expect(tableById(gd, tableId)?.columns[1]?.width).toBe(2);
    expect(cellAt(0, 1).style.width).toBe(`${String(LATTICE.col * 2)}px`);
    expect(cellAt(0, 2)).toHaveAttribute('data-address', 'E4');
    expect(live()).toHaveTextContent('Column 2 is 2 units wide');
    // A drag on the first column's divider previews and commits once (as at the header).
    let writes = 0;
    gd.doc.on('update', () => {
      writes += 1;
    });
    const first = within(screen.getByTestId('divider-strip')).getAllByRole('separator')[0]!;
    fireEvent.pointerDown(first, { pointerId: 1, button: 0, clientX: 100, clientY: 0 });
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 100 + 400, clientY: 0 });
    expect(cellAt(0, 0).style.width).toBe(`${String(LATTICE.col * 4)}px`);
    expect(writes).toBe(0);
    fireEvent.pointerUp(first, { pointerId: 1, clientX: 500, clientY: 0 });
    expect(writes).toBe(1);
    expect(tableById(gd, tableId)?.columns[0]?.width).toBe(4);
    // Showing the header row again moves the dividers back into it; the strip goes.
    act(() => {
      gridRef.current?.commands.setHeaderRows(tableId, 1);
    });
    expect(screen.queryByTestId('divider-strip')).not.toBeInTheDocument();
    expect(within(grid()).getAllByRole('columnheader')).toHaveLength(3);
  });

  it('GRID-08 the strip renders only where a divider can: not for a read-only viewer', () => {
    setHeaderRows(gd, tableId, 0);
    mount({ editable: false });
    expect(screen.queryByTestId('divider-strip')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
  });

  it('GRID-08 INSP-04 double-click on a divider fits a freshly created table with its default “Column N” headers: the fit route is gated on a measurer only, never on the table’s age or content', async () => {
    const measure: FitMeasure = {
      measure: (text, font) => text.length * (TYPE_SIZE_PX[font.size] / 2),
    };
    // A new table: empty cells, "Column 1".."Column 3" — the customer's case.
    mount({ fit: () => ({ locale: 'en-US', measure }) });
    await userEvent.click(cellAt(0, 0));
    const divider = screen.getByRole('separator', { name: 'Resize column Column 1' });
    expect(divider.title).toMatch(/double-click or Enter fits to content/);
    // Widen it by hand first, so the fit has something to bring back.
    fireEvent.keyDown(divider, { code: 'ArrowRight', key: 'ArrowRight', shiftKey: true });
    expect(tableById(gd, tableId)?.columns[0]?.width).toBe(5);
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize column Column 1' }));
    // "Column 1" at 8 × 6.5 = 52 px + chrome → one unit: the header label alone sizes it.
    expect(tableById(gd, tableId)?.columns[0]?.width).toBe(1);
    expect(live()).toHaveTextContent('Fitted 1 column to content');
  });
});

describe('inline rename of the title and the column headers (ADR-051)', () => {
  const columnField = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Column name' });
  const titleField = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Table title' });
  const header = (i: number) => within(grid()).getAllByRole('columnheader')[i]!;

  it('KEYS-06 KEYS-08 A11Y-01 F2 with a column selected (⇧→ from a cell) opens the header’s field in place of the label, selected, not a tab stop of the grid; Enter writes the name as one undo step, announces it and puts focus back on the cell; @ paths keep resolving (REF-01)', async () => {
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'Namche');
    setCellText(gd, tableId, rows[0]!, cols[1]!, '3440');
    commitCellText(gd, tableId, rows[1]!, cols[2]!, '=Sum(@"Table 1".Namche."Column 2")');
    mount({ undo });
    await userEvent.click(cellAt(0, 1));
    fireEvent.keyDown(cellAt(0, 1), { code: 'F2', key: 'F2' });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
    // ⇧→ selects Column 2 from the cell; F2 then renames the band's anchor column.
    fireEvent.keyDown(cellAt(0, 1), { code: 'ArrowRight', key: 'ArrowRight', shiftKey: true });
    expect(header(1)).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(cellAt(0, 1), { code: 'F2', key: 'F2' });
    const field = columnField();
    expect(field.closest('[role="columnheader"]')).toBe(header(1));
    expect(field).toHaveValue('Column 2');
    expect(field).toHaveFocus();
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('Column 2'.length);
    expect(within(header(1)).queryByText('Column 2')).not.toBeInTheDocument();
    // The grid keeps its one tab stop among the cells (A11Y-01).
    expect(cells().filter((el) => el.tabIndex === 0)).toHaveLength(1);
    const steps = undo.undoStack.length;
    await userEvent.clear(field);
    await userEvent.type(field, ' Owner {Enter}');
    expect(tableById(gd, tableId)?.columns[1]?.label).toBe('Owner'); // trimmed
    expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
    expect(within(header(1)).getByText('Owner')).toBeInTheDocument();
    expect(live()).toHaveTextContent('Renamed column Column 2 to Owner');
    expect(cellAt(0, 1)).toHaveFocus();
    expect(undo.undoStack).toHaveLength(steps + 1);
    // The formula is bound to the column's id: the value holds and the text re-spells.
    expect(cellAt(1, 2)).toHaveTextContent(/3,440/);
    expect(cellAt(1, 2)).toHaveTextContent('=Sum(@"Table 1".Namche.Owner)');
    act(() => {
      undo.undo();
    });
    expect(tableById(gd, tableId)?.columns[1]?.label).toBe('Column 2');
  });

  it('KEYS-08 MENU-05 a double-click on the label opens the field; Escape keeps the old name and returns focus; an empty name is refused beside the field and in the live region; an unchanged name writes nothing; Enter on the focused header opens it too', async () => {
    let writes = 0;
    gd.doc.on('update', () => {
      writes += 1;
    });
    mount();
    await userEvent.click(cellAt(0, 0));
    await userEvent.dblClick(within(header(2)).getByText('Column 3'));
    const field = columnField();
    expect(field).toHaveFocus();
    await userEvent.type(field, 'Nope');
    fireEvent.keyDown(field, { code: 'Escape', key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
    expect(tableById(gd, tableId)?.columns[2]?.label).toBe('Column 3');
    // The presses under the double-click selected Column 3 (ADR-049) and put focus on its
    // header; Escape went to the field, not the shell: that selection stands, focus is back
    // on the header — where Enter renames again.
    expect(header(2)).toHaveAttribute('aria-selected', 'true');
    expect(cellAt(0, 2)).toHaveAttribute('aria-selected', 'true');
    expect(header(2)).toHaveFocus();
    fireEvent.keyDown(header(2), { code: 'Enter', key: 'Enter' });
    const again = columnField();
    await userEvent.clear(again);
    fireEvent.keyDown(again, { code: 'Enter', key: 'Enter' });
    expect(again).toBeInTheDocument();
    expect(again).toHaveAttribute('aria-invalid', 'true');
    expect(again).toHaveAttribute('placeholder', 'A column needs a name');
    expect(live()).toHaveTextContent('A column needs a name');
    expect(again).toHaveFocus();
    // The same name again: no write, the field closes.
    await userEvent.type(again, 'Column 3');
    const before = writes;
    fireEvent.keyDown(again, { code: 'Enter', key: 'Enter' });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
    expect(writes).toBe(before);
    expect(header(2)).toHaveFocus();
    // Leaving the field commits what is typed.
    await userEvent.dblClick(within(header(2)).getByText('Column 3'));
    await userEvent.clear(columnField());
    await userEvent.type(columnField(), 'Status');
    fireEvent.blur(columnField());
    expect(tableById(gd, tableId)?.columns[2]?.label).toBe('Status');
  });

  it('I18N-01 GRID-08 the field ignores Enter and Escape while an IME composes; a double-click on the divider fits rather than renames', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    await userEvent.dblClick(within(header(0)).getByText('Column 1'));
    const field = columnField();
    fireEvent.keyDown(field, { code: 'Enter', key: 'Enter', isComposing: true });
    fireEvent.keyDown(field, { code: 'Escape', key: 'Escape', keyCode: 229 });
    expect(columnField()).toBeInTheDocument();
    fireEvent.keyDown(field, { code: 'Escape', key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize column Column 1' }));
    expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
  });

  it('KEYS-08 MENU-05 the title: F2 with the table selected, Enter on the focused title bar or a double-click on the title text opens the title field; Enter renames the table and announces it; Escape keeps the title; an empty title is refused', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    // ⌘A's outcome: the table selected, no cell armed, focus still on the cell.
    act(() => {
      gridRef.current?.actions.selectTable(tableId);
    });
    fireEvent.keyDown(cellAt(0, 0), { code: 'F2', key: 'F2' });
    const field = titleField();
    expect(field).toHaveValue('Table 1');
    expect(field).toHaveFocus();
    expect(field.closest('.gd-table__title')).not.toBeNull();
    await userEvent.clear(field);
    await userEvent.type(field, 'Owners{Enter}');
    expect(tableById(gd, tableId)?.title).toBe('Owners');
    expect(live()).toHaveTextContent('Renamed table Table 1 to Owners');
    expect(screen.getByRole('grid', { name: 'Owners' })).toBeInTheDocument();
    // Focus lands on the title bar (focusable by script and pointer only, never a tab stop):
    // back on the cell it would have armed it and talked over the announcement. The table
    // stays selected; Enter on the bar renames again.
    const bar = document.querySelector<HTMLElement>('.gd-table__title')!;
    expect(bar.tabIndex).toBe(-1);
    expect(bar).toHaveFocus();
    expect(selected()).toBeNull();
    fireEvent.keyDown(bar, { code: 'Enter', key: 'Enter' });
    expect(titleField()).toHaveFocus();
    fireEvent.keyDown(titleField(), { code: 'Escape', key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Table title' })).not.toBeInTheDocument();
    expect(tableById(gd, tableId)?.title).toBe('Owners');
    expect(bar).toHaveFocus();
    await userEvent.dblClick(screen.getByText('Owners', { selector: '.gd-table__title-text' }));
    expect(titleField()).toHaveFocus();
    await userEvent.clear(titleField());
    fireEvent.keyDown(titleField(), { code: 'Enter', key: 'Enter' });
    expect(titleField()).toHaveAttribute('placeholder', 'A table needs a title');
    expect(tableById(gd, tableId)?.title).toBe('Owners');
  });

  it('REF-05 MENU-02 a derived or a mapping column gets no field from any route — a double-click on the label, Enter or F2 on the header, F2 with the column selected — and each route says why', async () => {
    const regions = createTable(gd, {
      sheetId: tableById(gd, tableId)!.sheetId,
      at: { col: 8, row: 1 },
      columns: 1,
      rows: 1,
      title: 'Regions',
    });
    const linked = addMappingColumn(gd, tableId, {
      tableId: regions,
      colId: tableById(gd, regions)!.columns[0]!.id,
    })!;
    const derived = addDerivedColumn(gd, tableId, {
      sourceColId: cols[0]!,
      method: 'Format',
      args: ['Trimmed'],
    })!;
    mount();
    await userEvent.click(cellAt(0, 0, 5));
    const headerOf = (colId: Id) =>
      within(grid())
        .getAllByRole('columnheader')
        .find((h) => h.dataset.colId === colId)!;
    const noField = () =>
      expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
    // The mapping column: `↔ Regions · Column 1`.
    await userEvent.dblClick(within(headerOf(linked)).getByText(/^↔ Regions/));
    noField();
    expect(live()).toHaveTextContent(
      'Column ↔ Regions · Column 1 keeps its name: a mapping column is named by its target',
    );
    headerOf(linked).focus();
    fireEvent.keyDown(headerOf(linked), { code: 'Enter', key: 'Enter' });
    noField();
    fireEvent.keyDown(headerOf(linked), { code: 'F2', key: 'F2' });
    noField();
    // The derived column, selected as a band from the header press: F2 from its anchor cell.
    await userEvent.dblClick(within(headerOf(derived)).getByText(/^@/));
    noField();
    expect(live()).toHaveTextContent('keeps its name: a derived column is named by its signature');
    expect(headerOf(derived)).toHaveAttribute('aria-selected', 'true');
    const anchor = cells().find((el) => el.getAttribute('aria-selected') === 'true')!;
    fireEvent.keyDown(anchor, { code: 'F2', key: 'F2' });
    noField();
    // Focus never went into a field: the keyboard is where the press left it.
    expect(document.activeElement?.matches('input')).toBe(false);
    // An entered column still renames from the same routes.
    await userEvent.dblClick(within(headerOf(cols[1]!)).getByText('Column 2'));
    expect(columnField()).toHaveFocus();
  });

  it('REF-01 MENU-05 a duplicate name is refused in the field with the reason shown beside it and said once; leaving the field with a refused name cancels — the label returns and focus is not taken back', async () => {
    mount();
    await userEvent.click(cellAt(0, 0));
    await userEvent.dblClick(within(header(1)).getByText('Column 2'));
    const field = columnField();
    await userEvent.clear(field);
    await userEvent.type(field, 'column 3{Enter}');
    expect(field).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveValue('column 3');
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('column 3'.length);
    const reason = document.getElementById(field.getAttribute('aria-describedby') ?? '')!;
    expect(reason).toHaveTextContent('Another column is already named Column 3');
    expect(reason).toHaveClass('gd-table__rename-reason');
    expect(reason).not.toHaveClass('gd-visually-hidden');
    expect(live()).toHaveTextContent('Another column is already named Column 3');
    expect(tableById(gd, tableId)?.columns[1]?.label).toBe('Column 2');
    // Typing again clears the refusal; leaving with the refused name still typed cancels.
    await userEvent.type(field, '!');
    expect(field).not.toHaveAttribute('aria-invalid');
    await userEvent.clear(field);
    await userEvent.type(field, 'Column 1');
    await userEvent.click(cellAt(2, 2));
    expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
    expect(tableById(gd, tableId)?.columns[1]?.label).toBe('Column 2');
    expect(within(header(1)).getByText('Column 2')).toBeInTheDocument();
    expect(cellAt(2, 2)).toHaveFocus();
    // The title: a duplicate across the workbook is refused the same way.
    createTable(gd, {
      sheetId: tableById(gd, tableId)!.sheetId,
      at: { col: 8, row: 8 },
      columns: 1,
      rows: 1,
      title: 'Other',
    });
    act(() => {
      gridRef.current?.actions.selectTable(tableId);
    });
    fireEvent.keyDown(cellAt(2, 2), { code: 'F2', key: 'F2' });
    await userEvent.clear(titleField());
    await userEvent.type(titleField(), 'other{Enter}');
    expect(titleField()).toHaveAttribute('aria-invalid', 'true');
    expect(live()).toHaveTextContent('Another table is already named Other');
    expect(tableById(gd, tableId)?.title).toBe('Table 1');
  });

  it('RESP-02 SHARE-03 without the rename routes (phone, view-only) nothing opens on F2, Enter or a double-click, and the title bar is not focusable', async () => {
    mount({ editable: false });
    await userEvent.dblClick(within(header(0)).getByText('Column 1'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    header(0).focus();
    fireEvent.keyDown(header(0), { code: 'F2', key: 'F2' });
    fireEvent.keyDown(header(0), { code: 'Enter', key: 'Enter' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.dblClick(screen.getByText('Table 1'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelector<HTMLElement>('.gd-table__title')?.hasAttribute('tabindex')).toBe(
      false,
    );
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

  it('SHARE-04 a collaborator’s selection renders as an outline in their presence colour with a name tag', () => {
    mount({
      presence: [
        {
          userId: 'u-2',
          name: 'Sembian V',
          colour: 4,
          sheetId: null,
          cell: { tableId, rowId: rows[1]!, colId: cols[2]! },
        },
      ],
    });
    const tagged = screen.getByLabelText('Sembian V is here');
    expect(tagged).toHaveClass('gd-cell__presence-tag');
    const cell = tagged.closest('.gd-cell');
    expect(cell).toHaveClass('gd-cell--presence');
    expect(cell).toHaveStyle({ '--gd-presence': 'var(--presence-4)' });
    // One outline per collaborator, none anywhere else.
    expect(document.querySelectorAll('.gd-cell--presence')).toHaveLength(1);
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
    expect(chevron).toHaveAccessibleName('Collapse B5 (⌥←)');
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
    expect(chevronIn(rowEls()[0]!)).toHaveAccessibleName('Expand B5 (⌥→)');
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

  it('HIER-08 while the viewer groups the table the outline column shows no depth, prefix or chevron, and the data keeps it; ungrouping restores the outline', async () => {
    outlineFixture();
    viewStore.set(tableId, { sortBy: null, filter: null, groupBy: cols[1]! });
    mount();
    // The projection (bands) lands a tick later; the outline is hidden from the first render.
    expect(cellAt(2, 0)).not.toHaveClass('gd-cell--outline');
    expect(screen.queryByTestId('outline-chevron')).toBeNull();
    expect(screen.queryByText('↳')).toBeNull();
    expect(rowEls()[2]).not.toHaveAttribute('aria-level');
    expect(rowMeta(tableMap(gd, tableId)!, rows[2]!).depth).toBe(2);
    await screen.findAllByTestId('group-band');
    act(() => {
      viewStore.clear(tableId);
    });
    await waitFor(() => {
      expect(cellAt(2, 0)).toHaveClass('gd-cell--outline');
    });
    expect(rowEls()[2]).toHaveAttribute('aria-level', '3');
  });

  it('HIER-08 under the viewer’s sort or filter the outline is not drawn, the table is a plain grid, and ⌘] ⌘[ ⌥← announce why instead of writing', async () => {
    outlineFixture();
    mount({ viewSorted: true });
    expect(screen.queryByRole('treegrid')).toBeNull();
    expect(cellAt(2, 0)).not.toHaveClass('gd-cell--outline');
    expect(screen.queryByTestId('outline-chevron')).toBeNull();
    expect(rowEls()[2]).not.toHaveAttribute('aria-level');
    await userEvent.click(cellAt(3, 1));
    const chord = new KeyboardEvent('keydown', {
      code: 'BracketRight',
      key: ']',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    cellAt(3, 1).dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(true); // handled, so nothing else takes the chord
    fireEvent.keyDown(cellAt(3, 1), { code: 'BracketLeft', key: '[', metaKey: true });
    fireEvent.keyDown(cellAt(0, 0), { code: 'ArrowLeft', key: 'ArrowLeft', altKey: true });
    expect(live()).toHaveTextContent(
      'Hierarchy is unavailable while the view is sorted or filtered',
    );
    expect(rowMeta(tableMap(gd, tableId)!, rows[3]!).depth).toBe(0);
    expect(rowMeta(tableMap(gd, tableId)!, rows[0]!).collapsed).toBe(false);
    expect(rowEls()).toHaveLength(6);
  });

  it('HIER-04 HIER-09 KEYS-06 ⌘] on a cell in column D nests the row with its outline in D — the indent and ↳ render there, B carries nothing, no address moves, the selection stays — while the rows nested from B keep theirs; the chevron sits in the parent’s column; ⌘[ back to the top level clears the column', async () => {
    outlineFixture();
    mount();
    const before = cells().map((el) => el.getAttribute('data-address'));
    await userEvent.click(cellAt(3, 2)); // D8: r3, at depth 0 right after r0's subtree
    fireEvent.keyDown(cellAt(3, 2), { code: 'BracketRight', key: ']', metaKey: true });
    expect(rowEls()[3]).toHaveAttribute('aria-level', '2');
    expect(cellAt(3, 2)).toHaveClass('gd-cell--outline');
    expect(cellAt(3, 2).style.getPropertyValue('--gd-outline-depth')).toBe('1');
    expect(within(cellAt(3, 2)).getByText('↳')).toHaveAttribute('aria-hidden', 'true');
    expect(cellAt(3, 0)).not.toHaveClass('gd-cell--outline');
    expect(cellAt(3, 0).style.getPropertyValue('--gd-outline-depth')).toBe('');
    expect(within(cellAt(3, 0)).queryByText('↳')).toBeNull();
    // r1 and r2 were nested without a column: they stay in B.
    expect(cellAt(1, 0)).toHaveClass('gd-cell--outline');
    expect(cellAt(2, 0).style.getPropertyValue('--gd-outline-depth')).toBe('2');
    // HIER-09: no address moved; the selection is still D8.
    expect(cells().map((el) => el.getAttribute('data-address'))).toEqual(before);
    expect(selected()).toBe('D8');
    expect(rowMeta(tableMap(gd, tableId)!, rows[3]!).outlineColumn).toBe(cols[2]);
    // HIER-05: nest r4 under r3 from B — r4 draws in B, and r3's chevron is in D, its own column.
    await userEvent.click(cellAt(4, 0));
    fireEvent.keyDown(cellAt(4, 0), { code: 'BracketRight', key: ']', metaKey: true });
    fireEvent.keyDown(cellAt(4, 0), { code: 'BracketRight', key: ']', metaKey: true });
    expect(rowEls()[4]).toHaveAttribute('aria-level', '3');
    expect(cellAt(4, 0)).toHaveClass('gd-cell--outline');
    expect(within(cellAt(3, 2)).getByTestId('outline-chevron')).toBeInTheDocument();
    expect(within(cellAt(3, 0)).queryByTestId('outline-chevron')).toBeNull();
    // ⌘[ from B promotes r3 (r4 with it): at the top level the row's column is cleared.
    await userEvent.click(cellAt(3, 0));
    fireEvent.keyDown(cellAt(3, 0), { code: 'BracketLeft', key: '[', metaKey: true });
    expect(rowEls()[3]).toHaveAttribute('aria-level', '1');
    expect(cellAt(3, 2)).not.toHaveClass('gd-cell--outline');
    expect(cellAt(3, 0)).toHaveClass('gd-cell--outline');
    expect(within(cellAt(3, 0)).getByTestId('outline-chevron')).toBeInTheDocument();
    expect(rowMeta(tableMap(gd, tableId)!, rows[3]!).outlineColumn).toBeNull();
    expect(cells().map((el) => el.getAttribute('data-address'))).toEqual(before);
  });

  it('HIER-04 A11Y-05 hiding the column that carries the outline — a row’s own or the table’s — falls back to the table’s outline column and the announcement says where the outline went; the row keeps its column for when the column returns', () => {
    outlineFixture();
    nestRow(gd, tableId, rows[3]!, cols[2]); // r3 from D
    mount();
    expect(cellAt(3, 2)).toHaveClass('gd-cell--outline');
    act(() => {
      gridRef.current?.commands.hideColumn(tableId, cols[2]!);
    });
    expect(live()).toHaveTextContent(
      'Hid column Column 3. Outline column Column 3 is hidden; showing the outline in Column 1',
    );
    expect(cellAt(3, 0, 2)).toHaveClass('gd-cell--outline');
    expect(within(cellAt(3, 0, 2)).getByText('↳')).toBeInTheDocument();
    expect(rowMeta(tableMap(gd, tableId)!, rows[3]!).outlineColumn).toBe(cols[2]);
    act(() => {
      gridRef.current?.commands.unhideColumn(tableId, cols[2]!);
    });
    expect(cellAt(3, 2)).toHaveClass('gd-cell--outline');
    // The table's own outline column hidden: the same sentence, the next visible column.
    setOutlineColumn(gd, tableId, cols[1]!);
    act(() => {
      gridRef.current?.commands.hideColumn(tableId, cols[1]!);
    });
    expect(live()).toHaveTextContent(
      'Hid column Column 2. Outline column Column 2 is hidden; showing the outline in Column 1',
    );
    // A column that carries no outline says only that it was hidden: r3 promoted to the top
    // level forgets its column, so Column 3 carries nothing.
    act(() => {
      gridRef.current?.commands.unhideColumn(tableId, cols[1]!);
      promoteRow(gd, tableId, rows[3]!);
      gridRef.current?.commands.hideColumn(tableId, cols[2]!);
    });
    expect(live()).toHaveTextContent(/^Hid column Column 3$/);
    // A blank-labelled column (ADR-051 refuses one by hand; a document may hold one) is named by
    // its grid letter, read before it hides (it has none after).
    act(() => {
      gridRef.current?.commands.unhideColumn(tableId, cols[2]!);
      gd.doc.transact(() => {
        columnsArray(tableMap(gd, tableId)!)
          .toArray()
          .find((c) => c.get('id') === cols[2])
          ?.set('label', '');
      }, gd.origin);
      nestRow(gd, tableId, rows[3]!, cols[2]);
      gridRef.current?.commands.hideColumn(tableId, cols[2]!);
    });
    expect(live()).toHaveTextContent(
      'Hid column D. Outline column D is hidden; showing the outline in Column 2',
    );
  });

  it('HIER-04 GRID-10 the pinned mirror draws each row’s outline in that row’s own column', () => {
    outlineFixture();
    gd.doc.transact(() => {
      tableMap(gd, tableId)!.set('frozenColumns', 2);
    });
    nestRow(gd, tableId, rows[3]!, cols[1]); // r3 from C
    mount({ pinnedLeft: 0 });
    const mirrorRows = screen.getByTestId('pinned-panel').querySelectorAll('.gd-table__row');
    const mirrorCells = (r: number) => mirrorRows[r + 1]!.querySelectorAll('.gd-cell'); // after the header
    expect(mirrorCells(1)[0]).toHaveClass('gd-cell--outline'); // r1: B
    expect(mirrorCells(1)[0]!.querySelector('.gd-cell__branch')).toHaveTextContent('↳');
    expect(mirrorCells(3)[1]).toHaveClass('gd-cell--outline'); // r3: C
    expect(mirrorCells(3)[1]!.querySelector('.gd-cell__branch')).toHaveTextContent('↳');
    expect(mirrorCells(3)[0]).not.toHaveClass('gd-cell--outline');
    expect(mirrorCells(3)[0]!.querySelector('.gd-cell__branch')).toBeNull();
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

// ---------------------------------------------------------------------------
// wave4/inspector-controls: the look painted on the grid (INSP-04..07, MENU-04)
// ---------------------------------------------------------------------------
describe('appearance on the grid (INSP-04..06, MENU-04)', () => {
  afterEach(() => {
    setSharedRuleEvaluatorForTests(null);
  });

  it('INSP-05 INSP-06 INSP-10 a column appearance paints every cell as data attributes and custom properties; a cell override wins; the lattice box is untouched', () => {
    setColumnAppearance(gd, tableId, cols[0]!, {
      fill: 'amber',
      border: { edges: 'top-bottom', weight: 'strong' },
      font: 'mono',
      weight: 600,
      size: 'body',
      textColour: 'danger',
      hAlign: 'center',
      vAlign: 'bottom',
    });
    setCellAppearance(gd, tableId, rows[1]!, cols[0]!, { fill: 'slate', textColour: 'ink' });
    mount();
    const b5 = cellAt(0, 0);
    expect(b5).toHaveAttribute('data-fill', 'amber');
    expect(b5).toHaveAttribute('data-ink', 'danger');
    expect(b5).toHaveAttribute('data-font', 'mono');
    expect(b5).toHaveAttribute('data-weight', '600');
    expect(b5).toHaveAttribute('data-size', 'body');
    expect(b5).toHaveAttribute('data-halign', 'center');
    expect(b5).toHaveAttribute('data-valign', 'bottom');
    expect(b5).toHaveClass('gd-cell--bordered');
    expect(b5.style.getPropertyValue('--gd-bt')).toBe('1');
    expect(b5.style.getPropertyValue('--gd-bb')).toBe('1');
    expect(b5.style.getPropertyValue('--gd-br')).toBe('0');
    expect(b5.style.getPropertyValue('--gd-border-colour')).toBe('var(--rule-strong)');
    expect(b5.style.getPropertyValue('--gd-border-width')).toBe('2px');
    // GRID-01: the cell keeps its one-unit width; the border is paint on a pseudo-element.
    expect(b5.style.width).toBe(`${String(LATTICE.col)}px`);
    // The override on B6 wins field by field; the rest inherits.
    const b6 = cellAt(1, 0);
    expect(b6).toHaveAttribute('data-fill', 'slate');
    expect(b6).toHaveAttribute('data-ink', 'ink');
    expect(b6).toHaveAttribute('data-font', 'mono');
    // A column with nothing set paints nothing.
    expect(cellAt(0, 1)).not.toHaveAttribute('data-fill');
    expect(cellAt(0, 1)).not.toHaveAttribute('data-halign');
  });

  it('A11Y-03 FMT-02 a text colour under 4.5:1 on its fill is replaced by ink and flagged; Automatic alignment keeps numbers right', () => {
    setColumnAppearance(gd, tableId, cols[0]!, { fill: 'forest', textColour: 'warning' });
    setColumnFormat(gd, tableId, cols[1]!, 'number', {});
    setCellText(gd, tableId, rows[0]!, cols[1]!, '42');
    mount();
    expect(cellAt(0, 0)).toHaveAttribute('data-ink', 'ink');
    expect(cellAt(0, 0)).toHaveAttribute('data-ink-adjusted', 'true');
    expect(cellAt(0, 1)).toHaveAttribute('data-halign', 'right');
  });

  it('INSP-05 A11Y-04 a conditional rule, evaluated by the rules service, paints its fill and mark and adds a flag naming the rule; first match wins', async () => {
    setSharedRuleEvaluatorForTests(createRuleEvaluator({ worker: false }));
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'overdue invoice');
    setCellText(gd, tableId, rows[1]!, cols[0]!, 'paid');
    setCellText(
      gd,
      tableId,
      rows[2]!,
      cols[0]!,
      'a very long entry that runs past forty characters',
    );
    addColumnRule(gd, tableId, cols[0]!, {
      when: { trigger: 'contains', text: 'overdue' },
      style: { fill: 'amber', mark: 'bold' },
    });
    addColumnRule(gd, tableId, cols[0]!, {
      when: { trigger: 'charsOver', count: 40 },
      style: { textColour: 'ink-muted', mark: 'strikethrough' },
    });
    mount();
    await waitFor(() => {
      expect(cellAt(0, 0)).toHaveAttribute('data-fill', 'amber');
    });
    expect(cellAt(0, 0)).toHaveAttribute('data-mark', 'bold');
    expect(cellAt(0, 0)).toHaveClass('gd-cell--rule');
    expect(within(cellAt(0, 0)).getByTitle('Rule: contains “overdue”')).toBeInTheDocument();
    expect(cellAt(1, 0)).not.toHaveAttribute('data-rule');
    expect(cellAt(2, 0)).toHaveAttribute('data-ink', 'ink-muted');
    expect(cellAt(2, 0)).toHaveAttribute('data-mark', 'strikethrough');
    // Removing the rules clears the paint on the next answer.
    act(() => {
      setColumnRules(gd, tableId, cols[0]!, []);
    });
    await waitFor(() => {
      expect(cellAt(0, 0)).not.toHaveAttribute('data-fill');
    });
  });

  it('INSP-04 the table look paints as attributes on the table: style, outline, gridlines, banding, a hidden title keeps its bar, the caption is a strip at the foot', () => {
    setTableLook(gd, tableId, {
      style: 'slate',
      outline: 'accent',
      gridlines: 'contrast',
      alternating: true,
      titleShown: false,
      captionShown: true,
      caption: 'Q3 sites',
    });
    mount();
    const table = screen.getByRole('grid').closest('.gd-table')!;
    expect(table).toHaveAttribute('data-style', 'slate');
    expect(table).toHaveAttribute('data-outline', 'accent');
    expect(table).toHaveAttribute('data-gridlines', 'contrast');
    expect(table).toHaveAttribute('data-alternating', 'true');
    expect(table).toHaveAttribute('aria-label', 'Table 1');
    expect(table.querySelector('.gd-table__title-text')).toBeNull();
    expect(table.querySelector<HTMLElement>('.gd-table__title')!.style.height).toBe('44px');
    const caption = screen.getByTestId('table-caption');
    expect(caption).toHaveTextContent('Q3 sites');
    expect(caption.style.height).toBe(`${String(LATTICE.row)}px`);
    // Addresses are the same as without any of it.
    expect(cellAt(0, 0)).toHaveAttribute('data-address', 'B5');
  });

  it('MENU-04 GRID-01 a merged span draws its anchor over the covered cells, which keep their address but neither content nor a tab stop — no width in the anchor row, their column width below it; arrows skip them', async () => {
    setCellText(gd, tableId, rows[0]!, cols[1]!, 'hidden under the span');
    mergeCells(gd, tableId, rows[0]!, cols[0]!, { rows: 2, cols: 2 });
    mount();
    const anchor = cellAt(0, 0);
    expect(anchor).toHaveClass('gd-cell--span');
    expect(anchor.style.width).toBe(`${String(2 * LATTICE.col)}px`);
    expect(anchor.style.height).toBe(`${String(2 * LATTICE.row)}px`);
    // The anchor tells assistive tech how many positions it stands for.
    expect(anchor).toHaveAttribute('aria-colspan', '2');
    expect(anchor).toHaveAttribute('aria-rowspan', '2');
    const placeholders = Array.from(
      document.querySelectorAll<HTMLElement>('[data-covered="true"]'),
    );
    expect(placeholders.map((p) => p.getAttribute('data-address'))).toEqual(['C5', 'B6', 'C6']);
    for (const p of placeholders) {
      expect(p).toHaveAttribute('aria-hidden', 'true');
      expect(p).toHaveTextContent('');
    }
    // The anchor's box has taken C5's room; B6 and C6 keep theirs so D6 stays under D5.
    expect(placeholders[0]!.style.width).toBe('0px');
    expect(placeholders[1]!.style.width).toBe(`${String(LATTICE.col)}px`);
    expect(placeholders[2]!.style.width).toBe(`${String(LATTICE.col)}px`);
    expect(cells().map((c) => c.getAttribute('data-address'))).not.toContain('C5');
    // The data under the span is intact: unmerging shows it again.
    await userEvent.click(anchor);
    fireEvent.keyDown(anchor, { code: 'ArrowRight', key: 'ArrowRight' });
    expect(selected()).toBe('D5');
    act(() => {
      unmergeCells(gd, tableId, rows[0]!, cols[0]!);
    });
    expect(
      screen.getByRole('gridcell', { name: /^C5, hidden under the span/ }),
    ).toBeInTheDocument();
  });

  it('FX-07 GRID-09 a formula in a compact row shows its expression beside the value without changing the row height; a wrapped row keeps it on its own line (#142, ADR 43)', () => {
    commitCellText(gd, tableId, rows[2]!, cols[0]!, '=Sum(B5:B6)');
    mount();
    const cell = cellAt(2, 0);
    expect(cell).not.toHaveClass('gd-cell--wrap');
    expect(cell.querySelector('.gd-formula__expr')).toHaveTextContent('=Sum(B5:B6)');
    expect(cell.querySelector('.gd-formula__expr')).toHaveAttribute(
      'aria-label',
      'Expression =Sum(B5:B6)',
    );
    // The row is one lattice unit still (GRID-09): 22 px, and its address is its own.
    expect(cell).toHaveAttribute('data-address', 'B7');
    expect(cell.closest('[role="row"]')).toHaveStyle({ height: '22px' });
    act(() => {
      setRowHeight(gd, tableId, rows[2]!, 2);
    });
    expect(cellAt(2, 0)).toHaveClass('gd-cell--tall');
    expect(cellAt(2, 0).closest('[role="row"]')).toHaveStyle({ height: '44px' });
    expect(cellAt(2, 0).querySelector('.gd-formula__expr')).toHaveTextContent('=Sum(B5:B6)');
  });

  it('INSP-05 FX-07 a rule on a formula cell matches the evaluated value, never the source', async () => {
    setSharedRuleEvaluatorForTests(createRuleEvaluator({ worker: false }));
    setCellText(gd, tableId, rows[0]!, cols[0]!, '7');
    setCellText(gd, tableId, rows[1]!, cols[0]!, '5');
    commitCellText(gd, tableId, rows[2]!, cols[0]!, '=Sum(B5:B6)');
    addColumnRule(gd, tableId, cols[0]!, {
      when: { trigger: 'contains', text: '12' },
      style: { fill: 'slate' },
    });
    addColumnRule(gd, tableId, cols[0]!, {
      when: { trigger: 'contains', text: 'Sum' },
      style: { fill: 'amber' },
    });
    mount();
    // The formula evaluates to 12: the first rule matches the value; the source text never matches.
    await waitFor(() => {
      expect(cellAt(2, 0)).toHaveAttribute('data-fill', 'slate');
    });
    expect(cellAt(2, 0)).not.toHaveAttribute('data-fill', 'amber');
  });

  it('INSP-05 a rule may draw a border, which beats the column\'s; a cell\'s explicit "none" shows no fill over a column fill (INSP-10)', async () => {
    setSharedRuleEvaluatorForTests(createRuleEvaluator({ worker: false }));
    setColumnAppearance(gd, tableId, cols[0]!, {
      fill: 'amber',
      border: { edges: 'all', weight: 'hairline' },
    });
    setCellAppearance(gd, tableId, rows[1]!, cols[0]!, {
      fill: 'none',
      border: { edges: 'none', weight: 'hairline' },
    });
    setCellText(gd, tableId, rows[0]!, cols[0]!, 'flagged');
    addColumnRule(gd, tableId, cols[0]!, {
      when: { trigger: 'contains', text: 'flag' },
      style: { border: { edges: 'outline', weight: 'accent' } },
    });
    mount();
    await waitFor(() => {
      expect(cellAt(0, 0).style.getPropertyValue('--gd-border-colour')).toBe('var(--rule-accent)');
    });
    expect(cellAt(0, 0)).toHaveAttribute('data-fill', 'amber');
    expect(cellAt(1, 0)).not.toHaveAttribute('data-fill');
    expect(cellAt(1, 0)).not.toHaveClass('gd-cell--bordered');
    expect(cellAt(2, 0)).toHaveAttribute('data-fill', 'amber');
    expect(cellAt(2, 0).style.getPropertyValue('--gd-border-colour')).toBe('var(--rule-hairline)');
  });

  it("GRID-10 INSP-05 the pinned mirror paints the frozen cells' fill, type and span box like the grid", () => {
    setColumnAppearance(gd, tableId, cols[0]!, { fill: 'slate', weight: 600, size: 'h3' });
    mergeCells(gd, tableId, rows[0]!, cols[0]!, { rows: 1, cols: 2 });
    act(() => {
      setFrozenColumns(gd, tableId, 2);
    });
    mount({ pinnedLeft: 40 });
    const mirror = screen.getByTestId('pinned-panel');
    const cells = mirror.querySelectorAll<HTMLElement>('.gd-cell');
    const first = cells[0]!;
    expect(first).toHaveAttribute('data-fill', 'slate');
    expect(first).toHaveAttribute('data-weight', '600');
    expect(first).toHaveAttribute('data-size', 'h3');
    expect(first).toHaveClass('gd-cell--span');
    expect(first.style.width).toBe(`${String(2 * LATTICE.col)}px`);
    expect(cells[1]).toHaveClass('gd-cell--covered');
    expect(cells[1]!.style.width).toBe('0px');
  });

  it('MENU-04 SHARE-04 GRID-06 a collaborator’s merge covers the cell being edited here: the draft commits into the covered cell (its data is kept), and the selection lands on the anchor with focus', async () => {
    const other = openDocument(new Y.Doc());
    Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(gd.doc));
    mount();
    await userEvent.click(cellAt(0, 1));
    fireEvent.keyDown(cellAt(0, 1), { code: 'KeyQ', key: 'q' });
    expect(screen.getByLabelText('Edit C5')).toBeInTheDocument();
    act(() => {
      mergeCells(other, tableId, rows[0]!, cols[0]!, { rows: 1, cols: 2 });
      Y.applyUpdate(gd.doc, Y.encodeStateAsUpdate(other.doc, Y.encodeStateVector(gd.doc)));
    });
    // The placeholder is no focus target: the selection is the anchor, and it has focus.
    expect(selected()).toBe('B5');
    await waitFor(() => {
      expect(document.activeElement).toBe(cellAt(0, 0));
    });
    expect(screen.queryByLabelText('Edit C5')).not.toBeInTheDocument();
    // Nothing typed was lost: the covered cell holds it, and unmerging shows it.
    await waitFor(() => {
      expect(cellRich(tableMap(gd, tableId)!, rows[0]!, cols[1]!)).toEqual(
        docNode([paragraphNode([textNode('q')])]),
      );
    });
    act(() => {
      unmergeCells(gd, tableId, rows[0]!, cols[0]!);
    });
    expect(screen.getByRole('gridcell', { name: /^C5, q/ })).toBeInTheDocument();
  });
});
