import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import {
  bindGraphPair,
  cellAddress,
  commitCellText,
  createGraphPair,
  createShapedTableWithGraph,
  listSheets,
  openDocument,
  removeGraphPair,
  seedSampleWorkscape,
  setCellText,
  setGraphDimensions,
  tableById,
  tableMap,
  tablesOnSheet,
  toggleGraphDimension,
  type GedeDoc,
} from '@gede/core';

import {
  autoStartTour,
  dismissTourDone,
  reportTourInvite,
  resetTourForTests,
  setTourDocument,
  setTourFindQuery,
  setTourPointing,
  setTourRoute,
  setTourSampleDocumentId,
  skipTour,
  startTour,
  subscribeTour,
  tourEnded,
  tourState,
} from './store.js';

/** The worked example step 2b shows (`tour.step2.concat.body`). */
const CONCAT_EXAMPLE = '=Concat(C5, " — ", @Team.Priya.Role)';

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
    reference(gd, '=@Team.Marcus.Role');
    commitCellText(
      gd,
      c.deliverables.id,
      c.deliverables.row,
      c.deliverables.daysCol,
      CONCAT_EXAMPLE,
    );
  }
  if (step >= 4) bindAndChoose(gd);
  if (step >= 5) setTourFindQuery(true, 'Blocked');
  expect(tourState()).toMatchObject({ phase: 'running', step });
  return gd;
}

/** Commit `text` into Deliverables row 2's Owner role cell (the cross-table reference cell). */
function reference(gd: GedeDoc, text: string): void {
  const c = cells(gd);
  commitCellText(gd, c.deliverables.id, c.deliverables.row, c.deliverables.roleCol, text);
}

/** Commit `text` into Deliverables row 2's Days cell (where the Concat goes). */
function days(gd: GedeDoc, text: string): void {
  const c = cells(gd);
  commitCellText(gd, c.deliverables.id, c.deliverables.row, c.deliverables.daysCol, text);
}

/** Step 3 done the direct way: a pair bound to Deliverables, then one dimension unticked (3 → 2). */
function bindAndChoose(gd: GedeDoc): void {
  const d = cells(gd).deliverables;
  const pair = createGraphPair(gd, { sheetId: listSheets(gd)[0]!.id, tableId: d.id });
  toggleGraphDimension(gd, pair.pairId, tableById(gd, d.id)!.columns[0]!.id, false);
}

