/**
 * The conditional-highlighting Worker (INSP-05; PRD §8 pattern rules run
 * chip regexes, and regexes never run on the main thread). One request in,
 * one response out, ids matched by the client
 * (`routes/document/style/rules-client.ts`). The engine is `@gede/core`'s;
 * this file is only the message plumbing, so the main-thread fallback is the
 * same code without a thread.
 */
import { handleRulesRequest, isRulesRequest, type RulesResponse } from '@gede/core';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: RulesResponse) => void;
};

scope.onmessage = (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isRulesRequest(request)) {
    const id =
      typeof request === 'object' &&
      request !== null &&
      'id' in request &&
      typeof request.id === 'number'
        ? request.id
        : -1;
    scope.postMessage({ id, tableId: '', colId: '', ok: false, error: 'malformed request' });
    return;
  }
  scope.postMessage(handleRulesRequest(request));
};
