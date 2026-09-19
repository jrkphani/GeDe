/**
 * The inspector rail (INSP-01..12, FMT-06, FIND-06, KEYS-05, RESP-03/04)
 * against a real Yjs document through the same `useGrid` the shell uses.
 * The Find object is a labelled FAKE: its state is hand-built so the result
 * list can be checked without a search Worker.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  addDerivedColumn,
  cellAppearanceOverride,
  cellFormatOverride,
  cellRich,
  columnLetter,
  createSheet,
  createTable,
  createUndoManager,
  DEFAULT_SEARCH_OPTIONS,
  hasMarkThroughout,
  LATTICE,
  openDocument,
  rowHeights,
  rowMeta,
  setCellText,
  spanAt,
  tableAddresses,
  tableById,
  tableMap,
  toggleMarkThroughout,
  type GedeDoc,
  type Id,
  type SearchMatch,
  type ToggleMark,
} from '@gede/core';

import { TooltipProvider } from '@gede/ui';

import { LiveRegion } from '../../../announce.js';
import { installMatchMedia } from '../../../test/match-media.js';
import { useYVersion } from '../../../doc/use-y.js';
import { openViewStore, ViewStoreProvider, type ViewStore } from '../../../doc/view-state.js';
import type { Find } from '../find/useFind.js';
import { useGrid, type Grid } from '../grid/use-grid.js';
import { Inspector, type InspectorProps } from '../Inspector.js';
import type { InspectorMode } from '../Toolbar.js';

let gd: GedeDoc;
let sheetId: Id;
let tableId: Id;
let store: ViewStore;
const grid: { current: Grid | null } = { current: null };

function fakeFind(matches: readonly SearchMatch[] = [], listOpen = true): Find {
  return {
    state: {
      open: matches.length > 0,
      replaceShown: false,
      query: 'camp',
      replacement: '',
      options: DEFAULT_SEARCH_OPTIONS,
      matches,
      current: matches.length > 0 ? 0 : -1,
      pending: false,
      skipped: null,
      notice: null,
      listOpen,
    },
    actions: {
      open: vi.fn(),
      close: vi.fn(),
      setQuery: vi.fn(),
      setReplacement: vi.fn(),
      setOption: vi.fn(),
      setReplaceShown: vi.fn(),
      setListOpen: vi.fn(),
      next: vi.fn(),
      previous: vi.fn(),
      goTo: vi.fn(),
      replaceCurrent: vi.fn(),
      replaceAll: vi.fn(),
      dismissNotice: vi.fn(),
    },
    inputRef: { current: null },
    focusTick: 0,
  };
}

interface HarnessProps {
  mode?: InspectorMode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  editable?: boolean;
  select?: 'table' | 'cell' | null;
  find?: Find;
  slots?: InspectorProps['slots'];
  /** KEYS-03: the document's undo manager, so a command settles one undo step as the shell does. */
  undo?: Y.UndoManager;
  organizeTab?: InspectorProps['organizeTab'];
  onOrganizeTabChange?: InspectorProps['onOrganizeTabChange'];
  object?: InspectorProps['object'];
}

function Harness({
  mode = 'format',
  open = true,
  onOpenChange = () => undefined,
  editable = true,
  select = 'cell',
  find = fakeFind(),
  slots,
  undo,
  organizeTab,
  onOrganizeTabChange,
  object,
}: HarnessProps) {
  const g = useGrid(gd, editable, { undo });
  grid.current = g;
  useYVersion(gd.tables);
  const record = tableById(gd, tableId);
  // Select through the same reducer the grid uses, once, on mount.
  const selectedRef = { current: false };
  if (!selectedRef.current && record !== null && g.state.selection === null && select !== null) {
    selectedRef.current = true;
    queueMicrotask(() => {
      if (select === 'cell') {
        g.actions.selectCell({ tableId, rowId: record.rows[0]!, colId: record.columns[0]!.id });
      } else {
        g.actions.selectTable(tableId);
      }
    });
  }
  const toggleMark = (mark: ToggleMark) => {
    const cell = g.cell;
    const table = cell === null ? null : tableMap(gd, cell.tableId);
    if (cell === null || table === null) return;
    g.commands.commitRichCell(
      cell,
      toggleMarkThroughout(cellRich(table, cell.rowId, cell.colId), mark),
    );
  };
  return (
    <TooltipProvider>
      <ViewStoreProvider value={store}>
        <Inspector
          gd={gd}
          mode={mode}
          open={open}
          onOpenChange={onOpenChange}
          organizeTab={organizeTab}
          onOrganizeTabChange={onOrganizeTabChange}
          object={object}
          selection={g.state.selection}
          editing={g.state.editing !== null}
          editable={editable}
          commands={g.commands}
          find={find}
          onToggleMark={toggleMark}
          slots={slots}
        />
        <LiveRegion />
      </ViewStoreProvider>
    </TooltipProvider>
  );
}

