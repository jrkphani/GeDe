/**
 * Yjs → React. The document is the state; React only re-renders. These hooks
 * hand back a version counter that ticks on every deep change, so a component
 * reads the shared types directly during render and never holds a copy.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { Awareness } from 'y-protocols/awareness';

/** Any Yjs shared type (Y.Map, Y.Array, Y.XmlFragment …); structural so generics stay out of callers. */
export interface Observable {
  observe(handler: (event: unknown, transaction: unknown) => void): void;
  unobserve(handler: (event: unknown, transaction: unknown) => void): void;
  observeDeep(handler: (events: unknown, transaction: unknown) => void): void;
  unobserveDeep(handler: (events: unknown, transaction: unknown) => void): void;
}

export interface UseYVersionOptions {
  /**
   * `deep` (default) re-renders on any change beneath the type; `shallow` only
   * when the type's own entries change — the shell watches the tables map
   * shallowly (tables added or removed) and each TableView watches its own
   * map deeply, so a cell edit re-renders that table alone.
   */
  depth?: 'deep' | 'shallow' | undefined;
}

/** Re-render when `type` changes. Returns a change counter. */
export function useYVersion(
  type: Observable | null | undefined,
  { depth = 'deep' }: UseYVersionOptions = {},
): number {
  const version = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (type === null || type === undefined) return () => undefined;
      const handler = () => {
        version.current += 1;
        onChange();
      };
      if (depth === 'deep') {
        type.observeDeep(handler);
        return () => {
          type.unobserveDeep(handler);
        };
      }
      type.observe(handler);
      return () => {
        type.unobserve(handler);
      };
    },
    [type, depth],
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
