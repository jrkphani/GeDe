// Context graphs through the real shell (GRAPH-01..11, INSP-08, REF-05, RESP-02).
// FAKES, all labelled: `fake-indexeddb` for IndexedDB, `FakeRoom` for the
// y-websocket room (real wire format, in memory), the documents REST API as a
// vi.fn() returning the server's shape. The SPA, the Yjs replica and the
// inline formula engine run for real; table content is written through
// `@gede/core` on the room's replica and arrives over the fake socket.
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDerivedColumn,
  graphsOnSheet,
  listSheets,
  openDocument,
  setCellText,
  tableById,
  tablesOnSheet,
  type GedeDoc,
  type Id,
} from '@gede/core';
import type * as DocumentsApi from '../../../api/documents.js';
import type * as CoverageGraphModule from './CoverageGraph.js';
import type * as RingGraphModule from './RingGraph.js';
import { setDocumentSeamsForTests } from '../../../doc/use-document.js';
import { FakeRoom, until } from '../../../test/fake-websocket.js';
import { installMatchMedia } from '../../../test/match-media.js';
import { renderRoutes, withConfig } from '../../../test/helpers.js';
import { routes } from '../../../routes.js';

const user = { sub: 'sub-1', email: 'meena@1cloudhub.com', name: 'Meena' };

vi.mock('../../../auth/cognito.js', () => ({
  isPasskeySupported: () => true,
  accessToken: () => Promise.resolve('tok'),
  refreshAccessToken: () => Promise.resolve('fresh'),
  currentUser: () => Promise.resolve(user),
  onAuthEvent: () => () => undefined,
  signOutLocal: vi.fn(() => Promise.resolve()),
  classifyError: () => ({ kind: 'other', message: 'x' }),
}));

vi.mock('../../../api/documents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentsApi>();
  return { ...actual, getDocument: vi.fn(), renameDocument: vi.fn(() => Promise.resolve()) };
});

// Render counters (review of #90, finding 6): the SVG halves are wrapped with a labelled
// test seam; the components themselves are real.
const renders = vi.hoisted(() => ({ ring: 0, coverage: 0 }));
vi.mock('./RingGraph.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RingGraphModule>();
  const Counted = (props: Parameters<typeof actual.RingGraph>[0]) => {
    renders.ring += 1;
    return createElement(actual.RingGraph, props);
  };
  return { ...actual, RingGraph: Counted };
});
vi.mock('./CoverageGraph.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CoverageGraphModule>();
  const Counted = (props: Parameters<typeof actual.CoverageGraph>[0]) => {
    renders.coverage += 1;
    return createElement(actual.CoverageGraph, props);
  };
  return { ...actual, CoverageGraph: Counted };
});

const docs = await import('../../../api/documents.js');
const ID = '6f1b2c3d-0000-4000-8000-0000000d0c99';
const record = {
  id: ID,
  title: 'Trek contexts',
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:00:00Z',
  ownerId: 'sub-1',
  permission: 'owner' as const,
};

let room: FakeRoom;
let storeSeq = 0;

async function openShell(path = `/d/${ID}`) {
  const view = renderRoutes(routes, [path]);
  await waitFor(() => {
    expect(screen.getByTestId('plane')).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByRole('tab', { name: /Sheet 1/ })).toBeInTheDocument();
  });
  return view;
}

async function addTable() {
  await userEvent.click(screen.getByRole('button', { name: 'Add table' }));
  await waitFor(() => {
    expect(screen.getAllByRole('grid').length).toBeGreaterThan(0);
  });
  await until(() => room.doc.getMap('tables').size === 1);
}

/** The room's replica and the one table on it, with its ids. */
function roomTable(): {
  gd: GedeDoc;
  sheetId: Id;
  tableId: Id;
  rows: readonly Id[];
  cols: readonly Id[];
} {
  const gd = openDocument(room.doc);
  const sheetId = listSheets(gd)[0]?.id ?? '';
  const t = tablesOnSheet(gd, sheetId)[0];
  if (t === undefined) throw new Error('no table');
  return { gd, sheetId, tableId: t.id, rows: t.rows, cols: t.columns.map((c) => c.id) };
}

