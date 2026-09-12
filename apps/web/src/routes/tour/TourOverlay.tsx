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
 * cancels an edit or closes Find), so it never ends the tour by accident.
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
import { TOUR_STEP_COUNT, tourStep } from './steps.js';
import { useSpotlight, useViewportSize } from './use-spotlight.js';

export interface TourOverlayProps {
  /** 1-based step. */
  step: number;
  onSkip: () => void;
}

export function TourOverlay({ step, onSkip }: TourOverlayProps) {
  const t = useMessages();
  const definition = tourStep(step);
  const target = useSpotlight(definition.target);
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
