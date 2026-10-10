/**
 * A sheet's structure on the canvas (SET-13..18; ADR-056, SPEC §3–4) against a real Yjs
 * document and the grid commands the shell uses — no room, no Worker.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  addRow,
  addSection,
  createSheet,
  createTable,
  listSections,
  openDocument,
  renameSection,
  sectionLockReason,
  setCellText,
  setSectionLocked,
  setSheetLocked,
  tableAddresses,
  tableById,
  tableMap,
  type GedeDoc,
  type Id,
  type TableKind,
} from '@gede/core';

import { LiveRegion } from '../../../announce.js';
import { useYVersion } from '../../../doc/use-y.js';
import { openViewStore, ViewStoreProvider, type ViewStore } from '../../../doc/view-state.js';
import { useGrid, type Grid } from '../grid/use-grid.js';
import { menuEntriesFor, type MenuContext } from '../menus/entries.js';
import { TableView } from '../TableView.js';
import { SheetStructure } from './SheetStructure.js';

let gd: GedeDoc;
let sheetId: Id;
let viewStore: ViewStore;
const grid: { current: Grid | null } = { current: null };

const canvas = { addTable: () => undefined, fit: () => undefined, actualSize: () => undefined };
const sheets = { add: () => undefined, rename: () => undefined, remove: () => undefined };

function Harness({ tables = [] as Id[] }: { tables?: Id[] }) {
  const g = useGrid(gd, true);
  grid.current = g;
  useYVersion(gd.tables, { depth: 'shallow' });
  useYVersion(gd.sheets);
  const [renaming, setRenaming] = useState<Id | null>(null);
  const context: MenuContext = {
    gd,
    editable: true,
    commands: g.commands,
    clipboard: {} as MenuContext['clipboard'],
    selectedCell: g.cell,
    canvas,
    sheets,
    sections: {
      sheetId,
      add: () => undefined,
      rename: (_sheet, sectionId) => {
        setRenaming(sectionId);
      },
      setLocked: (sheet, sectionId, locked) => {
        setSectionLocked(gd, sheet, sectionId, locked);
      },
      setSheetLocked: (sheet, locked) => {
        setSheetLocked(gd, sheet, locked);
      },
    },
  };
  return (
    <ViewStoreProvider value={viewStore}>
      <SheetStructure
        gd={gd}
        sheetId={sheetId}
        editable
        renaming={renaming}
        commitRename={(sectionId, name) => {
          if (!renameSection(gd, sheetId, sectionId, name)) return { ok: false, reason: 'refused' };
          setRenaming(null);
          return { ok: true };
        }}
        cancelRename={() => {
          setRenaming(null);
        }}
        menuEntries={(sectionId) =>
          menuEntriesFor(context, { kind: 'section', sheetId, sectionId })
        }
      />
      {tables.map((id) => {
        const map = tableMap(gd, id);
        return map === null ? null : (
          <TableView
            key={id}
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
      })}
      <LiveRegion />
    </ViewStoreProvider>
  );
}

function setTable(
  title: string,
  elements: readonly string[],
  col: number,
  kind: TableKind = 'simple',
) {
  const id = createTable(gd, { sheetId, at: { col, row: 2 }, columns: 2, rows: 0, kind, title });
  const range = tableById(gd, id)?.columns[0]?.id ?? '';
  for (const element of elements) setCellText(gd, id, addRow(gd, id), range, element);
  return id;
}

function section(name: string, first: number, last: number): Id {
  return addSection(gd, sheetId, { name, firstColumn: first, lastColumn: last }) ?? '';
}

beforeEach(async () => {
  // Radix returns focus from the previous test's unmounted menu on a zero timer.
  await new Promise((resolve) => setTimeout(resolve, 0));
  localStorage.clear();
  viewStore = openViewStore('user-1', 'doc-structure');
  gd = openDocument(new Y.Doc());
  sheetId = createSheet(gd);
});

describe('sections on the canvas (SET-17)', () => {
  test('SET-17 a section is a named lane with its ordinal, between guide lines on lattice column edges', () => {
    section('Foundation', 0, 5);
    section('Pairs', 7, 12);
    render(<Harness />);
    const lanes = screen.getAllByTestId('section-lane');
    expect(lanes).toHaveLength(2);
    expect(lanes[0]).toHaveStyle({ left: '0px', width: '960px' });
    // The second lane starts a column after the gutter column (6): 7 × 160.
    expect(lanes[1]).toHaveStyle({ left: '1120px', width: '960px' });
    expect(within(lanes[0]!).getByRole('heading', { name: 'Foundation' })).toBeInTheDocument();
    expect(lanes[0]!.querySelectorAll('.gd-lane__guide')).toHaveLength(2);
    expect(screen.getByRole('group', { name: 'Section 2: Pairs' })).toBeInTheDocument();
  });

  test('SET-17 Rename section… opens the heading as a field, Enter renames, and no table address moves', async () => {
    const lane = section('Foundation', 0, 5);
    const id = setTable('E', ['a'], 1);
    render(<Harness tables={[id]} />);
    const addresses = () => tableAddresses(tableMap(gd, id)!);
    const address = addresses();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Section menu: Foundation' }));
    await user.click(await screen.findByRole('menuitem', { name: /Rename section…/ }));
    const field = await screen.findByRole('textbox', { name: 'Section name' });
    await user.clear(field);
    await user.type(field, 'Fundamentals{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Fundamentals' })).toBeInTheDocument();
    });
    expect(listSections(gd, sheetId).find((s) => s.id === lane)?.name).toBe('Fundamentals');
    expect(addresses()).toEqual(address);
  });

  test('SET-17 an empty name is refused with the reason and the old name stays', async () => {
    section('Foundation', 0, 5);
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Section menu: Foundation' }));
    await user.click(await screen.findByRole('menuitem', { name: /Rename section…/ }));
    const field = await screen.findByRole('textbox', { name: 'Section name' });
    await user.clear(field);
    await user.keyboard('{Enter}');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('placeholder', 'A section needs a name');
    expect(listSections(gd, sheetId)[0]?.name).toBe('Foundation');
  });
});

describe('lock on the canvas (SET-18)', () => {
  test('SET-18 Lock section says “Locked {name}” in the lane, and Unlock section takes it back', async () => {
    const lane = section('Foundation', 0, 5);
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Section menu: Foundation' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Lock section' }));
    const status = await screen.findByText('Locked Foundation');
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(sectionLockReason(gd, sheetId, lane)).toBe('section');
    await user.click(screen.getByRole('button', { name: 'Section menu: Foundation' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Unlock section' }));
    await waitFor(() => {
      expect(screen.queryByText('Locked Foundation')).toBeNull();
    });
    expect(sectionLockReason(gd, sheetId, lane)).toBeNull();
  });

  test('SET-18 a locked section’s Rename section… is disabled with “the section is locked”; a locked sheet says so', () => {
    const lane = section('Foundation', 0, 5);
    const context = { gd, editable: true, sections: { sheetId } } as unknown as MenuContext;
    setSectionLocked(gd, sheetId, lane, true);
    const rename = () =>
      menuEntriesFor(context, { kind: 'section', sheetId, sectionId: lane }).find(
        (e) => e.id === 'section-rename',
      );
    expect(rename()).toMatchObject({ disabledReason: 'the section is locked' });
    setSheetLocked(gd, sheetId, true);
    expect(rename()).toMatchObject({ disabledReason: 'the sheet is locked' });
    // Unlock stays on offer: lock binds everyone, and anyone who can edit can unlock.
    const unlock = menuEntriesFor(context, { kind: 'section', sheetId, sectionId: lane }).find(
      (e) => e.id === 'section-lock',
    );
    expect(unlock).toMatchObject({ label: 'Unlock section' });
    expect(unlock).not.toHaveProperty('disabledReason', expect.any(String));
  });

  test('SET-18 a table in a locked section reads as locked: cells say why, commands refuse and say it', async () => {
    const lane = section('Foundation', 0, 5);
    const id = setTable('E', ['a', 'b'], 1);
    render(<Harness tables={[id]} />);
    const rowId = tableById(gd, id)?.rows[0] ?? '';
    const colId = tableById(gd, id)?.columns[0]?.id ?? '';
    act(() => {
      setSectionLocked(gd, sheetId, lane, true);
    });
    const cell = screen.getAllByRole('gridcell')[0];
    await waitFor(() => {
      expect(cell?.getAttribute('aria-label') ?? '').toMatch(/the section is locked/);
    });
    let written = true;
    act(() => {
      written = grid.current?.commands.commitCell({ tableId: id, rowId, colId }, 'z') ?? true;
    });
    expect(written).toBe(false);
    expect(grid.current?.commands.readOnlyReason({ tableId: id, rowId, colId })).toBe(
      'sectionLocked',
    );
    expect(tableById(gd, id)?.rows).toHaveLength(2);
    act(() => {
      expect(grid.current?.commands.insertRowBelow(id)).toBeNull();
    });
    expect(tableById(gd, id)?.rows).toHaveLength(2);
    expect(screen.getByText('The section is locked')).toBeInTheDocument();
  });

  test('SET-18 a locked sheet disables a table’s menu items with “the sheet is locked”', () => {
    const id = setTable('E', ['a'], 1);
    render(<Harness tables={[id]} />);
    setSheetLocked(gd, sheetId, true);
    const context = {
      gd,
      editable: true,
      commands: grid.current!.commands,
      sections: { sheetId },
      canvas,
      sheets,
    } as unknown as MenuContext;
    const entries = menuEntriesFor(context, { kind: 'table', tableId: id });
    const add = entries.find((e) => e.id === 'row-append');
    expect(add).toMatchObject({ disabledReason: 'the sheet is locked' });
    const del = entries.find((e) => e.id === 'table-delete');
    expect(del).toMatchObject({ disabledReason: 'the sheet is locked' });
    // Fit to canvas is not an edit.
    expect(entries.find((e) => e.id === 'fit')).not.toHaveProperty(
      'disabledReason',
      expect.any(String),
    );
    const sheetEntries = menuEntriesFor(context, { kind: 'sheet', sheetId });
    expect(sheetEntries.find((e) => e.id === 'sheet-lock')).toMatchObject({
      label: 'Unlock sheet',
    });
  });
});

describe('summaries on the canvas (SET-13..16)', () => {
  function relations() {
    section('Foundation', 0, 20);
    setTable('E', ['a', 'b', 'c'], 0);
    setTable('A', ['a', 'b', 'c'], 3);
    setTable('C', ['b', 'c', 'x'], 6);
    setTable('D', ['b', 'c'], 9);
  }

  test('SET-15 the section summary has the twelve columns, one row per set, counts in the caption', () => {
    relations();
    render(<Harness />);
    const summary = screen.getByRole('region', { name: 'Section summary: Foundation' });
    const headers = within(summary)
      .getAllByRole('columnheader')
      .map((h) => h.textContent?.replace(/±0°/, ''));
    expect(headers).toEqual([
      'set id',
      'name',
      'definition',
      'cardinality · bag',
      'special status',
      'similar definition',
      'improper subset of ⊆',
      'proper subset of ⊂',
      'element of ∈',
      'same as intersection',
      'same as union',
      'same as difference',
    ]);
    const body = within(summary).getAllByRole('row').slice(1);
    expect(body).toHaveLength(4);
    expect(summary).toHaveTextContent('Sets: 4 · Elements: 4');
    const e = body[0]!;
    expect(within(e).getAllByRole('cell')[0]).toHaveTextContent('E');
    // E equals A, and is a subset of A and of nothing properly.
    expect(within(e).getAllByRole('cell')[4]).toHaveTextContent('A');
  });

  test('SET-15 “—” is spoken as none found; the note says what it means', () => {
    relations();
    render(<Harness />);
    const summary = screen.getByRole('region', { name: 'Section summary: Foundation' });
    const e = within(summary).getAllByRole('row')[1]!;
    // Special status of a three-element set: nothing, in words for assistive technology.
    expect(within(e).getAllByRole('cell')[3]).toHaveTextContent('—none found');
    expect(summary).toHaveTextContent(
      '“—” means GeDe checked and found none, not that the cell is empty.',
    );
  });

  test('SET-15 above 30 sets the pair columns read “—” with the reason', () => {
    section('Big', 0, 200);
    for (let i = 0; i < 31; i += 1) setTable(`T${String(i)}`, [String(i)], i * 3);
    render(<Harness />);
    const summary = screen.getByRole('region', { name: 'Section summary: Big' });
    expect(summary).toHaveTextContent('more than 30 sets in this section');
    const first = within(summary).getAllByRole('row')[1]!;
    const cells = within(first).getAllByRole('cell');
    expect(cells[8]).toHaveTextContent('—more than 30 sets in this section');
    expect(cells[9]).toHaveTextContent('—more than 30 sets in this section');
    expect(cells[10]).toHaveTextContent('—more than 30 sets in this section');
  });

  test('SET-13 SET-14 U lists every element once, and the super set array labels elements and sets in words', () => {
    relations();
    render(<Harness />);
    const universe = screen.getByTestId('universal-set');
    expect(
      within(universe)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['a', 'b', 'c', 'x']);
    expect(universe).toHaveTextContent('|U| = 4');
    expect(universe).toHaveTextContent('@U');
    const array = screen.getByTestId('super-set-array');
    const items = within(array)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      'elementa',
      'elementb',
      'elementc',
      'elementx',
      'setE',
      'setA',
      'setC',
      'setD',
    ]);
  });

  test('SET-16 the sheet summary lists each section with its set and element counts', () => {
    section('First', 0, 8);
    section('Second', 10, 20);
    setTable('E', ['a', 'b'], 0);
    setTable('C', ['b', 'c'], 4);
    setTable('B', ['x'], 11);
    render(<Harness />);
    const summary = screen.getByRole('region', { name: 'sheet summary' });
    const rows = within(summary).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['1° First23', '2° Second11']);
  });

  test('SET-13 the structure draws nothing on a sheet with no set and no section', () => {
    createTable(gd, { sheetId, at: { col: 1, row: 1 }, columns: 2, rows: 2 });
    render(<Harness />);
    expect(screen.queryByTestId('sheet-structure')).toBeNull();
    fireEvent.click(document.body);
  });
});
