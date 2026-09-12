/**
 * Per-cell change counters for one table, so `Cell` can be memoised: a
 * keystroke in B5 bumps B5's counter and only B5 re-renders, instead of
 * every cell of the table (PRD §20: keystroke to visible update in 16 ms at
 * 1,000 cells). Structural changes (rows, columns, meta) reach the cells
 * through their ordinary props, which `TableView` recomputes per render.
 *
 * One deep observer on the table map, subscribed through
 * `useSyncExternalStore` so the counters are bumped before React re-renders.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { CellKey, TableMap } from '@gede/core';

/** Sentinel: every cell changed (a whole map arrived or went). */
const ALL: readonly string[] = [];

export interface CellVersions {
  /** The table's own change counter (what `useYVersion(table)` returned). */
  readonly table: number;
  /** The counter for one cell; 0 until it changes. */
  of(key: CellKey): number;
}

/**
 * Which cell an event belongs to, walking up from its target to the table's
 * `cells` or `cellFormat` map. `event.path` cannot be used: Yjs defers deep
 * observers until after it has re-based every event's path on the outermost
 * observed ancestor, so inside a listener the path is relative to whichever
 * type was visited last, not to `table`.
 */
function cellKeysOf(
  table: TableMap,
  event: Y.YEvent<Y.AbstractType<unknown>>,
): readonly string[] | null {
  const cells: unknown = table.get('cells');
  const formats: unknown = table.get('cellFormat');
  const target: Y.AbstractType<unknown> = event.target;
  // The table itself: one of the two maps was created or replaced, so every cell may differ.
  if ((target as unknown) === table) {
    const keys = event.changes.keys;
    return keys.has('cells') || keys.has('cellFormat') ? ALL : null;
  }
  if (target === cells || target === formats) return Array.from(event.changes.keys.keys());
  // Walk up until the parent is one of the two maps (or the table, meaning neither).
  for (
    let type = target, parent = type.parent;
    parent !== null;
    type = parent, parent = type.parent
  ) {
    if ((parent as unknown) === table) return null;
    if (parent === cells || parent === formats) {
      const key = type._item?.parentSub;
      return typeof key === 'string' ? [key] : null;
    }
  }
  return null;
}

export function useCellVersions(table: TableMap): CellVersions {
  const counters = useRef(new Map<string, number>());
  /** Bumped when every cell may have changed; folded into each cell's counter. */
  const bulk = useRef(0);
  const version = useRef(0);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
        for (const event of events) {
          const keys = cellKeysOf(table, event);
          if (keys === null) continue;
          if (keys === ALL) {
            bulk.current += 1;
            continue;
          }
          for (const key of keys) {
            counters.current.set(key, (counters.current.get(key) ?? 0) + 1);
          }
        }
        version.current += 1;
        onChange();
      };
      table.observeDeep(handler);
      return () => {
        table.unobserveDeep(handler);
      };
    },
    [table],
  );
  const tableVersion = useSyncExternalStore(
    subscribe,
    () => version.current,
    () => 0,
  );
  return {
    table: tableVersion,
    of: (key) => (counters.current.get(key) ?? 0) + bulk.current,
  };
}
