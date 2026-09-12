/**
 * Yjs → React. The document is the state; React only re-renders. These hooks
 * hand back a version counter that ticks on every deep change, so a component
 * reads the shared types directly during render and never holds a copy.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Awareness } from 'y-protocols/awareness';

/** Any Yjs shared type (Y.Map, Y.Array, Y.XmlFragment …); structural so generics stay out of callers. */
export interface DeepObservable {
  observeDeep(handler: (events: unknown, transaction: unknown) => void): void;
  unobserveDeep(handler: (events: unknown, transaction: unknown) => void): void;
}

/** Re-render when anything under `type` changes (observeDeep). Returns a change counter. */
export function useYVersion(type: DeepObservable | null | undefined): number {
  const version = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (type === null || type === undefined) return () => undefined;
      const handler = () => {
        version.current += 1;
        onChange();
      };
      type.observeDeep(handler);
      return () => {
        type.unobserveDeep(handler);
      };
    },
    [type],
  );
  return useSyncExternalStore(
    subscribe,
    () => version.current,
    () => 0,
  );
}

/** Re-render when any awareness state changes (SHARE-04 presence). Returns a change counter. */
export function useAwarenessVersion(awareness: Awareness | null | undefined): number {
  const version = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (awareness === null || awareness === undefined) return () => undefined;
      const handler = () => {
        version.current += 1;
        onChange();
      };
      awareness.on('change', handler);
      return () => {
        awareness.off('change', handler);
      };
    },
    [awareness],
  );
  return useSyncExternalStore(
    subscribe,
    () => version.current,
    () => 0,
  );
}
