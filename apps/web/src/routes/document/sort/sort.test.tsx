/**
 * Sort, filter and grouping in the grid (SORT-01..06, HIER-08, RESP-02,
 * A11Y-01, ADR-026) against a real Yjs document — no shell, no room. The
 * harness is the same `useGrid` + `useSortCommands` + view store the shell
 * uses; the projection runs on the calling thread here (jsdom has no
 * Worker), through the same engine the Worker runs, and the formula engine
 * runs inline the same way.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  cellAddress,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  openDocument,
  setCellText,
  setRowCollapsed,
  setRowDepth,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
  type TableViewState,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import { engineFor } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import {
  clearViewState,
  openViewStore,
  readGroupBy,
  viewStateKey,
  ViewStoreProvider,
  type ViewStore,
} from '../../../doc/view-state.js';
import { useGrid, type Grid, type GridActions } from '../grid/use-grid.js';
import { TableView } from '../TableView.js';
import { ariaSortOf, headerGlyphs, sortModeOf } from './HeaderMenu.js';
import {
  createSortCommands,
  describeFilter,
  useSortCommands,
  type SortCommands,
} from './commands.js';
import { SortPanel } from './SortPanel.js';
import { setSharedProjectorForTests } from './useTableProjection.js';
import { createViewProjector } from './view-client.js';

interface HarnessProps {
  gd: GedeDoc;
  tableId: Id;
  store: ViewStore;
  editable?: boolean;
  /** RESP-02: the shell passes no commands on a phone, so no ▼ renders. */
  menu?: boolean;
  undo?: Y.UndoManager | undefined;
  /** Test seam: wrap the grid actions (e.g. to count `setViewRows` calls). */
  wrapActions?: ((actions: GridActions) => GridActions) | undefined;
  onGrid: (grid: Grid, sort: SortCommands) => void;
}

function Harness({
  gd,
  tableId,
  store,
  editable = true,
  menu = true,
  undo,
  wrapActions,
  onGrid,
}: HarnessProps) {
  const g = useGrid(gd, editable, { undo });
  const sort = useSortCommands(gd, store);
  // Stable like the shell's: a wrapper that changed identity per render would itself re-register.
  const actions = useMemo(
    () => (wrapActions === undefined ? g.actions : wrapActions(g.actions)),
    [g.actions, wrapActions],
  );
  onGrid(g, sort);
  useYVersion(gd.tables, { depth: 'shallow' });
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  return (
    <ViewStoreProvider value={store}>
      <TableView
        table={map}
        tier="micro"
        selected={g.state.selection?.tableId === tableId}
        selectedCell={g.cell}
        editing={g.state.editing}
        editable={editable}
        presence={[]}
        pinnedLeft={null}
        undo={undo}
        actions={actions}
        commands={g.commands}
        sort={menu ? sort : undefined}
      />
      <LiveRegion />
    </ViewStoreProvider>
  );
}

const USER = 'user-1';
const DOC = 'doc-sort';
let gd: GedeDoc;
let tableId: Id;
let rows: readonly Id[];
let cols: readonly Id[];
let store: ViewStore;
let grid: Grid | null = null;
let sortCommands: SortCommands | null = null;

/** The viewer's view for the fixture table, validated against its columns. */
const viewNow = (): TableViewState => sortCommands!.view(tableId)!;
const setView = (view: Partial<TableViewState>) => {
  act(() => {
    store.set(tableId, { sortBy: null, filter: null, groupBy: null, ...view });
  });
};

const COUNTRY = ['Singapore', 'Malaysia', 'Singapore', 'India', ''];
const CITY = ['Jurong', 'Kuala Lumpur', 'Tampines', 'Chennai', ''];

beforeEach(() => {
  setSharedProjectorForTests(createViewProjector({ worker: false }));
  localStorage.clear();
  store = openViewStore(USER, DOC);
  gd = openDocument(new Y.Doc());
  const sheetId = createSheet(gd);
  tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 5 });
  const record = tableById(gd, tableId)!;
  rows = record.rows;
  cols = record.columns.map((c) => c.id);
  COUNTRY.forEach((v, i) => {
    if (v !== '') setCellText(gd, tableId, rows[i]!, cols[0]!, v);
  });
  CITY.forEach((v, i) => {
    if (v !== '') setCellText(gd, tableId, rows[i]!, cols[1]!, v);
  });
  gd.doc.transact(() => {
    gd.tables.get(tableId)!.set('footerRows', 1);
  });
});

afterEach(() => {
  setSharedProjectorForTests(null);
  grid = null;
  sortCommands = null;
});

function mount(
  props: Partial<Pick<HarnessProps, 'editable' | 'undo' | 'menu' | 'wrapActions'>> = {},
) {
  return render(
    <Harness
      gd={gd}
      tableId={tableId}
      store={store}
      {...props}
      onGrid={(g, s) => {
        grid = g;
        sortCommands = s;
      }}
    />,
  );
}

/** The table's grid — a treegrid while its outline shows nesting (HIER), a grid otherwise. */
const gridEl = () => screen.queryByRole('grid') ?? screen.getByRole('treegrid');
const header = (label: string) =>
  within(gridEl()).getByRole('columnheader', { name: new RegExp(label) });
const menuButton = (label: string) =>
  screen.getByRole('button', { name: `Sort, filter or group ${label}` });
