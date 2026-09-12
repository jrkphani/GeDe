/**
 * The formula engine on the main thread: one host per Y.Doc that ships every
 * document transaction to `formula.worker.ts`, keeps the results it sends
 * back, and lets React subscribe per cell (FX-06, FX-07).
 *
 * Rules (apps/web/CLAUDE.md): the main thread never evaluates a formula.
 * Evaluation runs in the Worker; only where `Worker` does not exist at all
 * (jsdom, Node) does the same `FormulaEngine` run inline so tests exercise
 * the real engine. A Worker that dies is restarted from a fresh snapshot —
 * never downgraded to the main thread — and the failure is surfaced through
 * `status` so the shell can say so (ARCHITECTURE-DIGEST §3: a background
 * operation that failed is a banner, not a silent change of behaviour).
 * Typing is never blocked: the observer posts a structured-clone change
 * batch and returns; results arrive asynchronously and re-render by cell id.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import {
  FormulaEngine,
  observeWorkbook,
  openDocument,
  workbookSnapshot,
  type CellResult,
  type EngineRequest,
  type EngineResponse,
  type GedeDoc,
  type WorkbookCellId,
  type WorkbookChange,
} from '@gede/core';

import { activeLocale, subscribeLocale } from '../locale.js';

/** Where evaluation happens. Both speak the core protocol; only `worker` leaves the thread. */
export interface EngineTransport {
  readonly mode: 'worker' | 'inline';
  post(request: EngineRequest): void;
  onResponse(handler: (response: EngineResponse) => void): void;
  /** The transport died: a Worker that failed to load or threw. */
  onError?(handler: (error: unknown) => void): void;
  terminate(): void;
}

export interface EngineStatus {
  readonly mode: 'worker' | 'inline';
  /** Worker restarts so far; 0 is the healthy state. */
  readonly restarts: number;
  /** Set once restarts are exhausted: formulas stop evaluating until `retry()`. */
  readonly failed: boolean;
  readonly lastError: string | null;
}

export interface EngineHost {
  readonly mode: 'worker' | 'inline';
  readonly status: EngineStatus;
  subscribeStatus(onChange: () => void): () => void;
  /** Start a fresh Worker after `status.failed`. */
  retry(): void;
  result(cellId: WorkbookCellId): CellResult | undefined;
  /** Re-render signal for one cell; the callback fires when that cell's result changes. */
  subscribe(cellId: WorkbookCellId, onChange: () => void): () => void;
  /** Fires after every batch of results, for whole-sheet consumers. */
  subscribeAll(onChange: () => void): () => void;
  /** Monotonic counter across all result changes. */
  readonly version: number;
  /** Resolves once every change posted so far has been answered. */
  settled(): Promise<void>;
  /** Engine time of the last batch, for the §20 budget in devtools. */
  readonly lastElapsedMs: number;
  dispose(): void;
}

/** A Worker that dies this many times in one session stays down until Retry. */
export const MAX_WORKER_RESTARTS = 3;
/**
 * Liveness: a Worker killed without an `error` event (the browser reclaiming
 * it under memory pressure) answers nothing, so the host pings it and treats a
 * missed answer as a death. Only the `worker` transport is probed.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 5_000;

export function workerTransport(): EngineTransport {
  const worker = new Worker(new URL('../workers/formula.worker.ts', import.meta.url), {
    type: 'module',
    name: 'gede-formula',
  });
  return {
    mode: 'worker',
    post: (request) => {
      worker.postMessage(request);
    },
    onResponse: (handler) => {
      worker.onmessage = (e: MessageEvent<EngineResponse>) => {
        handler(e.data);
      };
    },
    onError: (handler) => {
      worker.onerror = (e) => {
        handler(e.error ?? e.message);
      };
    },
    terminate: () => {
      worker.terminate();
    },
  };
}

/**
 * The same engine on the main thread, answered on a microtask so the ordering
 * guarantees match the Worker (a result never lands inside the transaction
 * that caused it). Used only where `Worker` is unavailable, and in tests.
 */
