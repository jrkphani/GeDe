import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  cellAddress,
  commitCellText,
  createGraphPair,
  listSheets,
  openDocument,
  seedSampleWorkscape,
  setCellText,
  tableById,
  tableMap,
  tablesOnSheet,
  type GedeDoc,
} from '@gede/core';

import {
  autoStartTour,
  dismissTourDone,
  reportTourInvite,
  resetTourForTests,
  setTourDocument,
  setTourFindQuery,
  setTourRoute,
  setTourSampleDocumentId,
  skipTour,
  startTour,
  subscribeTour,
  tourEnded,
  tourState,
} from './store.js';

const SAMPLE_ID = '9a1a0d7e-0000-4000-8000-000000000001';

function sample(): GedeDoc {
  const doc = new Y.Doc();
  seedSampleWorkscape(doc);
  return openDocument(doc);
}

/** The sample's two tables and an empty cell in each, as a person would find them. */
function cells(gd: GedeDoc) {
  const [deliverables, team] = tablesOnSheet(gd, listSheets(gd)[0]!.id);
  const d = tableById(gd, deliverables!.id)!;
  const t = tableById(gd, team!.id)!;
  return {
    deliverables: {
      id: d.id,
      row: d.rows[1]!,
      roleCol: d.columns[5]!.id,
      daysCol: d.columns[4]!.id,
    },
    team: { id: t.id, row: t.rows[0]!, nameCol: t.columns[0]!.id },
  };
}

/** Drive the tour to `step` with the sample open, as the journey does. */
function openSampleAt(step: 2 | 3 | 4 | 5): GedeDoc {
  startTour();
  setTourSampleDocumentId(SAMPLE_ID);
  const gd = sample();
  setTourDocument(gd);
  setTourRoute(`/d/${SAMPLE_ID}`);
  if (step >= 3) {
    const c = cells(gd);
    commitCellText(
      gd,
      c.deliverables.id,
      c.deliverables.row,
      c.deliverables.roleCol,
      '=@Team.Marcus.Role',
    );
  }
  if (step >= 4)
    createGraphPair(gd, { sheetId: listSheets(gd)[0]!.id, tableId: cells(gd).deliverables.id });
  if (step >= 5) setTourFindQuery(true, 'Blocked');
  expect(tourState()).toMatchObject({ phase: 'running', step });
  return gd;
}

afterEach(() => {
  resetTourForTests();
});

