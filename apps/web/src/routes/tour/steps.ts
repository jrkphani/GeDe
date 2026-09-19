/**
 * The six steps of the first-run tour, in PRD order as amended by ADR-055
 * (ONB-05): open the sample, write a cross-table reference, compute over the
 * text in cells with a set operator, add a context graph, open Find and
 * search, invite by email. Each names the element it spotlights by its
 * `data-tour` anchor (`docs/PROTOTYPE-CHANGES-2026-09-12.md` §1.1) — steps 2
 * and 3 have none and centre their cards (ONB-06) — and the catalogue keys of
 * its copy.
 *
 * Three steps are guided sub-flows: several cards under one counter, each
 * advancing only on the person's action, never a Next. Step 2 (`2 of 6`)
 * teaches the cross-table reference and then `=Concat()` (FX-01). Step 3
 * (`3 of 6`) teaches the set operators (FX-09): `pick-form` asks for any of
 * the five from the `=` forms menu, `set-result` for one that compares two
 * sets. Step 4 (`4 of 6`) is only meaningful once the graph is pointed at a
 * table and its dimensions are chosen (GRAPH-03, GRAPH-05): `add` spotlights
 * `+ Graph`, `point` the pointing targets over the sheet's tables,
 * `dimensions` the checklist in the Graph tab. Which sub-card shows is
 * derived by the store from the document and pointing mode.
 */
import type { MessageKey } from '../../i18n/index.js';

/** `data-tour` anchors the tour measures by bounding box (ONB-04). */
export type TourTarget =
  'sample' | 'graph' | 'pointing' | 'dimensions' | 'inspector-expand' | 'find' | 'share';

/** How a step knows its action was performed (ONB-05). */
export type TourAdvance =
  /** The sample document is open (the route is `/d/<sampleDocumentId>`). */
  | { readonly kind: 'sample-open' }
  /**
   * One more committed cross-table formula than when the step began, then one
   * more committed `=Concat()` over two operands with a bound reference.
   */
  | { readonly kind: 'cross-table-reference' }
  /**
   * One more committed set-operator formula than when the step began, then
   * one more whose operator compares two sets (Inter, Diff, Comp or Cross)
   * than when its card first showed (FX-09, ADR-055).
   */
  | { readonly kind: 'set-formula' }
  /**
   * A graph pair that was not there when the step began is bound to a table
   * and its dimensions were changed to a set of at least two (GRAPH-05).
   */
  | { readonly kind: 'graph-added' }
  /** Find is open with a non-empty query. */
  | { readonly kind: 'find-query' }
  /** An invitation was sent from the Share sheet. */
  | { readonly kind: 'invite-sent' };

/** The copy and target of one card (a step, or one of a sub-flow's cards). */
export interface TourCard {
  readonly target: TourTarget | null;
  readonly title: MessageKey;
  readonly body: MessageKey;
  /** The Numbers comparison (ONB-10); step 1 has none. */
  readonly note: MessageKey | null;
  /** The pending action, rendered in amber (ONB-09). */
  readonly action: MessageKey;
}

export interface TourStep extends TourCard {
  readonly id: string;
  readonly advance: TourAdvance;
}

/** Step 2's sub-states, in the order a person meets them. */
export type ReferenceSubstep = 'reference' | 'concat';
/** Step 3's sub-states, in the order a person meets them. */
export type SetSubstep = 'pick-form' | 'set-result';
/** Step 4's sub-states, in the order a person meets them. */
export type GraphSubstep = 'add' | 'point' | 'dimensions';
export type TourSubstep = ReferenceSubstep | SetSubstep | GraphSubstep;

export const REFERENCE_STEP = 2;
export const SET_STEP = 3;
export const GRAPH_STEP = 4;

export function isGraphSubstep(substep: TourSubstep | null): substep is GraphSubstep {
  return substep === 'add' || substep === 'point' || substep === 'dimensions';
}

/**
 * The sub-cards. `reference` and `add` are the prototype's steps 2 and 3
 * verbatim; the graph sub-cards keep step 4's comparison note — the graph
 * is introduced on its own terms throughout (ONB-10). Step 3's two cards
 * are centred like step 2's: the forms menu exists only while a cell is
 * being typed into, so there is nothing to spotlight (ONB-06).
 */
export const SUBSTEP_CARDS: Readonly<Record<TourSubstep, TourCard>> = {
  reference: {
    target: null,
    title: 'tour.step2.title',
    body: 'tour.step2.body',
    note: 'tour.step2.note',
    action: 'tour.step2.action',
  },
  concat: {
    target: null,
    title: 'tour.step2.concat.title',
    body: 'tour.step2.concat.body',
    note: 'tour.step2.concat.note',
    action: 'tour.step2.concat.action',
  },
  'pick-form': {
    target: null,
    title: 'tour.step3.title',
    body: 'tour.step3.body',
    note: 'tour.step3.note',
    action: 'tour.step3.action',
  },
  'set-result': {
    target: null,
    title: 'tour.step3.result.title',
    body: 'tour.step3.result.body',
    note: 'tour.step3.note',
    action: 'tour.step3.result.action',
  },
  add: {
    target: 'graph',
    title: 'tour.step4.title',
    body: 'tour.step4.body',
    note: 'tour.step4.note',
    action: 'tour.step4.action',
  },
  point: {
    target: 'pointing',
    title: 'tour.step4.point.title',
    body: 'tour.step4.point.body',
    note: 'tour.step4.note',
    action: 'tour.step4.point.action',
  },
  dimensions: {
    target: 'dimensions',
    title: 'tour.step4.dimensions.title',
    body: 'tour.step4.dimensions.body',
    note: 'tour.step4.note',
    action: 'tour.step4.dimensions.action',
  },
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'open-sample',
    target: 'sample',
    title: 'tour.step1.title',
    body: 'tour.step1.body',
    note: null,
    action: 'tour.step1.action',
    advance: { kind: 'sample-open' },
  },
  {
    id: 'cross-table-reference',
    ...SUBSTEP_CARDS.reference,
    advance: { kind: 'cross-table-reference' },
  },
  {
    id: 'set-formula',
    ...SUBSTEP_CARDS['pick-form'],
    advance: { kind: 'set-formula' },
  },
  {
    id: 'add-graph',
    ...SUBSTEP_CARDS.add,
    advance: { kind: 'graph-added' },
  },
  {
    id: 'find',
    target: 'find',
    title: 'tour.step5.title',
    body: 'tour.step5.body',
    note: 'tour.step5.note',
    action: 'tour.step5.action',
    advance: { kind: 'find-query' },
  },
  {
    id: 'invite',
    target: 'share',
    title: 'tour.step6.title',
    body: 'tour.step6.body',
    note: 'tour.step6.note',
    action: 'tour.step6.action',
    advance: { kind: 'invite-sent' },
  },
];

export const TOUR_STEP_COUNT = TOUR_STEPS.length;

/** 1-based step number → definition. */
export function tourStep(step: number): TourStep {
  const found = TOUR_STEPS[step - 1];
  if (found === undefined) throw new RangeError(`no tour step ${String(step)}`);
  return found;
}

/** The card to show: the sub-flow's current card during steps 2, 3 and 4, else the step's own. */
export function tourCard(step: number, substep: TourSubstep | null): TourCard {
  if (substep !== null) return SUBSTEP_CARDS[substep];
  return tourStep(step);
}