/** Column-0 text of every rendered data row, top to bottom. */
const columnTexts = () =>
  within(gridEl())
    .getAllByRole('row')
    .filter((r) => r.getAttribute('aria-rowindex') !== null && !r.classList.contains('gd-band'))
    .map((r) => within(r).getAllByRole('gridcell')[0]?.textContent ?? '');
const addressOf = (rowIndex: number, colIndex: number) =>
  cellAddress(tableMap(gd, tableId)!, rows[rowIndex]!, cols[colIndex]!);
const cellByAddress = (address: string) =>
  gridEl().querySelector<HTMLElement>(`[data-address="${address}"]`);

/** Choose an option in a Radix Select (a combobox): open it, pick by name. */
async function choose(trigger: HTMLElement, optionName: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('option', { name: optionName }));
}

async function openMenu(label: string) {
  await userEvent.click(menuButton(label));
  // Radix names the menu by its trigger (aria-labelledby wins over the surface's aria-label).
  return screen.findByRole('menu', { name: `Sort, filter or group ${label}` });
}

describe('header menu (SORT-01, MENU-03)', () => {
  it('SORT-01 each header carries a ▼ opening None, A–Z, Z–A, Chars, Words, Freq, the group toggle and a contains filter', async () => {
    mount();
    expect(menuButton('Column 1')).toBeInTheDocument();
    expect(menuButton('Column 2')).toBeInTheDocument();
    const menu = await openMenu('Column 1');
    const radios = within(menu).getAllByRole('menuitemradio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'None',
      'A–Z',
      'Z–A',
      'Chars',
      'Words',
      'Freq',
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'None' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Group rows by this column' }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByRole('menuitem', { name: 'Filter this column…' })).toBeInTheDocument();
    // MENU-02: Clear is present but disabled with its reason while nothing is active.
    const clear = within(menu).getByRole('menuitem', { name: 'Clear sort, filter and grouping' });
    expect(clear).toHaveAttribute('aria-disabled', 'true');
    expect(clear).toHaveAttribute('title', 'nothing is sorted, filtered or grouped');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(menuButton('Column 1')).toHaveFocus();
  });

  it('HIER-04 MENU-03 the ▼ carries "Use as outline column" for an editor — checked on the column that carries the outline, a document write; a viewer’s ▼ has no such item (ADR-051)', async () => {
    mount();
    const first = await openMenu('Column 1');
    expect(
      within(first).getByRole('menuitemcheckbox', { name: 'Use as outline column' }),
    ).toHaveAttribute('aria-checked', 'true'); // the first visible column, by default
    await userEvent.keyboard('{Escape}');
    const second = await openMenu('Column 2');
    const item = within(second).getByRole('menuitemcheckbox', { name: 'Use as outline column' });
    expect(item).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(item);
    await waitFor(() => {
      expect(tableById(gd, tableId)?.outlineColumn).toBe(cols[1]);
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Outline column: Column 2');
    // The outline is drawn in Column 2 now: its cells carry the class, Column 1's do not.
    expect(cellByAddress(addressOf(0, 1)!)).toHaveClass('gd-cell--outline');
    expect(cellByAddress(addressOf(0, 0)!)).not.toHaveClass('gd-cell--outline');
    cleanup();
    mount({ editable: false });
    const viewer = await openMenu('Column 2');
    expect(
      within(viewer).queryByRole('menuitemcheckbox', { name: 'Use as outline column' }),
    ).toBeNull();
  });

  it('SORT-01 choosing A–Z sorts the rows on screen, tints the header with ↑ and sets aria-sort; no address changes', async () => {
    mount();
    expect(columnTexts()).toEqual(['Singapore', 'Malaysia', 'Singapore', 'India', '']);
    const b5 = addressOf(3, 0); // India's cell
    expect(cellByAddress(b5!)).toHaveTextContent('India');
    const menu = await openMenu('Column 1');
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'A–Z' }));
    await waitFor(() => {
      expect(columnTexts()).toEqual(['India', 'Malaysia', 'Singapore', 'Singapore', '']);
    });
    expect(header('Column 1')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('Column 1')).toHaveClass('gd-table__header--view');
    expect(header('Column 1').querySelector('[data-glyph="arrow-up"]')).not.toBeNull();
    expect(header('Column 2')).not.toHaveAttribute('aria-sort');
    // Non-negotiable 3: India is still at its address, now drawn first.
    expect(addressOf(3, 0)).toBe(b5);
    expect(cellByAddress(b5!)).toHaveTextContent('India');
    expect(tableById(gd, tableId)!.rows).toEqual(rows);
    expect(screen.getByTestId('live-region')).toHaveTextContent('Sorted Column 1 A–Z');
    // Z–A: ↓ and descending; the blank row stays last.
    const again = await openMenu('Column 1');
    await userEvent.click(within(again).getByRole('menuitemradio', { name: 'Z–A' }));
    await waitFor(() => {
      expect(columnTexts()).toEqual(['Singapore', 'Singapore', 'Malaysia', 'India', '']);
    });
    expect(header('Column 1')).toHaveAttribute('aria-sort', 'descending');
    expect(header('Column 1').querySelector('[data-glyph="arrow-down"]')).not.toBeNull();
  });

  it('SORT-01 Chars, Words and Freq show the ⇅ glyph with aria-sort="other"', async () => {
    mount();
    const menu = await openMenu('Column 2');
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Words' }));
    await waitFor(() => {
      expect(header('Column 2')).toHaveAttribute('aria-sort', 'other');
    });
    expect(header('Column 2').querySelector('[data-glyph="sort"]')).not.toBeNull();
    await waitFor(() => {
      // "Kuala Lumpur" has two words: first.
      expect(columnTexts()[0]).toBe('Malaysia');
    });
  });

  it('SORT-01 KEYS-03 a sort is not a document edit: nothing reaches the document or the undo stack, and the view persists per user and document on the device', async () => {
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    mount({ undo });
    const menu = await openMenu('Column 1');
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'A–Z' }));
    await waitFor(() => {
      expect(columnTexts()[0]).toBe('India');
    });
    expect(undo.canUndo()).toBe(false);
    const stored = JSON.stringify(tableMap(gd, tableId)!.toJSON());
    expect(stored).not.toContain('sortBy');
    expect(stored).not.toContain('groupBy');
    // Persisted under (user, document), readable by a fresh store for the same pair only.
    const raw = localStorage.getItem(viewStateKey(USER, DOC));
    expect(raw).toContain('"az"');
    expect(openViewStore(USER, DOC).get(tableId).sortBy).toEqual({ colId: cols[0], mode: 'az' });
    expect(openViewStore('someone-else', DOC).get(tableId).sortBy).toBeNull();
    expect(openViewStore(USER, 'another-doc').get(tableId).sortBy).toBeNull();
    // AUTH-09: sign-out forgets every view on the device.
    expect(clearViewState()).toEqual([viewStateKey(USER, DOC)]);
    expect(localStorage.getItem(viewStateKey(USER, DOC))).toBeNull();
  });

  it('SORT-01 a column both sorted and filtered shows both glyphs; a filter over every column marks every header', async () => {
    mount();
    setView({
      sortBy: { colId: cols[0]!, mode: 'az' },
      filter: { colId: cols[0]!, text: 'a', fuzzy: false, facet: null },
    });
    await waitFor(() => {
      expect(header('Column 1').querySelector('[data-glyph="arrow-up"]')).not.toBeNull();
      expect(header('Column 1').querySelector('[data-glyph="search"]')).not.toBeNull();
    });
    expect(header('Column 2').querySelector('[data-glyph="search"]')).toBeNull();
    expect(header('Column 1')).toHaveAttribute('title', 'Column 1 — sorted A–Z, filtered');
    setView({ filter: { colId: null, text: 'a', fuzzy: false, facet: null } });
    await waitFor(() => {
      expect(header('Column 2').querySelector('[data-glyph="search"]')).not.toBeNull();
    });
    expect(header('Column 1').querySelector('[data-glyph="search"]')).not.toBeNull();
    expect(header('Column 2')).toHaveClass('gd-table__header--view');
    expect(header('Column 2')).toHaveAttribute('title', 'Column 2 — filtered (any column)');
    // The ▼ of any column edits the any-column filter and keeps its scope.
    const menu = await openMenu('Column 2');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /^Filter: any column/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter Column 2' });
    const field = within(panel).getByLabelText('Any column contains');
    await userEvent.clear(field);
    await userEvent.type(field, 'Tampines');
    // INSP-12 (#138): live — no Apply step; the view follows the keystrokes.
    await waitFor(() => {
      expect(viewNow().filter).toEqual({
        colId: null,
        text: 'Tampines',
        fuzzy: false,
        facet: null,
      });
    });
  });
});

