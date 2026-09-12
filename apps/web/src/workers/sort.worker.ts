/**
 * The sort / filter / group Worker (SORT-01..05, PRD §20: fuzzy and regex
 * matching off the main thread). One request in, one response out, ids
 * matched by the client (`routes/document/sort/view-client.ts`). The engine
 * is `@gede/core`'s; this file is only the message plumbing, so the
 * main-thread fallback is the same code without a thread.
 */
import { handleViewRequest, isViewRequest, type ViewResponse } from '@gede/core';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: ViewResponse) => void;
};

scope.onmessage = (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isViewRequest(request)) {
    const id =
      typeof request === 'object' &&
      request !== null &&
      'id' in request &&
      typeof request.id === 'number'
        ? request.id
        : -1;
    scope.postMessage({ id, tableId: '', ok: false, error: 'malformed request' });
    return;
  }
  scope.postMessage(handleViewRequest(request));
};
