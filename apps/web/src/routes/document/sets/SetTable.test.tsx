/**
 * Set tables on the canvas (SET-02..07; ADR-056, SPEC §5) against a real Yjs document and
 * the grid commands the shell uses — no room, no Worker.
 */
import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import {
  addRow,
  createSheet,
  createTable,
  createUndoManager,
  nestRow,
  openDocument,
  setCellText,
  setTableFacts,
  setTableLook,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
  type TableKind,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import { useYVersion } from '../../../doc/use-y.js';
import { openViewStore, ViewStoreProvider, type ViewStore } from '../../../doc/view-state.js';
import { useGrid, type Grid, type GridOptions } from '../grid/use-grid.js';
import { TableView } from '../TableView.js';
import { SetCounts } from './SetTableParts.js';

let gd: GedeDoc;
let sheetId: Id;
let viewStore: ViewStore;

function Harness({
  tableId,
  options,
  grid,
}: {
  tableId: Id;
  options?: GridOptions | undefined;
  grid: { current: Grid | null };
}) {
  const g = useGrid(gd, true, options);
  grid.current = g;
  useYVersion(gd.tables, { depth: 'shallow' });
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  return (
    <ViewStoreProvider value={viewStore}>
      <TableView
        table={map}
        tier="micro"
        selected={false}
        selectedCell={g.cell}
        editing={g.state.editing}
        editable
        presence={[]}
        pinnedLeft={null}
        actions={g.actions}
        commands={g.commands}
      />
      <LiveRegion />
    </ViewStoreProvider>
  );
}

function mount(tableId: Id, options?: GridOptions) {
  const grid: { current: Grid | null } = { current: null };
  render(<Harness tableId={tableId} options={options} grid={grid} />);
  return grid;
}

/** A set table at B2 (title B2:B3, header B4, elements from B5) holding `elements` in its range. */
function setTable(kind: TableKind, elements: readonly string[], title = 'E'): Id {
  const id = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 0, kind, title });
  const range = tableById(gd, id)?.columns[0]?.id ?? '';
  for (const element of elements) setCellText(gd, id, addRow(gd, id), range, element);
  return id;
}

const rowsOf = (id: Id): readonly Id[] => tableById(gd, id)?.rows ?? [];
const rangeOf = (id: Id): Id => tableById(gd, id)?.columns[0]?.id ?? '';
const degrees = () => screen.getAllByTestId('set-degree').map((el) => el.textContent);

beforeEach(() => {
  localStorage.clear();
  viewStore = openViewStore('user-1', 'doc-set-table');
  gd = openDocument(new Y.Doc());
  sheetId = createSheet(gd);
});

