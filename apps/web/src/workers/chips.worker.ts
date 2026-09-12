/**
 * Smart Chip / regex Worker (PRD §20: "regex execution … off the main
 * thread"). One request in, one response out, ids matched by the client.
 * The handler is `@gede/core`'s; this file is only the message plumbing, so
 * the main-thread fallback (`chips.ts`) is the same code without a thread.
 */
import { handleChipRequest, isChipRequest, type ChipResponse } from '@gede/core';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: ChipResponse) => void;
};

scope.onmessage = (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isChipRequest(request)) {
    const id =
      typeof request === 'object' &&
      request !== null &&
      'id' in request &&
      typeof request.id === 'number'
        ? request.id
        : -1;
    scope.postMessage({ id, ok: false, error: 'malformed request' });
    return;
  }
  scope.postMessage(handleChipRequest(request));
};