describe('filter (SORT-01, SORT-03, SORT-04)', () => {
  it('SORT-03 "Filter this column…" opens a panel with focus in the field; a fuzzy contains filter keeps near misses and the footer counts the rows shown', async () => {
    mount();
    const menu = await openMenu('Column 1');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Filter this column…' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter Column 1' });
    const field = within(panel).getByLabelText('Column 1 contains');
    await waitFor(() => {
      expect(field).toHaveFocus();
    });
    expect(
      within(panel).getByRole('switch', { name: 'Fuzzy match — tolerates typos' }),
    ).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(field, 'Sngapore');
    // INSP-12 (#138): the filter applies as it is typed — no Apply step; the panel stays open
    // for more changes and Escape closes it.
    await waitFor(() => {
      expect(columnTexts()).toEqual(['Singapore', 'Singapore', '']);
    });
    expect(within(panel).queryByRole('button', { name: 'Apply' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Two Singapore rows survive; the empty row is exempt and stays at the end.
    expect(header('Column 1').querySelector('[data-glyph="search"]')).not.toBeNull();
    expect(screen.getByTestId('table-footer')).toHaveTextContent('3 of 5 rows');
    expect(viewNow().filter).toEqual({
      colId: cols[0],
      text: 'Sngapore',
      fuzzy: true,
      facet: null,
    });
    // MENU-05: focus is back on the ▼ that started it.
    expect(menuButton('Column 1')).toHaveFocus();
    // Exact matching drops the near miss.
    const again = await openMenu('Column 1');
    await userEvent.click(within(again).getByRole('menuitem', { name: /^Filter: / }));
    const panel2 = await screen.findByRole('dialog', { name: 'Filter Column 1' });
    expect(within(panel2).getByLabelText('Column 1 contains')).toHaveValue('Sngapore');
    await userEvent.click(within(panel2).getByRole('switch'));
    // The switch is a whole step: it applies at once.
    await waitFor(() => {
      expect(columnTexts()).toEqual(['']);
    });
    expect(screen.getByTestId('table-footer')).toHaveTextContent('1 of 5 rows');
  });

  it('SORT-04 an entity facet keeps rows whose scoped cell contains a Smart Chip match', async () => {
    mount();
    const menu = await openMenu('Column 1');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Filter this column…' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter Column 1' });
    await choose(within(panel).getByRole('combobox', { name: 'Has an entity' }), 'Country');
    await waitFor(() => {
      expect(columnTexts()).toEqual(['Singapore', 'Malaysia', 'Singapore', 'India', '']);
    });
    // Column 2 holds cities, not countries: the same facet there keeps only the empty row.
    sortCommands!.setFilter(tableId, { colId: cols[1]!, text: '', fuzzy: false, facet: 'country' });
    await waitFor(() => {
      expect(columnTexts()).toEqual(['']);
    });
    expect(screen.getByTestId('live-region')).toHaveTextContent('Filtered: Column 2 has a Country');
  });
});

