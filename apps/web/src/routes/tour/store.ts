/**
 * Tour state (ONB-02..08, ONB-13). One module store for the whole app, read
 * with `useSyncExternalStore`: the tour outlives route changes (step 1 is in
 * the library, steps 2–5 in the sample document), so it cannot live in a
 * route's React state.
 *
 * A step advances only when the document, the route or a feature says its
 * action happened (ONB-05); there is no Next. The inputs are:
 *
 *   - the route (`setTourRoute`), for step 1 (the sample is open);
 *   - the open Y.Doc (`setTourDocument`), for steps 2 and 3 — the set of
 *     cells holding a cross-table formula, and the count of graph objects,
 *     compared with what was there when the step began, so what the sample
 *     ships with never advances it. Every transaction is observed, remote
 *     ones included: a collaborator writing a reference into the sample
 *     while the person is on step 2 advances it — the action happened in the
 *     document the card points at, and attributing transactions would put
 *     origin tracking in the tour for no product gain;
 *   - Find's query (`setTourFindQuery`) for step 4 and the Share sheet's
 *     invitation (`reportTourInvite`) for step 5.
 *
 * The store never talks to the server: `TourController` persists the flag
 * (`PATCH /api/me { tourDone }`) when the phase becomes `ending` and moves
 * it on with `tourEnded()`.
 */
import { crossTableReferenceKeys, newCrossTableReference, type GedeDoc } from '@gede/core';

import { TOUR_STEP_COUNT, tourStep } from './steps.js';

export type TourEndReason = 'skipped' | 'completed';

export type TourState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'running';
      /** 1-based. */
      readonly step: number;
      /** What was there when the step began, once the document was available; null until then. */
      readonly baseline: {
        /** Workbook cell ids holding a cross-table formula (step 2). */
        readonly crossReferences: ReadonlySet<string> | null;
        /** Graph objects (step 3). */
        readonly graphs: number | null;
      };
    }
  /** Skip or completion happened; the controller is persisting the flag. */
  | { readonly phase: 'ending'; readonly reason: TourEndReason }
  /** Completed and persisted; the confirmation is showing (ONB-14). */
  | { readonly phase: 'done' };

interface Inputs {
  pathname: string;
  sampleDocumentId: string | null;
  doc: GedeDoc | null;
  findOpen: boolean;
  findQuery: string;
}

const IDLE: TourState = { phase: 'idle' };

let state: TourState = IDLE;
const inputs: Inputs = {
  pathname: '/',
  sampleDocumentId: null,
  doc: null,
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

export function graphCount(gd: GedeDoc): number {
  return gd.graphs.size;
}

function sampleIsOpen(): boolean {
  const id = inputs.sampleDocumentId;
  return id !== null && inputs.pathname === `/d/${id}`;
}

/** Take whichever baseline the current step needs and does not have yet. */
function settleBaseline(): void {
  if (state.phase !== 'running' || inputs.doc === null) return;
  const { advance } = tourStep(state.step);
  const { baseline } = state;
  if (advance.kind === 'cross-table-reference' && baseline.crossReferences === null) {
    set({
      ...state,
      baseline: { ...baseline, crossReferences: crossTableReferenceKeys(inputs.doc) },
    });
  } else if (advance.kind === 'graph-added' && baseline.graphs === null) {
    set({ ...state, baseline: { ...baseline, graphs: graphCount(inputs.doc) } });
  }
}

/** Whether the current step's action has been performed. */
function stepSatisfied(): boolean {
  if (state.phase !== 'running') return false;
  const { advance } = tourStep(state.step);
  const { baseline } = state;
  switch (advance.kind) {
    case 'sample-open':
      return sampleIsOpen();
    case 'cross-table-reference':
      return (
        inputs.doc !== null &&
        baseline.crossReferences !== null &&
        newCrossTableReference(baseline.crossReferences, crossTableReferenceKeys(inputs.doc)) !==
          null
      );
    case 'graph-added':
      return (
        inputs.doc !== null && baseline.graphs !== null && graphCount(inputs.doc) > baseline.graphs
      );
    case 'find-query':
      return inputs.findOpen && inputs.findQuery.trim() !== '';
    case 'invite-sent':
      // Reported as an event (`reportTourInvite`), never inferred from state.
      return false;
  }
}

let evaluating = false;

/** Re-read the inputs; advance while the current step is satisfied. */
function evaluate(): void {
  if (evaluating) return;
  evaluating = true;
  try {
    settleBaseline();
    while (state.phase === 'running' && stepSatisfied()) advance();
  } finally {
    evaluating = false;
  }
}

function advance(): void {
  if (state.phase !== 'running') return;
  if (state.step >= TOUR_STEP_COUNT) {
    set({ phase: 'ending', reason: 'completed' });
    return;
  }
  set({
    phase: 'running',
    step: state.step + 1,
    baseline: { crossReferences: null, graphs: null },
  });
  settleBaseline();
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

export function setTourFindQuery(open: boolean, query: string): void {
  if (inputs.findOpen === open && inputs.findQuery === query) return;
  inputs.findOpen = open;
  inputs.findQuery = query;
  evaluate();
}

/** The Share sheet sent an invitation (ONB-05, step 5). */
export function reportTourInvite(): void {
  if (state.phase !== 'running') return;
  if (tourStep(state.step).advance.kind === 'invite-sent') advance();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Begin at step 1 (ONB-02, ONB-08). Restarts a running tour. */
export function startTour(): void {
  set({ phase: 'running', step: 1, baseline: { crossReferences: null, graphs: null } });
  evaluate();
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
  inputs.findOpen = false;
  inputs.findQuery = '';
  autoStarted.clear();
  set(IDLE);
}
