/**
 * The formula engine on the main thread: one host per Y.Doc that ships every
 * document transaction to `formula.worker.ts`, keeps the results it sends
 * back, and lets React subscribe per cell (FX-06, FX-07).
 *
 * Rules (apps/web/CLAUDE.md): the main thread never evaluates a formula.
 * Evaluation runs in the Worker; where `Worker` does not exist (jsdom, Node)
 * the same `FormulaEngine` runs inline so tests exercise the real engine.
 * Typing is never blocked: the observer posts a structured-clone change
 * batch and returns; results arrive asynchronously and re-render by cell id.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import {
  FormulaEngine,
  observeWorkbook,
  openDocument,
  type CellResult,
  type EngineRequest,
  type EngineResponse,
  type GedeDoc,
  type WorkbookCellId,
  type WorkbookChange,
} from '@gede/core';

/** Where evaluation happens. Both speak the core protocol; only `worker` leaves the thread. */
export interface EngineTransport {
  readonly mode: 'worker' | 'inline';
  post(request: EngineRequest): void;
  onResponse(handler: (response: EngineResponse) => void): void;
  terminate(): void;
}

export interface EngineHost {
  readonly mode: 'worker' | 'inline';
  result(cellId: WorkbookCellId): CellResult | undefined;
  /** Re-render signal for one cell; the callback fires when that cell's result changes. */
  subscribe(cellId: WorkbookCellId, onChange: () => void): () => void;
  /** Fires after every batch of results, for whole-sheet consumers (outlines, overlays). */
  subscribeAll(onChange: () => void): () => void;
  /** Monotonic counter across all result changes. */
  readonly version: number;
  /** Resolves once every change posted so far has been answered. */
  settled(): Promise<void>;
  /** Engine time of the last batch, for the §20 budget in devtools. */
  readonly lastElapsedMs: number;
  dispose(): void;
}

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
    terminate: () => {
      worker.terminate();
    },
  };
}

/**
 * Main-thread fallback: the same engine, answered on a microtask so the
 * ordering guarantees match the Worker (a result never lands inside the
 * transaction that caused it). Used where `Worker` is unavailable and in tests.
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

export function createEngineHost(gd: GedeDoc, transport = defaultTransport()): EngineHost {
  const results = new Map<WorkbookCellId, CellResult>();
  const cellListeners = new Map<WorkbookCellId, Set<() => void>>();
  const allListeners = new Set<() => void>();
  const pending = new Set<number>();
  const settleWaiters: (() => void)[] = [];
  let seq = 0;
  let version = 0;
  let lastElapsedMs = 0;

  const notify = (cellId: WorkbookCellId) => {
    const set = cellListeners.get(cellId);
    if (set !== undefined) for (const cb of set) cb();
  };

  transport.onResponse((response) => {
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
  });

  const post = (changes: WorkbookChange[]) => {
    seq += 1;
    const request: EngineRequest = { type: 'apply', seq, changes };
    pending.add(seq);
    transport.post(request);
  };
  const stopObserving = observeWorkbook(gd, post);

  return {
    mode: transport.mode,
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
      transport.terminate();
      cellListeners.clear();
      allListeners.clear();
      pending.clear();
    },
  };
}

const hosts = new WeakMap<Y.Doc, EngineHost>();

/**
 * The engine for a document, created on first use and disposed when the
 * document is destroyed (`useDocument` destroys it on unmount).
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

const EMPTY_RESULT: CellResult | undefined = undefined;

/** Subscribe a component to one cell's result. Re-renders only that cell. */
export function useCellResult(doc: Y.Doc, cellId: WorkbookCellId): CellResult | undefined {
  const host = engineFor(doc);
  const subscribe = useCallback(
    (onChange: () => void) => host.subscribe(cellId, onChange),
    [host, cellId],
  );
  return useSyncExternalStore(
    subscribe,
    () => host.result(cellId),
    () => EMPTY_RESULT,
  );
}

/** Re-render on any result change; returns the host's version counter. */
export function useEngineVersion(doc: Y.Doc): number {
  const host = engineFor(doc);
  const subscribe = useCallback((onChange: () => void) => host.subscribeAll(onChange), [host]);
  return useSyncExternalStore(
    subscribe,
    () => host.version,
    () => 0,
  );
}
