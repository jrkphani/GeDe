/**
 * INSP-07: re-render the caller when a table's `pinned` or `z` key changes.
 * The document shell watches `tables` shallowly (objects added or removed)
 * so a cell edit never re-renders it; the pinned layer and the paint order
 * are decided by the shell, though, so it needs exactly these two keys —
 * and nothing else — from inside the table maps.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { GedeDoc } from '@gede/core';

const FLAGS: readonly string[] = ['pinned', 'z'];

export function useTableFlags(gd: GedeDoc): number {
  const version = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
        for (const event of events) {
          // A table map is a direct child of `tables`; deeper targets are cells and columns.
          if (event.target.parent !== gd.tables) continue;
          for (const key of event.changes.keys.keys()) {
            if (FLAGS.includes(key)) {
              version.current += 1;
              onChange();
              return;
            }
          }
        }
      };
      gd.tables.observeDeep(handler);
      return () => {
        gd.tables.unobserveDeep(handler);
      };
    },
    [gd],
  );
  return useSyncExternalStore(
    subscribe,
    () => version.current,
    () => 0,
  );
}