describe('grouping (SORT-05, HIER-08 (partial: bands only))', () => {
  it('SORT-05 grouping collapses rows into bands stating value and count on the grouped column, each collapsible, after the sort', async () => {
    mount();
    setView({ sortBy: { colId: cols[1]!, mode: 'az' } });
    const menu = await openMenu('Column 1');
    await userEvent.click(
      within(menu).getByRole('menuitemcheckbox', { name: 'Group rows by this column' }),
    );
    // HIER-08: the hierarchy layer reads the grouped column from the viewer's store.
    expect(readGroupBy(store, tableId)).toBe(cols[0]);
    const groups = await within(gridEl()).findAllByRole('rowgroup');
    // Sorted by city A–Z first: Chennai (India), Jurong (Singapore), Kuala Lumpur (Malaysia), Tampines.
    expect(
      groups.map((g) => g.getAttribute('aria-label') ?? g.getAttribute('aria-labelledby')),
    ).toHaveLength(3);
    const bands = within(gridEl()).getAllByTestId('group-band');
    expect(bands.map((b) => within(b).getByRole('button').textContent)).toEqual([
      'India1 row',
      'Singapore2 rows',
      'Malaysia1 row',
    ]);
    const first = within(bands[0]!).getByRole('button');
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(bands[0]).toHaveAttribute('role', 'row');
    expect(within(bands[0]!).getByRole('rowheader')).toHaveAttribute('aria-colspan', '2');
    // The band sits on the grouped column: Column 1 starts at 0 px.
    expect(first).toHaveStyle({ left: '0px' });
    // Within a band the sort order holds; the empty row is loose after the bands.
    expect(columnTexts()).toEqual(['India', 'Singapore', 'Singapore', 'Malaysia', '']);
    expect(header('Column 1').querySelector('[data-glyph="group"]')).not.toBeNull();
    expect(gridEl()).toHaveAttribute('aria-rowcount', String(5 + 3 + 1));
    // Collapse Singapore: its two rows leave the grid, the band stays, the count too.
    await userEvent.click(within(bands[1]!).getByRole('button'));
    expect(within(bands[1]!).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    expect(columnTexts()).toEqual(['India', 'Malaysia', '']);
    expect(gridEl()).toHaveAttribute('aria-rowcount', String(3 + 3 + 1));
    // Nothing moved in the document.
    expect(tableById(gd, tableId)!.rows).toEqual(rows);
    // Removing the grouping restores the flat rows (HIER-08).
    const again = await openMenu('Column 1');
    await userEvent.click(
      within(again).getByRole('menuitemcheckbox', { name: 'Group rows by this column' }),
    );
    await waitFor(() => {
      expect(within(gridEl()).queryAllByRole('rowgroup')).toHaveLength(0);
    });
    expect(columnTexts()).toEqual(['India', 'Singapore', 'Malaysia', 'Singapore', '']);
  });

  it('SORT-05 A11Y-01 a band toggles from the keyboard with Enter and the group band is not a data cell', async () => {
    mount();
    setView({ groupBy: cols[0]! });
    const bands = await within(gridEl()).findAllByTestId('group-band');
    const toggle = within(bands[0]!).getByRole('button');
    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(bands[0]!).queryByRole('gridcell')).toBeNull();
  });
});

describe('clear (SORT-06)', () => {
  it('SORT-06 Clear resets sort, filter and grouping for the table in one action and forgets the stored view', async () => {
    mount();
    setView({
      sortBy: { colId: cols[0]!, mode: 'az' },
      filter: { colId: null, text: 'Singapore', fuzzy: false, facet: null },
      groupBy: cols[0]!,
    });
    await within(gridEl()).findAllByTestId('group-band');
    expect(localStorage.getItem(viewStateKey(USER, DOC))).not.toBeNull();
    const menu = await openMenu('Column 2');
    await userEvent.click(
      within(menu).getByRole('menuitem', { name: 'Clear sort, filter and grouping' }),
    );
    await waitFor(() => {
      expect(columnTexts()).toEqual(['Singapore', 'Malaysia', 'Singapore', 'India', '']);
    });
    expect(viewNow()).toEqual({ sortBy: null, filter: null, groupBy: null });
    expect(within(gridEl()).queryAllByRole('rowgroup')).toHaveLength(0);
    expect(screen.getByTestId('table-footer')).toHaveTextContent('5 rows');
    // Nothing left on the device for this table.
    expect(localStorage.getItem(viewStateKey(USER, DOC))).toBeNull();
  });
});

