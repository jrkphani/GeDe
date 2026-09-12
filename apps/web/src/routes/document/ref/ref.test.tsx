/**
 * References in the grid (REF-01..REF-05, HIER-07) against a real Yjs
 * document and the real engine on the inline transport — no shell, no room,
 * nothing mocked. The harness is the `useGrid` the shell uses.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addDerivedColumn,
  addMappingColumn,
  cellText,
  createSheet,
  createTable,
  createUndoManager,
  deleteColumn,
  isGraphDimensionCandidate,
  openDocument,
  rowMeta,
  setCellText,
  setPull,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import { engineFor } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import { useGrid, type Grid } from '../grid/use-grid.js';
import { TableView } from '../TableView.js';
import { DerivedColumnPanel } from './DerivedColumnPanel.js';
import { auditPipeline } from './pipeline-audit.js';

interface HarnessProps {
  gd: GedeDoc;
  tableId: Id;
  editable?: boolean;
  undo?: Y.UndoManager | undefined;
  grid: { current: Grid | null };
}

function Harness({ gd, tableId, editable = true, undo, grid }: HarnessProps) {
  const g = useGrid(gd, editable, { undo });
  grid.current = g;
  useYVersion(gd.tables, { depth: 'shallow' });
  const map = tableMap(gd, tableId);
  if (map === null) return null;
  return (
    <>
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
        actions={g.actions}
        commands={g.commands}
      />
      <LiveRegion />
    </>
  );
}

function Mount(props: Omit<HarnessProps, 'grid'>) {
  const ref = useRef<Grid | null>(null);
  return <Harness {...props} grid={ref} />;
}

let gd: GedeDoc;
let sheet: Id;
let peaks: Id;
let notes: Id;

function fill(tableId: Id, rows: string[][]): void {
  const rec = tableById(gd, tableId);
  if (rec === null) throw new Error('no table');
  rows.forEach((cells, r) => {
    cells.forEach((text, c) => {
      const rowId = rec.rows[r];
      const colId = rec.columns[c]?.id;
      if (rowId === undefined || colId === undefined) throw new Error('shape');
      if (text !== '') setCellText(gd, tableId, rowId, colId, text);
    });
  });
}

/** Type into the rich editor the way a browser does; ProseMirror reads the DOM change. */
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
  document.getSelection()?.collapse(node, node.textContent?.length ?? 0);
  await act(async () => {
    await Promise.resolve();
  });
}

const settled = () => act(() => engineFor(gd.doc).settled());
// A table with nesting is a treegrid (ADR-025); a flat one a grid.
const gridOf = (title: string) =>
  screen.queryByRole('grid', { name: title }) ?? screen.getByRole('treegrid', { name: title });
const cellsOf = (title: string) => within(gridOf(title)).getAllByRole('gridcell');
const live = () => screen.getByTestId('live-region');

beforeEach(() => {
  gd = openDocument(new Y.Doc());
  sheet = createSheet(gd);
  peaks = createTable(gd, {
    sheetId: sheet,
    at: { col: 1, row: 1 },
    columns: 2,
    rows: 3,
    title: 'Peaks',
  });
  fill(peaks, [
    ['Lukla', 'Nepal'],
    ['Namche', 'Nepal'],
    ['Leh', 'India'],
  ]);
  notes = createTable(gd, {
    sheetId: sheet,
    at: { col: 6, row: 1 },
    columns: 2,
    rows: 2,
    title: 'Notes',
  });
  fill(notes, [['Lukla (2860 m)', '']]);
});

describe('REF-01 reference cells', () => {
  it('REF-01 picking an entity from @ in a plain cell turns it into a live reference: accent mono, badge, path', async () => {
    render(<Mount gd={gd} tableId={notes} />);
    const target = cellsOf('Notes')[1]!; // second column, first row
    await userEvent.dblClick(target);
    const editor = screen.getByRole('textbox');
    await typeText(editor, '@Luk');
    const list = await screen.findByRole('listbox', { name: 'Entities' });
    expect(within(list).getAllByRole('option')[0]).toHaveTextContent('@Peaks.Lukla');
    await userEvent.keyboard('{Enter}');
    // The pick committed at once as one entity-bound token (ADR-023), no formula typed.
    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull();
    });
    const rec = tableById(gd, notes)!;
    const stored = cellText(tableMap(gd, notes)!, rec.rows[0]!, rec.columns[1]!.id);
    expect(stored).toMatch(/^=\{e:[0-9A-Z]{26}:[0-9A-Z]{26}:[0-9A-Z]{26}\}$/u);
    await settled();
    const body = within(cellsOf('Notes')[1]!).getByTestId('reference-cell');
    expect(body).toHaveClass('gd-ref--reference');
    expect(within(body).getByText('Lukla')).toBeInTheDocument();
    expect(within(body).getByLabelText('Reference, @Peaks.Lukla')).toHaveTextContent('@');
    // Compact row: the path is the tooltip (ADR-024); it follows the source label.
    expect(body).toHaveAttribute('title', '@Peaks.Lukla');
    const p = tableById(gd, peaks)!;
    act(() => {
      setCellText(gd, peaks, p.rows[0]!, p.columns[0]!.id, 'Lukla airstrip');
    });
    await settled();
    await waitFor(() => {
      expect(within(cellsOf('Notes')[1]!).getByText('Lukla airstrip')).toBeInTheDocument();
    });
    expect(within(cellsOf('Notes')[1]!).getByTestId('reference-cell')).toHaveAttribute(
      'title',
      '@Peaks."Lukla airstrip"',
    );
  });
});