describe('tour store', () => {
  test('ONB-02 autoStart runs once per account while idle; a second arrival or another idle check does not restart it', () => {
    expect(tourState()).toEqual({ phase: 'idle' });
    expect(autoStartTour('acct-1')).toBe(true);
    expect(tourState()).toMatchObject({ phase: 'running', step: 1 });
    expect(autoStartTour('acct-1')).toBe(false);
    skipTour();
    tourEnded('skipped');
    expect(tourState()).toEqual({ phase: 'idle' });
    expect(autoStartTour('acct-1')).toBe(false);
    // Another account in the same page life (sign out, sign in) gets its own start.
    expect(autoStartTour('acct-2')).toBe(true);
  });

  test('ONB-05 step 1 advances only when the route is the sample document, not any document', () => {
    startTour();
    setTourSampleDocumentId(SAMPLE_ID);
    setTourRoute('/d/some-other-document');
    expect(tourState()).toMatchObject({ step: 1 });
    setTourRoute(`/d/${SAMPLE_ID}`);
    expect(tourState()).toMatchObject({ step: 2 });
  });

  test('ONB-05 ONB-06 step 2 advances on one more committed cross-table formula than the sample shipped with; same-table formulas and plain text do not count', () => {
    const gd = openSampleAt(2);
    const c = cells(gd);
    // The seeded =@Team.Priya.Role is the baseline: opening the sample does not advance.
    expect(tourState()).toMatchObject({ step: 2 });
    const state = tourState();
    expect(state.phase === 'running' && state.baseline.crossReferences?.size).toBe(1);
    setCellText(gd, c.deliverables.id, c.deliverables.row, c.deliverables.roleCol, 'plain text');
    // A formula over the table's own cells (Days of two deliverables) stays inside it.
    const map = tableMap(gd, c.deliverables.id)!;
    const d = tableById(gd, c.deliverables.id)!;
    const from = cellAddress(map, d.rows[2]!, c.deliverables.daysCol)!;
    const to = cellAddress(map, d.rows[3]!, c.deliverables.daysCol)!;
    commitCellText(
      gd,
      c.deliverables.id,
      c.deliverables.row,
      c.deliverables.daysCol,
      `=Sum(${from}:${to})`,
    );
    expect(tourState()).toMatchObject({ step: 2 });
    commitCellText(
      gd,
      c.deliverables.id,
      c.deliverables.row,
      c.deliverables.roleCol,
      '=@Team.Marcus.Role',
    );
    expect(tourState()).toMatchObject({ step: 3, baseline: { graphs: 0 } });
  });

  test('ONB-05 step 2 advances when the seeded reference is overwritten with another, or cleared and written elsewhere — the set changed, not the count', () => {
    let gd = openSampleAt(2);
    let c = cells(gd);
    const d = tableById(gd, c.deliverables.id)!;
    // Overwrite the sample's own =@Team.Priya.Role (row 1) with a different reference.
    commitCellText(
      gd,
      c.deliverables.id,
      d.rows[0]!,
      c.deliverables.roleCol,
      '=@Team.Priya.Capacity',
    );
    expect(tourState()).toMatchObject({ step: 2 });
    // Same cell again is not a new key; moving it is.
    setCellText(gd, c.deliverables.id, d.rows[0]!, c.deliverables.roleCol, '');
    expect(tourState()).toMatchObject({ step: 2 });
    commitCellText(gd, c.deliverables.id, d.rows[1]!, c.deliverables.roleCol, '=@Team.Priya.Role');
    expect(tourState()).toMatchObject({ step: 3 });

    resetTourForTests();
    gd = openSampleAt(2);
    c = cells(gd);
    // A remote transaction counts too: the document the card points at gained a reference.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(gd.doc));
    const rgd = openDocument(remote);
    const rc = cells(rgd);
    commitCellText(
      rgd,
      rc.deliverables.id,
      rc.deliverables.row,
      rc.deliverables.roleCol,
      '=@Team.Marcus.Role',
    );
    Y.applyUpdate(gd.doc, Y.encodeStateAsUpdate(remote), 'remote');
    expect(tourState()).toMatchObject({ step: 3 });
  });

  test('ONB-05 step 2 takes its baseline when the document arrives, so the tour can start before the room loads', () => {
    startTour();
    setTourSampleDocumentId(SAMPLE_ID);
    setTourRoute(`/d/${SAMPLE_ID}`);
    expect(tourState()).toMatchObject({ step: 2, baseline: { crossReferences: null } });
    const gd = sample();
    setTourDocument(gd);
    const state = tourState();
    expect(state.phase === 'running' && state.baseline.crossReferences?.size).toBe(1);
    setTourDocument(null);
    expect(tourState()).toMatchObject({ step: 2 });
  });

  test('ONB-05 step 3 advances when a graph object appears in the document (a pair counts once as more than before)', () => {
    const gd = openSampleAt(3);
    createGraphPair(gd, { sheetId: listSheets(gd)[0]!.id, tableId: cells(gd).deliverables.id });
    expect(tourState()).toMatchObject({ step: 4 });
  });

  test('ONB-05 step 4 advances on Find open with a non-empty query; open with blanks does not', () => {
    openSampleAt(4);
    setTourFindQuery(true, '   ');
    expect(tourState()).toMatchObject({ step: 4 });
    setTourFindQuery(false, 'Blocked');
    expect(tourState()).toMatchObject({ step: 4 });
    setTourFindQuery(true, 'Blocked');
    expect(tourState()).toMatchObject({ step: 5 });
  });

  test('ONB-05 ONB-14 step 5 completes on the invitation event; the event is ignored at any other step', () => {
    startTour();
    reportTourInvite();
    expect(tourState()).toMatchObject({ phase: 'running', step: 1 });
    resetTourForTests();
    openSampleAt(5);
    reportTourInvite();
    expect(tourState()).toEqual({ phase: 'ending', reason: 'completed' });
    tourEnded('completed');
    expect(tourState()).toEqual({ phase: 'done' });
    dismissTourDone();
    expect(tourState()).toEqual({ phase: 'idle' });
  });

  test('ONB-07 Skip ends the tour from any step for good; ONB-08 start restarts at step 1', () => {
    openSampleAt(4);
    skipTour();
    expect(tourState()).toEqual({ phase: 'ending', reason: 'skipped' });
    tourEnded('skipped');
    expect(tourState()).toEqual({ phase: 'idle' });
    setTourRoute('/');
    startTour();
    expect(tourState()).toMatchObject({ phase: 'running', step: 1 });
    // Replay while already running restarts at step 1 too — and when the sample
    // is the open route, step 1 is satisfied at once.
    setTourRoute(`/d/${SAMPLE_ID}`);
    expect(tourState()).toMatchObject({ step: 2 });
    setTourFindQuery(true, 'x');
    startTour();
    expect(tourState()).toMatchObject({ step: 2 });
  });

  test('ONB-05 subscribers are told of every transition and nothing else', () => {
    const seen: string[] = [];
    const stop = subscribeTour(() => {
      const s = tourState();
      seen.push(s.phase === 'running' ? `running:${String(s.step)}` : s.phase);
    });
    startTour();
    setTourRoute('/');
    setTourRoute('/');
    setTourSampleDocumentId(SAMPLE_ID);
    setTourRoute(`/d/${SAMPLE_ID}`);
    stop();
    skipTour();
    expect(seen).toEqual(['running:1', 'running:2']);
  });
});
