/**
 * Mounts the tour above every route (ONB-02..08, ONB-13, ONB-14). Reads the
 * store, feeds it the route, and owns the side effects the store does not:
 *
 *   - ONB-03 / ONB-07: when a run ends (completed or skipped) the per-account
 *     flag is set with `PATCH /api/me { tourDone: true }`; the tour ends
 *     locally either way — a failed write only means the flag stays unset
 *     until the next run;
 *   - ONB-08: Replay clears the flag and restarts at step 1 at once;
 *   - ONB-13: below 768 px nothing renders and nothing starts (the store
 *     keeps a run that was already going, so widening the window resumes it);
 *   - ONB-14: completion shows the confirmation naming the `?` in the library.
 */
import { Toast } from '@gede/ui';
import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useSession } from '../../auth/session.js';
import { useMessages } from '../../i18n/index.js';
import { usePhone } from '../../breakpoint.js';
import { tourFlag } from './flag-queue.js';
import {
  autoStartTour,
  dismissTourDone,
  setTourRoute,
  setTourSampleDocumentId,
  skipTour,
  startTour,
  tourEnded,
  type TourEndReason,
} from './store.js';
import { TourOverlay } from './TourOverlay.js';
import { useTourState } from './use-tour.js';

export { useTourGraphSubstep, useTourState } from './use-tour.js';

/** How long the completion confirmation stays (DS: ~8 s). */
export const TOUR_DONE_TOAST_MS = 8000;

/** ONB-13: the tour needs an editable document, so it never runs on a phone (ADR-035, ADR-039). */
export function useTourAllowed(): boolean {
  return !usePhone();
}

/**
 * ONB-08: Replay from the library's help control — and from the completion
 * toast. Clears the flag and restarts at step 1; works whether or not a tour
 * is already running. Step 1 targets the library row, so a Replay from
 * anywhere else (the toast inside a document) goes to the library first.
 */
export function useReplayTour(): () => void {
  const { updateProfile } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (location.pathname !== '/') void navigate('/');
    startTour();
    // The run is already on; the write is queued behind any Skip still in flight.
    void tourFlag.persist(false, updateProfile);
  }, [updateProfile, navigate, location.pathname]);
}

/**
 * ONB-02: the library calls this on arrival. Starts once per account per page
 * life while the server flag is unset and the viewport allows it.
 */
export function useTourAutoStart(): void {
  const { profile } = useSession();
  const allowed = useTourAllowed();
  useEffect(() => {
    if (profile?.tourDoneAt !== null || !allowed) return;
    autoStartTour(profile.id);
  }, [profile, allowed]);
}

export function TourController() {
  const state = useTourState();
  const { profile, updateProfile } = useSession();
  const allowed = useTourAllowed();
  const location = useLocation();
  const t = useMessages();
  const replay = useReplayTour();

  useEffect(() => {
    setTourRoute(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    setTourSampleDocumentId(profile?.sampleDocumentId ?? null);
  }, [profile?.sampleDocumentId]);

  // ONB-03, ONB-07: persist the end of a run — serialised with any Replay
  // write, so the profile never lags a later answer — then let the store move on.
  useEffect(() => {
    if (state.phase !== 'ending') return;
    const reason: TourEndReason = state.reason;
    let live = true;
    void tourFlag.persist(true, updateProfile).then(() => {
      if (live) tourEnded(reason);
    });
    return () => {
      live = false;
    };
  }, [state, updateProfile]);

  if (!allowed) return null;

  return (
    <>
      {state.phase === 'running' && (
        <TourOverlay
          step={state.step}
          substep={state.substep}
          pairId={state.pairId}
          onSkip={skipTour}
        />
      )}
      <Toast
        className="gd-tour__toast"
        open={state.phase === 'done'}
        onOpenChange={(open) => {
          if (!open) dismissTourDone();
        }}
        duration={TOUR_DONE_TOAST_MS}
        title={t('tour.done.message')}
        undo={{
          label: t('tour.done.replay'),
          altText: t('library.help.replay'),
          onUndo: () => {
            dismissTourDone();
            replay();
          },
        }}
      />
    </>
  );
}