describe('REF-02 pulls', () => {
  it('REF-02 pulled rows render the mirrored value with the ↰ badge, are read-only and refuse typing', async () => {
    const p = tableById(gd, peaks)!;
    const n = tableById(gd, notes)!;
    setPull(gd, notes, n.columns[1]!.id, {
      tableId: peaks,
      colId: p.columns[0]!.id,
      filter: 'nepal',
    });
    render(<Mount gd={gd} tableId={notes} />);
    await settled();
    const cells = cellsOf('Notes');
    // 2 own rows + 2 pulled rows, 2 columns.
    expect(cells).toHaveLength(8);
    const pulledLukla = cells[5]!;
    expect(pulledLukla).toHaveAttribute('data-read-only', 'pulled');
    expect(pulledLukla).toHaveAttribute('aria-readonly', 'true');
    await waitFor(() => {
      expect(within(pulledLukla).getByTestId('pulled-cell')).toHaveTextContent('Lukla');
    });
    expect(within(pulledLukla).getByLabelText(/^Pulled, Peaks/u)).toHaveTextContent('↰');
    // The receiving column renamed itself after its source.
    expect(
      within(gridOf('Notes')).getByRole('columnheader', { name: /↰ Peaks · Column 1/u }),
    ).toBeInTheDocument();
    // Every cell of a pulled row is read-only, the first column included (REF-05).
    await userEvent.click(cells[4]!);
    await userEvent.keyboard('x');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(live()).toHaveTextContent('read-only: pulled from another table');
  });
});

describe('REF-03 mapping columns', () => {
  it('REF-03 a mapping cell is a picker over the target distinct values; Enter opens it, a pick writes one undo step', async () => {
    const p = tableById(gd, peaks)!;
    const colId = addMappingColumn(gd, notes, { tableId: peaks, colId: p.columns[1]!.id })!;
    const undo = createUndoManager(gd, { captureTimeout: 0 });
    render(<Mount gd={gd} tableId={notes} undo={undo} />);
    const cells = cellsOf('Notes');
    const cell = cells[2]!; // first row, third column (the mapping column)
    expect(cell).toHaveAttribute('data-read-only', 'linked');
    const trigger = within(cell).getByRole('combobox', { name: /mapping$/u });
    await userEvent.click(cells[0]!);
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(cell).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    const list = await screen.findByRole('listbox');
    // Distinct, collated: India, Nepal (Nepal appears twice in the target).
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['India', 'Nepal']);
    await userEvent.click(within(list).getByRole('option', { name: 'Nepal' }));
    const n = tableById(gd, notes)!;
    await waitFor(() => {
      expect(cellText(tableMap(gd, notes)!, n.rows[0]!, colId)).toBe('Nepal');
    });
    expect(trigger).toHaveTextContent('Nepal');
    expect(live()).toHaveTextContent('set to Nepal');
    // Typing is refused (REF-05); the picker is the only write path.
    await userEvent.keyboard('x');
    expect(screen.queryByRole('textbox')).toBeNull();
    // One pick, one step.
    expect(undo.undoStack).toHaveLength(1);
    act(() => {
      undo.undo();
    });
    expect(cellText(tableMap(gd, notes)!, n.rows[0]!, colId)).toBe('');
    // Not a graph dimension (REF-05).
    expect(isGraphDimensionCandidate(tableById(gd, notes)!.columns[2]!)).toBe(false);
  });

  it('RESP-02 without edit rights a mapping cell shows its value and no picker', () => {
    const p = tableById(gd, peaks)!;
    const colId = addMappingColumn(gd, notes, { tableId: peaks, colId: p.columns[1]!.id })!;
    const n = tableById(gd, notes)!;
    setCellText(gd, notes, n.rows[0]!, colId, 'Nepal');
    render(<Mount gd={gd} tableId={notes} editable={false} />);
    const cell = cellsOf('Notes')[2]!;
    expect(within(cell).queryByRole('combobox')).toBeNull();
    expect(within(cell).getByTestId('mapping-cell')).toHaveTextContent('Nepal');
  });
});

