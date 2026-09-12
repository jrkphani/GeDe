/**
 * Find state (FIND-01..10). Viewer state, never document state: the query,
 * the options, the match list and the current match live here; the document
 * is read to build the index and written only by Replace.
 *
 * The index lives in the search Worker (`search-client.ts`). While the bar is
 * open the hook watches the document and re-indexes changed tables after a
 * short debounce; the query re-runs on every index change so the counter and
 * the highlights never go stale.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import {
  buildSearchSnapshot,
  cellText,
  DEFAULT_SEARCH_OPTIONS,
  documentEntriesOf,
  graphEntriesOf,
  replaceInText,
  setCellText,
  tableEntries,
  tableMap,
  type DocumentName,
  type GedeDoc,
  type SearchMatch,
  type SearchOptions,
  type SearchResponse,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { listDocuments } from '../../../api/documents.js';
import { describeMatch } from './match-geometry.js';
import { createSearchClient, type SearchClient } from './search-client.js';

/** Re-index debounce after a document change (ms); short enough to feel live while typing in a cell. */
const REINDEX_DELAY_MS = 150;
/** Query debounce while typing in the Find field (ms). */
const QUERY_DELAY_MS = 40;
const QUERY_STORAGE_PREFIX = 'gede.find.query:';

export interface FindState {
  readonly open: boolean;
  readonly replaceShown: boolean;
  readonly query: string;
  readonly replacement: string;
  readonly options: SearchOptions;
  readonly matches: readonly SearchMatch[];
  /** Index into `matches`, or -1 with no matches. */
  readonly current: number;
  /** True until the first results for the latest query arrive. */
  readonly pending: boolean;
  /** FIND-08: read-only matches skipped by the last Replace / All, once one has run. */
  readonly skipped: number | null;
  readonly listOpen: boolean;
}

export interface FindActions {
  /** FIND-01: open (or re-focus, selecting the query); `replace` shows the replace row. */
  readonly open: (options?: { replace?: boolean }) => void;
  /** FIND-09: close and clear highlighting; the query is retained for the session. */
  readonly close: () => void;
  readonly setQuery: (query: string) => void;
  readonly setReplacement: (text: string) => void;
  readonly setOption: <K extends keyof SearchOptions>(key: K, value: SearchOptions[K]) => void;
  readonly setReplaceShown: (shown: boolean) => void;
  readonly setListOpen: (open: boolean) => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly goTo: (index: number) => void;
  /** FIND-08: rewrite the current match, then step to the next. */
  readonly replaceCurrent: () => void;
  readonly replaceAll: () => void;
}

export interface FindNavigation {
  /** FIND-07: switch sheet if needed and move the viewport to the match. */
  readonly onReveal: (match: SearchMatch) => void;
  /** FIND-03: a document-name match navigates to that workscape. */
  readonly onOpenDocument: (docId: string) => void;
  /** FIND-09: on close, the current match becomes the selection so keyboard focus lands there. */
  readonly onSelect: (match: SearchMatch) => void;
}

export interface UseFindOptions {
  gd: GedeDoc;
  docId: string;
  editable: boolean;
  navigation: FindNavigation;
}

export interface Find {
  state: FindState;
  actions: FindActions;
  /** The Find field: `open()` focuses it and selects its text. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Bumps whenever `open()` runs so the bar can re-focus an already open field. */
  focusTick: number;
}

function readStoredQuery(docId: string): string {
  try {
    return sessionStorage.getItem(`${QUERY_STORAGE_PREFIX}${docId}`) ?? '';
  } catch {
    return '';
  }
}

function storeQuery(docId: string, query: string): void {
  try {
    sessionStorage.setItem(`${QUERY_STORAGE_PREFIX}${docId}`, query);
  } catch {
    // Storage may be unavailable (private mode); the query simply is not retained.
  }
}

/** Table ids touched by a batch of deep events under `gd.tables`, split into changed and removed. */
function tableChanges(
  events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
  tables: object,
): { changed: Set<string>; removed: Set<string> } {
  const changed = new Set<string>();
  const removed = new Set<string>();
  for (const event of events) {
    if (event.target === tables) {
      event.changes.keys.forEach((change, key) => {
        if (change.action === 'delete') removed.add(key);
        else changed.add(key);
      });
      continue;
    }
    const head = event.path[0];
    if (typeof head === 'string') changed.add(head);
  }
  return { changed, removed };
}

