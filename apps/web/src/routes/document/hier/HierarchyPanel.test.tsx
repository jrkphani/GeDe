/**
 * The hierarchy panel over a real document and a real `useGrid` (HIER-01,
 * HIER-02, HIER-03, HIER-06, HIER-08, RESP-02). Not mounted in the inspector
 * here — the integrator does that — so HIER-01's inspector half stays partial.
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
import { HierarchyPanel } from './HierarchyPanel.js';

let gd: GedeDoc;
let tableId: Id;
let rows: readonly Id[];
let cols: readonly Id[];
const gridRef: { current: Grid | null } = { current: null };

function Harness({ editable = true }: { editable?: boolean }) {
  const grid = useGrid(gd, editable);
  gridRef.current = grid;
  return (
    <>
      <HierarchyPanel
        gd={gd}
        selection={grid.state.selection}
        commands={grid.commands}
        editable={editable}
      />
      <LiveRegion />
    </>
  );
}

const select = (rowId: Id) => {
  act(() => {
    gridRef.current?.actions.selectCell({ tableId, rowId, colId: cols[0]! });
  });
};
const button = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
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
  it('HIER-01 (partial: not yet mounted in the inspector) HIER-03 with a cell selected it shows the row, "↳ under <parent>" or "top level — no parent", and the depth', () => {
    render(<Harness />);
    expect(screen.getByText('Select a cell to see its row.')).toBeInTheDocument();
    select(rows[1]!);
    expect(screen.getByTestId('hierarchy-row')).toHaveTextContent('Lobuche');
    expect(screen.getByTestId('hierarchy-parent')).toHaveTextContent('↳ under Base camp');
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('Level 2');
    select(rows[0]!);
    expect(screen.getByTestId('hierarchy-parent')).toHaveTextContent('top level — no parent');
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('Level 1');
    // A blank row is named by its address; a blank parent likewise.
    select(rows[2]!);
    expect(screen.getByTestId('hierarchy-row')).toHaveTextContent('B7');
  });

  it('HIER-01 (partial: not yet mounted in the inspector) HIER-02 Promote and Nest act on the row and render disabled exactly when the document would refuse, with the reason', async () => {
    render(<Harness />);
    select(rows[0]!);
    expect(button('⇤ Promote')).toBeDisabled();
    expect(button('⇤ Promote')).toHaveAttribute('title', 'Already at the top level');
    expect(button('Nest ⇥')).toBeDisabled(); // the first row never nests
    select(rows[2]!); // depth 0, under a depth-1 row: may nest once, then twice
    expect(button('Nest ⇥')).toBeEnabled();
    expect(button('Nest ⇥')).toHaveAttribute('aria-keyshortcuts', 'Meta+BracketRight');
    await userEvent.click(button('Nest ⇥'));
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('Level 2');
    expect(screen.getByTestId('hierarchy-parent')).toHaveTextContent('↳ under Base camp');
    await userEvent.click(button('Nest ⇥'));
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('Level 3');
    expect(screen.getByTestId('hierarchy-parent')).toHaveTextContent('↳ under Lobuche');
    expect(button('Nest ⇥')).toBeDisabled();
    expect(button('Nest ⇥')).toHaveAttribute(
      'title',
      'A row nests at most one level deeper than the row above it',
    );
    await userEvent.click(button('⇤ Promote'));
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('Level 2');
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

  it('HIER-08 while the table is grouped the panel says so and the depth controls stay usable on the data', () => {
    render(<Harness />);
    act(() => {
      gd.doc.transact(() => {
        tableMap(gd, tableId)!.set('groupBy', cols[1]);
      });
    });
    select(rows[1]!);
    expect(screen.getByTestId('hierarchy-grouped')).toHaveTextContent('Grouped by Column 2');
    expect(screen.getByTestId('hierarchy-depth')).toHaveTextContent('Level 2');
    expect(button('⇤ Promote')).toBeEnabled();
    act(() => {
      gd.doc.transact(() => {
        tableMap(gd, tableId)!.set('groupBy', null);
      });
    });
    expect(screen.queryByTestId('hierarchy-grouped')).toBeNull();
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