/** Region × Season over the table's first two columns; row 3 is a draft (no season). */
async function fillContexts() {
  const { gd, tableId, rows, cols } = roomTable();
  const grid: [string, string][] = [
    ['Nepal', 'Spring'],
    ['India', 'Spring'],
    ['Nepal', ''],
  ];
  gd.doc.transact(() => {
    grid.forEach(([region, season], r) => {
      setCellText(gd, tableId, rows[r] ?? '', cols[0] ?? '', region);
      if (season !== '') setCellText(gd, tableId, rows[r] ?? '', cols[1] ?? '', season);
    });
  });
  await waitFor(() => {
    expect(screen.getAllByText('Nepal').length).toBeGreaterThan(0);
  });
}

async function graphThisTable() {
  await userEvent.click(screen.getByRole('button', { name: 'Add graph' }));
  await userEvent.click(screen.getByRole('button', { name: /Bind the graph to Table 1/ }));
  await waitFor(() => {
    expect(screen.getByTestId('ring-graph')).toBeInTheDocument();
  });
}

/** Type into the rich editor by mutating the contenteditable; ProseMirror reads it on a microtask. */
async function typeInto(editor: HTMLElement, text: string): Promise<void> {
  const paragraphs = editor.querySelectorAll('p');
  const p = paragraphs[paragraphs.length - 1] ?? editor;
  const last = p.lastChild;
  let node: Node;
  if (last !== null && last.nodeType === Node.TEXT_NODE) {
    last.textContent = `${last.textContent ?? ''}${text}`;
    node = last;
  } else {
    if (last !== null && last.nodeName === 'BR') last.remove();
    node = p.appendChild(document.createTextNode(text));
  }
  document.getSelection()?.collapse(node, node.textContent?.length ?? 0);
  await act(async () => {
    await Promise.resolve();
  });
}

const ring = () => screen.getByRole('region', { name: /^Ring graph/ });
const coverage = () => screen.getByRole('region', { name: /^Coverage graph/ });

