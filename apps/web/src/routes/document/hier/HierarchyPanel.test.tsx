/**
 * The hierarchy panel over a real document and a real `useGrid` (HIER-01,
 * HIER-02, HIER-03, HIER-06, HIER-08, RESP-02). Not mounted in the inspector
 * here; `inspector/Inspector.test.tsx` covers the mounted Table tab.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createSheet,
  createTable,
  nestRow,
  openDocument,
  setCellText,
  setRowCollapsed,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import { useGrid, type Grid } from '../grid/use-grid.js';
import { openViewStore, ViewStoreProvider, type ViewStore } from '../../../doc/view-state.js';
import { HierarchyPanel } from './HierarchyPanel.js';

let gd: GedeDoc;
let tableId: Id;
let rows: readonly Id[];
let cols: readonly Id[];
let store: ViewStore;
const gridRef: { current: Grid | null } = { current: null };

function Harness({ editable = true, viewSorted }: { editable?: boolean; viewSorted?: boolean }) {
  const grid = useGrid(gd, editable);
  gridRef.current = grid;
  return (
    <ViewStoreProvider value={store}>
      <HierarchyPanel
        gd={gd}
        selection={grid.state.selection}
        commands={grid.commands}
        editable={editable}
        viewSorted={viewSorted}
      />
      <LiveRegion />
    </ViewStoreProvider>
  );
}

const select = (rowId: Id) => {
  act(() => {
    gridRef.current?.actions.selectCell({ tableId, rowId, colId: cols[0]! });
  });
};
const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  localStorage.clear();
  store = openViewStore('user-1', 'doc-hier');
  gd = openDocument(new Y.Doc());
  const sheet = createSheet(gd);
  tableId = createTable(gd, { sheetId: sheet, at: { col: 1, row: 1 }, columns: 2, rows: 4 });
  const rec = tableById(gd, tableId)!;
  rows = rec.rows;
  cols = rec.columns.map((c) => c.id);
  setCellText(gd, tableId, rows[0]!, cols[0]!, 'Base camp');
  setCellText(gd, tableId, rows[1]!, cols[0]!, 'Lobuche');
  nestRow(gd, tableId, rows[1]!);
});

describe('HierarchyPanel', () => {
  it('HIER-01 HIER-03 with a cell selected it shows the row, "↳ under <parent>" or "top level — no parent", and the depth', () => {
    render(<Harness />);
    expect(screen.getByText('Select a cell to see its row.')).toBeInTheDocument();
    select(rows[1]!);
    expect(screen.getByTestId('hierarchy-row')).toHaveTextContent('Lobuche');
    expect(screen.getByTestId('hierarchy-parent')).toHaveTextContent('↳ under Base camp');
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('depth 1');
    select(rows[0]!);
    expect(screen.getByTestId('hierarchy-parent')).toHaveTextContent('top level — no parent');
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('depth 0');
    // A blank row is named by its address; a blank parent likewise.
    select(rows[2]!);
    expect(screen.getByTestId('hierarchy-row')).toHaveTextContent('B7');
  });

  it('HIER-01 HIER-02 Promote and Nest act on the row and render disabled exactly when the document would refuse, with the reason', async () => {
    render(<Harness />);
    select(rows[0]!);
    expect(button('⇤ Promote')).toBeDisabled();
    expect(button('⇤ Promote')).toHaveAttribute('title', 'Already at the top level');
    expect(button('Nest ⇥')).toBeDisabled(); // the first row never nests
    select(rows[2]!); // depth 0, under a depth-1 row: may nest once, then twice
    expect(button('Nest ⇥')).toBeEnabled();
    expect(button('Nest ⇥')).toHaveAttribute('aria-keyshortcuts', 'Meta+BracketRight');
    await userEvent.click(button('Nest ⇥'));
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('depth 1');
    expect(screen.getByTestId('hierarchy-parent')).toHaveTextContent('↳ under Base camp');
    await userEvent.click(button('Nest ⇥'));
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('depth 2');
    expect(screen.getByTestId('hierarchy-parent')).toHaveTextContent('↳ under Lobuche');
    expect(button('Nest ⇥')).toBeDisabled();
    expect(button('Nest ⇥')).toHaveAttribute(
      'title',
      'A row nests at most one level deeper than the row above it',
    );
    await userEvent.click(button('⇤ Promote'));
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('depth 1');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Promoted to level 2');
  });

  it('HIER-06 Collapse row, Collapse all and Expand all act on the document; they render disabled when there is nothing to do', async () => {
    render(<Harness />);
    select(rows[0]!);
    expect(button('Collapse row')).toHaveAttribute('aria-expanded', 'true');
    expect(button('Expand all')).toBeDisabled();
    await userEvent.click(button('Collapse row'));
    expect(tableById(gd, tableId)).not.toBeNull();
    expect(button('Expand row')).toHaveAttribute('aria-expanded', 'false');
    expect(button('Collapse all')).toBeDisabled();
    expect(button('Expand all')).toBeEnabled();
    await userEvent.click(button('Expand all'));
    expect(button('Collapse row')).toBeInTheDocument();
    await userEvent.click(button('Collapse all'));
    expect(screen.getByTestId('live-region')).toHaveTextContent('Collapsed 1 row');
    // A leaf has no collapse control at all.
    select(rows[2]!);
    expect(screen.queryByRole('button', { name: /Collapse row|Expand row/ })).toBeNull();
  });

  it('HIER-08 while the viewer groups the table the panel says so, shows the kept depth, and disables the depth controls with the reason', () => {
    render(<Harness />);
    act(() => {
      store.set(tableId, { sortBy: null, filter: null, groupBy: cols[1]! });
    });
    select(rows[1]!);
    expect(screen.getByTestId('hierarchy-grouped')).toHaveTextContent('Grouped by Column 2');
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('depth 1');
    expect(button('⇤ Promote')).toBeDisabled();
    expect(button('⇤ Promote')).toHaveAttribute('title', 'Unavailable while the table is grouped');
    // The document never carried it (ADR-026).
    expect(JSON.stringify(tableMap(gd, tableId)!.toJSON())).not.toContain('groupBy');
    act(() => {
      store.clear(tableId);
    });
    expect(screen.queryByTestId('hierarchy-grouped')).toBeNull();
    expect(button('⇤ Promote')).toBeEnabled();
    // The viewer's own sort locks depth the same way, without the prop.
    act(() => {
      store.set(tableId, { sortBy: { colId: cols[0]!, mode: 'az' }, filter: null, groupBy: null });
    });
    expect(screen.getByTestId('hierarchy-sorted')).toHaveTextContent('sorted or filtered');
    expect(button('Nest ⇥')).toBeDisabled();
  });

  it('HIER-08 while the viewer’s sort or filter is active the panel says so and every depth and collapse control is disabled with the reason; the data keeps its depth', () => {
    render(<Harness viewSorted />);
    select(rows[1]!);
    expect(screen.getByTestId('hierarchy-sorted')).toHaveTextContent('sorted or filtered');
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('depth 1');
    for (const name of ['⇤ Promote', 'Nest ⇥', 'Collapse all']) {
      expect(button(name)).toBeDisabled();
      expect(button(name)).toHaveAttribute(
        'title',
        'Unavailable while the view is sorted or filtered',
      );
    }
    select(rows[0]!);
    expect(button('Collapse row')).toBeDisabled();
  });

  it('RESP-02 SHARE-03 for a read-only viewer every control is disabled and says "View only"; nothing writes', async () => {
    setRowCollapsed(gd, tableId, rows[0]!, true);
    render(<Harness editable={false} />);
    select(rows[0]!);
    for (const name of ['⇤ Promote', 'Nest ⇥', 'Expand row', 'Collapse all', 'Expand all']) {
      expect(button(name)).toBeDisabled();
      expect(button(name)).toHaveAttribute('title', 'View only');
    }
    await userEvent.click(button('Expand all'));
    expect(tableById(gd, tableId)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Expand row' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});
