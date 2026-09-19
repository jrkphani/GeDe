/**
 * The guided sample workscape (ONB-01): `Q3 Delivery — Guided sample`, seeded
 * server-side once per user and pinned first in every library. It carries
 * exactly what the six-step tour refers to:
 *
 *   - two tables, `Deliverables` and `Team`, so a cross-table reference
 *     (`=@Team.Priya.Role`, step 2) has somewhere to point;
 *   - an `Owner` column and `Blocked` statuses, so the Find step's operator
 *     examples match rows (`col:Owner`; `Due` is a date column for `is:date`);
 *   - a `Due` column formatted as dates and a `Days` column formatted as
 *     numbers, with an id-bound `=Sum(…)` over it (FX, FMT);
 *   - an `Owner` column with repeated names and a `Team` whose names are
 *     the owners, so the set-operator step's examples evaluate (step 3,
 *     FX-09, ADR-055): `=Union(C5:C12, I5:I8)` and `=Diff(I5:I8, C6)` —
 *     `ref/set-call.test.ts` pins the addresses and the results;
 *   - at least two entered columns on `Deliverables`, so a context graph the
 *     person adds in step 4 binds with two or more dimensions (GRAPH-05).
 *
 * The formulas go through `commitCellText`, so they are stored id-bound like
 * any formula a person types. Everything is written under `SEED_ORIGIN` in
 * one transaction; the sample is a document like any other afterwards.
 */
import * as Y from 'yjs';

import { cellAddress } from '../doc/geometry.js';
import { addColumn, createTable } from '../doc/mutations.js';
import { columnsArray, openDocument, tableById, type GedeDoc } from '../doc/schema.js';
import { SEED_ORIGIN, seedNewDocument, type SeedOptions } from '../doc/seed.js';
import { commitCellText } from '../engine/commit.js';
import { setColumnFormat } from '../format/mutations.js';
import { setCellText } from '../doc/mutations.js';
import type { Id } from '../ids.js';

/** The sample's title, exactly as ONB-01 spells it. */
export const SAMPLE_TITLE = 'Q3 Delivery — Guided sample';

export const SAMPLE_DELIVERABLES_TITLE = 'Deliverables';
export const SAMPLE_TEAM_TITLE = 'Team';

/** Column labels, in order, of the two tables. */
export const SAMPLE_DELIVERABLES_COLUMNS = [
  'Deliverable',
  'Owner',
  'Status',
  'Due',
  'Days',
  'Owner role',
] as const;
export const SAMPLE_TEAM_COLUMNS = ['Name', 'Role', 'Capacity'] as const;

/** Rows of `Deliverables`: deliverable, owner, status, due (ISO), days. */
export const SAMPLE_DELIVERABLES: readonly (readonly [string, string, string, string, string])[] = [
  ['Onboarding flow', 'Priya', 'In progress', '2026-07-14', '12'],
  ['Billing export', 'Marcus', 'Blocked', '2026-07-21', '8'],
  ['Search index', 'Aditi', 'Done', '2026-07-03', '15'],
  ['Audit log', 'Marcus', 'In progress', '2026-08-04', '6'],
  ['Passkey sign-in', 'Priya', 'Blocked', '2026-08-11', '9'],
  ['Mobile read view', 'Sanjay', 'Not started', '2026-08-25', '10'],
  ['Data export', 'Aditi', 'Done', '2026-07-28', '5'],
  ['Release notes', 'Sanjay', 'In progress', '2026-09-08', '3'],
];

/** Rows of `Team`: name, role, capacity in days. The last row totals the capacity. */
export const SAMPLE_TEAM: readonly (readonly [string, string, string])[] = [
  ['Priya', 'Product engineer', '20'],
  ['Marcus', 'Platform engineer', '18'],
  ['Aditi', 'Data engineer', '22'],
  ['Sanjay', 'Designer', '15'],
];
export const SAMPLE_TEAM_TOTAL_LABEL = 'Total';

/** The worked cross-table reference in the first deliverable's `Owner role` cell. */
export const SAMPLE_REFERENCE_FORMULA = `=@${SAMPLE_TEAM_TITLE}.Priya.Role`;

export interface SampleSeedResult {
  readonly sheetId: Id;
  readonly deliverablesId: Id;
  readonly teamId: Id;
}

function labelColumns(gd: GedeDoc, tableId: Id, labels: readonly string[]): Id[] {
  const table = gd.tables.get(tableId);
  if (table === undefined) throw new RangeError(`no table ${tableId}`);
  const columns = columnsArray(table);
  const ids: Id[] = [];
  columns.toArray().forEach((column, i) => {
    const label = labels[i];
    if (label === undefined) return;
    column.set('label', label);
    ids.push(String(column.get('id')));
  });
  for (let i = columns.length; i < labels.length; i += 1) {
    ids.push(addColumn(gd, tableId, { label: labels[i] }));
  }
  return ids;
}