describe('set tables on the canvas (ADR-056)', () => {
  test('SET-03 the meta row states the kind, the set id and, where the definition cannot say, “—” in words', () => {
    const id = setTable('simple', ['a', 'b', 'c']);
    mount(id);
    const meta = screen.getByTestId('set-meta');
    expect(meta).toHaveTextContent('Simple set');
    const values = within(meta).getByRole('list', { name: 'Set facts' });
    const items = within(values).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      `set id: ${id}`,
      'finite or infinite: —not determined from the definition',
      'bound or free variable: —not determined from the definition',
      'quantifier: —not determined from the definition',
      'special status: —none',
    ]);
    // The “—” itself is hidden from assistive technology; its meaning is read instead.
    expect(items[1]?.querySelector('[aria-hidden="true"]')).toHaveTextContent('—');
    expect(items[0]).toHaveAttribute('title', `set id: ${id}`);
  });

  test('SET-03 a set-builder definition and the cardinality fill the meta row; nothing is typed there', () => {
    const id = setTable('simple', ['a']);
    setTableLook(gd, id, { caption: '{ x | x is a letter in ‘abc’ }' });
    mount(id);
    const meta = screen.getByTestId('set-meta');
    expect(meta).toHaveTextContent('finite');
    expect(meta).toHaveTextContent('bound');
    expect(meta).toHaveTextContent('singleton');
    expect(within(meta).queryByRole('textbox')).toBeNull();
    act(() => {
      setTableLook(gd, id, { caption: '∃x x ∈ E' });
    });
    expect(screen.getByTestId('set-meta')).toHaveTextContent('existential ∃');
  });

  test('SET-03 an empty set is null', () => {
    mount(setTable('simple', []));
    expect(screen.getByTestId('set-meta')).toHaveTextContent('special status: null');
  });

  test('SET-04 the title row shows the name and the definition as typed', () => {
    const id = setTable('simple', ['a'], 'E');
    setTableLook(gd, id, { caption: '{ x | x is a letter in ‘abc’ }' });
    mount(id);
    const title = screen.getByText('E', { selector: '.gd-table__title-text' });
    expect(title.closest('.gd-set-title')).not.toBeNull();
    expect(screen.getByTestId('set-definition')).toHaveTextContent(
      'definition: { x | x is a letter in ‘abc’ }',
    );
  });

  test('SET-05 the footer count strip states cardinality and bag; a repeat counts in the bag only', () => {
    mount(setTable('simple', ['a', 'b', 'c', 'b'], 'E'));
    const counts = screen.getByTestId('set-counts');
    expect(within(counts).getByText('|E| = 3')).toHaveAttribute('aria-hidden', 'true');
    expect(within(counts).getByText('bag 4')).toBeInTheDocument();
    expect(counts).toHaveTextContent('E: cardinality 3, bag 4');
    // A set's strip states its counts, not the plain table's rows and columns.
    expect(screen.getByTestId('table-footer')).not.toHaveTextContent('columns');
  });

  test('SET-05 the counts go through Intl.NumberFormat for the active locale', () => {
    const id = setTable('simple', ['a']);
    const table = tableMap(gd, id);
    const facts = table === null ? null : setTableFacts(table);
    if (facts === null) throw new Error('no facts');
    render(
      <SetCounts
        title="E"
        facts={{ ...facts, cardinality: 123456, bag: 1234567 }}
        locale="hi-IN"
      />,
    );
    expect(screen.getByText('|E| = 1,23,456')).toBeInTheDocument();
    expect(screen.getByText('bag 12,34,567')).toBeInTheDocument();
  });

  test('SET-07 the rail labels meta, title, header and rows in mono with U+00B0, and no address moves', () => {
    const id = setTable('simple', ['a', 'b']);
    mount(id);
    expect(degrees()).toEqual(['−2°', '−1°', '±0°', '+1°', '+2°']);
    for (const el of screen.getAllByTestId('set-degree')) {
      expect(el).toHaveAttribute('aria-hidden', 'true');
      expect(el).toHaveClass('gd-mono');
    }
    // A table at B2: title rows 2–3, header row 4, first element B5 — as a plain table's.
    const [first] = screen.getAllByRole('gridcell');
    expect(first).toHaveAttribute('data-address', 'B5');
  });

  test('SET-02 a repeated element is kept and flagged “repeat of +2°” in words', () => {
    const id = setTable('simple', ['a', 'b', 'b']);
    mount(id);
    const notes = screen.getAllByTestId('set-note');
    expect(notes.map((n) => n.textContent)).toEqual(['repeat of +2°']);
    const cell = notes[0]?.closest('[role="gridcell"]');
    expect(cell).toHaveAttribute('aria-label', 'B7, b, repeat of +2°');
  });

  test('SET-06 a family states each row as element, set or family in words, by Nest and Promote', () => {
    const id = setTable('family', ['d', 'A', 'a', 'F', 'S', 'x'], 'T');
    const [, , a, , s, x] = rowsOf(id);
    nestRow(gd, id, a ?? '');
    nestRow(gd, id, s ?? '');
    nestRow(gd, id, x ?? '');
    nestRow(gd, id, x ?? '');
    mount(id);
    expect(screen.getAllByTestId('set-note').map((n) => n.textContent)).toEqual([
      'element',
      'set',
      'element',
      'family',
      'set',
      'element',
    ]);
    expect(degrees().slice(3)).toEqual(['+1°', '+2°', '+2.1°', '+3°', '+3.1°', '+3.1.1°']);
    // |T| counts the top-level members; the bag every leaf.
    expect(screen.getByTestId('set-counts')).toHaveTextContent('T: cardinality 3, bag 3');
  });

  test('SET-02 a plain table has no meta row, rail or count strip', () => {
    const id = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 2 });
    mount(id);
    expect(screen.queryByTestId('set-meta')).toBeNull();
    expect(screen.queryAllByTestId('set-degree')).toHaveLength(0);
    expect(screen.queryByTestId('table-footer')).toBeNull();
  });
});

describe('Split into rows (SET-02)', () => {
  test('SET-02 typing a comma value into a range cell offers Split into rows; elsewhere it does not', () => {
    const id = setTable('simple', ['a']);
    const offerSplit = vi.fn();
    const grid = mount(id, { offerSplit });
    const [row] = rowsOf(id);
    const description = tableById(gd, id)?.columns[1]?.id ?? '';
    act(() => {
      grid.current?.commands.commitCell(
        { tableId: id, rowId: row ?? '', colId: description },
        'x, y',
      );
    });
    expect(offerSplit).not.toHaveBeenCalled();
    act(() => {
      grid.current?.commands.commitCell(
        { tableId: id, rowId: row ?? '', colId: rangeOf(id) },
        'a, b, c',
      );
    });
    expect(offerSplit).toHaveBeenCalledWith(
      { tableId: id, rowId: row, colId: rangeOf(id) },
      3,
      'B5',
    );
  });

  test('SET-02 Split into rows gives each element a row, announces it and is one undo step', () => {
    const id = setTable('simple', ['a, b, a']);
    const undo = createUndoManager(gd);
    const grid = mount(id, { undo });
    const [row] = rowsOf(id);
    act(() => {
      grid.current?.commands.splitIntoRows({ tableId: id, rowId: row ?? '', colId: rangeOf(id) });
    });
    expect(rowsOf(id)).toHaveLength(3);
    expect(screen.getByTestId('live-region')).toHaveTextContent('Split B5 into 3 rows');
    expect(screen.getByTestId('set-counts')).toHaveTextContent('cardinality 2, bag 3');
    expect(screen.getAllByTestId('set-note').map((n) => n.textContent)).toEqual(['repeat of +1°']);
    act(() => {
      undo.undo();
    });
    expect(rowsOf(id)).toHaveLength(1);
  });
});
