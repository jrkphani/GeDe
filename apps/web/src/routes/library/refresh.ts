import { useEffect, useRef } from 'react';

/**
 * LIB-D11: archive and trash are document states, and a second client signed
 * in to the same account must observe them without a reload. The library has
 * no per-user push channel (rooms are per document), so it re-reads its view
 * from the service on a fixed cadence while the tab is visible, and at once
 * when the tab becomes visible or the window regains focus — the same path
 * every other remote change (a rename, a share, a delete) already takes.
 * ADR-028 records the choice; the per-user channel is the growth step.
 *
 * 15 s is well inside the per-user request budget (300/min) at a few dozen
 * tabs and short enough that a second client reads as live.
 */
export const LIBRARY_REFRESH_MS = 15_000;

/**
 * Call `refresh` every `intervalMs` while `document.visibilityState` is
 * `visible`, and immediately on `visibilitychange` → visible and on window
 * `focus`. `refresh` is read through a ref so callers pass a fresh closure
 * each render without restarting the timer. `enabled` pauses everything
 * (while the first load is in flight, for instance).
 */
export function useLibraryRefresh(
  refresh: () => void,
  { intervalMs = LIBRARY_REFRESH_MS, enabled = true }: { intervalMs?: number; enabled?: boolean },
): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled) return undefined;
    const visible = () => document.visibilityState === 'visible';
    const tick = () => {
      if (visible()) latest.current();
    };
    const timer = setInterval(tick, intervalMs);
    const onVisibility = () => {
      if (visible()) latest.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
    };
  }, [intervalMs, enabled]);
}
