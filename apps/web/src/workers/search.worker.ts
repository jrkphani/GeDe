/**
 * The Find Worker (FIND-03..05): owns the search index and answers queries so
 * fuzzy matching never runs on the main thread. The protocol is
 * `@gede/core`'s `SearchRequest` / `SearchResponse`; the same engine backs the
 * main-thread fallback in `routes/document/find/search-client.ts`.
 */
import { createSearchEngine, type SearchRequest, type SearchResponse } from '@gede/core';

interface WorkerScope {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage(message: SearchResponse): void;
}

const scope = self as unknown as WorkerScope;
const engine = createSearchEngine();

scope.onmessage = (event) => {
  const response = engine.handle(event.data);
  if (response !== null) scope.postMessage(response);
};
