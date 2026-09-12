/**
 * Talks to the search Worker (`workers/search.worker.ts`). Where `Worker` is
 * unavailable (jsdom in unit tests) the same engine runs on the main thread
 * behind the same asynchronous surface, so callers never branch.
 *
 * In a browser fuzzy matching never moves to the main thread: a Worker that
 * errors is terminated and restarted (its index is gone, so the client asks
 * the owner to re-send it); after `MAX_RESTARTS` failures the client stops
 * and reports that instead.
 */
import { createSearchEngine, type SearchRequest, type SearchResponse } from '@gede/core';

/** Restarts allowed before the client gives up (a worker that dies on load loops otherwise). */
export const MAX_RESTARTS = 3;

export interface WorkerFailure {
  readonly type: 'worker-error';
  /** True when a fresh Worker is up and needs the index again; false when the client has stopped. */
  readonly restarted: boolean;
  readonly message: string;
}

export type SearchClientEvent = SearchResponse | WorkerFailure;

export interface SearchClient {
  readonly mode: 'worker' | 'main';
  post(request: SearchRequest): void;
  /** Subscribe to responses and failures. Returns the unsubscribe function. */
  subscribe(listener: (event: SearchClientEvent) => void): () => void;
  /** True once the Worker has failed `MAX_RESTARTS` times; the owner should create a new client. */
  readonly stopped: boolean;
  dispose(): void;
}

function workerAvailable(): boolean {
  return typeof Worker === 'function';
}

function spawn(): Worker {
  return new Worker(new URL('../../../workers/search.worker.ts', import.meta.url), {
    type: 'module',
    name: 'gede-search',
  });
}

export function createSearchClient(): SearchClient {
  const listeners = new Set<(event: SearchClientEvent) => void>();
  const emit = (event: SearchClientEvent) => {
    listeners.forEach((l) => {
      l(event);
    });
  };
  const subscribe = (listener: (event: SearchClientEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  if (workerAvailable()) {
    let worker: Worker | null = null;
    let restarts = 0;
    let stopped = false;
    const attach = (w: Worker) => {
      w.onmessage = (event: MessageEvent<SearchResponse>) => {
        emit(event.data);
      };
      w.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        if (worker !== w) return; // an old worker's late error
        w.terminate();
        const message = typeof event.message === 'string' ? event.message : '';
        if (restarts >= MAX_RESTARTS) {
          worker = null;
          stopped = true;
          emit({ type: 'worker-error', restarted: false, message });
          return;
        }
        restarts += 1;
        worker = spawn();
        attach(worker);
        emit({ type: 'worker-error', restarted: true, message });
      };
    };
    worker = spawn();
    attach(worker);
    return {
      mode: 'worker',
      get stopped() {
        return stopped;
      },
      post(request) {
        worker?.postMessage(request);
      },
      subscribe,
      dispose() {
        listeners.clear();
        worker?.terminate();
        worker = null;
        stopped = true;
      },
    };
  }

  // Main-thread fallback for environments without Workers (jsdom): same
  // engine, responses delivered on a microtask so ordering assumptions hold.
  const engine = createSearchEngine();
  let disposed = false;
  return {
    mode: 'main',
    get stopped() {
      return disposed;
    },
    post(request) {
      const response = engine.handle(request);
      if (response === null) return;
      queueMicrotask(() => {
        if (!disposed) emit(response);
      });
    },
    subscribe,
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
