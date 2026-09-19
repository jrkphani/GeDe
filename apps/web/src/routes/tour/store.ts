/**
 * Tour state (ONB-02..08, ONB-13). One module store for the whole app, read
 * with `useSyncExternalStore`: the tour outlives route changes (step 1 is in
 * the library, steps 2–6 in the sample document), so it cannot live in a
 * route's React state.
 *
 * A step advances only when the document, the route or a feature says its
 * action happened (ONB-05); there is no Next. The inputs are:
 *
 *   - the route (`setTourRoute`), for step 1 (the sample is open);
 *   - the open Y.Doc (`setTourDocument`), for steps 2, 3 and 4 — the sets of
 *     cells holding a cross-table formula and a `=Concat()` (step 2), the
 *     sets of cells holding a set-operator formula and one that compares two
 *     sets (step 3, FX-09), the set of graph pairs and the dimensions of the
 *     pair the person made (step 4), compared with what was there when the
 *     step began, so what the sample ships with never advances it. Every
 *     transaction is observed, remote ones included: a collaborator writing
 *     a reference into the sample while the person is on step 2 advances
 *     it — the action happened in the document the card points at, and
 *     attributing transactions would put origin tracking in the tour for no
 *     product gain;
 *   - pointing mode (`setTourPointing`), for step 4's `point` sub-card;
 *   - Find's query (`setTourFindQuery`) for step 5 and the Share sheet's
 *     invitation (`reportTourInvite`) for step 6.
 *
 * Steps 2, 3 and 4 are sub-flows. Their sub-state is derived from the inputs
 * on every evaluation, never stored as a cursor: step 2 shows `reference`
 * until a new cross-table formula exists and `concat` after; step 3 shows
 * `pick-form` until a new set-operator formula exists and `set-result`
 * after; step 4 shows `point` while pointing mode is on, else `dimensions`
 * while a bound pair the step did not start with exists, else `add`. So
 * Escape in pointing mode returns to `add` by itself, a graph removed
 * returns to `add`, Re-point returns to `point`, and a set formula cleared
 * returns to `pick-form` — Skip stays the only exit (ONB-07).
 *
 * The store never talks to the server: `TourController` persists the flag
 * (`PATCH /api/me { tourDone }`) when the phase becomes `ending` and moves
 * it on with `tourEnded()`.
 */
import {
  concatFormulaKeys,
  crossTableReferenceKeys,
  graphRecord,
  graphsInPair,
  newCrossTableReference,
  SET_RESULT_FUNCTION_NAMES,
  setOperatorFormulaKeys,
  tableById,
  type GedeDoc,
  type Id,
} from '@gede/core';

import {
  GRAPH_STEP,
  REFERENCE_STEP,
  SET_STEP,
  TOUR_STEP_COUNT,
  tourStep,
  type TourSubstep,
} from './steps.js';

export type TourEndReason = 'skipped' | 'completed';

/** What was there when the step began, once the document was available; null until then. */
export interface TourBaseline {
  /** Workbook cell ids holding a cross-table formula (step 2a). */
  readonly crossReferences: ReadonlySet<string> | null;
  /**
   * Workbook cell ids holding a `=Concat()` over a bound reference, taken when
   * the `concat` card first shows (step 2b) — so the formula that satisfied 2a
   * is part of 2b's baseline and 2b waits for a second one (#159 item 11d).
   */
  readonly concats: ReadonlySet<string> | null;
  /** Workbook cell ids holding a set-operator formula (step 3a, FX-09). */
  readonly setCalls: ReadonlySet<string> | null;
  /**
   * Workbook cell ids holding an Inter, Diff, Comp or Cross, taken when the
   * `set-result` card first shows (step 3b) — so a Diff that satisfied 3a is
   * part of 3b's baseline and 3b waits for a second one (ADR-045, ADR-055).
   */
  readonly setResults: ReadonlySet<string> | null;
  /** Graph pair ids (step 4). */
  readonly graphs: ReadonlySet<Id> | null;
  /**
   * Per pair the step did not start with: the dimensions it had when its
   * binding first showed the `dimensions` card (step 4c); re-taken when its
   * table changes (Re-point binds another table and resets the dimensions).
   * Per pair, so a collaborator's pair arriving mid-step is tracked beside
   * the person's own, never instead of it (review of #160, D2).
   */
  readonly dimensions: ReadonlyMap<Id, PairBaseline>;
}

export interface PairBaseline {
  readonly tableId: Id;
  readonly columns: ReadonlySet<Id>;
}

export interface TourRunning {
  readonly phase: 'running';
  /** 1-based. */
  readonly step: number;
  /** The sub-flow's current card (steps 2, 3 and 4), null for the others. */
  readonly substep: TourSubstep | null;
  /** The bound pairs made since step 4 began, in creation order (the person's, and any collaborator's). */
  readonly pairIds: readonly Id[];
  readonly baseline: TourBaseline;
}