export function inlineTransport(): EngineTransport {
  const engine = new FormulaEngine();
  let handler: ((response: EngineResponse) => void) | null = null;
  let alive = true;
  return {
    mode: 'inline',
    post: (request) => {
      // Structured clone keeps the inline path honest: nothing shared by reference.
      const cloned = structuredClone(request);
      queueMicrotask(() => {
        if (!alive) return;
        const response = engine.handle(cloned);
        handler?.(response);
      });
    },
    onResponse: (h) => {
      handler = h;
    },
    terminate: () => {
      alive = false;
    },
  };
}

let transportFactory: (() => EngineTransport) | null = null;

/** Test seam: force a transport (e.g. inline, or a fake that records requests). */
export function setEngineTransportForTests(factory: (() => EngineTransport) | null): void {
  transportFactory = factory;
}

function defaultTransport(): EngineTransport {
  if (transportFactory !== null) return transportFactory();
  return typeof Worker === 'undefined' ? inlineTransport() : workerTransport();
}

export function createEngineHost(
  gd: GedeDoc,
  makeTransport: () => EngineTransport = defaultTransport,
): EngineHost {
  const results = new Map<WorkbookCellId, CellResult>();
  const cellListeners = new Map<WorkbookCellId, Set<() => void>>();
  const allListeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  const pending = new Set<number>();
  const settleWaiters: (() => void)[] = [];
  let transport = makeTransport();
  let seq = 0;
  let version = 0;
  let lastElapsedMs = 0;
  let status: EngineStatus = {
    mode: transport.mode,
    restarts: 0,
    failed: false,
    lastError: null,
  };

  const setStatus = (next: Partial<EngineStatus>) => {
    status = { ...status, ...next };
    for (const cb of statusListeners) cb();
  };
  const notify = (cellId: WorkbookCellId) => {
    const set = cellListeners.get(cellId);
    if (set !== undefined) for (const cb of set) cb();
  };
  let awaitingPong: number | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const onResponse = (response: EngineResponse) => {
    if (response.type === 'pong') {
      if (response.seq === awaitingPong) {
        awaitingPong = null;
        if (pongTimer !== null) clearTimeout(pongTimer);
        pongTimer = null;
      }
      return;
    }
    lastElapsedMs = response.elapsedMs;
    const touched: WorkbookCellId[] = [];
    for (const id of response.removed) {
      if (results.delete(id)) touched.push(id);
    }
    for (const r of response.results) {
      results.set(r.cellId, r);
      touched.push(r.cellId);
    }
    if (touched.length > 0) {
      version += 1;
      for (const id of touched) notify(id);
      for (const cb of allListeners) cb();
    }
    pending.delete(response.seq);
    if (pending.size === 0) for (const resolve of settleWaiters.splice(0)) resolve();
  };

  const post = (changes: readonly WorkbookChange[]) => {
    if (status.failed) return; // nothing to answer; Retry re-seeds from a snapshot
    seq += 1;
    const request: EngineRequest = { type: 'apply', seq, changes };
    pending.add(seq);
    transport.post(request);
  };
  // I18N: `Format` presets case through `Intl` for the active locale; the engine hears
  // every change and re-evaluates (the Worker has no window to read it from).
  const postLocale = () => {
    if (status.failed) return;
    seq += 1;
    pending.add(seq);
    transport.post({ type: 'locale', seq, locale: activeLocale() });
  };
  const stopLocale = subscribeLocale(postLocale);

  const stopHeartbeat = () => {
    if (heartbeat !== null) clearInterval(heartbeat);
    if (pongTimer !== null) clearTimeout(pongTimer);
    heartbeat = null;
    pongTimer = null;
    awaitingPong = null;
  };
  const startHeartbeat = () => {
    stopHeartbeat();
    if (transport.mode !== 'worker') return;
    heartbeat = setInterval(() => {
      if (awaitingPong !== null || status.failed) return; // one probe in flight at a time
      seq += 1;
      awaitingPong = seq;
      transport.post({ type: 'ping', seq });
      pongTimer = setTimeout(() => {
        if (awaitingPong === null) return;
        restart(new Error('formula worker stopped answering'));
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  };

  // A Worker that dies (script blocked, uncaught throw, or silently — see the
  // heartbeat) is replaced by a fresh one seeded from the current document.
  // Evaluation never moves to the main thread; after MAX_WORKER_RESTARTS the
  // host reports failure and waits for Retry.
  const restart = (error: unknown) => {
    stopHeartbeat();
    transport.terminate();
    pending.clear();
    const message = error instanceof Error ? error.message : String(error);
    if (status.restarts >= MAX_WORKER_RESTARTS) {
      setStatus({ failed: true, lastError: message });
      for (const resolve of settleWaiters.splice(0)) resolve();
      return;
    }
    setStatus({ restarts: status.restarts + 1, lastError: message });
    start();
    postLocale();
    post([{ type: 'reset', snapshot: workbookSnapshot(gd) }]);
  };
  const start = () => {
    transport = makeTransport();
    setStatus({ mode: transport.mode });
    transport.onResponse(onResponse);
    transport.onError?.(restart);
    startHeartbeat();
  };
  transport.onResponse(onResponse);
  transport.onError?.(restart);
  startHeartbeat();
  postLocale();
  const stopObserving = observeWorkbook(gd, post);

  return {
    get mode() {
      return transport.mode;
    },
    get status() {
      return status;
    },
    subscribeStatus: (onChange) => {
      statusListeners.add(onChange);
      return () => {
        statusListeners.delete(onChange);
      };
    },
    retry: () => {
      if (!status.failed) return;
      setStatus({ failed: false, restarts: 0, lastError: null });
      start();
      postLocale();
      post([{ type: 'reset', snapshot: workbookSnapshot(gd) }]);
    },
    result: (cellId) => results.get(cellId),
    subscribe: (cellId, onChange) => {
      let set = cellListeners.get(cellId);
      if (set === undefined) {
        set = new Set();
        cellListeners.set(cellId, set);
      }
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) cellListeners.delete(cellId);
      };
    },
    subscribeAll: (onChange) => {
      allListeners.add(onChange);
      return () => {
        allListeners.delete(onChange);
      };
    },
    get version() {
      return version;
    },
    get lastElapsedMs() {
      return lastElapsedMs;
    },
    settled: () =>
      pending.size === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            settleWaiters.push(resolve);
          }),
    dispose: () => {
      stopObserving();
      stopLocale();
      stopHeartbeat();
      transport.terminate();
      cellListeners.clear();
      allListeners.clear();
      statusListeners.clear();
      pending.clear();
    },
  };
}