async function mount(props: HarnessProps = {}) {
  const view = render(<Harness {...props} />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

const rail = () => screen.getByTestId('inspector');
const tab = (name: string) => screen.getByRole('tab', { name });
const section = (label: string) => screen.getByRole('region', { name: label });

describe('Inspector', () => {
  beforeEach(() => {
    localStorage.clear();
    store = openViewStore('user-1', 'doc-inspector');
    gd = openDocument(new Y.Doc());
    sheetId = createSheet(gd);
    tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 3, rows: 4 });
    const record = tableById(gd, tableId)!;
    setCellText(gd, tableId, record.rows[0]!, record.columns[0]!.id, 'Base camp');
  });

  it('INSP-01 Format shows Table, Cell, Text, Arrange and Derive as Radix tabs; Organize shows Categories, Sort and Filter; Graph appears only with a graph', async () => {
    const { rerender } = await mount();
    expect(rail()).toHaveAttribute('aria-label', 'Format inspector');
    const list = screen.getByRole('tablist', { name: 'Format' });
    expect(
      within(list)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Table', 'Cell', 'Text', 'Arrange', 'Derive']);
    expect(tab('Table')).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(tab('Cell'));
    expect(screen.getByRole('tabpanel')).toContainElement(section('data format'));
    rerender(<Harness mode="organize" />);
    expect(rail()).toHaveAttribute('aria-label', 'Organize inspector');
    expect(
      within(screen.getByRole('tablist', { name: 'Organize' }))
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['Categories', 'Sort', 'Filter']);
    // INSP-08 (partial): the Graph tab renders only when the graph slot is filled.
    rerender(<Harness slots={{ graph: <p>Graph controls</p> }} />);
    expect(tab('Graph')).toBeInTheDocument();
  });

  it('INSP-08 INSP-03 selecting a graph brings its tab to the front; deselecting it falls back to Table; a tab chosen while the graph is selected stays chosen', async () => {
    const { rerender } = await mount();
    await userEvent.click(tab('Cell'));
    expect(tab('Cell')).toHaveAttribute('aria-selected', 'true');
    // The graph becomes the selected object: its tab is selected at once.
    rerender(<Harness slots={{ graph: <p>Graph controls</p> }} />);
    expect(tab('Graph')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Graph controls');
    // The person may still move to another tab while the graph stays selected.
    await userEvent.click(tab('Arrange'));
    expect(tab('Arrange')).toHaveAttribute('aria-selected', 'true');
    rerender(<Harness slots={{ graph: <p>Graph controls</p>, derive: <p>Derive</p> }} />);
    expect(tab('Arrange')).toHaveAttribute('aria-selected', 'true');
    // Deselected: the Graph tab goes, and a Graph selection falls back to Table.
    await userEvent.click(tab('Graph'));
    rerender(<Harness />);
    expect(screen.queryByRole('tab', { name: 'Graph' })).toBeNull();
    expect(tab('Table')).toHaveAttribute('aria-selected', 'true');
    // Reselected: the Graph tab comes to the front again.
    rerender(<Harness slots={{ graph: <p>Graph controls</p> }} />);
    expect(tab('Graph')).toHaveAttribute('aria-selected', 'true');
  });

  it('INSP-02 RESP-04 collapsed, the rail is a 38 px strip with the expand control and the mode name; the head and tabs are gone', async () => {
    const onOpenChange = vi.fn();
    await mount({ open: false, onOpenChange });
    expect(rail()).toHaveAttribute('data-state', 'collapsed');
    expect(rail()).toHaveClass('gd-inspector--collapsed');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inspector-selected')).not.toBeInTheDocument();
    expect(rail()).toHaveTextContent('Format');
    await userEvent.click(screen.getByRole('button', { name: 'Expand inspector' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // The strip width is the token the shell measures the canvas by.
    const css = readFileSync(resolve(__dirname, '../document.css'), 'utf8');
    expect(css).toMatch(/--gd-inspector-strip:\s*2\.375rem/);
    expect(css).toMatch(/--gd-inspector:\s*20\.125rem/);
    expect(css).toMatch(/\.gd-inspector--collapsed\s*\{[^}]*width:\s*var\(--gd-inspector-strip\)/);
  });

  it('RESP-03 in overlay mode (below 1024 px) Escape and a press outside collapse the rail; Escape is taken before the shell sees it', async () => {
    installMatchMedia((q) => q.includes('max-width: 1023.98px'));
    const onOpenChange = vi.fn();
    await mount({ onOpenChange });
    expect(rail()).toHaveAttribute('data-overlay', 'true');
    const escape = fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
    expect(escape).toBe(false); // prevented: the shell's Escape (clear the selection) stays quiet
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    // A press inside the rail is not outside; one on the canvas is.
    fireEvent.pointerDown(rail(), { pointerId: 1 });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    const outside = document.body.appendChild(document.createElement('div'));
    fireEvent.pointerDown(outside, { pointerId: 2 });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    outside.remove();
    // The toolbar's own toggles are never "outside": they decide the rail's state themselves.
    const toolbar = document.body.appendChild(document.createElement('div'));
    toolbar.className = 'gd-doc__toolbar';
    const button = toolbar.appendChild(document.createElement('button'));
    fireEvent.pointerDown(button, { pointerId: 3 });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    toolbar.remove();
  });

  it('RESP-03 below 1024 px the rail is an absolute overlay on the canvas', () => {
    const css = readFileSync(resolve(__dirname, '../document.css'), 'utf8');
    const block = /@media \(max-width: 1023\.98px\) \{([\s\S]*?)\n\}/g;
    const blocks = Array.from(css.matchAll(block)).map((m) => m[1] ?? '');
    expect(blocks.some((b) => /\.gd-inspector\s*\{[^}]*position:\s*absolute/.test(b))).toBe(true);
  });

  it('INSP-03 the head states the object, its address, row and column counts', async () => {
    const { rerender } = await mount();
    const head = screen.getByTestId('inspector-selected');
    expect(within(head).getByText('Table 1')).toBeInTheDocument();
    expect(within(head).getByLabelText('Address B5')).toBeInTheDocument();
    expect(head).toHaveTextContent('4 rows · 3 columns');
    rerender(<Harness select={null} />);
    act(() => {
      grid.current!.actions.clear();
    });
    expect(screen.getByTestId('inspector-selected')).toHaveTextContent('Nothing selected');
  });

  it('INSP-04 INSP-12 KEYS-03 the Table tab: style, title and caption, header row, footer, frozen columns, row and column counts, outline, gridlines, alternating colour, width, wrap and fit write through at once; typing a caption is one undo step', async () => {
    const undo = createUndoManager(gd);
    await mount({ undo });
    await userEvent.click(tab('Table'));
    // Table style: one of the four ramp pairs, as a Radix toggle group with labelled swatches.
    const style = section('table style');
    // Only the neutral pair is offered (DS "no third meaning"): Plain and Slate.
    expect(
      within(style)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Plain', 'Slate']);
    await userEvent.click(within(style).getByRole('radio', { name: 'Slate' }));
    expect(tableById(gd, tableId)?.look.style).toBe('slate');
    // Title and caption: the title bar keeps its rows; the caption is a strip at the foot.
    const before = tableAddresses(tableMap(gd, tableId)!);
    const titling = section('title and caption');
    await userEvent.click(within(titling).getByRole('switch', { name: 'Title' }));
    expect(tableById(gd, tableId)?.look.titleShown).toBe(false);
    await userEvent.click(within(titling).getByRole('switch', { name: 'Caption' }));
    expect(tableById(gd, tableId)?.look.captionShown).toBe(true);
    await userEvent.type(within(titling).getByRole('textbox', { name: 'Caption text' }), 'Q3');
    expect(tableById(gd, tableId)?.look.caption).toBe('Q3');
    expect(tableAddresses(tableMap(gd, tableId)!)).toEqual(before);
    // The keystrokes merged through the capture window (as the title field's do): one undo
    // clears the caption.
    act(() => {
      undo.undo();
    });
    expect(tableById(gd, tableId)?.look.caption).toBe('');
    await userEvent.type(within(titling).getByRole('textbox', { name: 'Caption text' }), 'Q3');
    // Outline, gridline density and alternating rows.
    const lines = section('outline and gridlines');
    await userEvent.click(within(lines).getByRole('combobox', { name: 'Table outline' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Accent' }));
    expect(tableById(gd, tableId)?.look.outline).toBe('accent');
    await userEvent.click(within(lines).getByRole('combobox', { name: 'Gridline density' }));
    await userEvent.click(await screen.findByRole('option', { name: 'High contrast' }));
    expect(tableById(gd, tableId)?.look.gridlines).toBe('contrast');
    await userEvent.click(within(lines).getByRole('switch', { name: 'Alternating row colour' }));
    expect(tableById(gd, tableId)?.look.alternating).toBe(true);
    expect(screen.getByTestId('live-region')).toHaveTextContent('alternating rows updated');
    // Fit-to-content needs a text measurer; jsdom has no 2D canvas, so the buttons say so
    // rather than guessing a width (INSP-11 shape, a live reason).
    expect(
      within(section('row and column size')).getByRole('button', { name: 'Fit width to content' })
        .title,
    ).toBe('Fit width to content — text cannot be measured in this browser');
    // INSP-04 / GRID-11 (#138): header row and footer row are counts (0 or 1), like the
    // header columns.
    const headers = section('headers and footer');
    await userEvent.click(within(headers).getByRole('button', { name: 'Fewer header rows' }));
    expect(tableById(gd, tableId)?.headerRows).toBe(0);
    expect(within(headers).getByRole('button', { name: 'Fewer header rows' }).title).toBe(
      'Fewer — the header row is hidden',
    );
    await userEvent.click(within(headers).getByRole('button', { name: 'More footer rows' }));
    expect(tableById(gd, tableId)?.footerRows).toBe(1);
    expect(within(headers).getByRole('button', { name: 'More footer rows' }).title).toBe(
      'More — at the maximum',
    );
    await userEvent.click(within(headers).getByRole('combobox', { name: 'Header columns' }));
    await userEvent.click(await screen.findByRole('option', { name: '1 column' }));
    expect(tableById(gd, tableId)?.frozenColumns).toBe(1);

    const counts = section('rows and columns');
    await userEvent.click(within(counts).getByRole('button', { name: 'More rows' }));
    expect(tableById(gd, tableId)?.rows).toHaveLength(5);
    await userEvent.click(within(counts).getByRole('button', { name: 'Fewer rows' }));
    expect(tableById(gd, tableId)?.rows).toHaveLength(4);
    await userEvent.click(within(counts).getByRole('button', { name: 'More columns' }));
    expect(tableById(gd, tableId)?.columns).toHaveLength(4);
    await userEvent.click(within(counts).getByRole('button', { name: 'Fewer columns' }));
    expect(tableById(gd, tableId)?.columns).toHaveLength(3);

    const size = section('row and column size');
    await userEvent.click(within(size).getByRole('button', { name: 'More units' }));
    expect(tableById(gd, tableId)?.columns.reduce((a, c) => a + c.width, 0)).toBe(4);
    await userEvent.click(
      within(section('wrap')).getByRole('switch', { name: 'Wrap text in cells' }),
    );
    expect(tableById(gd, tableId)?.look.wrap).toBe(true);
    expect(screen.getByTestId('live-region')).toHaveTextContent('text wraps in cells');
  });

  it("INSP-04 GRID-08 GRID-09 KEYS-03 the Table tab's Height and Width act on the selected row and column as spinbuttons — arrows, Shift-arrows, typed values snapped to whole units, each one undo step — and Distribute evenly shares the total (ADR-049, #167 criteria 7–9)", async () => {
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    await mount({ undo });
    await userEvent.click(tab('Table'));
    const size = section('row and column size');
    const table = tableMap(gd, tableId)!;
    const rec = tableById(gd, tableId)!;
    const height = () => within(size).getByRole('spinbutton', { name: 'Height' });
    const width = () => within(size).getByRole('spinbutton', { name: 'Width' });
    // B5 is selected: the fields read row 5 and column Column 1, in units and px at 100 %.
    expect(height()).toHaveAttribute('aria-valuenow', '1');
    expect(height()).toHaveAttribute('aria-valuetext', '1 unit, 22 px, row 5');
    expect(width()).toHaveAttribute('aria-valuetext', '1 unit, 160 px, column Column 1');
    expect(height()).toHaveAttribute('aria-valuemin', '1');
    expect(height()).not.toHaveAttribute('aria-valuemax');
    const steps = undo.undoStack.length;
    height().focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(rowMeta(table, rec.rows[0]!)).toMatchObject({ height: 2, fit: false });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Row 5 is 2 units tall');
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(rowMeta(table, rec.rows[0]!).height).toBe(6);
    expect(undo.undoStack).toHaveLength(steps + 2);
    // A typed value snaps to a whole unit ≥ 1 on Enter; nothing below one.
    await userEvent.clear(height());
    await userEvent.type(height(), '2.4{Enter}');
    expect(rowMeta(table, rec.rows[0]!).height).toBe(2);
    await userEvent.clear(height());
    await userEvent.type(height(), '0{Enter}');
    expect(rowMeta(table, rec.rows[0]!).height).toBe(1);
    // Width: the same for the selected column.
    width().focus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(tableById(gd, tableId)?.columns[0]?.width).toBe(3);
    expect(screen.getByTestId('live-region')).toHaveTextContent('Column 1 is 3 units wide');
    // Distribute columns evenly: 3 + 1 + 1 → 2, 2, 1 (the remainder to the first).
    await userEvent.click(within(size).getByRole('button', { name: 'Distribute columns evenly' }));
    expect(tableById(gd, tableId)?.columns.map((c) => c.width)).toEqual([2, 2, 1]);
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      '3 columns distributed: 2, 2, 1 units',
    );
    // Fit needs a measurer; jsdom has none, so the field's Fit says so.
    expect(within(size).getByRole('button', { name: 'Fit height to content' }).title).toBe(
      'Fit height to content — text cannot be measured in this browser',
    );
  });

  it('INSP-04 KEYS-03 REF-01 the Table tab is the home of Rename table and Rename column: Title text beside the Title switch and Name for the selected column, each written on Enter or blur as one undo step; an empty name is refused beside the field; Escape drops the draft; a derived column’s Name says why; Width is reachable with one cell selected (ADR-051)', async () => {
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    const record = tableById(gd, tableId)!;
    const derived = addDerivedColumn(gd, tableId, {
      sourceColId: record.columns[0]!.id,
      method: 'Format',
      args: ['Trimmed'],
    })!;
    await mount({ undo });
    await userEvent.click(tab('Table'));
    // Title text, next to the Title switch (the switch keeps its name; the field has its own).
    const titling = section('title and caption');
    expect(within(titling).getByRole('switch', { name: 'Title' })).toBeInTheDocument();
    const title = within(titling).getByRole('textbox', { name: 'Title text' });
    expect(title).toHaveValue('Table 1');
    const steps = undo.undoStack.length;
    await userEvent.clear(title);
    await userEvent.type(title, '  Camps  {Enter}');
    expect(tableById(gd, tableId)?.title).toBe('Camps');
    expect(undo.undoStack).toHaveLength(steps + 1);
    expect(screen.getByTestId('live-region')).toHaveTextContent('Renamed table Table 1 to Camps');
    // An empty title is refused beside the field; nothing is written; Escape drops the draft.
    await userEvent.clear(title);
    await userEvent.keyboard('{Enter}');
    expect(within(titling).getByRole('alert')).toHaveTextContent('A table needs a title');
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(tableById(gd, tableId)?.title).toBe('Camps');
    await userEvent.keyboard('{Escape}');
    expect(title).toHaveValue('Camps');
    expect(within(titling).queryByRole('alert')).not.toBeInTheDocument();
    // Blur commits a typed title.
    await userEvent.clear(title);
    await userEvent.type(title, 'Camps 2026');
    act(() => {
      title.blur();
    });
    expect(tableById(gd, tableId)?.title).toBe('Camps 2026');
    // Name: the armed cell's column (B5 → Column 1); the section says what it names.
    const column = section('column');
    expect(column).toHaveTextContent(
      /Column Column 1\. Formulas and paths follow the column by id/,
    );
    const name = within(column).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Column 1');
    await userEvent.clear(name);
    await userEvent.type(name, 'Owner{Enter}');
    expect(tableById(gd, tableId)?.columns[0]?.label).toBe('Owner');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Renamed column Column 1 to Owner');
    expect(undo.undoStack).toHaveLength(steps + 3);
    // Width is reachable from the same single-cell selection (no band needed).
    const size = section('row and column size');
    expect(within(size).getByRole('spinbutton', { name: 'Width' })).toHaveAttribute(
      'aria-valuetext',
      '1 unit, 160 px, column Owner',
    );
    // A derived column is named by its signature: the field is present, read-only, with the reason.
    act(() => {
      grid.current!.actions.selectCell({ tableId, rowId: record.rows[0]!, colId: derived });
    });
    const derivedName = within(section('column')).getByRole('textbox', { name: 'Name' });
    expect(derivedName).toHaveAttribute('aria-disabled', 'true');
    expect(derivedName).toHaveAttribute('readonly');
    expect(derivedName.title).toBe('Name — a derived column is named by its signature');
    // A band of several columns has no one name to edit.
    act(() => {
      grid.current!.actions.selectBand(tableId, 'column', record.columns[0]!.id);
      grid.current!.actions.selectBand(tableId, 'column', record.columns[1]!.id, true);
    });
    expect(within(section('column')).getByRole('textbox', { name: 'Name' }).title).toBe(
      'Name — select one column',
    );
    // The table alone: no column selected.
    act(() => {
      grid.current!.actions.selectTable(tableId);
    });
    expect(within(section('column')).getByRole('textbox', { name: 'Name' }).title).toBe(
      'Name — select a column first',
    );
    expect(section('column')).toHaveTextContent('Select a column, or a cell in it, to rename it.');
  });

  it('HIER-01 HIER-02 the Table tab mounts the hierarchy panel: the selected row, its parent, and Nest / Promote acting through the grid commands', async () => {
    await mount();
    await userEvent.click(tab('Table'));
    const row = within(section('row'));
    expect(row.getByTestId('hierarchy-parent')).toHaveTextContent(/top level/);
    const promote = row.getByRole('button', { name: /Promote/ });
    expect(promote).toHaveAttribute('aria-disabled', 'true'); // the first row has nothing above it
    // Select the second row and nest it under the first.
    const record = tableById(gd, tableId)!;
    act(() => {
      grid.current!.actions.selectCell({
        tableId,
        rowId: record.rows[1]!,
        colId: record.columns[0]!.id,
      });
    });
    await userEvent.click(row.getByRole('button', { name: /Nest/ }));
    expect(screen.getByTestId('live-region')).toHaveTextContent('Nested to level 2');
    expect(within(section('row')).getByText(/under/)).toBeInTheDocument();
  });

  it('INSP-05 INSP-10 FMT-06 the Cell tab scopes the data format to the column by default, states the scope before applying, and the cell override beats it', async () => {
    await mount();
    await userEvent.click(tab('Cell'));
    const format = section('data format');
    expect(format).toHaveTextContent(
      'Formats Column 1 as Automatic for all 4 rows, and for rows added later.',
    );
    await userEvent.click(within(format).getByRole('combobox', { name: 'Format' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Number' }));
    const record = tableById(gd, tableId)!;
    expect(record.columns[0]?.format).toBe('number');
    expect(format).toHaveTextContent('Formats Column 1 as Number for all 4 rows');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Formats Column 1 as Number');
    // Number options appear and write through.
    await userEvent.click(within(format).getByRole('combobox', { name: 'Decimals' }));
    await userEvent.click(await screen.findByRole('option', { name: '2' }));
    expect(tableById(gd, tableId)?.columns[0]?.formatOpts.decimals).toBe(2);
    // Cell scope: the sentence names the cell and the write is an override.
    await userEvent.click(within(format).getByRole('radio', { name: 'Cell B5' }));
    expect(format).toHaveTextContent(
      'Formats cell B5 as Number. Other cells in Column 1 keep the column format.',
    );
    await userEvent.click(within(format).getByRole('combobox', { name: 'Format' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Currency' }));
    const table = tableMap(gd, tableId)!;
    expect(cellFormatOverride(table, record.rows[0]!, record.columns[0]!.id)?.kind).toBe(
      'currency',
    );
    expect(tableById(gd, tableId)?.columns[0]?.format).toBe('number');
    expect(within(format).getByRole('combobox', { name: 'Currency' })).toHaveTextContent('SGD');
    // Back to the column format.
    await userEvent.click(within(format).getByRole('button', { name: 'Use column format' }));
    expect(cellFormatOverride(table, record.rows[0]!, record.columns[0]!.id)).toBeNull();
    // Overrides are counted in the column sentence (FMT-06).
    await userEvent.click(within(format).getByRole('combobox', { name: 'Format' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Date' }));
    await userEvent.click(within(format).getByRole('radio', { name: 'Column Column 1' }));
    expect(format).toHaveTextContent(
      'Formats Column 1 as Number for all 4 rows, and for rows added later. 1 cell with its own format will keep it.',
    );
  });

  it('INSP-05 INSP-10 INSP-12 fill and the border matrix write to the column by default and to the cell as an override, one transaction each, with the scope stated first', async () => {
    await mount();
    await userEvent.click(tab('Cell'));
    const fill = section('fill and border');
    expect(fill).toHaveTextContent(
      'The fill and border applies to Column 1 for all 4 rows, and for rows added later.',
    );
    await userEvent.click(within(fill).getByRole('radio', { name: 'Amber' }));
    const record = tableById(gd, tableId)!;
    expect(record.columns[0]?.appearance.fill).toBe('amber');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Fill set for column Column 1');
    // The positional matrix: nine edges, then the weight.
    const edges = within(fill).getByRole('radiogroup', { name: 'Border edges' });
    expect(within(edges).getAllByRole('radio')).toHaveLength(9);
    await userEvent.click(within(edges).getByRole('radio', { name: /Top and bottom/ }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance.border).toEqual({
      edges: 'top-bottom',
      weight: 'hairline',
    });
    await userEvent.click(within(fill).getByRole('combobox', { name: 'Weight' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Strong' }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance.border?.weight).toBe('strong');
    // Cell scope: an override on B5 only; the column keeps amber.
    await userEvent.click(within(fill).getByRole('radio', { name: 'Cell B5' }));
    expect(fill).toHaveTextContent('The fill and border applies to cell B5 only.');
    await userEvent.click(within(fill).getByRole('radio', { name: 'Slate' }));
    const table = tableMap(gd, tableId)!;
    expect(cellAppearanceOverride(table, record.rows[0]!, record.columns[0]!.id)?.fill).toBe(
      'slate',
    );
    expect(tableById(gd, tableId)?.columns[0]?.appearance.fill).toBe('amber');
    await userEvent.click(within(fill).getByRole('button', { name: 'Use column appearance' }));
    expect(cellAppearanceOverride(table, record.rows[0]!, record.columns[0]!.id)).toBeNull();
    // Cell scope "None" over the column's amber is an explicit none: the cell shows no fill
    // while the column keeps its own (INSP-10 "applies to cell B5 only").
    await userEvent.click(within(fill).getByRole('radio', { name: 'None' }));
    expect(cellAppearanceOverride(table, record.rows[0]!, record.columns[0]!.id)?.fill).toBe(
      'none',
    );
    await userEvent.click(within(edges).getByRole('radio', { name: /No border/ }));
    expect(cellAppearanceOverride(table, record.rows[0]!, record.columns[0]!.id)?.border).toEqual({
      edges: 'none',
      weight: 'strong',
    });
    await userEvent.click(within(fill).getByRole('button', { name: 'Use column appearance' }));
    // Back on the column: "None" clears the fill; "No border" clears the border.
    await userEvent.click(within(fill).getByRole('radio', { name: 'Column Column 1' }));
    await userEvent.click(within(fill).getByRole('radio', { name: 'None' }));
    await userEvent.click(within(edges).getByRole('radio', { name: /No border/ }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance).toEqual({});
  });

  it('INSP-05 A11Y-04 conditional highlighting rules are the PRD triggers on the column, listed in priority order, each with a fill, text colour or mark, and removable', async () => {
    await mount();
    await userEvent.click(tab('Cell'));
    const rules = section('conditional highlighting');
    expect(rules).toHaveTextContent('Rules apply to every cell of Column 1, first match first.');
    const add = within(rules).getByRole('button', { name: 'Add a rule' });
    expect(add.title).toBe('Add a rule — the rule needs its text or count');
    await userEvent.type(within(rules).getByRole('textbox', { name: 'Text' }), 'camp');
    await userEvent.click(add);
    let record = tableById(gd, tableId)!;
    expect(record.columns[0]?.rules).toHaveLength(1);
    expect(record.columns[0]?.rules[0]).toMatchObject({
      when: { trigger: 'contains', text: 'camp' },
      style: { fill: 'amber' },
    });
    expect(within(rules).getByRole('list', { name: 'Rules' })).toHaveTextContent(
      'contains “camp” Amber fill',
    );
    // A metrics trigger with a count, and a mark as the output.
    await userEvent.click(within(rules).getByRole('combobox', { name: 'When the text' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Characters over' }));
    await userEvent.click(within(rules).getByRole('combobox', { name: 'Mark' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Strikethrough' }));
    await userEvent.click(within(rules).getByRole('button', { name: 'Add a rule' }));
    record = tableById(gd, tableId)!;
    expect(record.columns[0]?.rules[1]).toMatchObject({
      when: { trigger: 'charsOver', count: 40 },
      style: { fill: 'amber', mark: 'strikethrough' },
    });
    // A pattern trigger names a Smart Chip; a border is an output too (PRD §8).
    await userEvent.click(within(rules).getByRole('combobox', { name: 'When the text' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Fails chip' }));
    expect(within(rules).getByRole('combobox', { name: 'Chip' })).toHaveTextContent('Email');
    await userEvent.click(within(rules).getByRole('combobox', { name: 'Border' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Outline only' }));
    await userEvent.click(within(rules).getByRole('combobox', { name: 'Border weight' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Accent' }));
    await userEvent.click(within(rules).getByRole('button', { name: 'Add a rule' }));
    expect(tableById(gd, tableId)?.columns[0]?.rules[2]).toMatchObject({
      when: { trigger: 'failsChip', chip: 'email' },
      style: { border: { edges: 'outline', weight: 'accent' } },
    });
    // The list order is the priority: the third rule moves up one place.
    expect(within(rules).getByRole('button', { name: 'Move rule 1 up' }).title).toBe(
      'Move rule 1 up — already first',
    );
    await userEvent.click(within(rules).getByRole('button', { name: 'Move rule 3 up' }));
    expect(tableById(gd, tableId)?.columns[0]?.rules[1]?.when).toEqual({
      trigger: 'failsChip',
      chip: 'email',
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Rule moved up');
    await userEvent.click(
      within(rules).getByRole('button', { name: 'Remove rule 1: contains “camp”' }),
    );
    expect(tableById(gd, tableId)?.columns[0]?.rules).toHaveLength(2);
    expect(screen.getByTestId('live-region')).toHaveTextContent('Rule removed');
  });

  it('MENU-04 GRID-01 the merge controls span rows and columns from the cell; every address stays; unmerge shows the covered cells again', async () => {
    await mount();
    await userEvent.click(tab('Cell'));
    const merge = section('merge');
    const table = tableMap(gd, tableId)!;
    const before = tableAddresses(table);
    await userEvent.click(within(merge).getByRole('button', { name: 'More columns' }));
    await userEvent.click(within(merge).getByRole('button', { name: 'More rows' }));
    const record = tableById(gd, tableId)!;
    expect(spanAt(table, record.rows[0]!, record.columns[0]!.id)).toMatchObject({
      rows: 2,
      cols: 2,
    });
    expect(tableAddresses(table)).toEqual(before);
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'B5 spans 2 rows and 2 columns; every address stays',
    );
    // Past the edge the stepper stops: three columns, so at most three across.
    await userEvent.click(within(merge).getByRole('button', { name: 'More columns' }));
    expect(within(merge).getByRole('button', { name: 'More columns' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(merge).getByRole('button', { name: 'Unmerge cells' }));
    expect(spanAt(table, record.rows[0]!, record.columns[0]!.id)).toBeNull();
    expect(within(merge).getByRole('button', { name: 'Unmerge cells' }).title).toBe(
      'Unmerge cells — the cell is not merged',
    );
  });

  it('INSP-06 INSP-10 KEYS-05 the Text tab sets family, weight, size, character styles, text colour and alignment on the column with a cell override, toggles marks over the whole cell with the chord beside each, and wraps the column or the row', async () => {
    await mount();
    await userEvent.click(tab('Text'));
    const font = section('font');
    expect(font).toHaveTextContent(
      'The typography applies to Column 1 for all 4 rows, and for rows added later.',
    );
    await userEvent.click(within(font).getByRole('combobox', { name: 'Family' }));
    await userEvent.click(await screen.findByRole('option', { name: 'IBM Plex Mono' }));
    await userEvent.click(within(font).getByRole('combobox', { name: 'Weight' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Semibold' }));
    await userEvent.click(within(font).getByRole('combobox', { name: 'Size' }));
    // The whole type scale above the 11.5 px cell floor; the four weights end at 600 (DS §2).
    const sizes = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(sizes).toEqual([
      '11.5 px · cell',
      '13 px · body-sm',
      '15 px · body',
      '16 px · h3',
      '20 px · h2',
      '28 px · h1',
      '40 px · display',
    ]);
    await userEvent.click(screen.getByRole('option', { name: '15 px · body' }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance).toEqual({
      font: 'mono',
      weight: 600,
      size: 'body',
    });
    expect(tableById(gd, tableId)?.columns[0]?.wrap).toBeNull(); // a size never touches wrap (ADR-049)
    await userEvent.click(within(font).getByRole('combobox', { name: 'Weight' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Light',
      'Regular',
      'Medium',
      'Semibold',
    ]);
    await userEvent.keyboard('{Escape}');
    // Character styles are bundles on the scale; the active one reads pressed. Title (h2) needs
    // two rows: the editing replica's auto-height grows them (ADR-049), wrap is untouched.
    const presets = within(section('character styles'));
    await userEvent.click(presets.getByRole('button', { name: 'Title' }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance).toMatchObject({
      size: 'h2',
      weight: 600,
    });
    expect(tableById(gd, tableId)?.columns[0]?.wrap).toBeNull();
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      'Weight set, Size set for column Column 1',
    );
    expect(presets.getByRole('button', { name: 'Title' })).toHaveAttribute('aria-pressed', 'true');
    // Text colour and alignment.
    const colour = within(section('text colour'));
    await userEvent.click(colour.getByRole('combobox', { name: 'Text colour' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Danger' }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance.textColour).toBe('danger');
    const align = section('alignment');
    await userEvent.click(within(align).getByRole('radio', { name: 'Centre' }));
    await userEvent.click(within(align).getByRole('radio', { name: 'Bottom' }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance).toMatchObject({
      hAlign: 'center',
      vAlign: 'bottom',
    });
    // Cell scope: the override is the cell's own; the column keeps its values.
    await userEvent.click(within(font).getByRole('radio', { name: 'Cell B5' }));
    await userEvent.click(within(font).getByRole('combobox', { name: 'Weight' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Regular' }));
    const rec = tableById(gd, tableId)!;
    expect(
      cellAppearanceOverride(tableMap(gd, tableId)!, rec.rows[0]!, rec.columns[0]!.id),
    ).toEqual({ weight: 400 });
    expect(rec.columns[0]?.appearance.weight).toBe(600);
    const marks = within(section('marks'));
    const bold = marks.getByRole('button', { name: 'Bold' });
    expect(bold).toHaveAttribute('aria-pressed', 'false');
    expect(bold).toHaveAttribute('aria-keyshortcuts', 'Meta+B');
    expect(bold.title).toBe('Bold (⌘B)');
    await userEvent.click(bold);
    const record = tableById(gd, tableId)!;
    const table = tableMap(gd, tableId)!;
    expect(hasMarkThroughout(cellRich(table, record.rows[0]!, record.columns[0]!.id), 'bold')).toBe(
      true,
    );
    expect(marks.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(marks.getByRole('button', { name: 'Superscript' }));
    await userEvent.click(marks.getByRole('button', { name: 'Subscript' }));
    const rich = cellRich(table, record.rows[0]!, record.columns[0]!.id);
    expect(hasMarkThroughout(rich, 'subscript')).toBe(true);
    expect(hasMarkThroughout(rich, 'superscript')).toBe(false);
    // ADR-049: one wrap switch at the tab's scope — the cell here (chosen above); the column
    // when the scope says so; the table's default is in the Table tab. No height is written.
    const wrap = within(section('wrap'));
    expect(wrap.getByRole('switch', { name: 'Wrap text in B5' })).not.toBeChecked();
    await userEvent.click(wrap.getByRole('switch', { name: 'Wrap text in B5' }));
    expect(
      cellAppearanceOverride(tableMap(gd, tableId)!, record.rows[0]!, record.columns[0]!.id)?.wrap,
    ).toBe(true);
    expect(screen.getByTestId('live-region')).toHaveTextContent('Wrapped for B5');
    await userEvent.click(wrap.getByRole('button', { name: "Follow the column's wrap" }));
    expect(
      cellAppearanceOverride(tableMap(gd, tableId)!, record.rows[0]!, record.columns[0]!.id)?.wrap,
    ).toBeUndefined();
    await userEvent.click(within(font).getByRole('radio', { name: /Column/ }));
    await userEvent.click(wrap.getByRole('switch', { name: 'Wrap text in column Column 1' }));
    expect(tableById(gd, tableId)?.columns[0]?.wrap).toBe(true);
    expect(rowHeights(table)).toEqual([1, 1, 1, 1]);
  });

  it('INSP-06 GRID-09 KEYS-03 with rows selected the Text tab\'s wrap acts on the band in one step, and "Follow the columns\' wrap" clears it again (ADR-049, review of #169)', async () => {
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    await mount({ undo });
    const rec = tableById(gd, tableId)!;
    const table = tableMap(gd, tableId)!;
    await act(async () => {
      grid.current?.actions.selectBand(tableId, 'row', rec.rows[0]!);
      grid.current?.actions.selectBand(tableId, 'row', rec.rows[1]!, true);
      await Promise.resolve();
    });
    await userEvent.click(tab('Text'));
    const wrap = within(section('wrap'));
    expect(wrap.queryByRole('button', { name: "Follow the columns' wrap" })).toBeNull();
    const steps = undo.undoStack.length;
    await userEvent.click(wrap.getByRole('switch', { name: 'Wrap text in 2 selected rows' }));
    expect(rowMeta(table, rec.rows[0]!).wrap).toBe(true);
    expect(rowMeta(table, rec.rows[1]!).wrap).toBe(true);
    expect(rowMeta(table, rec.rows[2]!).wrap).toBeNull();
    expect(undo.undoStack).toHaveLength(steps + 1);
    expect(screen.getByTestId('live-region')).toHaveTextContent('2 rows wrapped');
    await userEvent.click(wrap.getByRole('button', { name: "Follow the columns' wrap" }));
    expect(rowMeta(table, rec.rows[0]!).wrap).toBeNull();
    expect(rowMeta(table, rec.rows[1]!).wrap).toBeNull();
    expect(undo.undoStack).toHaveLength(steps + 2);
    expect(screen.getByTestId('live-region')).toHaveTextContent(
      "2 rows follow their columns' wrap",
    );
    expect(wrap.queryByRole('button', { name: "Follow the columns' wrap" })).toBeNull();
  });

  it('INSP-07 the Arrange tab: stacking order, canvas layout, size and position in grid address and pixels, pin to viewport and DAG edges — live, positions staying on the lattice', async () => {
    // A second table on the sheet, so stacking and layout have something to order.
    const other = createTable(gd, { sheetId, at: { col: 6, row: 1 }, columns: 2, rows: 2 });
    await mount();
    await userEvent.click(tab('Arrange'));
    const stacking = section('stacking order');
    expect(stacking).toHaveTextContent('Table 1 is 1 of 2, back to front.');
    expect(within(stacking).getByRole('button', { name: 'Back' }).title).toBe(
      'Back — already at the back',
    );
    await userEvent.click(within(stacking).getByRole('button', { name: 'Front' }));
    expect(tableById(gd, tableId)?.z).toBe(1);
    expect(tableById(gd, other)?.z).toBe(0);
    expect(stacking).toHaveTextContent('Table 1 is 2 of 2');
    const layout = section('canvas layout');
    await userEvent.click(within(layout).getByRole('button', { name: 'Stacked' }));
    // Stacked: one column from the first origin, each table under the last (RESP-01 addresses follow).
    expect(tableById(gd, other)?.gridCol).toBe(1);
    expect(tableById(gd, tableId)?.gridCol).toBe(1);
    expect(tableById(gd, tableId)?.gridRow).toBeGreaterThan(tableById(gd, other)!.gridRow);
    expect(screen.getByTestId('live-region')).toHaveTextContent('Stacked: 2 tables placed');
    // DOC-02 / ADR-041 (#140): pin and DAG edges toggle in the toolbar; the tab states them.
    const viewport = section('viewport');
    expect(within(viewport).queryByRole('switch')).toBeNull();
    expect(screen.getByTestId('arrange-pinned')).toHaveTextContent('not pinned');
    expect(screen.getByTestId('arrange-edges')).toHaveTextContent('hidden');
    act(() => {
      grid.current!.commands.setTablePinned(tableId, true);
      grid.current!.commands.setSheetEdgesShown(sheetId, true);
    });
    expect(screen.getByTestId('arrange-pinned')).toHaveTextContent('pinned');
    expect(screen.getByTestId('arrange-edges')).toHaveTextContent('shown');
    expect(viewport).toHaveTextContent(/Reads from\s*0 tables/);
    // Lanes: left to right on one row; Table 1 (at the front) lands after the other.
    await userEvent.click(within(layout).getByRole('button', { name: 'Pipeline lanes' }));
    const laned = tableById(gd, tableId)!;
    expect(laned.gridRow).toBe(tableById(gd, other)!.gridRow);
    expect(laned.gridCol).toBeGreaterThan(tableById(gd, other)!.gridCol);
    const position = section('position');
    expect(position).toHaveTextContent(
      `${columnLetter(laned.gridCol)}${String(laned.gridRow + 1)}`,
    );
    expect(position).toHaveTextContent(
      `${String(laned.gridCol * LATTICE.col)} × ${String(laned.gridRow * LATTICE.row)}`,
    );
    await userEvent.click(within(position).getByRole('button', { name: 'More column' }));
    await userEvent.click(within(position).getByRole('button', { name: 'More row' }));
    const record = tableById(gd, tableId)!;
    expect([record.gridCol, record.gridRow]).toEqual([laned.gridCol + 1, laned.gridRow + 1]);
    expect(position).toHaveTextContent(
      `${columnLetter(laned.gridCol + 1)}${String(laned.gridRow + 2)}`,
    );
    expect(section('size')).toHaveTextContent('3 units · 480 px');
  });

  it('INSP-09 (partial: the Derive controls are slots) INSP-11 Derive, Categories, Sort and Filter carry their slot markers and disabled controls with reasons until their releases mount', async () => {
    const { rerender } = await mount();
    await userEvent.click(tab('Derive'));
    expect(screen.getByRole('tabpanel').querySelector('[data-slot="derive"]')).not.toBeNull();
    // HIER-01 / INSP-09: the hierarchy controls are the real panel, not a stub — the
    // hierarchy release has shipped, so no control may name it as still to come.
    const hierarchy = within(screen.getByTestId('hierarchy-panel'));
    expect(hierarchy.getByTestId('hierarchy-parent')).toHaveTextContent(/top level/);
    expect(hierarchy.getByRole('button', { name: /Nest/ }).title).not.toMatch(/release/);
    expect(screen.getByRole('button', { name: 'Add a derived column' }).title).toBe(
      'Add a derived column — arrives with the references release (#77)',
    );
    rerender(<Harness mode="organize" />);
    expect(screen.getByRole('tabpanel').querySelector('[data-slot="hierarchy"]')).not.toBeNull();
    await userEvent.click(tab('Sort'));
    expect(screen.getByRole('tabpanel').querySelector('[data-slot="sort"]')).not.toBeNull();
    // A mounted slot replaces the marker.
    rerender(<Harness mode="organize" slots={{ sort: <p>Sort panel</p> }} />);
    expect(screen.getByText('Sort panel')).toBeInTheDocument();
    expect(screen.getByRole('tabpanel').querySelector('[data-slot="sort"]')).toBeNull();
  });

  it('INSP-11 every disabled control carries a live reason — a limit of the moment or the issue that owns it — never a bare "not implemented"; the appearance controls no longer wait on any issue; view-only disables the writes with that reason', async () => {
    const { rerender } = await mount();
    await userEvent.click(tab('Cell'));
    // The weight waits on an edge being chosen: a live reason, not a release.
    const weight = within(section('fill and border')).getByRole('combobox', { name: 'Weight' });
    expect(weight).toBeDisabled();
    expect(weight).toHaveAttribute('title', 'choose an edge first');
    for (const tabName of ['Table', 'Cell', 'Text', 'Arrange'] as const) {
      await userEvent.click(tab(tabName));
      const panel = screen.getByRole('tabpanel');
      const reasons = Array.from(
        panel.querySelectorAll<HTMLElement>('[aria-disabled="true"][title], [disabled][title]'),
      ).map((el) => el.title);
      // Live limits ("already at …", "nests at most one level") say why now; a control that
      // waits for a release names the issue that owns it — never a bare "not implemented".
      for (const reason of reasons) {
        expect(reason).not.toMatch(/not implemented|in this release/);
        if (reason.includes('arrives')) expect(reason).toMatch(/#\d+/);
        // INSP-04..07 and MENU-04 have shipped: nothing in these tabs names their issues.
        expect(reason).not.toMatch(/#8[2-57]\b/);
      }
    }
    await userEvent.click(tab('Cell'));
    rerender(<Harness editable={false} />);
    expect(screen.getByRole('combobox', { name: 'Format' })).toHaveAttribute(
      'title',
      'you have view-only access',
    );
    await userEvent.click(tab('Table'));
    expect(screen.getByRole('button', { name: 'More rows' }).title).toBe(
      'More — you have view-only access',
    );
  });

  it('INSP-11 MENU-02 an aria-disabled control looks disabled and its reason is reachable by pointer, keyboard and assistive tech (#126)', async () => {
    await mount();
    await userEvent.click(tab('Arrange'));
    const back = within(section('stacking order')).getByRole('button', { name: 'Back' });
    expect(back).toHaveAttribute('aria-disabled', 'true');
    expect(back.title).toBe('Back — the only table on this sheet');
    expect(back).toHaveAccessibleDescription('the only table on this sheet');
    // Focusable, so the keyboard reaches the tooltip; the DS treats it as disabled (Button.css).
    back.focus();
    expect(back).toHaveFocus();
    await userEvent.click(tab('Cell'));
    const unmerge = within(section('merge')).getByRole('button', { name: 'Unmerge cells' });
    expect(unmerge).toHaveAttribute('aria-disabled', 'true');
    expect(unmerge).toHaveAccessibleDescription('the cell is not merged');
    const add = within(section('conditional highlighting')).getByRole('button', {
      name: 'Add a rule',
    });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add).toHaveAccessibleDescription(/./);
  });

  it('INSP-03 the head states the grouping in force, and a selected graph by kind, source and dimensions (#138)', async () => {
    const { rerender } = await mount();
    const head = () => screen.getByTestId('inspector-selected');
    expect(head()).not.toHaveTextContent('grouped by');
    act(() => {
      store.set(tableId, {
        sortBy: null,
        filter: null,
        groupBy: tableById(gd, tableId)!.columns[1]!.id,
      });
    });
    expect(head()).toHaveTextContent('grouped by Column 2');
    rerender(
      <Harness
        select={null}
        object={{ label: 'Ring graph of Table 1', facts: ['4 source rows', '2 dimensions'] }}
        slots={{ graph: <p>Graph tab</p> }}
      />,
    );
    act(() => {
      grid.current!.actions.clear();
    });
    expect(head()).toHaveTextContent('Ring graph of Table 1');
    expect(head()).toHaveTextContent('4 source rows · 2 dimensions');
  });

  it('INSP-01 each Organize tab shows its own section, and the shell can open a tab directly (#138)', async () => {
    const onOrganizeTabChange = vi.fn();
    const panels = {
      hierarchy: <p data-testid="categories-body">Categories body</p>,
      sort: <p data-testid="sort-body">Sort body</p>,
      filter: <p data-testid="filter-body">Filter body</p>,
    };
    const { rerender } = await mount({
      mode: 'organize',
      slots: panels,
      organizeTab: 'filter',
      onOrganizeTabChange,
    });
    expect(screen.getByRole('tab', { name: 'Filter' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('filter-body')).toBeVisible();
    expect(screen.queryByTestId('sort-body')).toBeNull();
    await userEvent.click(tab('Sort'));
    expect(onOrganizeTabChange).toHaveBeenCalledWith('sort');
    rerender(<Harness mode="organize" slots={panels} organizeTab="sort" />);
    expect(screen.getByTestId('sort-body')).toBeVisible();
    expect(screen.queryByTestId('filter-body')).toBeNull();
  });

  it('FIND-06 the result list renders in the rail while the bar is open and the list is shown, in sync with the current match', async () => {
    const record = tableById(gd, tableId)!;
    const match = (rowIndex: number, text: string): SearchMatch => ({
      id: `${tableId}:${String(rowIndex)}#value`,
      entryId: `${tableId}:${String(rowIndex)}`,
      field: 'value',
      text,
      distance: 0,
      start: 0,
      end: 4,
      readOnly: false,
      target: {
        kind: 'cell',
        sheetId,
        sheetOrdinal: 1,
        tableId,
        tableTitle: 'Table 1',
        rowId: record.rows[rowIndex]!,
        colId: record.columns[0]!.id,
        rowIndex,
        colIndex: 0,
        colLabel: 'Column 1',
        format: 'text',
      },
    });
    const find = fakeFind([match(0, 'Base camp'), match(1, 'Camp two')]);
    const { rerender } = await mount({ find });
    const results = within(section('find results'));
    const list = results.getByTestId('find-results');
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(rows[0]).toHaveTextContent('B5 in Table 1');
    await userEvent.click(rows[1]!);
    expect(find.actions.goTo).toHaveBeenCalledWith(1);
    rerender(<Harness find={fakeFind([match(0, 'Base camp')], false)} />);
    expect(screen.queryByTestId('find-results')).not.toBeInTheDocument();
  });
});
