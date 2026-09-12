/**
 * The five steps of the first-run tour, in PRD order (ONB-05): open the
 * sample, write a cross-table reference, add a context graph, open Find and
 * search, invite by email. Each names the element it spotlights by its
 * `data-tour` anchor (`docs/PROTOTYPE-CHANGES-2026-09-12.md` §1.1) — step 2
 * has none and centres its card (ONB-06) — and the catalogue keys of its copy.
 */
import type { MessageKey } from '../../i18n/index.js';

/** `data-tour` anchors the tour measures by bounding box (ONB-04). */
export type TourTarget = 'sample' | 'graph' | 'find' | 'share';

/** How a step knows its action was performed (ONB-05). */
export type TourAdvance =
  /** The sample document is open (the route is `/d/<sampleDocumentId>`). */
  | { readonly kind: 'sample-open' }
  /** One more committed cross-table formula than when the step began. */
  | { readonly kind: 'cross-table-reference' }
  /** One more graph object than when the step began. */
  | { readonly kind: 'graph-added' }
  /** Find is open with a non-empty query. */
  | { readonly kind: 'find-query' }
  /** An invitation was sent from the Share sheet. */
  | { readonly kind: 'invite-sent' };

export interface TourStep {
  readonly id: string;
  readonly target: TourTarget | null;
  readonly title: MessageKey;
  readonly body: MessageKey;
  /** The Numbers comparison (ONB-10); step 1 has none. */
  readonly note: MessageKey | null;
  /** The pending action, rendered in amber (ONB-09). */
  readonly action: MessageKey;
  readonly advance: TourAdvance;
}

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
    target: null,
    title: 'tour.step2.title',
    body: 'tour.step2.body',
    note: 'tour.step2.note',
    action: 'tour.step2.action',
    advance: { kind: 'cross-table-reference' },
  },
  {
    id: 'add-graph',
    target: 'graph',
    title: 'tour.step3.title',
    body: 'tour.step3.body',
    note: 'tour.step3.note',
    action: 'tour.step3.action',
    advance: { kind: 'graph-added' },
  },
  {
    id: 'find',
    target: 'find',
    title: 'tour.step4.title',
    body: 'tour.step4.body',
    note: 'tour.step4.note',
    action: 'tour.step4.action',
    advance: { kind: 'find-query' },
  },
  {
    id: 'invite',
    target: 'share',
    title: 'tour.step5.title',
    body: 'tour.step5.body',
    note: 'tour.step5.note',
    action: 'tour.step5.action',
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