describe('context graphs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withConfig();
    installMatchMedia((q) => q.includes('min-width: 1200'));
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh) jsdom');
    room = new FakeRoom();
    const store = `graph-store-${String(++storeSeq)}`;
    setDocumentSeamsForTests({ WebSocketImpl: room.WebSocket, storeName: () => store });
    vi.mocked(docs.getDocument).mockResolvedValue(record);
  });
  afterEach(() => {
    setDocumentSeamsForTests(null);
    vi.restoreAllMocks();
  });

  it('GRAPH-01 GRAPH-03 GRAPH-02 + Graph enters pointing mode (accent targets, banner, Escape cancels); the click binds a ring and coverage pair side by side below the table', async () => {
    await openShell();
    await addTable();
    await userEvent.click(screen.getByRole('button', { name: 'Add graph' }));
    expect(screen.getByText('Click a table to bind the graph.')).toBeInTheDocument();
    const target = screen.getByRole('button', { name: 'Bind the graph to Table 1' });
    expect(target).toHaveClass('gd-pointing__target');
    expect(screen.getByTestId('live-region')).toHaveTextContent(/Pointing/);
    fireEvent.keyDown(window, { code: 'Escape' });
    expect(screen.queryByTestId('pointing-overlay')).not.toBeInTheDocument();
    expect(screen.queryByText('Click a table to bind the graph.')).not.toBeInTheDocument();
    expect(room.doc.getMap('graphs').size).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'Add graph' }));
    await userEvent.click(screen.getByRole('button', { name: 'Bind the graph to Table 1' }));
    expect(screen.queryByTestId('pointing-overlay')).not.toBeInTheDocument();
    await until(() => room.doc.getMap('graphs').size === 2);
    const { gd, sheetId, tableId } = roomTable();
    const [r, c] = graphsOnSheet(gd, sheetId);
    expect(r?.kind).toBe('ring');
    expect(c?.kind).toBe('coverage');
    expect(r?.pairId).toBe(c?.pairId);
    expect(r?.tableId).toBe(tableId);
    expect(c?.tableId).toBe(tableId);
    expect(c?.gridRow).toBe(r?.gridRow);
    expect(c?.gridCol).toBe((r?.gridCol ?? 0) + (r?.widthUnits ?? 0) + 1);
    // Positions are lattice data: the frame sits at exactly col × 160, row × 22.
    const frame = ring();
    expect(frame.style.left).toBe(`${String((r?.gridCol ?? 0) * 160)}px`);
    expect(frame.style.top).toBe(`${String((r?.gridRow ?? 0) * 22)}px`);
    expect(frame).toHaveAttribute('data-selected', 'true');
    // The header states dimensions and the tuple count (GRAPH-07); the default is the first three columns.
    expect(within(frame).getByTestId('graph-dimensions')).toHaveTextContent(
      'Column 1 · Column 2 · Column 3',
    );
    expect(within(frame).getByTestId('graph-stat')).toHaveTextContent('0 / 1');
    // INSP-08: the Graph tab exists only now.
    expect(screen.getByRole('tab', { name: 'Graph' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add table' }));
    // A table selection made in the grid drops the graph selection, and the tab with it.
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: 'Graph' })).not.toBeInTheDocument();
    });
  });

  it('GRAPH-06 GRAPH-07 GRAPH-05 INSP-08 REF-05 dimensions → parameters → contexts recompute live; symbols in row order; a partial row is hollow and dashed; the checklist counts distinct values and refuses a derived column', async () => {
    await openShell();
    await addTable();
    await fillContexts();
    await graphThisTable();
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    const { gd, tableId, cols } = roomTable();
    // Three default dimensions: Column 3 is empty, so no row is complete yet.
    const list = screen.getByTestId('dimension-checklist');
    expect(within(list).getByLabelText(/Column 1/)).toBeChecked();
    expect(within(list).getByText('2 values')).toBeInTheDocument(); // Nepal, India
    expect(within(list).getByText('1 value')).toBeInTheDocument(); // Spring
    await userEvent.click(within(list).getByLabelText(/Column 3/));
    await until(() => {
      const g = graphsOnSheet(gd, listSheets(gd)[0]?.id ?? '');
      return g.every((x) => x.dimensions.length === 2);
    });
    await waitFor(() => {
      expect(within(ring()).getByTestId('graph-dimensions')).toHaveTextContent(
        'Column 1 · Column 2',
      );
    });
    // Two dimensions {Nepal, India} × {Spring}: two covered tuples of two (GRAPH-07).
    expect(within(ring()).getByTestId('graph-stat')).toHaveTextContent('2 / 2');
    expect(within(coverage()).getByTestId('graph-stat')).toHaveTextContent('2 / 2');
    const svg = screen.getByTestId('ring-graph');
    const nodes = within(svg).getAllByRole('button', { name: /^Context / });
    expect(nodes.map((n) => n.getAttribute('aria-label'))).toEqual([
      'Context α: Column 1 Nepal, Column 2 Spring, complete',
      'Context β: Column 1 India, Column 2 Spring, complete',
      'Context γ: Column 1 Nepal, Column 2 unbound, draft',
    ]);
    expect(nodes[0]).toHaveClass('gd-ring__node--complete');
    expect(nodes[2]).toHaveClass('gd-ring__node--draft');
    expect(nodes[2]).toHaveAttribute('data-complete', 'false');
    // One arc per dimension, one dot per parameter, contexts on the inner orbits.
    expect(svg.querySelectorAll('.gd-ring__arc')).toHaveLength(2);
    expect(within(svg).getAllByRole('button', { name: /^Column/ })).toHaveLength(3);
    expect(screen.getByTestId('graph-contexts')).toHaveTextContent(
      '3 contexts · 2 distinct tuples covered of 2 · 1 draft',
    );
    // Live: a new value recomputes parameters, the space and the symbols.
    const rows = tableById(gd, tableId)?.rows ?? [];
    setCellText(gd, tableId, rows[2] ?? '', cols[1] ?? '', 'Autumn');
    await waitFor(() => {
      expect(within(ring()).getByTestId('graph-stat')).toHaveTextContent('3 / 4');
    });
    expect(
      within(svg).getByRole('button', {
        name: 'Context γ: Column 1 Nepal, Column 2 Autumn, complete',
      }),
    ).toBeInTheDocument();
    // REF-05: a derived column is listed, disabled, with its reason, never checked.
    addDerivedColumn(gd, tableId, { sourceColId: cols[0] ?? '', method: 'Extract', args: ['/e/'] });
    await waitFor(() => {
      expect(within(list).getByText('derived column')).toBeInTheDocument();
    });
    const derived = within(list).getByLabelText(/Extract/);
    expect(derived).toBeDisabled();
    expect(derived).not.toBeChecked();
    // Add dimension column: a new entered column, marked as a dimension (one command).
    await userEvent.click(screen.getByRole('button', { name: 'Add dimension column' }));
    await waitFor(() => {
      expect(within(ring()).getByTestId('graph-dimensions')).toHaveTextContent(
        /Column 1 · Column 2 · Column 5/,
      );
    });
  });

  it('GRAPH-08 GRAPH-09 GRAPH-10 the coverage slice pins to the selection; hover mutes across the pair, draws spokes and lights the row; nodes select rows, empty cells append pre-filled rows, Shift+Enter opens a child sheet', async () => {
    await openShell();
    await addTable();
    await fillContexts();
    const { gd, tableId, cols } = roomTable();
    const rows = tableById(gd, tableId)?.rows ?? [];
    // A third dimension so there is something to pin: Grade.
    gd.doc.transact(() => {
      setCellText(gd, tableId, rows[0] ?? '', cols[2] ?? '', 'Easy');
      setCellText(gd, tableId, rows[1] ?? '', cols[2] ?? '', 'Hard');
      setCellText(gd, tableId, rows[2] ?? '', cols[1] ?? '', 'Autumn');
      setCellText(gd, tableId, rows[2] ?? '', cols[2] ?? '', 'Hard');
    });
    await graphThisTable();
    // GRAPH-08: rows Column 1, columns Column 2, Column 3 pinned to its first value.
    const axes = () => within(coverage()).getByTestId('coverage-axes');
    await waitFor(() => {
      expect(axes()).toHaveTextContent('rows Column 1 · columns Column 2 · pinned Column 3: Easy');
    });
    const cells = () => within(screen.getByTestId('coverage-graph')).getAllByRole('button');
    expect(cells().map((c) => c.getAttribute('aria-label'))).toEqual([
      'α: Column 1 Nepal, Column 2 Spring, Column 3 Easy',
      'Unexplored: Column 1 Nepal, Column 2 Autumn, Column 3 Easy. Add a row',
      'Unexplored: Column 1 India, Column 2 Spring, Column 3 Easy. Add a row',
      'Unexplored: Column 1 India, Column 2 Autumn, Column 3 Easy. Add a row',
    ]);
    // GRAPH-10: clicking a node selects its row; the pin follows the selection (row β is Hard).
    const nodeBeta = within(screen.getByTestId('ring-graph')).getByRole('button', {
      name: 'Context β: Column 1 India, Column 2 Spring, Column 3 Hard, complete',
    });
    await userEvent.click(nodeBeta);
    await waitFor(() => {
      expect(axes()).toHaveTextContent('pinned Column 3: Hard');
    });
    expect(nodeBeta).toHaveAttribute('aria-pressed', 'true');
    const selected = document.querySelector('[aria-selected="true"]');
    expect(selected?.closest('[role="row"]')).toBe(
      document.querySelectorAll('.gd-table__row:not(.gd-table__row--header)')[1],
    );
    // Explicit pin from the inspector wins over the selection.
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    await userEvent.click(screen.getByRole('combobox', { name: /Pin Column 3/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Easy' }));
    await waitFor(() => {
      expect(axes()).toHaveTextContent('pinned Column 3: Easy');
    });
    // Swapping an axis keeps the two distinct (GRAPH-05 chips).
    await userEvent.click(screen.getByRole('combobox', { name: /Rows/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Column 2' }));
    await waitFor(() => {
      expect(axes()).toHaveTextContent('rows Column 2 · columns Column 1');
    });
    await until(() => {
      const [g] = graphsOnSheet(gd, listSheets(gd)[0]?.id ?? '');
      return g?.slice.rowAxis === cols[1] && g?.slice.colAxis === cols[0];
    });

    // GRAPH-09: hovering a node mutes what is not adjacent across the pair, draws spokes and lights the row.
    const nodeAlpha = within(screen.getByTestId('ring-graph')).getByRole('button', {
      name: 'Context α: Column 1 Nepal, Column 2 Spring, Column 3 Easy, complete',
    });
    fireEvent.pointerEnter(nodeAlpha);
    await waitFor(() => {
      expect(screen.getAllByTestId('ring-spoke')).toHaveLength(3);
    });
    expect(screen.getByTestId('ring-graph')).toHaveClass('gd-ring--hover');
    expect(nodeAlpha).not.toHaveClass('gd-ring__node--muted');
    expect(nodeBeta).toHaveClass('gd-ring__node--muted');
    const dots = within(screen.getByTestId('ring-graph')).getAllByRole('button', {
      name: /^Column/,
    });
    expect(
      dots.find((d) => d.getAttribute('aria-label')?.startsWith('Column 1 Nepal')),
    ).toHaveClass('gd-ring__dot--lit');
    expect(
      dots.find((d) => d.getAttribute('aria-label')?.startsWith('Column 1 India')),
    ).toHaveClass('gd-ring__dot--muted');
    const litRow = document.querySelector('.gd-table__row--lit');
    expect(litRow).toBe(document.querySelectorAll('.gd-table__row:not(.gd-table__row--header)')[0]);
    expect(
      within(screen.getByTestId('coverage-graph')).getByRole('button', { name: /^α:/ }),
    ).toHaveClass('gd-coverage__cell--lit');
    fireEvent.pointerLeave(screen.getByTestId('ring-graph'));
    await waitFor(() => {
      expect(document.querySelector('.gd-table__row--lit')).toBeNull();
    });

    // GRAPH-10: an empty coverage cell appends a row pre-filled with the whole tuple, pins included.
    const rowsBefore = tableById(gd, tableId)?.rows.length ?? 0;
    const empty = within(screen.getByTestId('coverage-graph')).getByRole('button', {
      name: 'Unexplored: Column 1 India, Column 2 Autumn, Column 3 Easy. Add a row',
    });
    await userEvent.click(empty);
    await until(() => (tableById(gd, tableId)?.rows.length ?? 0) === rowsBefore + 1);
    const table = tableById(gd, tableId);
    const newRow = table?.rows[table.rows.length - 1] ?? '';
    const { cellText } = await import('@gede/core');
    const map = room.doc.getMap('tables').get(tableId) as Parameters<typeof cellText>[0];
    expect(cellText(map, newRow, cols[0] ?? '')).toBe('India');
    expect(cellText(map, newRow, cols[1] ?? '')).toBe('Autumn');
    expect(cellText(map, newRow, cols[2] ?? '')).toBe('Easy');
    expect(screen.getByTestId('live-region')).toHaveTextContent('Added a row with 3 values');
    await waitFor(() => {
      expect(
        within(screen.getByTestId('coverage-graph')).getByRole('button', { name: /^δ: / }),
      ).toBeInTheDocument();
    });

    // GRAPH-10: Shift+Enter on a focused node opens a new sheet named after the symbol with a shaped child table.
    const alpha = within(screen.getByTestId('ring-graph')).getByRole('button', {
      name: /^Context α/,
    });
    alpha.focus();
    fireEvent.keyDown(alpha, { code: 'Enter', shiftKey: true });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /α/, selected: true })).toBeInTheDocument();
    });
    await until(() => listSheets(gd).length === 2);
    const child = listSheets(gd)[1];
    expect(child?.label).toBe('α');
    expect(child?.parentContext).toBe('α — Nepal · Spring · Easy');
    const childTables = tablesOnSheet(gd, child?.id ?? '');
    expect(childTables[0]?.title).toBe('Children of α');
    expect(childTables[0]?.columns.map((c) => c.label)).toEqual([
      'Dimension A',
      'Dimension B',
      'Dimension C',
      'Notes',
    ]);
  });

  it('GRAPH-11 GRAPH-04 GRAPH-05 the header moves and the corner resizes on the lattice (keyboard too); Add shaped table binds in one step; Re-point and Remove', async () => {
    await openShell();
    // GRAPH-04 from the empty-sheet menu: a shaped table with its pair, one step.
    await userEvent.click(screen.getByRole('button', { name: 'Add shaped table here' }));
    await until(() => room.doc.getMap('graphs').size === 2);
    const gd = openDocument(room.doc);
    const sheetId = listSheets(gd)[0]?.id ?? '';
    const shaped = tablesOnSheet(gd, sheetId)[0];
    expect(shaped?.columns.map((c) => c.label)).toEqual([
      'Dimension A',
      'Dimension B',
      'Dimension C',
      'Notes',
    ]);
    expect(within(ring()).getByTestId('graph-dimensions')).toHaveTextContent(
      'Dimension A · Dimension B · Dimension C',
    );
    const [r0] = graphsOnSheet(gd, sheetId);
    // GRAPH-11: arrows on the focused header move one unit; the document stores units.
    const header = within(ring()).getByRole('button', { name: /^Move Ring graph/ });
    header.focus();
    fireEvent.keyDown(header, { code: 'ArrowRight' });
    fireEvent.keyDown(header, { code: 'ArrowDown' });
    await until(() => {
      const g = graphsOnSheet(gd, sheetId)[0];
      return g?.gridCol === (r0?.gridCol ?? 0) + 1 && g.gridRow === (r0?.gridRow ?? 0) + 1;
    });
    await waitFor(() => {
      expect(ring().style.left).toBe(`${String(((r0?.gridCol ?? 0) + 1) * 160)}px`);
    });
    // The corner resizes in whole units and never below the minimum box.
    const corner = within(ring()).getByRole('separator', { name: /^Resize Ring graph/ });
    fireEvent.keyDown(corner, { code: 'ArrowRight' });
    await until(() => graphsOnSheet(gd, sheetId)[0]?.widthUnits === 7);
    for (let i = 0; i < 8; i += 1) fireEvent.keyDown(corner, { code: 'ArrowLeft' });
    await until(() => graphsOnSheet(gd, sheetId)[0]?.widthUnits === 2);
    expect(corner).toHaveAttribute('aria-valuetext', '2 by 28 units');
    // A pointer drag on the header previews and commits once, snapped (GRAPH-11).
    fireEvent.pointerDown(header, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(header, {
      pointerId: 1,
      clientX: 100 + 2 * 160 + 30,
      clientY: 100 - 22 * 1,
    });
    expect(ring()).toHaveClass('gd-graph--dragging');
    fireEvent.pointerUp(header, { pointerId: 1, clientX: 100 + 2 * 160 + 30, clientY: 100 - 22 });
    await until(() => graphsOnSheet(gd, sheetId)[0]?.gridCol === (r0?.gridCol ?? 0) + 3);
    expect(graphsOnSheet(gd, sheetId)[0]?.gridRow).toBe(r0?.gridRow ?? 0);
    // Coverage kept its own geometry (GRAPH-02: position and size are per object).
    expect(graphsOnSheet(gd, sheetId)[1]?.widthUnits).toBe(6);

    // GRAPH-05: Re-point enters pointing mode for this pair; a second table binds it.
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    expect(screen.getByTestId('graph-source')).toHaveTextContent('Contexts 1');
    await userEvent.click(screen.getByRole('button', { name: 'Add table' }));
    await until(() => tablesOnSheet(gd, sheetId).length === 2);
    await userEvent.click(within(ring()).getByRole('button', { name: /^Move Ring graph/ }));
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    await userEvent.click(screen.getByRole('button', { name: 'Re-point' }));
    expect(screen.getByText('Click a table to re-point the graph.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Bind the graph to Table 2' }));
    await until(() =>
      graphsOnSheet(gd, sheetId).every((g) => g.tableId === tablesOnSheet(gd, sheetId)[1]?.id),
    );
    await waitFor(() => {
      expect(screen.getByTestId('graph-source')).toHaveTextContent('Table 2');
    });
    expect(room.doc.getMap('graphs').size).toBe(2);
    // Remove takes both halves.
    await userEvent.click(screen.getByRole('button', { name: 'Remove graph' }));
    await until(() => room.doc.getMap('graphs').size === 0);
    expect(screen.queryByRole('tab', { name: 'Graph' })).not.toBeInTheDocument();
  });

  it('GRAPH-01 "Graph this table" in the table context menu creates a bound pair', async () => {
    await openShell();
    await addTable();
    const title = screen.getByText('Table 1', { selector: '.gd-table__title-text' });
    fireEvent.contextMenu(title);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Graph this table' }));
    await until(() => room.doc.getMap('graphs').size === 2);
    expect(ring()).toBeInTheDocument();
    expect(coverage()).toBeInTheDocument();
  });

  it('A11Y-01 INSP-08 GRAPH-09 a graph is selectable without a pointer: Enter on the header or on a node opens the Graph tab; keyboard focus emphasises across the pair and lights the row', async () => {
    await openShell();
    await addTable();
    const { gd, tableId, rows, cols } = roomTable();
    gd.doc.transact(() => {
      setCellText(gd, tableId, rows[0] ?? '', cols[0] ?? '', 'India');
      setCellText(gd, tableId, rows[0] ?? '', cols[1] ?? '', 'Q1');
      setCellText(gd, tableId, rows[0] ?? '', cols[2] ?? '', 'Retail');
    });
    await graphThisTable();
    // Drop the graph selection (Escape clears it, as for cells).
    fireEvent.keyDown(window, { code: 'Escape' });
    await userEvent.click(screen.getByTestId('plane'));
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: 'Graph' })).not.toBeInTheDocument();
    });
    // Enter on the header (a button) selects the graph: the Graph tab appears.
    const header = within(ring()).getByRole('button', { name: /^Move Ring graph/ });
    header.focus();
    fireEvent.keyDown(header, { code: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Graph' })).toBeInTheDocument();
    });
    expect(ring()).toHaveAttribute('data-selected', 'true');
    fireEvent.keyDown(window, { code: 'Escape' });
    await userEvent.click(screen.getByTestId('plane'));
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: 'Graph' })).not.toBeInTheDocument();
    });
    // Focus on a node (the roving tab stop) emphasises across the pair, as a hover does.
    const node = within(screen.getByTestId('ring-graph')).getByRole('button', {
      name: 'Context α: Column 1 India, Column 2 Q1, Column 3 Retail, complete',
    });
    fireEvent.focus(node);
    await waitFor(() => {
      expect(screen.getAllByTestId('ring-spoke')).toHaveLength(3);
    });
    expect(
      within(screen.getByTestId('coverage-graph')).getByRole('button', { name: /^α:/ }),
    ).toHaveClass('gd-coverage__cell--lit');
    expect(document.querySelector('.gd-table__row--lit')).not.toBeNull();
    // Enter on the node selects the graph and its row, as a click does.
    fireEvent.keyDown(node, { code: 'Enter' });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Graph' })).toBeInTheDocument();
    });
    expect(node).toHaveAttribute('aria-pressed', 'true');
    // Tab is never trapped: the roving handler leaves it to the browser.
    expect(fireEvent.keyDown(node, { code: 'Tab' })).toBe(true);
  });

  it('GRAPH-08 a one-dimensional graph shows one coverage column, one cell per parameter, with unique keys', async () => {
    const keyErrors: string[] = [];
    const original = console.error.bind(console);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('same key')) keyErrors.push(String(args[0]));
      else original(...args);
    });
    await openShell();
    await addTable();
    const { gd, tableId, rows, cols } = roomTable();
    gd.doc.transact(() => {
      setCellText(gd, tableId, rows[0] ?? '', cols[0] ?? '', 'India');
      setCellText(gd, tableId, rows[1] ?? '', cols[0] ?? '', 'Nepal');
      setCellText(gd, tableId, rows[2] ?? '', cols[0] ?? '', 'Peru');
    });
    await graphThisTable();
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    const list = screen.getByTestId('dimension-checklist');
    await userEvent.click(within(list).getByLabelText(/Column 2/));
    await userEvent.click(within(list).getByLabelText(/Column 3/));
    await waitFor(() => {
      expect(within(coverage()).getByTestId('coverage-axes')).toHaveTextContent(/^rows Column 1$/);
    });
    const cells = within(screen.getByTestId('coverage-graph')).getAllByRole('button');
    expect(cells.map((c) => c.getAttribute('aria-label'))).toEqual([
      'α: Column 1 India',
      'β: Column 1 Nepal',
      'γ: Column 1 Peru',
    ]);
    expect(within(ring()).getByTestId('graph-stat')).toHaveTextContent('3 / 3');
    expect(keyErrors).toEqual([]);
  });

  it('RESP-02 GRAPH-01 on the phone the pair renders read-only: no header drag, no corner, no pointing, no write-back', async () => {
    const first = await openShell();
    await addTable();
    await fillContexts();
    await graphThisTable();
    await waitFor(() => {
      expect(document.querySelector('.gd-doc')).toHaveAttribute('data-replica', 'ready');
    });
    await until(() => room.doc.getMap('graphs').size === 2);
    first.unmount();
    installMatchMedia((q) => q.includes('767.98') || q.includes('899.98'));
    await openShell();
    await waitFor(() => {
      expect(screen.getByTestId('ring-graph')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^Move Ring graph/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator', { name: /^Resize/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add graph' })).not.toBeInTheDocument();
    const empty = within(screen.getByTestId('coverage-graph')).getAllByRole('button', {
      name: /^Unexplored/,
    })[0]!;
    expect(empty).toHaveAttribute('aria-disabled', 'true');
    expect(empty.getAttribute('aria-label')).not.toMatch(/Add a row/);
    const rowsBefore = room.doc.getMap('tables').size;
    await userEvent.click(empty);
    const node = within(screen.getByTestId('ring-graph')).getAllByRole('button', {
      name: /^Context/,
    })[0]!;
    await userEvent.dblClick(node);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(room.doc.getMap('graphs').size).toBe(2);
    expect(room.doc.getArray('sheets').length).toBe(1);
    expect(room.doc.getMap('tables').size).toBe(rowsBefore);
  });

  it('GRAPH-06 GRAPH-09 render scope: a keystroke in a cell that is not a dimension renders neither half; a committed edit in a dimension column renders each half once; a hover renders the pair, not the shell', async () => {
    await openShell();
    await addTable();
    await fillContexts();
    await graphThisTable();
    const { gd, tableId, rows, cols } = roomTable();
    // Two dimensions (Column 1 · Column 2) so Column 3 is unrelated to the derivation.
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    await userEvent.click(
      within(screen.getByTestId('dimension-checklist')).getByLabelText(/Column 3/),
    );
    await waitFor(() => {
      expect(within(ring()).getByTestId('graph-dimensions')).toHaveTextContent(
        'Column 1 · Column 2',
      );
    });
    // Select D5 first (a selection change is a legitimate render), then type into it.
    const d5 = screen.getByRole('gridcell', { name: /^D5/ });
    await userEvent.click(d5);
    fireEvent.keyDown(d5, { code: 'Enter' });
    const editor = screen.getByLabelText('Edit D5');
    renders.ring = 0;
    renders.coverage = 0;
    await typeInto(editor, 'note');
    await typeInto(editor, 's');
    expect(renders).toEqual({ ring: 0, coverage: 0 });
    // Committing it in place (blur) writes the document; Column 3 is not a dimension, so
    // the derivation is structurally the same and neither half renders.
    fireEvent.blur(editor);
    await until(() => JSON.stringify(room.doc.getMap('tables').toJSON()).includes('notes'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(renders).toEqual({ ring: 0, coverage: 0 });
    // …and a committed edit in a dimension column re-derives once: one render per half.
    renders.ring = 0;
    renders.coverage = 0;
    setCellText(gd, tableId, rows[1] ?? '', cols[1] ?? '', 'Autumn');
    await waitFor(() => {
      expect(within(ring()).getByTestId('graph-stat')).toHaveTextContent('2 / 4');
    });
    expect(renders).toEqual({ ring: 1, coverage: 1 });
    // A hover renders the pair once each and nothing above it (the shell's selection stays).
    renders.ring = 0;
    renders.coverage = 0;
    const node = within(screen.getByTestId('ring-graph')).getAllByRole('button', {
      name: /^Context/,
    })[0]!;
    fireEvent.pointerEnter(node);
    await waitFor(() => {
      expect(screen.getAllByTestId('ring-spoke').length).toBeGreaterThan(0);
    });
    expect(renders).toEqual({ ring: 1, coverage: 1 });
    expect(document.querySelector('.gd-table__row--lit')).not.toBeNull();
  });
});