const hosts = new WeakMap<Y.Doc, EngineHost>();

/**
 * The engine for a document, created on first use and disposed when the
 * document is destroyed (`useDocument` destroys it on unmount). Call from an
 * effect or an event handler, not during render: it starts a Worker and
 * installs a document observer.
 */
export function engineFor(doc: Y.Doc): EngineHost {
  let host = hosts.get(doc);
  if (host === undefined) {
    host = createEngineHost(openDocument(doc));
    hosts.set(doc, host);
    const created = host;
    doc.on('destroy', () => {
      created.dispose();
      hosts.delete(doc);
    });
  }
  return host;
}

/** The engine for a document if one has been started; render-safe. */
export function peekEngine(doc: Y.Doc): EngineHost | undefined {
  return hosts.get(doc);
}

const EMPTY_RESULT: CellResult | undefined = undefined;

/**
 * Subscribe a component to one cell's result. Re-renders only that cell.
 * The engine is started in an effect (declared first, so it precedes the
 * store subscription); until then the result is `undefined` (pending).
 */
export function useCellResult(doc: Y.Doc, cellId: WorkbookCellId): CellResult | undefined {
  useEffect(() => {
    engineFor(doc);
  }, [doc]);
  const subscribe = useCallback(
    (onChange: () => void) => engineFor(doc).subscribe(cellId, onChange),
    [doc, cellId],
  );
  return useSyncExternalStore(
    subscribe,
    () => peekEngine(doc)?.result(cellId),
    () => EMPTY_RESULT,
  );
}

const IDLE_STATUS: EngineStatus = { mode: 'worker', restarts: 0, failed: false, lastError: null };

/** The engine's health, for the banner (starts the engine if needed). */
export function useEngineStatus(doc: Y.Doc): EngineStatus {
  useEffect(() => {
    engineFor(doc);
  }, [doc]);
  const subscribe = useCallback(
    (onChange: () => void) => engineFor(doc).subscribeStatus(onChange),
    [doc],
  );
  return useSyncExternalStore(
    subscribe,
    () => peekEngine(doc)?.status ?? IDLE_STATUS,
    () => IDLE_STATUS,
  );
}