describe('traversal and read-only (GRID-05, RESP-02, SHARE-03)', () => {
  it('GRID-05 arrows and Enter move through the sorted order, and past its last row a row is appended', async () => {
    mount();
    setView({ sortBy: { colId: cols[0]!, mode: 'az' } });
    await waitFor(() => {
      expect(columnTexts()[0]).toBe('India');
    });
    const india = cellByAddress(addressOf(3, 0)!)!;
    // A11Y-01: with nothing selected, the table's tab stop is the first row *on screen*.
    expect(india).toHaveAttribute('tabindex', '0');
    expect(cellByAddress(addressOf(0, 0)!)).toHaveAttribute('tabindex', '-1');
    await userEvent.click(india);
    expect(india).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}');
    // Next on screen is Malaysia (document row 1), not document row 4.
    expect(cellByAddress(addressOf(1, 0)!)).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowUp}');
    expect(india).toHaveAttribute('aria-selected', 'true');
    // Down from the last visible row (the blank one) appends a row.
    await userEvent.click(cellByAddress(addressOf(4, 0)!)!);
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(tableById(gd, tableId)!.rows).toHaveLength(6);
    });
    const appended = tableById(gd, tableId)!.rows[5]!;
    await waitFor(() => {
      expect(grid!.cell?.rowId).toBe(appended);
      // The new row renders at once, before the next projection lands.
      expect(
        gridEl().querySelector(
          `[data-address="${cellAddress(tableMap(gd, tableId)!, appended, cols[0]!)!}"]`,
        ),
      ).not.toBeNull();
    });
  });

  it('GRID-05 SORT-01 an edit in a sorted view lands in the underlying row; Enter then moves down the screen order', async () => {
    mount();
    setView({ sortBy: { colId: cols[0]!, mode: 'az' } });
    await waitFor(() => {
      expect(columnTexts()).toEqual(['India', 'Malaysia', 'Singapore', 'Singapore', '']);
    });
    // Third on screen is document row 0 (the first Singapore; the sort is stable) → B5.
    const third = within(gridEl())
      .getAllByRole('row')
      .filter((r) => r.getAttribute('aria-rowindex') !== null)[2]!;
    const target = within(third).getAllByRole('gridcell')[0]!;
    expect(target).toHaveAttribute('data-address', addressOf(0, 0));
    await userEvent.click(target);
    fireEvent.keyDown(target, { code: 'KeyZ', key: 'Z' });
    fireEvent.keyDown(screen.getByLabelText(`Edit ${addressOf(0, 0)!}`), {
      code: 'Enter',
      key: 'Enter',
    });
    const map = tableMap(gd, tableId)!;
    expect(cellText(map, rows[0]!, cols[0]!)).toBe('Z');
    expect(cellText(map, rows[2]!, cols[0]!)).toBe('Singapore');
    expect(cellText(map, rows[3]!, cols[0]!)).toBe('India');
    expect(tableById(gd, tableId)!.rows).toEqual(rows);
    // Enter moved down the screen order from the edited row: the other Singapore (row 2).
    expect(grid!.cell?.rowId).toBe(rows[2]);
    await waitFor(() => {
      expect(columnTexts()).toEqual(['India', 'Malaysia', 'Singapore', 'Z', '']);
    });
  });

  it('A11Y-01 GRID-05 when the selected row leaves the view (edited past the filter, or its band collapsed) the selection moves to the row now at its place and the grid keeps a tab stop', async () => {
    mount();
    setView({ filter: { colId: cols[0]!, text: 'Singapore', fuzzy: false, facet: null } });
    await waitFor(() => {
      expect(columnTexts()).toEqual(['Singapore', 'Singapore', '']);
    });
    const first = cellByAddress(addressOf(0, 0)!)!;
    await userEvent.click(first);
    fireEvent.keyDown(first, { code: 'KeyX', key: 'X' });
    // Blur commits in place (GRID-06); row 0 no longer matches and leaves the view.
    fireEvent.blur(screen.getByLabelText(`Edit ${addressOf(0, 0)!}`));
    await waitFor(() => {
      expect(columnTexts()).toEqual(['Singapore', '']);
    });
    await waitFor(() => {
      expect(grid!.cell?.rowId).toBe(rows[2]);
    });
    expect(gridEl().querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
    act(() => {
      grid!.actions.move('down');
    });
    expect(grid!.cell?.rowId).toBe(rows[4]);
    // A band collapsing over the selection moves it the same way.
    setView({ groupBy: cols[0]! });
    await waitFor(() => {
      expect(within(gridEl()).getAllByTestId('group-band')).toHaveLength(4);
    });
    await userEvent.click(cellByAddress(addressOf(1, 0)!)!); // Malaysia, alone in its band
    const bands = within(gridEl()).getAllByTestId('group-band');
    const malaysia = bands.find((b) => b.textContent?.includes('Malaysia'))!;
    await userEvent.click(within(malaysia).getByRole('button'));
    await waitFor(() => {
      expect(grid!.cell?.rowId).not.toBe(rows[1]);
    });
    expect(cellByAddress(addressOf(1, 0)!)).toBeNull();
    expect(gridEl().querySelectorAll('[role="gridcell"][tabindex="0"]')).toHaveLength(1);
  });

  it('RESP-02 on a phone no ▼ renders; the viewer’s stored view still applies and bands still expand and collapse', async () => {
    store.set(tableId, {
      sortBy: { colId: cols[0]!, mode: 'az' },
      filter: null,
      groupBy: cols[0]!,
    });
    mount({ editable: false, menu: false });
    expect(screen.queryByRole('button', { name: /Sort, filter or group/ })).not.toBeInTheDocument();
    const bands = await within(gridEl()).findAllByTestId('group-band');
    expect(bands.map((b) => within(b).getByRole('button').textContent)).toEqual([
      'India1 row',
      'Malaysia1 row',
      'Singapore2 rows',
    ]);
    expect(header('Column 1')).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(within(bands[2]!).getByRole('button'));
    expect(columnTexts()).toEqual(['India', 'Malaysia', '']);
  });

  it('SHARE-03 a view-only participant sorts their own view: the ▼ renders and works, and the document stays untouched', async () => {
    mount({ editable: false });
    const menu = await openMenu('Column 1');
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Z–A' }));
    await waitFor(() => {
      expect(columnTexts()).toEqual(['Singapore', 'Singapore', 'Malaysia', 'India', '']);
    });
    expect(JSON.stringify(tableMap(gd, tableId)!.toJSON())).not.toContain('sortBy');
    // No edit affordance came with it (RESP-02 / SHARE-03): nothing to type into a band, no add-row.
    expect(screen.queryByRole('button', { name: /Add row to/ })).not.toBeInTheDocument();
  });

  it('SORT-01 SORT-04 a formula column sorts and facets by its evaluated value (FX-07), re-projecting when the engine answers', async () => {
    // Column 2 becomes a derived column: each cell concatenates Column 1 with a suffix.
    const map = tableMap(gd, tableId)!;
    const suffix = ['@1cloudhub.com', ' Ltd', ' desk', '', ''];
    rows.forEach((rowId, i) => {
      if (i < 3) {
        setCellText(
          gd,
          tableId,
          rowId,
          cols[1]!,
          `=Concat(${cellAddress(map, rowId, cols[0]!)!}, "${suffix[i] ?? ''}")`,
        );
      }
    });
    mount();
    setView({ sortBy: { colId: cols[1]!, mode: 'az' } });
    await act(async () => {
      await engineFor(gd.doc).settled();
    });
    // By value: "Chennai desk" (text), "Malaysia Ltd", "Singapore desk", "Singapore@1cloudhub.com".
    await waitFor(() => {
      expect(columnTexts()).toEqual(['India', 'Malaysia', 'Singapore', 'Singapore', '']);
    });
    // The facet Email reads the values: only the concatenated address matches.
    setView({ filter: { colId: cols[1]!, text: '', fuzzy: false, facet: 'email' } });
    await waitFor(() => {
      expect(columnTexts()).toEqual(['Singapore', '']);
    });
    // The source text never matches: no value contains "Concat".
    setView({ filter: { colId: cols[1]!, text: 'Concat', fuzzy: false, facet: null } });
    await waitFor(() => {
      expect(columnTexts()).toEqual(['']);
    });
  });

  it('HIER-06 SORT-01 a collapsed subtree stays out of a sorted view and out of traversal: one visibility seam', async () => {
    // Rows 1 and 2 nest under row 0 (Singapore); row 0 collapses.
    setRowDepth(gd, tableId, rows[1]!, 1);
    setRowDepth(gd, tableId, rows[2]!, 1);
    setRowCollapsed(gd, tableId, rows[0]!, true);
    mount();
    expect(columnTexts()).toEqual(['Singapore', 'India', '']);
    setView({ sortBy: { colId: cols[0]!, mode: 'az' } });
    await waitFor(() => {
      expect(columnTexts()).toEqual(['India', 'Singapore', '']);
    });
    // The hidden rows are neither drawn nor reachable: down from India lands on Singapore.
    await userEvent.click(cellByAddress(addressOf(3, 0)!)!);
    await userEvent.keyboard('{ArrowDown}');
    expect(grid!.cell?.rowId).toBe(rows[0]);
    await userEvent.keyboard('{ArrowDown}');
    expect(grid!.cell?.rowId).toBe(rows[4]);
    // Expanding brings the children back, in the sorted order, through the same seam.
    act(() => {
      setRowCollapsed(gd, tableId, rows[0]!, false);
    });
    await waitFor(() => {
      expect(columnTexts()).toEqual(['India', 'Malaysia', 'Singapore', 'Singapore', '']);
    });
    // The outline is not drawn while sorted (HIER-08): no chevron, a plain grid.
    expect(screen.queryByTestId('outline-chevron')).toBeNull();
    expect(screen.queryByRole('treegrid')).toBeNull();
  });

  it('SORT-01 the grid registers its view rows once per change, not once per render', async () => {
    const calls: (readonly Id[] | null)[] = [];
    mount({
      wrapActions: (actions) => ({
        ...actions,
        setViewRows: (id, list) => {
          calls.push(list);
          actions.setViewRows(id, list);
        },
      }),
    });
    setView({ sortBy: { colId: cols[0]!, mode: 'az' } });
    await waitFor(() => {
      expect(columnTexts()[0]).toBe('India');
    });
    const before = calls.length;
    // Renders that change nothing about the rows: a selection, then a presence-free re-render.
    await userEvent.click(cellByAddress(addressOf(3, 0)!)!);
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowUp}');
    expect(calls.length).toBe(before);
    // A change to the rows registers exactly once more.
    setView({ sortBy: { colId: cols[0]!, mode: 'za' } });
    await waitFor(() => {
      expect(columnTexts()[0]).toBe('Singapore');
    });
    expect(calls.length).toBe(before + 1);
  });
});