/**
 * Seed the guided sample into an empty document. Idempotent the way
 * `seedNewDocument` is: a document that already has a sheet is left alone.
 */
export function seedSampleWorkscape(
  doc: Y.Doc,
  options: Omit<SeedOptions, 'title'> = {},
): SampleSeedResult {
  const seeded = seedNewDocument(doc, { title: SAMPLE_TITLE, createdAt: options.createdAt });
  const gd = openDocument(doc);
  if (!seeded.seeded) {
    const [deliverables, team] = gd.tables.keys();
    return {
      sheetId: seeded.sheetId,
      deliverablesId: deliverables ?? '',
      teamId: team ?? '',
    };
  }
  const sheetId = seeded.sheetId;
  let deliverablesId: Id = '';
  let teamId: Id = '';
  // Nested `transact` calls join this one, so the sample is one seed-origin transaction.
  doc.transact(() => {
    deliverablesId = createTable(gd, {
      sheetId,
      at: { col: 1, row: 1 },
      columns: SAMPLE_DELIVERABLES_COLUMNS.length,
      rows: SAMPLE_DELIVERABLES.length,
      title: SAMPLE_DELIVERABLES_TITLE,
    });
    const dCols = labelColumns(gd, deliverablesId, SAMPLE_DELIVERABLES_COLUMNS);
    const [, , , dueCol, daysCol, roleCol] = dCols;
    if (dueCol === undefined || daysCol === undefined || roleCol === undefined) {
      throw new RangeError('sample: Deliverables columns were not created');
    }
    setColumnFormat(gd, deliverablesId, dueCol, 'date', { datePattern: 'D MMM YYYY' });
    setColumnFormat(gd, deliverablesId, daysCol, 'number', { decimals: 0 });
    const dRows = tableById(gd, deliverablesId)?.rows ?? [];
    SAMPLE_DELIVERABLES.forEach((values, r) => {
      const rowId = dRows[r];
      if (rowId === undefined) return;
      values.forEach((text, c) => {
        const colId = dCols[c];
        if (colId !== undefined) setCellText(gd, deliverablesId, rowId, colId, text);
      });
    });

    // `Team` sits to the right of `Deliverables`, one lattice column apart.
    teamId = createTable(gd, {
      sheetId,
      at: { col: 1 + SAMPLE_DELIVERABLES_COLUMNS.length + 1, row: 1 },
      columns: SAMPLE_TEAM_COLUMNS.length,
      rows: SAMPLE_TEAM.length + 1,
      title: SAMPLE_TEAM_TITLE,
    });
    const tCols = labelColumns(gd, teamId, SAMPLE_TEAM_COLUMNS);
    const [nameCol, , capacityCol] = tCols;
    if (nameCol === undefined || capacityCol === undefined) {
      throw new RangeError('sample: Team columns were not created');
    }
    setColumnFormat(gd, teamId, capacityCol, 'number', { decimals: 0 });
    const tRows = tableById(gd, teamId)?.rows ?? [];
    SAMPLE_TEAM.forEach((values, r) => {
      const rowId = tRows[r];
      if (rowId === undefined) return;
      values.forEach((text, c) => {
        const colId = tCols[c];
        if (colId !== undefined) setCellText(gd, teamId, rowId, colId, text);
      });
    });
    const totalRow = tRows[SAMPLE_TEAM.length];
    const firstRow = tRows[0];
    const lastRow = tRows[SAMPLE_TEAM.length - 1];
    const teamTable = gd.tables.get(teamId);
    if (totalRow !== undefined && firstRow !== undefined && lastRow !== undefined && teamTable) {
      setCellText(gd, teamId, totalRow, nameCol, SAMPLE_TEAM_TOTAL_LABEL);
      const from = cellAddress(teamTable, firstRow, capacityCol);
      const to = cellAddress(teamTable, lastRow, capacityCol);
      if (from !== null && to !== null) {
        // Bound to the two corner cells at commit, so the range follows the rows (FX-05).
        commitCellText(gd, teamId, totalRow, capacityCol, `=Sum(${from}:${to})`);
      }
    }

    // The worked cross-table reference: bound to Priya's Role cell by id (REF-01).
    const firstDeliverable = dRows[0];
    if (firstDeliverable !== undefined) {
      commitCellText(gd, deliverablesId, firstDeliverable, roleCol, SAMPLE_REFERENCE_FORMULA);
    }
  }, SEED_ORIGIN);
  return { sheetId, deliverablesId, teamId };
}

/** The seeded sample as one Yjs update — what the service stores as snapshot seq 1. */
export function encodeSampleWorkscape(options: Omit<SeedOptions, 'title'> = {}): Uint8Array {
  const doc = new Y.Doc({ gc: true });
  try {
    seedSampleWorkscape(doc, options);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
