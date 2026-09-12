/**
 * PR #57 review: `Cell` re-rendered the whole table per keystroke. With
 * per-cell version counters and `memo(Cell)`, a change to one cell renders
 * that cell alone. `CellContent` (one per rendered cell at rest) is wrapped
 * with a counter here — a labelled test seam, the component itself is real.
 */
import { act, render, screen } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  cellKey,
  createSheet,
  createTable,
  openDocument,
  setCellFormat,
  setCellText,
  setColumnFormat,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { useYVersion } from '../../../doc/use-y.js';
import type * as CellModule from '../cell/index.js';
import { useGrid, type Grid } from './use-grid.js';
import { useCellVersions } from './cell-versions.js';

const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../cell/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CellModule>();
  const Real = actual.CellContent;
  const Counted = (props: React.ComponentProps<typeof Real>) => {
    renders.count += 1;
    return <Real {...props} />;
  };
  return { ...actual, CellContent: Counted };
});

const { TableView } = await import('../TableView.js');

let gd: GedeDoc;
let tableId: Id;
const grid: { current: Grid | null } = { current: null };
let rows: readonly Id[];
let cols: readonly Id[];

function Harness() {
  const g = useGrid(gd, true);
  grid.current = g;
  useYVersion(gd.tables, { depth: 'shallow' });
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  return (
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
  );
}

function Versions({ onRender }: { onRender: (v: ReturnType<typeof useCellVersions>) => void }) {
  const versions = useCellVersions(tableMap(gd, tableId)!);
  onRender(versions);
  return null;
}

describe('cell render isolation', () => {
  beforeEach(() => {
    gd = openDocument(new Y.Doc());
    const sheetId = createSheet(gd);
    tableId = createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 4, rows: 10 });
    const record = tableById(gd, tableId)!;
    rows = record.rows;
    cols = record.columns.map((c) => c.id);
    renders.count = 0;
  });

  it('GRID-04 a text change in one cell re-renders that cell only, not the 40 others', () => {
    render(<Harness />);
    expect(renders.count).toBe(40);
    renders.count = 0;
    act(() => {
      setCellText(gd, tableId, rows[3]!, cols[1]!, 'Kathmandu');
    });
    expect(renders.count).toBe(1);
    expect(screen.getByText('Kathmandu')).toBeInTheDocument();
    // Every keystroke of an edit is a fragment change on the same key: still one cell.
    renders.count = 0;
    act(() => {
      setCellText(gd, tableId, rows[3]!, cols[1]!, 'Kathmandu valley');
    });
    expect(renders.count).toBe(1);
    // A format override is a cell-level change too. The very first override creates the
    // overrides map (every cell may differ, all re-render once); the next is one cell.
    act(() => {
      setCellFormat(gd, tableId, rows[3]!, cols[1]!, 'number');
    });
    renders.count = 0;
    act(() => {
      setCellFormat(gd, tableId, rows[4]!, cols[1]!, 'date');
    });
    expect(renders.count).toBe(1);
  });

  it('FMT-01 GRID-03 a column-level change re-renders that column; a selection change the two cells whose state moved', () => {
    render(<Harness />);
    renders.count = 0;
    act(() => {
      setColumnFormat(gd, tableId, cols[2]!, 'number');
    });
    // The column's ten cells get a new `column` prop; the other thirty are untouched.
    expect(renders.count).toBe(10);
    renders.count = 0;
    act(() => {
      grid.current!.actions.selectCell({ tableId, rowId: rows[5]!, colId: cols[3]! });
    });
    // The newly selected cell, and the first cell that was the table's tab stop.
    expect(renders.count).toBe(2);
  });

  it('per-cell counters bump for the changed key only, from the map and from deep inside a fragment', () => {
    let latest: ReturnType<typeof useCellVersions> | null = null;
    render(
      <Versions
        onRender={(v) => {
          latest = v;
        }}
      />,
    );
    const a = cellKey(rows[0]!, cols[0]!);
    const b = cellKey(rows[1]!, cols[0]!);
    expect(latest!.of(a)).toBe(0);
    act(() => {
      setCellText(gd, tableId, rows[0]!, cols[0]!, 'one');
    });
    expect(latest!.of(a)).toBe(1);
    expect(latest!.of(b)).toBe(0);
    act(() => {
      setCellText(gd, tableId, rows[0]!, cols[0]!, 'one two'); // rewrites the fragment in place
    });
    expect(latest!.of(a)).toBeGreaterThanOrEqual(2);
    expect(latest!.of(b)).toBe(0);
  });
});