describe('helpers', () => {
  it('SORT-01 headerGlyphs, ariaSortOf and sortModeOf read one column of the view', () => {
    const view = {
      sortBy: { colId: 'a', mode: 'chars' as const },
      filter: { colId: 'b', text: 'x', fuzzy: false, facet: null },
      groupBy: null,
    };
    expect(sortModeOf(view, 'a')).toBe('chars');
    expect(sortModeOf(view, 'b')).toBe('none');
    expect(headerGlyphs(view, 'a')).toEqual([{ icon: 'sort', label: 'sorted by Chars' }]);
    expect(headerGlyphs(view, 'b')).toEqual([{ icon: 'search', label: 'filtered' }]);
    expect(headerGlyphs(view, 'c')).toEqual([]);
    expect(headerGlyphs({ ...view, filter: { ...view.filter, colId: 'a' } }, 'a')).toEqual([
      { icon: 'sort', label: 'sorted by Chars' },
      { icon: 'search', label: 'filtered' },
    ]);
    expect(headerGlyphs({ ...view, filter: { ...view.filter, colId: null } }, 'c')).toEqual([
      { icon: 'search', label: 'filtered (any column)' },
    ]);
    expect(ariaSortOf(view, 'a')).toBe('other');
    expect(ariaSortOf({ ...view, sortBy: { colId: 'a', mode: 'az' } }, 'a')).toBe('ascending');
    expect(ariaSortOf({ ...view, sortBy: { colId: 'a', mode: 'za' } }, 'a')).toBe('descending');
    expect(ariaSortOf(view, 'b')).toBeUndefined();
    expect(describeFilter({ colId: null, text: ' x ', fuzzy: true, facet: 'email' }, null)).toBe(
      'any column roughly contains “x” and has a Email',
    );
  });

  it('SORT-01 createSortCommands writes the viewer store and announces each command; a column the table lacks stores none', () => {
    const announce = vi.fn();
    const commands = createSortCommands({ gd, store, announce });
    expect(commands.setSort(tableId, cols[0]!, 'freq')).toEqual({ colId: cols[0], mode: 'freq' });
    expect(announce).toHaveBeenLastCalledWith('Sorted Column 1 Freq');
    expect(store.get(tableId).sortBy).toEqual({ colId: cols[0], mode: 'freq' });
    expect(commands.setGroupBy(tableId, cols[1]!)).toBe(cols[1]);
    expect(announce).toHaveBeenLastCalledWith('Grouped by Column 2');
    expect(commands.setGroupBy(tableId, 'not-a-column')).toBeNull();
    expect(commands.setSort(tableId, cols[0]!, null)).toBeNull();
    expect(announce).toHaveBeenLastCalledWith('Sort cleared');
    expect(
      commands.setFilter(tableId, { colId: 'gone', text: 'x', fuzzy: false, facet: null }),
    ).toEqual({
      colId: null,
      text: 'x',
      fuzzy: false,
      facet: null,
    });
    expect(commands.clear(tableId)).toBe(true);
    expect(announce).toHaveBeenLastCalledWith('Sort, filter and grouping cleared');
    expect(commands.view(tableId)).toEqual({ sortBy: null, filter: null, groupBy: null });
    expect(commands.view('nope')).toBeNull();
    // An unknown table is a no-op, not a throw.
    expect(commands.setSort('nope', cols[0]!, 'az')).toBeNull();
    expect(commands.clear('nope')).toBe(false);
  });

  it('SORT-01 the main-thread projector answers synchronously through the same engine, so nothing is ever superseded', async () => {
    const projector = createViewProjector({ worker: false });
    const table = tableMap(gd, tableId)!;
    const { buildProjectionInput } = await import('@gede/core');
    const input = buildProjectionInput(
      table,
      { sortBy: { colId: cols[0]!, mode: 'az' }, filter: null, groupBy: null },
      'en-US',
    );
    const first = projector.project(tableId, input);
    const second = projector.project(tableId, input);
    const a = await first;
    const b = await second;
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) expect(a.projection.rowIds[0]).toBe(rows[3]);
    expect(projector.mode).toBe('main');
  });

  it('SORT-01 the Worker client matches responses by id, marks superseded ones stale and recycles a failed Worker', async () => {
    // A FAKE Worker that echoes the engine's answer asynchronously (labelled: not a browser Worker).
    const { handleViewRequest } = await import('@gede/core');
    class FakeWorker {
      onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      terminated = false;
      postMessage(request: unknown) {
        setTimeout(() => {
          if (this.terminated) return;
          const r = request as Parameters<typeof handleViewRequest>[0];
          this.onmessage?.({ data: handleViewRequest(r) } as MessageEvent<unknown>);
        }, 0);
      }
      terminate() {
        this.terminated = true;
      }
    }
    const spawned: FakeWorker[] = [];
    const projector = createViewProjector({
      worker: true,
      spawn: () => {
        const w = new FakeWorker();
        spawned.push(w);
        return w as unknown as Worker;
      },
    });
    const { buildProjectionInput } = await import('@gede/core');
    const input = buildProjectionInput(
      tableMap(gd, tableId)!,
      { sortBy: { colId: cols[0]!, mode: 'az' }, filter: null, groupBy: null },
      'en-US',
    );
    const a = projector.project(tableId, input);
    const b = projector.project(tableId, input);
    const ra = await a;
    const rb = await b;
    expect(ra.ok).toBe(false);
    expect('stale' in ra && ra.stale).toBe(true);
    expect(rb.ok).toBe(true);
    if (rb.ok) expect(rb.projection.rowIds[0]).toBe(rows[3]);
    expect(spawned).toHaveLength(1);
    // A Worker error settles what is in flight and the next call spawns afresh.
    const c = projector.project(tableId, input);
    spawned[0]!.onerror?.({ message: 'boom' } as ErrorEvent);
    const rc = await c;
    expect(rc.ok).toBe(false);
    expect('error' in rc && rc.error).toBe('boom');
    const d = await projector.project(tableId, input);
    expect(d.ok).toBe(true);
    expect(spawned).toHaveLength(2);
    projector.dispose();
    expect(spawned[1]!.terminated).toBe(true);
  });

  it('SORT-01 a projection the Worker never answers times out, is recycled, and the next request gets a fresh Worker', async () => {
    vi.useFakeTimers();
    try {
      // A FAKE Worker that swallows every request (labelled: not a browser Worker).
      class SilentWorker {
        onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
        onerror: ((e: ErrorEvent) => void) | null = null;
        terminated = false;
        postMessage() {
          /* never answers */
        }
        terminate() {
          this.terminated = true;
        }
      }
      const spawned: SilentWorker[] = [];
      const projector = createViewProjector({
        worker: true,
        timeoutMs: 50,
        spawn: () => {
          const w = new SilentWorker();
          spawned.push(w);
          return w as unknown as Worker;
        },
      });
      const { buildProjectionInput } = await import('@gede/core');
      const input = buildProjectionInput(
        tableMap(gd, tableId)!,
        { sortBy: { colId: cols[0]!, mode: 'az' }, filter: null, groupBy: null },
        'en-US',
      );
      const a = projector.project(tableId, input);
      const other = projector.project('other-table', input);
      await vi.advanceTimersByTimeAsync(60);
      const ra = await a;
      expect(ra.ok).toBe(false);
      expect('error' in ra && ra.error).toMatch(/timed out after 50 ms/);
      // The recycle settles the other table's request too; nothing hangs.
      const ro = await other;
      expect(ro.ok).toBe(false);
      expect(spawned[0]!.terminated).toBe(true);
      void projector.project(tableId, input);
      expect(spawned).toHaveLength(2);
      projector.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SortPanel (PRD §18)', () => {
  function Panel({ selected = true }: { selected?: boolean }) {
    const commands = useSortCommands(gd, store);
    return (
      <ViewStoreProvider value={store}>
        <SortPanel gd={gd} tableId={selected ? tableId : null} commands={commands} />
      </ViewStoreProvider>
    );
  }
  const stored = () => store.get(tableId);

  it('SORT-01 SORT-05 SORT-06 the panel sets sort column and order, groups, filters and clears through the commands', async () => {
    render(<Panel />);
    await choose(screen.getByRole('combobox', { name: 'Column' }), 'Column 2');
    expect(stored().sortBy).toEqual({ colId: cols[1], mode: 'az' });
    await choose(screen.getByRole('combobox', { name: 'Order' }), 'Freq');
    expect(stored().sortBy).toEqual({ colId: cols[1], mode: 'freq' });
    await choose(screen.getByRole('combobox', { name: 'Group rows by' }), 'Column 1');
    expect(stored().groupBy).toBe(cols[0]);
    await userEvent.type(screen.getByLabelText('Any column contains'), 'India');
    // INSP-12: live, per keystroke; the field keeps focus and its caret while it writes.
    expect(screen.getByLabelText('Any column contains')).toHaveFocus();
    expect(stored().filter).toEqual({
      colId: null,
      text: 'India',
      fuzzy: true,
      facet: null,
    });
    await choose(screen.getByRole('combobox', { name: 'Look in' }), 'Column 1');
    expect(stored().filter?.colId).toBe(cols[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Clear sort, filter and grouping' }));
    expect(stored()).toEqual({ sortBy: null, filter: null, groupBy: null });
    expect(screen.getByRole('button', { name: 'Clear sort, filter and grouping' })).toBeDisabled();
  });

  it('MENU-02 without a table the controls are disabled with the reason, never hidden', () => {
    render(<Panel selected={false} />);
    expect(screen.getByRole('combobox', { name: 'Column' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Group rows by' })).toBeDisabled();
    expect(screen.getByTestId('sort-panel-reason')).toHaveTextContent('select a table first');
  });
});
