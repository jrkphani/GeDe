/**
 * The coachmark (ONB-04, ONB-06, ONB-07, ONB-09, ONB-11): a spotlight scrim
 * and a card, both fixed, both outside the page's own layout.
 *
 * Nothing here intercepts input. The scrim is one element with
 * `pointer-events: none` whose shadow dims the page around the target's live
 * box; the card is a non-modal `role="dialog"` that never takes focus on its
 * own and traps nothing, so the spotlit control — and every other one — stays
 * operable and a cell edit is never blocked. Skip is the card's only control
 * and is reachable by Tab like any button; Escape is left to the page (it
 * cancels an edit, closes Find or leaves pointing mode), so it never ends the
 * tour by accident.
 *
 * A sub-flow's cards (steps 2 and 3) share the step's counter and progress
 * dots; only the title, body and pending action change, and the card carries
 * `data-substep` for tests.
 *
 * Only the pending-action line is live (A11Y-05): a step change announces
 * "Pending action: <what to do next>", not the whole card; the counter and
 * title are read when the person moves to the dialog. Completion is
 * announced once, by the toast's own region.
 */
import { Button } from '@gede/ui';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';

import { useMessages } from '../../i18n/index.js';
import {
  CARD_HEIGHT_ESTIMATE,
  CARD_WIDTH,
  placeCard,
  spotlightRect,
  type Rect,
} from './geometry.js';
import { TOUR_STEP_COUNT, tourCard, type TourSubstep } from './steps.js';
import { targetSelectors, useSpotlightBox, useViewportSize } from './use-spotlight.js';

export interface TourOverlayProps {
  /** 1-based step. */
  step: number;
  /** The sub-flow's current card, for steps 2 and 3. */
  substep?: TourSubstep | null | undefined;
  /** The pairs made since step 3 began, whose rings stand in for a hidden checklist. */
  pairIds?: readonly string[] | undefined;
  onSkip: () => void;
}

export function TourOverlay({ step, substep = null, pairIds = [], onSkip }: TourOverlayProps) {
  const t = useMessages();
  const definition = tourCard(step, substep);
  const { rect: target, hidden } = useSpotlightBox(targetSelectors(definition.target, pairIds));
  const viewport = useViewportSize();
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardHeight, setCardHeight] = useState(CARD_HEIGHT_ESTIMATE);
  const titleId = useId();
  const bodyId = useId();

  // The card's own height decides whether it fits below its target (ONB-09).
  useEffect(() => {
    const card = cardRef.current;
    if (card === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const next = Math.round(card.getBoundingClientRect().height);
      if (next > 0) setCardHeight((previous) => (previous === next ? previous : next));
    });
    observer.observe(card);
    return () => {
      observer.disconnect();
    };
  }, []);

  const spotlight = spotlightRect(target);
  const position = placeCard(target, viewport, { width: CARD_WIDTH, height: cardHeight });
  const counter = t('tour.counter', { step, total: TOUR_STEP_COUNT });

  return (
    <>
      <div
        className={clsx('gd-tour__scrim', spotlight === null && 'gd-tour__scrim--full')}
        style={spotlight === null ? undefined : rectStyle(spotlight)}
        data-testid="tour-scrim"
        data-target={definition.target ?? 'none'}
        aria-hidden="true"
      />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="gd-tour__card"
        style={{ left: position.left, top: position.top, width: CARD_WIDTH }}
        data-testid="tour-card"
        data-step={step}
        data-substep={substep ?? undefined}
        data-placement={position.placement}
      >
        <div className="gd-tour__header">
          <span className="gd-tour__counter" aria-hidden="true">
            {counter}
          </span>
          <span className="gd-visually-hidden">
            {t('tour.progress', { step, total: TOUR_STEP_COUNT })}
          </span>
          <span className="gd-tour__dots" aria-hidden="true">
            {Array.from({ length: TOUR_STEP_COUNT }, (_, i) => (
              <span key={i} className={clsx('gd-tour__dot', i < step && 'gd-tour__dot--done')} />
            ))}
          </span>
        </div>
        <h2 id={titleId} className="gd-tour__title">
          {t(definition.title)}
        </h2>
        <p id={bodyId} className="gd-tour__body">
          {t(definition.body)}
          {/* GRAPH-03: a table off the canvas is still a target; the card says so (#159 item 2). */}
          {definition.target === 'pointing' && hidden > 0 && (
            <>
              {' '}
              <span data-testid="tour-off-canvas">{t('tour.step3.point.offCanvas')}</span>
            </>
          )}
        </p>
        {definition.note !== null && <p className="gd-tour__note">{t(definition.note)}</p>}
        <div className="gd-tour__footer">
          <p className="gd-tour__action" aria-live="polite" aria-atomic="true">
            <span className="gd-visually-hidden">{t('tour.pending')}: </span>
            {t(definition.action)}
          </p>
          <Button variant="ghost" size="sm" className="gd-tour__skip" onClick={onSkip}>
            {t('tour.skip')}
          </Button>
        </div>
      </div>
    </>
  );
}

function rectStyle(rect: Rect): { left: number; top: number; width: number; height: number } {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}