export type TourState =
  | { readonly phase: 'idle' }
  | TourRunning
  /** Skip or completion happened; the controller is persisting the flag. */
  | { readonly phase: 'ending'; readonly reason: TourEndReason }
  /** Completed and persisted; the confirmation is showing (ONB-14). */
  | { readonly phase: 'done' };

interface Inputs {
  pathname: string;
  sampleDocumentId: string | null;
  doc: GedeDoc | null;
  pointing: boolean;
  findOpen: boolean;
  findQuery: string;
}

/** GRAPH-05: the fewest dimensions a chosen set may hold for step 4 to complete. */
export const TOUR_MIN_DIMENSIONS = 2;

const IDLE: TourState = { phase: 'idle' };
const EMPTY_BASELINE: TourBaseline = {
  crossReferences: null,
  concats: null,
  setCalls: null,
  setResults: null,
  graphs: null,
  dimensions: new Map(),
};

let state: TourState = IDLE;
const inputs: Inputs = {
  pathname: '/',
  sampleDocumentId: null,
  doc: null,
  pointing: false,
  findOpen: false,
  findQuery: '',
};
const listeners = new Set<() => void>();
/** Accounts the tour auto-started for in this page's life (ONB-02: once per arrival). */
const autoStarted = new Set<string>();
let unobserveDoc: (() => void) | null = null;

function emit(): void {
  listeners.forEach((l) => {
    l();
  });
}

function set(next: TourState): void {
  if (next === state) return;
  state = next;
  emit();
}

export function subscribeTour(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function tourState(): TourState {
  return state;
}

// ---------------------------------------------------------------------------
// Detectors (ONB-05): pure reads over the inputs.
// ---------------------------------------------------------------------------

/** The ids of the document's graph pairs. */
export function graphPairIds(gd: GedeDoc): Set<Id> {
  const ids = new Set<Id>();
  gd.graphs.forEach((map) => {
    ids.add(graphRecord(map).pairId);
  });
  return ids;
}

/** A pair's binding and dimensions, read from its ring; null when the pair is gone. */
function pairDimensions(gd: GedeDoc, pairId: Id): { columns: Id[]; tableId: Id | null } | null {
  const lead = graphsInPair(gd, pairId)[0];
  if (lead === undefined) return null;
  const bound = lead.tableId !== null && tableById(gd, lead.tableId) !== null;
  return { columns: [...lead.dimensions], tableId: bound ? lead.tableId : null };
}

function sampleIsOpen(): boolean {
  const id = inputs.sampleDocumentId;
  return id !== null && inputs.pathname === `/d/${id}`;
}

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  if (a.size !== b.length) return false;
  for (const x of b) if (!a.has(x)) return false;
  return true;
}

/** A key in `current` that `baseline` did not have. */
function newKey(baseline: ReadonlySet<string> | null, current: ReadonlySet<string>): string | null {
  if (baseline === null) return null;
  for (const key of current) if (!baseline.has(key)) return key;
  return null;
}