export function useFind({ gd, docId, editable, navigation }: UseFindOptions): Find {
  const [open, setOpen] = useState(false);
  const [replaceShown, setReplaceShownState] = useState(false);
  const [query, setQueryState] = useState(() => readStoredQuery(docId));
  const [replacement, setReplacement] = useState('');
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [matches, setMatches] = useState<readonly SearchMatch[]>([]);
  const [current, setCurrent] = useState(-1);
  const [pending, setPending] = useState(false);
  const [skipped, setSkipped] = useState<number | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const client = useRef<SearchClient | null>(null);
  const requestId = useRef(0);
  const currentId = useRef<string | null>(null);
  const nav = useRef(navigation);
  nav.current = navigation;
  const latest = useRef({ query, options, open, matches, current });
  latest.current = { query, options, open, matches, current };

  // -- the worker ------------------------------------------------------------
  useEffect(() => {
    const c = createSearchClient();
    client.current = c;
    const unsubscribe = c.subscribe((response: SearchResponse) => {
      if (response.id !== requestId.current) return; // a stale answer
      setPending(false);
      const list = response.matches;
      setMatches(list);
      // Keep the same match current across a re-query when it survived; else clamp.
      const kept =
        currentId.current === null ? -1 : list.findIndex((m) => m.id === currentId.current);
      const next =
        list.length === 0
          ? -1
          : kept >= 0
            ? kept
            : Math.min(Math.max(0, latest.current.current), list.length - 1);
      setCurrent(next);
      currentId.current = next < 0 ? null : (list[next]?.id ?? null);
      // A11Y-05: the counter announces politely; an empty query has no counter (FIND-10 is for a query).
      if (latest.current.query.trim() !== '') {
        announce(
          list.length === 0 ? 'No matches' : `${String(next + 1)} of ${String(list.length)}`,
        );
      }
    });
    return () => {
      unsubscribe();
      c.dispose();
      client.current = null;
    };
  }, []);

  const runQuery = useCallback(() => {
    const c = client.current;
    if (c === null) return;
    requestId.current += 1;
    setPending(true);
    c.post({
      type: 'query',
      id: requestId.current,
      query: latest.current.query,
      options: latest.current.options,
    });
  }, []);

  // -- the index: full build on open, incremental while open (FIND-03) ------
  useEffect(() => {
    if (!open) return undefined;
    const c = client.current;
    if (c === null) return undefined;
    c.post({ type: 'reset', snapshot: buildSearchSnapshot(gd) });
    runQuery();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = new Set<string>();
    const removed = new Set<string>();
    let graphsDirty = false;
    let sheetsDirty = false;
    const flush = () => {
      timer = null;
      if (sheetsDirty) {
        // Sheet order feeds every entry's ordinal: rebuild.
        c.post({ type: 'reset', snapshot: buildSearchSnapshot(gd) });
      } else {
        const tables = [];
        for (const id of changed) {
          const t = tableEntries(gd, id);
          if (t === null) removed.add(id);
          else tables.push(t);
        }
        if (tables.length > 0) c.post({ type: 'upsertTables', tables });
        if (removed.size > 0) c.post({ type: 'removeTables', tableIds: [...removed] });
        if (graphsDirty) c.post({ type: 'setGraphs', graphs: graphEntriesOf(gd) });
      }
      changed.clear();
      removed.clear();
      graphsDirty = false;
      sheetsDirty = false;
      runQuery();
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, REINDEX_DELAY_MS);
    };
    const onTables = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      const delta = tableChanges(events, gd.tables);
      delta.changed.forEach((id) => changed.add(id));
      delta.removed.forEach((id) => removed.add(id));
      schedule();
    };
    const onGraphs = () => {
      graphsDirty = true;
      schedule();
    };
    const onSheets = () => {
      sheetsDirty = true;
      schedule();
    };
    gd.tables.observeDeep(onTables);
    gd.graphs.observeDeep(onGraphs);
    gd.sheets.observeDeep(onSheets);
    return () => {
      if (timer !== null) clearTimeout(timer);
      gd.tables.unobserveDeep(onTables);
      gd.graphs.unobserveDeep(onGraphs);
      gd.sheets.unobserveDeep(onSheets);
    };
  }, [open, gd, runQuery]);

  // FIND-03: document names, from the list the library fetches; this workscape is left out.
  useEffect(() => {
    if (!open || !options.documents) return undefined;
    const controller = new AbortController();
    Promise.all([
      listDocuments('browse', { signal: controller.signal }),
      listDocuments('shared', { signal: controller.signal }),
    ])
      .then((lists) => {
        const byId = new Map<string, DocumentName>();
        for (const doc of lists.flat()) {
          if (doc.id !== docId) byId.set(doc.id, { id: doc.id, title: doc.title });
        }
        client.current?.post({
          type: 'setDocuments',
          documents: documentEntriesOf([...byId.values()]),
        });
        runQuery();
      })
      .catch(() => {
        // The library list is unavailable: the document group is simply absent. Nothing is invented.
      });
    return () => {
      controller.abort();
    };
  }, [open, options.documents, docId, runQuery]);

  // Query and option changes re-run the search (debounced for typing).
  const firstRun = useRef(true);
  useEffect(() => {
    if (!open) return undefined;
    if (firstRun.current) {
      firstRun.current = false;
      return undefined;
    }
    const timer = setTimeout(runQuery, QUERY_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [open, query, options, runQuery]);
  useEffect(() => {
    storeQuery(docId, query);
  }, [docId, query]);

  // -- navigation (FIND-07) --------------------------------------------------
  const gdRef = useRef(gd);
  gdRef.current = gd;
  const step = useCallback((index: number, reveal = true) => {
    const list = latest.current.matches;
    if (list.length === 0) return;
    const bounded = ((index % list.length) + list.length) % list.length;
    const match = list[bounded];
    if (match === undefined) return;
    setCurrent(bounded);
    currentId.current = match.id;
    setSkipped(null);
    if (reveal) nav.current.onReveal(match);
    announce(
      `${String(bounded + 1)} of ${String(list.length)}, ${describeMatch(gdRef.current, match)}`,
    );
  }, []);

  const next = useCallback(() => {
    step(latest.current.current + 1);
  }, [step]);
  const previous = useCallback(() => {
    step(latest.current.current - 1);
  }, [step]);
  const goTo = useCallback(
    (index: number) => {
      const match = latest.current.matches[index];
      if (match === undefined) return;
      if (match.target.kind === 'document') {
        nav.current.onOpenDocument(match.target.docId);
        return;
      }
      step(index);
    },
    [step],
  );

  // -- open / close (FIND-01, FIND-09) ---------------------------------------
  const openBar = useCallback((opts: { replace?: boolean } = {}) => {
    setOpen(true);
    if (opts.replace === true) setReplaceShownState(true);
    setFocusTick((t) => t + 1);
  }, []);
  const close = useCallback(() => {
    if (!latest.current.open) return;
    const { matches: list, current: index } = latest.current;
    const match = list[index];
    setOpen(false);
    setListOpen(false);
    setMatches([]);
    setCurrent(-1);
    currentId.current = null;
    setSkipped(null);
    firstRun.current = true;
    if (match !== undefined && match.target.kind !== 'document') nav.current.onSelect(match);
    announce('Find closed');
  }, []);
  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    setSkipped(null);
  }, []);
  const setOption = useCallback(
    <K extends keyof SearchOptions>(key: K, value: SearchOptions[K]) => {
      setOptions((o) => (o[key] === value ? o : { ...o, [key]: value }));
    },
    [],
  );

  // -- replace (FIND-08) -----------------------------------------------------
  type Outcome = 'replaced' | 'skipped' | 'stale';
  const replaceOne = useCallback(
    (match: SearchMatch, text: string): Outcome => {
      if (match.readOnly || match.target.kind !== 'cell') return 'skipped';
      const { tableId, rowId, colId } = match.target;
      const table = tableMap(gd, tableId);
      if (table === null) return 'stale';
      const before = cellText(table, rowId, colId);
      let after: string;
      if (match.field === 'reference') {
        const at = before.indexOf(match.text);
        if (at < 0) return 'stale';
        after =
          before.slice(0, at) +
          replaceInText(match.text, match, text) +
          before.slice(at + match.text.length);
      } else {
        if (before !== match.text) return 'stale';
        after = replaceInText(before, match, text);
      }
      if (after === before) return 'stale';
      setCellText(gd, tableId, rowId, colId, after);
      return 'replaced';
    },
    [gd],
  );
  const replaceCurrent = useCallback(() => {
    if (!editable) return;
    const { matches: list, current: index } = latest.current;
    const match = list[index];
    if (match === undefined) return;
    const outcome = replaceOne(match, replacement);
    setSkipped(outcome === 'skipped' ? 1 : 0);
    announce(
      outcome === 'replaced'
        ? `Replaced ${describeMatch(gd, match)}`
        : outcome === 'skipped'
          ? `Skipped ${describeMatch(gd, match)}: it is not editable`
          : 'Nothing replaced',
    );
    // The re-index drops the rewritten match; keeping the index steps onto the next one.
    if (outcome === 'skipped' && list.length > 1) step(index + 1);
  }, [editable, gd, replacement, replaceOne, step]);
  const replaceAll = useCallback(() => {
    if (!editable) return;
    const list = latest.current.matches;
    if (list.length === 0) return;
    let replaced = 0;
    let skippedCount = 0;
    // One transaction: one undo step, one sync message.
    gd.doc.transact(() => {
      for (const match of list) {
        const outcome = replaceOne(match, replacement);
        if (outcome === 'replaced') replaced += 1;
        else if (outcome === 'skipped') skippedCount += 1;
      }
    }, gd.origin);
    setSkipped(skippedCount);
    announce(
      `Replaced ${String(replaced)}${skippedCount > 0 ? `, skipped ${String(skippedCount)} not editable` : ''}`,
    );
  }, [editable, gd, replacement, replaceOne]);

  const state = useMemo<FindState>(
    () => ({
      open,
      replaceShown,
      query,
      replacement,
      options,
      matches,
      current,
      pending,
      skipped,
      listOpen,
    }),
    [open, replaceShown, query, replacement, options, matches, current, pending, skipped, listOpen],
  );
  const actions = useMemo<FindActions>(
    () => ({
      open: openBar,
      close,
      setQuery,
      setReplacement,
      setOption,
      setReplaceShown: setReplaceShownState,
      setListOpen,
      next,
      previous,
      goTo,
      replaceCurrent,
      replaceAll,
    }),
    [openBar, close, setQuery, setOption, next, previous, goTo, replaceCurrent, replaceAll],
  );
  return { state, actions, inputRef, focusTick };
}
