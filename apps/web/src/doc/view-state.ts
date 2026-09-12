/**
 * Per-viewer table view state (ADR-026, SORT-01..06, HIER-08): a table's
 * sort, filter and grouping belong to the person looking at it, not to the
 * document. One store per open document, keyed by (user, document) in
 * `localStorage` under `gede.view.<sub>.<docId>`, one `TableViewState` per
 * table inside it. The document carries no view keys and the sync service
 * never sees them; sign-out wipes every `gede.view.*` entry along with the
 * IndexedDB replicas ("Nothing is left on this device", AUTH-09).
 *
 * Readers: `useTableView(tableId)` for components (through the provider the
 * document shell mounts) and `readGroupBy(store, tableId)` for code outside
 * React — the hierarchy layer reads the group column for HIER-08 from here.
 * Stored views are validated against the table's columns where they are
 * consumed (`normaliseTableView` in `@gede/core`), so a column deleted since
 * never sorts a table by nothing.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { EMPTY_VIEW, normaliseTableView, type Id, type TableViewState } from '@gede/core';

export const VIEW_STATE_PREFIX = 'gede.view.';

export function viewStateKey(userSub: string, docId: string): string {
  return `${VIEW_STATE_PREFIX}${userSub}.${docId}`;
}

export interface ViewStore {
  readonly docId: string;
  /** The stored view for a table, unvalidated — `EMPTY_VIEW` when none. */
  get(tableId: Id): TableViewState;
  /** Replace a table's view; an empty view removes the entry. */
  set(tableId: Id, view: TableViewState): void;
  /** SORT-06: forget the table's sort, filter and grouping in one step. */
  clear(tableId: Id): void;
  /** Re-render signal; fires after every change. */
  subscribe(listener: () => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readAll(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isEmpty(view: TableViewState): boolean {
  return view.sortBy === null && view.filter === null && view.groupBy === null;
}

/** Any column id passes here: the store knows the shape, the consumer knows the table's columns. */
const ANY_COLUMN = { has: () => true };

/** The shape stored on the device, checked on read; unknown fields are dropped. */
function asView(value: unknown): TableViewState {
  return normaliseTableView(value, ANY_COLUMN);
}

/**
 * Open the view store for one (user, document). Reads the device's copy once;
 * every write goes back to `localStorage` (a storage failure — private mode,
 * quota — keeps the view for this page only, like the locale store).
 */
export function openViewStore(userSub: string, docId: string): ViewStore {
  const key = viewStateKey(userSub, docId);
  const views = new Map<Id, TableViewState>();
  for (const [tableId, value] of Object.entries(readAll(key))) {
    const view = asView(value);
    if (!isEmpty(view)) views.set(tableId, view);
  }
  const listeners = new Set<() => void>();
  const persist = () => {
    try {
      if (views.size === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(Object.fromEntries(views)));
    } catch {
      /* no storage: the view lives for this page only */
    }
  };
  const publish = () => {
    persist();
    listeners.forEach((l) => {
      l();
    });
  };
  return {
    docId,
    get: (tableId) => views.get(tableId) ?? EMPTY_VIEW,
    set: (tableId, view) => {
      if (isEmpty(view)) views.delete(tableId);
      else views.set(tableId, view);
      publish();
    },
    clear: (tableId) => {
      if (!views.has(tableId)) return;
      views.delete(tableId);
      publish();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** AUTH-09: forget every view on this device. Returns the keys removed. */
export function clearViewState(): string[] {
  const removed: string[] = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(VIEW_STATE_PREFIX) === true) {
        localStorage.removeItem(key);
        removed.push(key);
      }
    }
  } catch {
    /* nothing to forget */
  }
  return removed;
}

/** Non-React reader for the hierarchy layer (HIER-08): the column a table is grouped by, or null. */
export function readGroupBy(store: ViewStore, tableId: Id): Id | null {
  return store.get(tableId).groupBy;
}

/** A store that holds nothing and remembers nothing: for a document opened without a signed-in user. */
export const NULL_VIEW_STORE: ViewStore = {
  docId: '',
  get: () => EMPTY_VIEW,
  set: () => undefined,
  clear: () => undefined,
  subscribe: () => () => undefined,
};

const ViewStoreContext = createContext<ViewStore>(NULL_VIEW_STORE);

/** Mounted once per open document by the shell; viewer state, never document data. */
export const ViewStoreProvider = ViewStoreContext.Provider;

export function useViewStore(): ViewStore {
  return useContext(ViewStoreContext);
}

/** The viewer's stored view for a table; re-renders on change. Validate against the table's columns before use. */
export function useTableView(tableId: Id): TableViewState {
  const store = useViewStore();
  const subscribe = useCallback((l: () => void) => store.subscribe(l), [store]);
  return useSyncExternalStore(
    subscribe,
    () => store.get(tableId),
    () => EMPTY_VIEW,
  );
}
