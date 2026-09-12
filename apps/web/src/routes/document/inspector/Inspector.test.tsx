/**
 * The inspector rail (INSP-01..12, FMT-06, FIND-06, KEYS-05, RESP-03/04)
 * against a real Yjs document through the same `useGrid` the shell uses.
 * The Find object is a labelled FAKE: its state is hand-built so the result
 * list can be checked without a search Worker.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  cellFormatOverride,
  cellRich,
  createSheet,
  createTable,
  DEFAULT_SEARCH_OPTIONS,
  hasMarkThroughout,
  openDocument,
  setCellText,
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
import { useYVersion } from '../../../doc/use-y.js';
import type { Find } from '../find/useFind.js';
import { useGrid, type Grid } from '../grid/use-grid.js';
import { Inspector, type InspectorProps } from '../Inspector.js';
import type { InspectorMode } from '../Toolbar.js';

let gd: GedeDoc;
let sheetId: Id;
let tableId: Id;
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
}

function Harness({
  mode = 'format',
  open = true,
  onOpenChange = () => undefined,
  editable = true,
  select = 'cell',
  find = fakeFind(),
  slots,
}: HarnessProps) {
  const g = useGrid(gd, editable);
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
      <Inspector
        gd={gd}
        mode={mode}
        open={open}
        onOpenChange={onOpenChange}
        selection={g.state.selection}
        editing={g.state.editing !== null}
        editable={editable}
        commands={g.commands}
        find={find}
        onToggleMark={toggleMark}
        slots={slots}
      />
      <LiveRegion />
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

  it('INSP-04 INSP-12 the Table tab: header row, footer, frozen columns, row and column counts, width and wrap write through at once', async () => {
    await mount();
    await userEvent.click(tab('Table'));
    const headers = section('headers and footer');
    await userEvent.click(within(headers).getByRole('switch', { name: 'Header row' }));
    expect(tableById(gd, tableId)?.headerRows).toBe(0);
    await userEvent.click(within(headers).getByRole('switch', { name: 'Footer row' }));
    expect(tableById(gd, tableId)?.footerRows).toBe(1);
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
    await userEvent.click(within(size).getByRole('switch', { name: 'Wrap every row' }));
    expect(screen.getByTestId('live-region')).toHaveTextContent('rows wrapped');
  });

  it('HIER-01 HIER-02 the Table tab mounts the hierarchy panel: the selected row, its parent, and Nest / Promote acting through the grid commands', async () => {
    await mount();
    await userEvent.click(tab('Table'));
    const row = within(section('row'));
    expect(row.getByText(/top level/)).toBeInTheDocument();
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

  it('INSP-06 KEYS-05 the Text tab toggles marks over the whole selected cell, shows the chord beside each, and wraps the column or the row', async () => {
    await mount();
    await userEvent.click(tab('Text'));
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
    const wrap = within(section('wrap'));
    await userEvent.click(wrap.getByRole('switch', { name: 'Wrap column Column 1' }));
    expect(tableById(gd, tableId)?.columns[0]?.wrap).toBe(true);
    await userEvent.click(wrap.getByRole('switch', { name: 'Wrap this row' }));
    expect(screen.getByTestId('live-region')).toHaveTextContent('Wrapped the row');
  });

  it('INSP-07 the Arrange tab states size and position in grid address and pixels, and moves the table on the lattice', async () => {
    await mount();
    await userEvent.click(tab('Arrange'));
    const position = section('position');
    expect(position).toHaveTextContent('B2');
    expect(position).toHaveTextContent('160 × 22');
    await userEvent.click(within(position).getByRole('button', { name: 'More column' }));
    await userEvent.click(within(position).getByRole('button', { name: 'More row' }));
    const record = tableById(gd, tableId)!;
    expect([record.gridCol, record.gridRow]).toEqual([2, 2]);
    expect(position).toHaveTextContent('C3');
    expect(section('size')).toHaveTextContent('3 units · 480 px');
  });

  it('INSP-09 (partial: the Derive controls are slots) INSP-11 Derive, Categories, Sort and Filter carry their slot markers and disabled controls with reasons until their releases mount', async () => {
    const { rerender } = await mount();
    await userEvent.click(tab('Derive'));
    expect(screen.getByRole('tabpanel').querySelector('[data-slot="derive"]')).not.toBeNull();
    const promote = screen.getByRole('button', { name: 'Promote' });
    expect(promote).toHaveAttribute('aria-disabled', 'true');
    expect(promote.title).toBe('Promote — arrives with the hierarchy release');
    rerender(<Harness mode="organize" />);
    expect(screen.getByRole('tabpanel').querySelector('[data-slot="hierarchy"]')).not.toBeNull();
    await userEvent.click(tab('Sort'));
    expect(screen.getByRole('button', { name: 'Sort now' })).toHaveAttribute(
      'title',
      'Sort now — arrives with the sort and filter release',
    );
    // A mounted slot replaces the marker.
    rerender(<Harness mode="organize" slots={{ sort: <p>Sort panel</p> }} />);
    expect(screen.getByText('Sort panel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sort now' })).not.toBeInTheDocument();
  });

  it('INSP-11 an unimplemented control is disabled with its reason, never operable; view-only disables the writes with that reason', async () => {
    const { rerender } = await mount();
    await userEvent.click(tab('Cell'));
    const fill = within(section('fill')).getByRole('button', { name: 'Amber' });
    expect(fill).toHaveAttribute('aria-disabled', 'true');
    expect(fill.title).toBe('Amber — not implemented in this release');
    expect(within(section('border')).getByRole('combobox', { name: 'Weight' })).toBeDisabled();
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
