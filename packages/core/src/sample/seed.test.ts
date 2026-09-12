import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import {
  cellText,
  documentMeta,
  listSheets,
  openDocument,
  tableById,
  tableMap,
  tablesOnSheet,
} from '../doc/index.js';
import {
  FormulaEngine,
  observeWorkbook,
  projectCellText,
  type CellResult,
} from '../engine/index.js';
import { defaultDimensions } from '../graph/mutations.js';
import { cellKey } from '../ids.js';
import { crossTableReferenceCount, isCrossTableFormula } from '../ref/cross-table.js';
import {
  encodeSampleWorkscape,
  SAMPLE_DELIVERABLES,
  SAMPLE_DELIVERABLES_COLUMNS,
  SAMPLE_DELIVERABLES_TITLE,
  SAMPLE_TEAM,
  SAMPLE_TEAM_COLUMNS,
  SAMPLE_TEAM_TITLE,
  SAMPLE_TEAM_TOTAL_LABEL,
  SAMPLE_TITLE,
  seedSampleWorkscape,
} from './seed.js';

function decoded(): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeSampleWorkscape({ createdAt: '2026-09-13T00:00:00.000Z' }));
  return doc;
}

function evaluate(doc: Y.Doc): Map<string, CellResult> {
  const gd = openDocument(doc);
  const engine = new FormulaEngine();
  const results = new Map<string, CellResult>();
  const stop = observeWorkbook(gd, (changes) => {
    const out = engine.apply(changes);
    for (const r of out.results) results.set(r.cellId, r);
  });
  stop();
  return results;
}

describe('seedSampleWorkscape', () => {
  test('ONB-01 the sample carries the title, two tables, the columns and rows the tour refers to', () => {
    const doc = decoded();
    const gd = openDocument(doc);
    expect(documentMeta(gd)).toEqual({
      title: SAMPLE_TITLE,
      createdAt: '2026-09-13T00:00:00.000Z',
    });
    const sheets = listSheets(gd);
    expect(sheets).toHaveLength(1);
    const tables = tablesOnSheet(gd, sheets[0]!.id);
    expect(tables.map((t) => t.title)).toEqual([SAMPLE_DELIVERABLES_TITLE, SAMPLE_TEAM_TITLE]);
    const [deliverables, team] = tables;
    expect(deliverables!.columns.map((c) => c.label)).toEqual([...SAMPLE_DELIVERABLES_COLUMNS]);
    expect(team!.columns.map((c) => c.label)).toEqual([...SAMPLE_TEAM_COLUMNS]);
    expect(deliverables!.rows).toHaveLength(SAMPLE_DELIVERABLES.length);
    expect(team!.rows).toHaveLength(SAMPLE_TEAM.length + 1);
    // The tables do not overlap: Team starts past Deliverables' last column.
    expect(team!.gridCol).toBeGreaterThan(deliverables!.gridCol + deliverables!.columns.length);
  });

  test('ONB-01 an Owner column and Blocked statuses exist for the Find step (col:Owner, is:blocked)', () => {
    const gd = openDocument(decoded());
    const table = tablesOnSheet(gd, listSheets(gd)[0]!.id)[0]!;
    const map = tableMap(gd, table.id)!;
    const owner = table.columns.find((c) => c.label === 'Owner')!;
    const status = table.columns.find((c) => c.label === 'Status')!;
    const owners = table.rows.map((r) => cellText(map, r, owner.id));
    const statuses = table.rows.map((r) => cellText(map, r, status.id));
    expect(new Set(owners)).toEqual(new Set(SAMPLE_TEAM.map(([name]) => name)));
    expect(statuses.filter((s) => s === 'Blocked').length).toBeGreaterThanOrEqual(2);
  });

  test('ONB-01 FMT-01 Due is a date column and Days a number column, with dates in every row', () => {
    const gd = openDocument(decoded());
    const table = tablesOnSheet(gd, listSheets(gd)[0]!.id)[0]!;
    const map = tableMap(gd, table.id)!;
    const due = table.columns.find((c) => c.label === 'Due')!;
    const days = table.columns.find((c) => c.label === 'Days')!;
    expect(due.format).toBe('date');
    expect(days.format).toBe('number');
    for (const row of table.rows) {
      expect(cellText(map, row, due.id)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(cellText(map, row, days.id)).toMatch(/^\d+$/);
    }
  });

  test('ONB-01 FX-05 the Team total is an id-bound Sum over the capacity rows and evaluates', () => {
    const doc = decoded();
    const gd = openDocument(doc);
    const team = tablesOnSheet(gd, listSheets(gd)[0]!.id)[1]!;
    const map = tableMap(gd, team.id)!;
    const name = team.columns[0]!;
    const capacity = team.columns.find((c) => c.label === 'Capacity')!;
    const total = team.rows[team.rows.length - 1]!;
    expect(cellText(map, total, name.id)).toBe(SAMPLE_TEAM_TOTAL_LABEL);
    const stored = cellText(map, total, capacity.id);
    expect(stored).toMatch(/^=Sum\(\{r:[0-9A-Z]{26}:/);
    expect(projectCellText(gd, stored)).toMatch(/^=Sum\([A-Z]+\d+:[A-Z]+\d+\)$/);
    const results = evaluate(doc);
    const result = results.get(`${team.id}/${cellKey(total, capacity.id)}`);
    expect(result?.value).toEqual(
      expect.objectContaining({
        kind: 'number',
        value: SAMPLE_TEAM.reduce((sum, [, , days]) => sum + Number(days), 0),
      }),
    );
  });

  test('ONB-01 REF-01 the worked cross-table reference is bound to Priya’s Role cell by id and evaluates', () => {
    const doc = decoded();
    const gd = openDocument(doc);
    const [deliverables, team] = tablesOnSheet(gd, listSheets(gd)[0]!.id);
    const map = tableMap(gd, deliverables!.id)!;
    const role = deliverables!.columns.find((c) => c.label === 'Owner role')!;
    const stored = cellText(map, deliverables!.rows[0]!, role.id);
    expect(stored).toMatch(new RegExp(`^=\\{e:${team!.id}:[0-9A-Z]{26}:[0-9A-Z]{26}\\}$`));
    expect(isCrossTableFormula(stored, deliverables!.id)).toBe(true);
    expect(projectCellText(gd, stored)).toBe('=@Team.Priya.Role');
    expect(crossTableReferenceCount(gd)).toBe(1);
    const results = evaluate(doc);
    const result = results.get(`${deliverables!.id}/${cellKey(deliverables!.rows[0]!, role.id)}`);
    expect(result?.error).toBeNull();
    expect(result?.value).toEqual(
      expect.objectContaining({ kind: 'text', text: 'Product engineer' }),
    );
  });

  test('ONB-01 GRAPH-05 Deliverables offers at least two entered columns as graph dimensions', () => {
    const gd = openDocument(decoded());
    const deliverables = tablesOnSheet(gd, listSheets(gd)[0]!.id)[0]!;
    expect(defaultDimensions(deliverables).length).toBeGreaterThanOrEqual(2);
    expect(gd.graphs.size).toBe(0);
  });

  test('ONB-01 seeding is idempotent: a document that already has a sheet is left alone', () => {
    const doc = decoded();
    const before = Y.encodeStateAsUpdate(doc);
    const result = seedSampleWorkscape(doc);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const gd = openDocument(doc);
    expect(tableById(gd, result.deliverablesId)?.title).toBe(SAMPLE_DELIVERABLES_TITLE);
    expect(tableById(gd, result.teamId)?.title).toBe(SAMPLE_TEAM_TITLE);
  });
});
