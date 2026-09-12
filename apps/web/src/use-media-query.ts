import { useSyncExternalStore } from 'react';

/** Window media query as React state. Chrome adapts to the window; the canvas queries its container. */
export function useMediaQuery(query: string): boolean {
  const subscribe = (onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  };
  const get = () => window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, get, () => false);
}
