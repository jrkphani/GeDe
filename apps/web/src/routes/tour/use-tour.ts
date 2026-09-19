/**
 * React reads of the tour store, for the controller and for the document
 * features the tour drives (the inspector rail and the Graph tab in step 4).
 * Kept apart from `TourController` so a feature can read the tour without
 * importing the controller's session, router and toast dependencies.
 */
import { useSyncExternalStore } from 'react';

import { GRAPH_STEP, isGraphSubstep, type GraphSubstep } from './steps.js';
import { subscribeTour, tourState, type TourState } from './store.js';

export function useTourState(): TourState {
  return useSyncExternalStore(subscribeTour, tourState, tourState);
}

/**
 * Step 4's current sub-card while the tour is on it, else null — for the
 * document shell, which opens the inspector for `dimensions` and lifts the
 * pointing banner above the scrim for `point`, and for the Graph tab, which
 * hands focus to its checklist for `dimensions` (A11Y-01).
 */
export function useTourGraphSubstep(): GraphSubstep | null {
  const state = useTourState();
  if (state.phase !== 'running' || state.step !== GRAPH_STEP) return null;
  return isGraphSubstep(state.substep) ? state.substep : null;
}