/** `gd` as another replica sees it, and a way to merge that replica's edits back. */
function replica(gd: GedeDoc): { rgd: GedeDoc; merge: () => void } {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(gd.doc));
  return {
    rgd: openDocument(other),
    merge: () => {
      Y.applyUpdate(gd.doc, Y.encodeStateAsUpdate(other), 'other');
    },
  };
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
    reference(gd, '=@Team.Marcus.Role');
    // The reference alone moves step 2 to its second card, not to step 3.
    expect(tourState()).toMatchObject({ step: 2, substep: 'concat' });
    days(gd, CONCAT_EXAMPLE);
    const after = tourState();
    expect(after).toMatchObject({ step: 3, substep: 'add' });
    expect(after.phase === 'running' && after.baseline.graphs?.size).toBe(0);
  });

  test('ONB-05 FX-01 step 2b advances on a committed Concat over two or more operands with a bound reference, written since 2b began; one operand or literals only do not count; `concat` is `Concat`', () => {
    // #159 item 11d: a formula that satisfies both cards advances only the current one —
    // 2a takes it, and 2b (baselined as its card shows) waits for a second formula.
    let gd = openSampleAt(2);
    days(gd, '=Concat(C5, " — ", @Team.Priya.Role)');
    let state = tourState();
    expect(state).toMatchObject({ step: 2, substep: 'concat' });
    expect(state.phase === 'running' && state.baseline.concats?.size).toBe(1);
    reference(gd, '=Concat(@Team.Priya.Name, ": ", @Team.Priya.Role)');
    expect(tourState()).toMatchObject({ step: 3 });

    resetTourForTests();
    gd = openSampleAt(2);
    state = tourState();
    expect(state).toMatchObject({ step: 2, substep: 'reference' });
    // 2b's baseline is not taken until its card shows.
    expect(state.phase === 'running' && state.baseline.concats).toBeNull();
    reference(gd, '=@Team.Marcus.Role');
    expect(tourState()).toMatchObject({ step: 2, substep: 'concat' });
    days(gd, '=Concat(C5)');
    expect(tourState()).toMatchObject({ step: 2, substep: 'concat' });
    days(gd, '=Concat("a", "b")');
    expect(tourState()).toMatchObject({ step: 2, substep: 'concat' });
    days(gd, '=Sum(F5, F6)');
    expect(tourState()).toMatchObject({ step: 2, substep: 'concat' });
    // Clearing the reference returns to 2a: the sub-state is derived, never a cursor.
    reference(gd, '');
    expect(tourState()).toMatchObject({ step: 2, substep: 'reference' });
    reference(gd, '=@Team.Marcus.Role');
    // The parser's name map: `concat` is `Concat`; an entity path alone is a bound operand.
    days(gd, '=concat(@Team.Priya.Role, "x")');
    expect(tourState()).toMatchObject({ step: 3 });
  });

  test('ONB-05 FX-01 a Concat that arrives from another replica counts (as ADR 35 rules)', () => {
    const gd = openSampleAt(2);
    reference(gd, '=@Team.Marcus.Role');
    expect(tourState()).toMatchObject({ step: 2, substep: 'concat' });
    const { rgd, merge } = replica(gd);
    days(rgd, CONCAT_EXAMPLE);
    merge();
    expect(tourState()).toMatchObject({ step: 3 });
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
    expect(tourState()).toMatchObject({ step: 2, substep: 'concat' });

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
    expect(tourState()).toMatchObject({ step: 2, substep: 'concat' });
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

  test('ONB-05 GRAPH-03 GRAPH-05 step 3 is a sub-flow: `add` → `point` while pointing → `dimensions` once the pair is bound → step 4 when the dimensions change to two or more', () => {
    const gd = openSampleAt(3);
    expect(tourState()).toMatchObject({ step: 3, substep: 'add', pairIds: [] });
    setTourPointing(true);
    expect(tourState()).toMatchObject({ step: 3, substep: 'point' });
    const d = cells(gd).deliverables;
    const pair = createGraphPair(gd, { sheetId: listSheets(gd)[0]!.id, tableId: d.id });
    setTourPointing(false);
    // Bound: the dimensions card, with the pair the person made and its three default dimensions.
    const bound = tourState();
    expect(bound).toMatchObject({ step: 3, substep: 'dimensions', pairIds: [pair.pairId] });
    const cols = tableById(gd, d.id)!.columns.map((c) => c.id);
    expect(bound.phase === 'running' && bound.baseline.dimensions.get(pair.pairId)).toEqual({
      tableId: d.id,
      columns: new Set(cols.slice(0, 3)),
    });
    // Down to one dimension: changed, but fewer than two — not done.
    setGraphDimensions(gd, pair.pairId, [cols[2]!]);
    expect(tourState()).toMatchObject({ step: 3, substep: 'dimensions' });
    // Back to the defaults: two or more, but the set the card began with — not done.
    setGraphDimensions(gd, pair.pairId, cols.slice(0, 3));
    expect(tourState()).toMatchObject({ step: 3, substep: 'dimensions' });
    // A fourth dimension: changed and at least two.
    toggleGraphDimension(gd, pair.pairId, cols[3]!, true);
    expect(tourState()).toMatchObject({ step: 4, substep: null, pairIds: [] });
  });

  test('ONB-05 GRAPH-03 Escape in pointing mode returns to `add`, not to Skip; a pair removed during `dimensions` returns to `add` too', () => {
    const gd = openSampleAt(3);
    setTourPointing(true);
    expect(tourState()).toMatchObject({ substep: 'point' });
    setTourPointing(false);
    expect(tourState()).toMatchObject({ phase: 'running', step: 3, substep: 'add' });
    const sheetId = listSheets(gd)[0]!.id;
    const pair = createGraphPair(gd, { sheetId, tableId: cells(gd).deliverables.id });
    expect(tourState()).toMatchObject({ substep: 'dimensions', pairIds: [pair.pairId] });
    removeGraphPair(gd, pair.pairId);
    expect(tourState()).toMatchObject({ phase: 'running', step: 3, substep: 'add', pairIds: [] });
    // The next pair takes a fresh dimensions baseline.
    const again = createGraphPair(gd, { sheetId, tableId: cells(gd).team.id });
    const next = tourState();
    expect(next).toMatchObject({ substep: 'dimensions', pairIds: [again.pairId] });
    expect(next.phase === 'running' && next.baseline.dimensions.has(again.pairId)).toBe(true);
  });

  test('ONB-05 GRAPH-03 GRAPH-05 an unbound pair never advances; Re-point shows `point` again and, bound to another table, resets the dimensions baseline so the defaults do not count', () => {
    const gd = openSampleAt(3);
    const sheetId = listSheets(gd)[0]!.id;
    const c = cells(gd);
    // An unbound pair (pointing mode's own, or one whose table was deleted) is not the action.
    const unbound = createGraphPair(gd, { sheetId, tableId: null });
    expect(tourState()).toMatchObject({ step: 3, substep: 'add', pairIds: [] });
    expect(bindGraphPair(gd, unbound.pairId, c.deliverables.id)).toBe(true);
    expect(tourState()).toMatchObject({ substep: 'dimensions', pairIds: [unbound.pairId] });
    // Re-point: pointing mode on, the card goes back to `point` while the pair stays bound.
    setTourPointing(true);
    expect(tourState()).toMatchObject({ substep: 'point', pairIds: [] });
    // Escape: back to the dimensions of the same binding, baseline kept.
    setTourPointing(false);
    let state = tourState();
    expect(state).toMatchObject({ substep: 'dimensions', pairIds: [unbound.pairId] });
    expect(
      state.phase === 'running' && state.baseline.dimensions.get(unbound.pairId)?.tableId,
    ).toBe(c.deliverables.id);
    // Re-pointed at Team: its default three dimensions are a new baseline, not a change.
    setTourPointing(true);
    expect(bindGraphPair(gd, unbound.pairId, c.team.id)).toBe(true);
    setTourPointing(false);
    state = tourState();
    expect(state).toMatchObject({ step: 3, substep: 'dimensions', pairIds: [unbound.pairId] });
    expect(
      state.phase === 'running' && state.baseline.dimensions.get(unbound.pairId)?.tableId,
    ).toBe(c.team.id);
    const teamCols = tableById(gd, c.team.id)!.columns.map((x) => x.id);
    toggleGraphDimension(gd, unbound.pairId, teamCols[0]!, false);
    expect(tourState()).toMatchObject({ step: 4 });
  });

  test('ONB-05 GRAPH-01 GRAPH-04 "Graph this table" and "Add shaped table" bind at once and skip `point`; a pair present when the step began never counts', () => {
    // Graph this table: bound directly.
    let gd = openSampleAt(3);
    const direct = createGraphPair(gd, {
      sheetId: listSheets(gd)[0]!.id,
      tableId: cells(gd).deliverables.id,
    });
    expect(tourState()).toMatchObject({ substep: 'dimensions', pairIds: [direct.pairId] });

    // Add shaped table, from pointing mode: bound to the new table in one step.
    resetTourForTests();
    gd = openSampleAt(3);
    setTourPointing(true);
    const shaped = createShapedTableWithGraph(gd, {
      sheetId: listSheets(gd)[0]!.id,
      at: { col: 1, row: 30 },
    });
    setTourPointing(false);
    expect(tourState()).toMatchObject({ substep: 'dimensions', pairIds: [shaped.pairId] });
    const first = tableById(gd, shaped.tableId)!.columns[0]!.id;
    expect(toggleGraphDimension(gd, shaped.pairId, first, false)).toHaveLength(2);
    expect(tourState()).toMatchObject({ step: 4 });

    // A pair present when the step began is the baseline, not the action.
    resetTourForTests();
    startTour();
    setTourSampleDocumentId(SAMPLE_ID);
    const pre = sample();
    createGraphPair(pre, { sheetId: listSheets(pre)[0]!.id, tableId: cells(pre).deliverables.id });
    setTourDocument(pre);
    setTourRoute(`/d/${SAMPLE_ID}`);
    reference(pre, '=@Team.Marcus.Role');
    days(pre, CONCAT_EXAMPLE);
    expect(tourState()).toMatchObject({ step: 3, substep: 'add', pairIds: [] });
  });

  test("ONB-05 GRAPH-05 a collaborator's pair arriving mid-step is tracked beside the person's own, never instead of it: the person's change completes the step, and so would the collaborator's (review of #160, D2)", () => {
    const gd = openSampleAt(3);
    const sheetId = listSheets(gd)[0]!.id;
    const c = cells(gd);
    // A collaborator binds a pair on Team while the person is still on `add`.
    const { rgd, merge } = replica(gd);
    const theirs = createGraphPair(rgd, { sheetId, tableId: cells(rgd).team.id });
    merge();
    expect(tourState()).toMatchObject({ substep: 'dimensions', pairIds: [theirs.pairId] });
    // The person adds their own on Deliverables: both are tracked, each with its own baseline.
    setTourPointing(true);
    const mine = createGraphPair(gd, { sheetId, tableId: c.deliverables.id });
    setTourPointing(false);
    const state = tourState();
    expect(state).toMatchObject({ substep: 'dimensions' });
    expect(state.phase === 'running' && [...state.pairIds].sort()).toEqual(
      [theirs.pairId, mine.pairId].sort(),
    );
    expect(state.phase === 'running' && state.baseline.dimensions.get(mine.pairId)?.tableId).toBe(
      c.deliverables.id,
    );
    expect(state.phase === 'running' && state.baseline.dimensions.get(theirs.pairId)?.tableId).toBe(
      c.team.id,
    );
    // The person unticks one of their own dimensions: done — the collaborator's pair untouched.
    toggleGraphDimension(gd, mine.pairId, tableById(gd, c.deliverables.id)!.columns[0]!.id, false);
    expect(tourState()).toMatchObject({ step: 4 });

    // And the other way round: the collaborator's change on their pair counts too (ADR 35).
    resetTourForTests();
    const again = openSampleAt(3);
    const other = replica(again);
    const pair = createGraphPair(other.rgd, {
      sheetId: listSheets(other.rgd)[0]!.id,
      tableId: cells(other.rgd).team.id,
    });
    other.merge();
    createGraphPair(again, {
      sheetId: listSheets(again)[0]!.id,
      tableId: cells(again).deliverables.id,
    });
    expect(tourState()).toMatchObject({ step: 3, substep: 'dimensions' });
    toggleGraphDimension(
      other.rgd,
      pair.pairId,
      tableById(other.rgd, cells(other.rgd).team.id)!.columns[0]!.id,
      false,
    );
    other.merge();
    expect(tourState()).toMatchObject({ step: 4 });
  });

  test('ONB-05 GRAPH-05 a pair bound and re-dimensioned from another replica counts (as ADR 35 rules)', () => {
    const gd = openSampleAt(3);
    const { rgd, merge } = replica(gd);
    const d = cells(rgd).deliverables;
    const pair = createGraphPair(rgd, { sheetId: listSheets(rgd)[0]!.id, tableId: d.id });
    merge();
    expect(tourState()).toMatchObject({ substep: 'dimensions', pairIds: [pair.pairId] });
    toggleGraphDimension(rgd, pair.pairId, tableById(rgd, d.id)!.columns[0]!.id, false);
    merge();
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
      seen.push(s.phase === 'running' ? `running:${String(s.step)}:${s.substep ?? '-'}` : s.phase);
    });
    startTour();
    setTourRoute('/');
    setTourRoute('/');
    setTourSampleDocumentId(SAMPLE_ID);
    setTourRoute(`/d/${SAMPLE_ID}`);
    setTourPointing(true); // Pointing mode outside step 3 changes nothing.
    stop();
    skipTour();
    expect(seen).toEqual(['running:1:-', 'running:2:reference']);
  });
});