describe('REF-04 derived columns', () => {
  it('REF-04 a derived column shows the engine result in accent mono under a lineage header and recomputes upstream', async () => {
    const n = tableById(gd, notes)!;
    addDerivedColumn(gd, notes, {
      sourceColId: n.columns[0]!.id,
      method: 'Extract',
      args: ['/\\(([^)]*)\\)/'],
    });
    render(<Mount gd={gd} tableId={notes} />);
    await settled();
    const cells = cellsOf('Notes');
    const derived = cells[1]!;
    expect(derived).toHaveAttribute('data-read-only', 'derived');
    await waitFor(() => {
      expect(within(derived).getByTestId('formula-cell')).toHaveTextContent('2860 m');
    });
    expect(within(derived).getByTestId('formula-cell')).toHaveClass('gd-ref--derived');
    expect(
      within(gridOf('Notes')).getByRole('columnheader', { name: /Extract/u }),
    ).toBeInTheDocument();
    const lineage = screen.getByTestId('lineage-header');
    // Column order: source, derived, source — two source bands around one pipeline band.
    expect(within(lineage).getAllByText('source · Notes')).toHaveLength(2);
    expect(within(lineage).getByText('derived pipeline ▸ 1 step')).toBeInTheDocument();
    act(() => {
      setCellText(gd, notes, n.rows[0]!, n.columns[0]!.id, 'Lukla (2900 m)');
    });
    await settled();
    await waitFor(() => {
      expect(within(cellsOf('Notes')[1]!).getByTestId('formula-cell')).toHaveTextContent('2900 m');
    });
  });

  it('REF-04 the inspector panel composes @Column.Method(args) and creates the column (partial: inspector mounts it)', async () => {
    const n = tableById(gd, notes)!;
    render(<DerivedColumnPanel gd={gd} tableId={notes} sourceColId={n.columns[0]!.id} />);
    const panel = screen.getByTestId('derived-column-panel');
    await userEvent.click(within(panel).getByRole('combobox', { name: 'Method' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Concat' }));
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Text' }), ' ✓');
    expect(within(panel).getByTestId('derive-signature')).toHaveTextContent(
      '@"Column 1".Concat(" ✓")',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Create derived column' }));
    const after = tableById(gd, notes)!;
    expect(after.columns[1]).toMatchObject({
      source: 'derived',
      label: '@"Column 1".Concat(" ✓")',
      derive: { sourceColId: n.columns[0]!.id, method: 'Concat', args: [' ✓'] },
    });
    expect(within(panel).getByRole('list', { name: 'Derived pipeline' })).toHaveTextContent(
      '@"Column 1".Concat(" ✓")',
    );
    // Editing a step re-labels it.
    await userEvent.click(within(panel).getByRole('button', { name: /^Edit /u }));
    await userEvent.click(within(panel).getByRole('combobox', { name: 'Method' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Format' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Update derived column' }));
    expect(tableById(gd, notes)!.columns[1]!.label).toBe('@"Column 1".Format("Title Case")');
  });

  it("INSP-09 the pipeline audit list walks the chain step by step with what each reads, its rows, errors and last recompute; the selected column's step is current; a pull is a step too (#127)", async () => {
    const p = tableById(gd, peaks)!;
    const [c1, c2] = p.columns.map((c) => c.id) as [Id, Id];
    // Step 1 reads Column 1; step 2 reads step 1 (A → B → C). Split needs a delimiter:
    // the empty one is an invalid argument, so every row of step 3 errors.
    const step1 = addDerivedColumn(gd, peaks, { sourceColId: c1, method: 'Concat', args: [' ✓'] })!;
    const step2 = addDerivedColumn(gd, peaks, {
      sourceColId: step1,
      method: 'Format',
      args: ['Upper Case'],
    })!;
    const step3 = addDerivedColumn(gd, peaks, { sourceColId: c2, method: 'Split', args: [''] })!;
    await settled();
    const host = engineFor(gd.doc);
    const before = Date.now();
    const steps = auditPipeline(
      gd,
      peaks,
      (id) => host.result(id),
      (id) => host.computedAt(id),
    );
    expect(
      steps.map((s) =>
        s.kind === 'derived'
          ? [s.step, s.source, s.outcome.rows, s.outcome.errors, s.outcome.pending]
          : s.kind,
      ),
    ).toEqual([
      [1, { label: 'Column 1', step: null }, 3, 0, 0],
      [2, { label: '@"Column 1".Concat(" ✓")', step: 1 }, 3, 0, 0],
      [3, { label: 'Column 2', step: null }, 0, 3, 0],
    ]);
    // The last recompute is the engine host's time for the newest result — real, not a time
    // the list made up when it first saw the result; without a reader there is none.
    for (const s of steps) {
      if (s.kind !== 'derived') continue;
      expect(s.outcome.at).toBeGreaterThan(0);
      expect(s.outcome.at).toBeLessThanOrEqual(before);
    }
    expect(
      auditPipeline(gd, peaks, (id) => host.result(id)).every(
        (s) => s.kind !== 'derived' || s.outcome.at === undefined,
      ),
    ).toBe(true);

    const { rerender } = render(<DerivedColumnPanel gd={gd} tableId={peaks} sourceColId={step2} />);
    const panel = screen.getByTestId('derived-column-panel');
    const list = within(panel).getByRole('list', { name: 'Derived pipeline' });
    const items = within(list).getAllByTestId('pipeline-step');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Step 1');
    expect(items[0]).toHaveTextContent('from Column 1');
    expect(items[0]).toHaveTextContent('3 rows');
    expect(items[0]).toHaveTextContent(/recomputed \d{1,2}:\d{2}:\d{2}/);
    expect(items[1]).toHaveTextContent('Step 2');
    expect(items[1]).toHaveTextContent('from step 1 (@"Column 1".Concat(" ✓"))');
    expect(items[2]).toHaveTextContent('0 rows · 3 errors');
    // The selection: step 2's column is selected, so its step is current and it is the
    // compose form's source.
    expect(items[1]).toHaveAttribute('aria-current', 'true');
    expect(items[0]).not.toHaveAttribute('aria-current');
    expect(within(panel).getByRole('combobox', { name: 'Source column' })).toHaveTextContent(
      '.Format("Upper Case")',
    );
    // Selecting another column moves both.
    rerender(<DerivedColumnPanel gd={gd} tableId={peaks} sourceColId={step3} />);
    expect(within(list).getAllByTestId('pipeline-step')[2]).toHaveAttribute('aria-current', 'true');
    expect(within(panel).getByRole('combobox', { name: 'Source column' })).toHaveTextContent(
      '@"Column 2".Split("")',
    );
    // Remove takes the step out of the chain.
    await userEvent.click(
      within(list).getByRole('button', { name: `Remove @"Column 2".Split("")` }),
    );
    expect(tableById(gd, peaks)!.columns.some((c) => c.id === step3)).toBe(false);
    await waitFor(() => {
      expect(within(list).getAllByTestId('pipeline-step')).toHaveLength(2);
    });
    // A pull is a step of the pipeline as well: it lists the rows it mirrored.
    const n = tableById(gd, notes)!;
    setPull(gd, peaks, c2, { tableId: notes, colId: n.columns[0]!.id, filter: '' });
    await settled();
    await waitFor(() => {
      expect(within(list).getAllByTestId('pipeline-step')).toHaveLength(3);
    });
    const pull = within(list).getAllByTestId('pipeline-step')[2]!;
    expect(pull).toHaveTextContent('Pull');
    expect(pull).toHaveTextContent('↰ Notes · Column 1');
    expect(pull).toHaveTextContent(/\d+ rows? pulled/);
  });
});

describe('HIER-07 Split children', () => {
  it('HIER-07 Split() pieces appear as read-only child rows beneath the parent, one depth deeper', async () => {
    const n = tableById(gd, notes)!;
    setCellText(gd, notes, n.rows[0]!, n.columns[0]!.id, 'One. Two');
    render(<Mount gd={gd} tableId={notes} />);
    act(() => {
      addDerivedColumn(gd, notes, { sourceColId: n.columns[0]!.id, method: 'Split', args: ['. '] });
    });
    await settled();
    await waitFor(() => {
      expect(tableById(gd, notes)!.rows).toHaveLength(4); // 2 own + 2 children
    });
    const after = tableById(gd, notes)!;
    const child = after.rows[1]!;
    const table = tableMap(gd, notes)!;
    expect(rowMeta(table, child)).toMatchObject({
      depth: 1,
      splitChild: true,
      splitOf: { rowId: n.rows[0], index: 0 },
    });
    expect(cellText(table, child, after.columns[1]!.id)).toBe('One');
    await waitFor(() => {
      const cells = cellsOf('Notes');
      expect(cells[3]).toHaveAttribute('data-read-only', 'splitChild');
      expect(cells[4]).toHaveTextContent('One');
    });
    // Fewer pieces, fewer children.
    act(() => {
      setCellText(gd, notes, n.rows[0]!, n.columns[0]!.id, 'Only');
    });
    await settled();
    await waitFor(() => {
      expect(tableById(gd, notes)!.rows).toHaveLength(3);
    });
    // The Split column deleted: its children go with it rather than staying as read-only rows.
    const splitCol = tableById(gd, notes)!.columns.find((c) => c.derive?.method === 'Split')!;
    act(() => {
      deleteColumn(gd, notes, splitCol.id);
    });
    await settled();
    await waitFor(() => {
      expect(tableById(gd, notes)!.rows).toEqual(n.rows);
    });
  });
});
