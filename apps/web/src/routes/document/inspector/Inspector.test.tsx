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
  cellAppearanceOverride,
  cellFormatOverride,
  cellRich,
  columnLetter,
  createSheet,
  createTable,
  DEFAULT_SEARCH_OPTIONS,
  hasMarkThroughout,
  LATTICE,
  openDocument,
  setCellText,
  sheetEdgesShown,
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

  it('INSP-04 INSP-12 the Table tab: style, title and caption, header row, footer, frozen columns, row and column counts, outline, gridlines, alternating colour, width, wrap and fit write through at once', async () => {
    await mount();
    await userEvent.click(tab('Table'));
    // Table style: one of the four ramp pairs, as a Radix toggle group with labelled swatches.
    const style = section('table style');
    await userEvent.click(within(style).getByRole('radio', { name: 'Forest' }));
    expect(tableById(gd, tableId)?.look.style).toBe('forest');
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
      within(section('row and column size')).getByRole('button', { name: 'Fit columns to content' })
        .title,
    ).toBe('Fit columns to content — text cannot be measured in this browser');
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
    // A pattern trigger names a Smart Chip.
    await userEvent.click(within(rules).getByRole('combobox', { name: 'When the text' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Fails chip' }));
    expect(within(rules).getByRole('combobox', { name: 'Chip' })).toHaveTextContent('Email');
    await userEvent.click(
      within(rules).getByRole('button', { name: 'Remove rule 1: contains “camp”' }),
    );
    expect(tableById(gd, tableId)?.columns[0]?.rules).toHaveLength(1);
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
    // The type scale from the 11.5 px cell floor to h2; nothing that cannot fit a row.
    const sizes = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(sizes).toEqual([
      '11.5 px · cell',
      '13 px · body-sm',
      '15 px · body',
      '16 px · h3',
      '20 px · h2',
    ]);
    await userEvent.click(screen.getByRole('option', { name: '15 px · body' }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance).toEqual({
      font: 'mono',
      weight: 600,
      size: 'body',
    });
    // Character styles are bundles on the scale; the active one reads pressed.
    const presets = within(section('character styles'));
    await userEvent.click(presets.getByRole('button', { name: 'Title' }));
    expect(tableById(gd, tableId)?.columns[0]?.appearance).toMatchObject({
      size: 'h2',
      weight: 600,
    });
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
    const wrap = within(section('wrap'));
    await userEvent.click(wrap.getByRole('switch', { name: 'Wrap column Column 1' }));
    expect(tableById(gd, tableId)?.columns[0]?.wrap).toBe(true);
    await userEvent.click(wrap.getByRole('switch', { name: 'Wrap this row' }));
    expect(screen.getByTestId('live-region')).toHaveTextContent('Wrapped the row');
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
    const viewport = section('viewport');
    await userEvent.click(within(viewport).getByRole('switch', { name: 'Pin to viewport' }));
    expect(tableById(gd, tableId)?.pinned).toBe(true);
    await userEvent.click(within(viewport).getByRole('switch', { name: 'DAG edges' }));
    expect(sheetEdgesShown(gd, sheetId)).toBe(true);
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
    expect(hierarchy.getByText(/top level/)).toBeInTheDocument();
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
