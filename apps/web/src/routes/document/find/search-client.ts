/**
 * Talks to the search Worker (`workers/search.worker.ts`). Where `Worker` is
 * unavailable (jsdom in unit tests) the same engine runs on the main thread
 * behind the same asynchronous surface, so callers never branch.
 */
import { createSearchEngine, type SearchRequest, type SearchResponse } from '@gede/core';

export interface SearchClient {
  readonly mode: 'worker' | 'main';
  post(request: SearchRequest): void;
  /** Subscribe to responses. Returns the unsubscribe function. */
  subscribe(listener: (response: SearchResponse) => void): () => void;
  dispose(): void;
}

function workerAvailable(): boolean {
  return typeof Worker === 'function';
}

export function createSearchClient(): SearchClient {
  const listeners = new Set<(response: SearchResponse) => void>();
  const emit = (response: SearchResponse) => {
    listeners.forEach((l) => {
      l(response);
    });
  };
  const subscribe = (listener: (response: SearchResponse) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  if (workerAvailable()) {
    const worker = new Worker(new URL('../../../workers/search.worker.ts', import.meta.url), {
      type: 'module',
      name: 'gede-search',
    });
    worker.onmessage = (event: MessageEvent<SearchResponse>) => {
      emit(event.data);
    };
    return {
      mode: 'worker',
      post(request) {
        worker.postMessage(request);
      },
      subscribe,
      dispose() {
        listeners.clear();
        worker.terminate();
      },
    };
  }

  // Main-thread fallback: same engine, responses delivered on a microtask so
  // the caller's ordering assumptions hold in both modes.
  const engine = createSearchEngine();
  let disposed = false;
  return {
    mode: 'main',
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