/** The bound pairs the step did not start with, in creation order (ULIDs sort by time). */
function newBoundPairIds(running: TourRunning, gd: GedeDoc): Id[] {
  const baseline = running.baseline.graphs;
  if (baseline === null) return [];
  const out: Id[] = [];
  for (const pairId of graphPairIds(gd)) {
    if (!baseline.has(pairId) && pairDimensions(gd, pairId)?.tableId != null) out.push(pairId);
  }
  return out.sort();
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Step 2's sub-state: `concat` once a cross-table formula the step did not
 * start with exists.
 */
function referenceSubstep(running: TourRunning): TourSubstep {
  const gd = inputs.doc;
  if (gd === null || running.baseline.crossReferences === null) return 'reference';
  return newCrossTableReference(running.baseline.crossReferences, crossTableReferenceKeys(gd)) ===
    null
    ? 'reference'
    : 'concat';
}

/**
 * Step 3's sub-state: `set-result` once a set-operator formula the step did
 * not start with exists (FX-09, ADR-055).
 */
function setSubstep(running: TourRunning): TourSubstep {
  const gd = inputs.doc;
  if (gd === null || running.baseline.setCalls === null) return 'pick-form';
  return newKey(running.baseline.setCalls, setOperatorFormulaKeys(gd)) === null
    ? 'pick-form'
    : 'set-result';
}

/**
 * Step 4's sub-state: `point` while pointing mode is on (arming, or Re-point
 * from the Graph tab); else `dimensions` while a pair the step did not start
 * with exists and is bound ("Graph this table" and "Add shaped table" bind at
 * once, so they arrive here directly); else `add`.
 */
function graphSubstep(running: TourRunning): { substep: TourSubstep; pairIds: readonly Id[] } {
  if (inputs.pointing) return { substep: 'point', pairIds: NO_PAIRS };
  const gd = inputs.doc;
  const pairIds = gd === null ? NO_PAIRS : newBoundPairIds(running, gd);
  if (pairIds.length > 0) return { substep: 'dimensions', pairIds };
  return { substep: 'add', pairIds: NO_PAIRS };
}

const NO_PAIRS: readonly Id[] = [];

/** The sub-state the inputs imply for the running step. */
function deriveSubstep(running: TourRunning): {
  substep: TourSubstep | null;
  pairIds: readonly Id[];
} {
  if (running.step === REFERENCE_STEP) {
    return { substep: referenceSubstep(running), pairIds: NO_PAIRS };
  }
  if (running.step === SET_STEP) return { substep: setSubstep(running), pairIds: NO_PAIRS };
  if (running.step === GRAPH_STEP) return graphSubstep(running);
  return { substep: null, pairIds: NO_PAIRS };
}

/** Take whichever baselines the step needs and does not have yet. */
function withBaseline(running: TourRunning): TourRunning {
  const gd = inputs.doc;
  if (gd === null) return running;
  const { advance } = tourStep(running.step);
  const { baseline } = running;
  if (advance.kind === 'cross-table-reference') {
    let next = running;
    if (baseline.crossReferences === null) {
      next = { ...next, baseline: { ...baseline, crossReferences: crossTableReferenceKeys(gd) } };
    }
    // 2b's baseline is taken as its card first shows, after 2a's formula exists.
    if (next.baseline.concats === null && referenceSubstep(next) === 'concat') {
      next = { ...next, baseline: { ...next.baseline, concats: concatFormulaKeys(gd) } };
    }
    return next;
  }
  if (advance.kind === 'set-formula') {
    let next = running;
    if (baseline.setCalls === null) {
      next = { ...next, baseline: { ...baseline, setCalls: setOperatorFormulaKeys(gd) } };
    }
    // 3b's baseline is taken as its card first shows, after 3a's formula exists — keyed to
    // what it measures: the four operators that compare two sets, Union left out.
    if (next.baseline.setResults === null && setSubstep(next) === 'set-result') {
      next = {
        ...next,
        baseline: {
          ...next.baseline,
          setResults: setOperatorFormulaKeys(gd, SET_RESULT_FUNCTION_NAMES),
        },
      };
    }
    return next;
  }
  if (advance.kind === 'graph-added') {
    let next = running;
    if (baseline.graphs === null) {
      next = { ...next, baseline: { ...next.baseline, graphs: graphPairIds(gd) } };
    }
    // The dimensions baseline is per binding: taken for each new pair as it first shows
    // the `dimensions` card, re-taken if a pair is re-pointed at another table (which
    // resets its dimensions). A pair that goes keeps its entry, harmlessly.
    let dimensions: Map<Id, PairBaseline> | null = null;
    for (const pairId of graphSubstep(next).pairIds) {
      const dims = pairDimensions(gd, pairId);
      const current = next.baseline.dimensions.get(pairId);
      if (dims?.tableId == null || current?.tableId === dims.tableId) continue;
      dimensions ??= new Map(next.baseline.dimensions);
      dimensions.set(pairId, { tableId: dims.tableId, columns: new Set(dims.columns) });
    }
    if (dimensions !== null) next = { ...next, baseline: { ...next.baseline, dimensions } };
    return next;
  }
  return running;
}

/** The running state with its derived sub-state in step with the inputs. */
function withSubstep(running: TourRunning): TourRunning {
  const { substep, pairIds } = deriveSubstep(running);
  if (substep === running.substep && sameList(pairIds, running.pairIds)) return running;
  return { ...running, substep, pairIds };
}

/** Whether the step's action has been performed. */
function stepSatisfied(running: TourRunning): boolean {
  const { advance } = tourStep(running.step);
  const { baseline } = running;
  const gd = inputs.doc;
  switch (advance.kind) {
    case 'sample-open':
      return sampleIsOpen();
    case 'cross-table-reference':
      return (
        gd !== null &&
        newKey(baseline.crossReferences, crossTableReferenceKeys(gd)) !== null &&
        newKey(baseline.concats, concatFormulaKeys(gd)) !== null
      );
    case 'set-formula':
      return (
        gd !== null &&
        newKey(baseline.setCalls, setOperatorFormulaKeys(gd)) !== null &&
        newKey(baseline.setResults, setOperatorFormulaKeys(gd, SET_RESULT_FUNCTION_NAMES)) !== null
      );
    case 'graph-added': {
      if (gd === null) return false;
      // Any pair made since the step began whose dimensions changed to two or more —
      // the person's own, whoever else's arrived meanwhile (ADR-035: remote counts).
      return graphSubstep(running).pairIds.some((pairId) => {
        const taken = baseline.dimensions.get(pairId);
        const dims = pairDimensions(gd, pairId);
        return (
          taken !== undefined &&
          dims !== null &&
          dims.tableId === taken.tableId &&
          dims.columns.length >= TOUR_MIN_DIMENSIONS &&
          !sameSet(taken.columns, dims.columns)
        );
      });
    }
    case 'find-query':
      return inputs.findOpen && inputs.findQuery.trim() !== '';
    case 'invite-sent':
      // Reported as an event (`reportTourInvite`), never inferred from state.
      return false;
  }
}

function running(step: number): TourRunning {
  return { phase: 'running', step, substep: null, pairIds: NO_PAIRS, baseline: EMPTY_BASELINE };
}

/**
 * Re-read the inputs: settle the step's baselines and sub-state, advance while
 * the step is satisfied. One emission per evaluation, with everything settled.
 */
function evaluate(force = false): void {
  if (state.phase !== 'running') return;
  let next = withBaseline(state);
  while (stepSatisfied(next)) {
    if (next.step >= TOUR_STEP_COUNT) {
      set({ phase: 'ending', reason: 'completed' });
      return;
    }
    next = withBaseline(running(next.step + 1));
  }
  const settled = withSubstep(next);
  if (settled === state && !force) return;
  state = settled;
  emit();
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export function setTourRoute(pathname: string): void {
  if (inputs.pathname === pathname) return;
  inputs.pathname = pathname;
  evaluate();
}

export function setTourSampleDocumentId(id: string | null): void {
  if (inputs.sampleDocumentId === id) return;
  inputs.sampleDocumentId = id;
  evaluate();
}

/**
 * The document the person has open, or null when none is. The store watches
 * its updates (every transaction, local or remote) while a step needs them.
 */
export function setTourDocument(doc: GedeDoc | null): void {
  if (inputs.doc === doc) return;
  unobserveDoc?.();
  unobserveDoc = null;
  inputs.doc = doc;
  if (doc !== null) {
    const onUpdate = (): void => {
      evaluate();
    };
    doc.doc.on('update', onUpdate);
    unobserveDoc = () => {
      doc.doc.off('update', onUpdate);
    };
  }
  evaluate();
}

/** GRAPH-03: whether pointing mode is on in the open document (step 4's `point` card). */
export function setTourPointing(active: boolean): void {
  if (inputs.pointing === active) return;
  inputs.pointing = active;
  evaluate();
}

export function setTourFindQuery(open: boolean, query: string): void {
  if (inputs.findOpen === open && inputs.findQuery === query) return;
  inputs.findOpen = open;
  inputs.findQuery = query;
  evaluate();
}

/** The Share sheet sent an invitation (ONB-05, step 6). */
export function reportTourInvite(): void {
  if (state.phase !== 'running') return;
  if (tourStep(state.step).advance.kind !== 'invite-sent') return;
  if (state.step >= TOUR_STEP_COUNT) {
    set({ phase: 'ending', reason: 'completed' });
    return;
  }
  // Replaced silently, then evaluated and announced once, settled (ONB-05).
  state = running(state.step + 1);
  evaluate(true);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Begin at step 1 (ONB-02, ONB-08). Restarts a running tour. */
export function startTour(): void {
  state = running(1);
  evaluate(true);
}

/**
 * ONB-02: start once per account per page life, when the flag is unset. The
 * caller has already checked the viewport (ONB-13). Returns whether it started.
 */
export function autoStartTour(accountId: string): boolean {
  if (autoStarted.has(accountId) || state.phase !== 'idle') return false;
  autoStarted.add(accountId);
  startTour();
  return true;
}

/** Skip ends the tour for good (ONB-07); the controller persists the flag. */
export function skipTour(): void {
  if (state.phase !== 'running') return;
  set({ phase: 'ending', reason: 'skipped' });
}

/** The controller has persisted (or given up persisting) the flag. */
export function tourEnded(reason: TourEndReason): void {
  if (state.phase !== 'ending') return;
  set(reason === 'completed' ? { phase: 'done' } : IDLE);
}

/** The completion confirmation was dismissed or timed out (ONB-14). */
export function dismissTourDone(): void {
  if (state.phase === 'done') set(IDLE);
}

/** Test seam: forget everything, including which accounts auto-started. */
export function resetTourForTests(): void {
  unobserveDoc?.();
  unobserveDoc = null;
  inputs.pathname = '/';
  inputs.sampleDocumentId = null;
  inputs.doc = null;
  inputs.pointing = false;
  inputs.findOpen = false;
  inputs.findQuery = '';
  autoStarted.clear();
  set(IDLE);
}
